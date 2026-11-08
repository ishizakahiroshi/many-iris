//! Explicitly synthetic executor. It never launches a provider or a shell.
use crate::mcp;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, Write},
    path::Path,
    process::Stdio,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::{Duration, timeout},
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const COMPLETE_AFTER_MS: u64 = 1_500;
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn evidence(payload: String) -> Value {
    json!({"kind":"synthetic-sha256","sha256":digest(&payload),"payload":payload})
}
fn fail(code: &str, detail: &str) -> (String, String) {
    (code.into(), detail.into())
}

pub fn tools() -> Vec<Value> {
    let string = || json!({"type":"string","minLength":1});
    let base = || json!({"attempt_id":string(),"fence":{"type":"integer","minimum":1},"executor_instance_id":string()});
    let mut start = base();
    start["instruction_hash"] = string();
    let mut stop = base();
    stop["stop_request_id"] = string();
    vec![
        mcp::tool("capabilities", json!({}), &[]),
        mcp::tool(
            "executor_start",
            start,
            &[
                "attempt_id",
                "fence",
                "executor_instance_id",
                "instruction_hash",
            ],
        ),
        mcp::tool(
            "executor_poll",
            base(),
            &["attempt_id", "fence", "executor_instance_id"],
        ),
        mcp::tool(
            "executor_stop",
            stop,
            &[
                "attempt_id",
                "fence",
                "executor_instance_id",
                "stop_request_id",
            ],
        ),
    ]
}

struct Engine {
    db: Connection,
}
impl Engine {
    fn open(path: &Path) -> Result<Self, String> {
        if path.as_os_str().is_empty() {
            return Err("Synthetic executor DB path required".into());
        }
        let db = Connection::open(path).map_err(|_| "Cannot open synthetic executor DB")?;
        db.busy_timeout(std::time::Duration::from_secs(1))
            .map_err(|_| "Cannot configure synthetic executor DB")?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|_| "Cannot read executor DB version")?;
        let tables: i64 = db.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], |r| r.get(0)).map_err(|_| "Cannot inspect executor DB")?;
        if version == 0 && tables == 0 {
            db.execute_batch("BEGIN IMMEDIATE; CREATE TABLE synthetic_executor_records(attempt_id TEXT PRIMARY KEY, record TEXT NOT NULL); PRAGMA user_version=1; COMMIT;").map_err(|_| "Cannot initialize synthetic executor DB")?;
        } else if version != 1 || tables != 1 {
            return Err("Unsupported synthetic executor DB; no reset attempted".into());
        }
        db.execute_batch(
            "PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE; COMMIT;",
        )
        .map_err(|_| "Synthetic executor DB already owned or unavailable")?;
        // Confirm the existing schema rather than interpreting another DB as ours.
        db.prepare("SELECT attempt_id, record FROM synthetic_executor_records LIMIT 0")
            .map_err(|_| "Synthetic executor DB schema mismatch")?;
        Ok(Self { db })
    }
    fn read(&self, attempt: &str) -> Result<Option<Value>, (String, String)> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT record FROM synthetic_executor_records WHERE attempt_id=?1",
                [attempt],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| fail("EXECUTOR_STORAGE", "Cannot read executor record"))?;
        let record: Option<Value> = raw
            .map(|s| {
                serde_json::from_str(&s).map_err(|_| {
                    fail(
                        "EXECUTOR_STORAGE",
                        "Invalid executor record; retained without reset",
                    )
                })
            })
            .transpose()?;
        if let Some(value) = &record {
            if value["attempt_id"] != attempt
                || !value["fence"].as_u64().is_some_and(|v| v > 0)
                || !value["executor_instance_id"].is_string()
                || !value["accepted_at_ms"].is_u64()
                || !value["event_seq"].as_u64().is_some_and(|v| v > 0)
                || !["accepted", "running", "result", "stop_observed"]
                    .iter()
                    .any(|phase| value["phase"] == *phase)
                || !value["start_event"].is_object()
                || !value["event"].is_object()
            {
                return Err(fail(
                    "EXECUTOR_STORAGE",
                    "Invalid executor record shape; retained without reset",
                ));
            }
        }
        Ok(record)
    }
    fn save(&mut self, attempt: &str, record: &Value) -> Result<(), (String, String)> {
        let tx = self
            .db
            .transaction()
            .map_err(|_| fail("EXECUTOR_STORAGE", "Cannot begin executor transaction"))?;
        tx.execute("INSERT INTO synthetic_executor_records(attempt_id,record) VALUES(?1,?2) ON CONFLICT(attempt_id) DO UPDATE SET record=excluded.record",params![attempt,record.to_string()]).map_err(|_| fail("EXECUTOR_STORAGE", "Cannot persist executor record"))?;
        tx.commit()
            .map_err(|_| fail("EXECUTOR_STORAGE", "Cannot commit executor receipt"))
    }
    fn identity(args: &Value) -> Result<(&str, u64, &str), (String, String)> {
        let attempt = args["attempt_id"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 256)
            .ok_or_else(|| fail("INVALID_ARGUMENT", "Bounded attempt_id required"))?;
        let fence = args["fence"]
            .as_u64()
            .filter(|v| *v > 0)
            .ok_or_else(|| fail("INVALID_ARGUMENT", "Positive fence required"))?;
        let instance = args["executor_instance_id"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 256)
            .ok_or_else(|| fail("INVALID_ARGUMENT", "Bounded executor_instance_id required"))?;
        Ok((attempt, fence, instance))
    }
    fn check(record: &Value, fence: u64, instance: &str) -> Result<(), (String, String)> {
        if record["fence"] != fence || record["executor_instance_id"] != instance {
            return Err(fail("EXECUTOR_FENCE", "Attempt ownership does not match"));
        }
        Ok(())
    }
    fn event(record: &Value, kind: &str, seq: u64, timestamp: u64) -> Value {
        json!({"attempt_id":record["attempt_id"],"fence":record["fence"],"executor_instance_id":record["executor_instance_id"],"event_seq":seq,"event_kind":kind,"observed_at":timestamp/1000})
    }
    fn reply(record: &Value) -> Value {
        json!({"synthetic":true,"accepted":true,"attempt_id":record["attempt_id"],"fence":record["fence"],"executor_instance_id":record["executor_instance_id"],"event":record["event"]})
    }
    fn start_reply(record: &Value) -> Value {
        let mut reply = Self::reply(record);
        reply["event"] = record["start_event"].clone();
        reply
    }
    fn apply(&mut self, operation: &str, args: &Value) -> Result<Value, (String, String)> {
        if operation == "capabilities" {
            return Ok(
                json!({"synthetic":true,"contract_version":"iris-synthetic-executor/1","protocol_version":mcp::VERSION,"durable_start_receipt":true,"query_by_attempt":true,"fenced_stop_proof":true,"result_sha256":true,"external_effects":false}),
            );
        }
        let (attempt, fence, instance) = Self::identity(args)?;
        let existing = self.read(attempt)?;
        match operation {
            "executor_start" => {
                let hash = args["instruction_hash"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 256)
                    .ok_or_else(|| fail("INVALID_ARGUMENT", "Bounded instruction hash required"))?;
                let fingerprint = digest(&args.to_string());
                if let Some(record) = existing {
                    Self::check(&record, fence, instance)?;
                    if record["start_fingerprint"] != fingerprint {
                        return Err(fail(
                            "EXECUTOR_CONFLICT",
                            "Attempt already accepted with different content",
                        ));
                    }
                    return Ok(Self::start_reply(&record));
                }
                let timestamp = now_ms();
                let mut record = json!({"attempt_id":attempt,"fence":fence,"executor_instance_id":instance,"instruction_hash":hash,"start_fingerprint":fingerprint,"accepted_at_ms":timestamp,"phase":"accepted","event_seq":1});
                record["event"] = Self::event(&record, "accepted", 1, timestamp);
                record["start_event"] = record["event"].clone();
                self.save(attempt, &record)?;
                Ok(Self::start_reply(&record))
            }
            "executor_poll" => {
                let mut record = existing.ok_or_else(|| {
                    fail("EXECUTOR_NOT_FOUND", "No durable receipt for this attempt")
                })?;
                Self::check(&record, fence, instance)?;
                if record["phase"] == "accepted" || record["phase"] == "running" {
                    let timestamp = now_ms();
                    let elapsed = timestamp
                        .saturating_sub(record["accepted_at_ms"].as_u64().unwrap_or(timestamp));
                    let next = if elapsed >= COMPLETE_AFTER_MS {
                        "result"
                    } else {
                        "running"
                    };
                    if next != record["phase"].as_str().unwrap_or("") {
                        let seq = record["event_seq"].as_u64().unwrap_or(0) + 1;
                        let mut event = Self::event(&record, next, seq, timestamp);
                        if next == "result" {
                            event["outcome"] = "succeeded".into();
                            event["owned_execution_ceased"] = true.into();
                            event["evidence"] = evidence(format!(
                                "synthetic:completed:{attempt}:{fence}:{}",
                                record["instruction_hash"].as_str().unwrap_or("")
                            ));
                        }
                        record["phase"] = next.into();
                        record["event_seq"] = seq.into();
                        record["event"] = event;
                        self.save(attempt, &record)?;
                    }
                }
                Ok(Self::reply(&record))
            }
            "executor_stop" => {
                let mut record = existing.ok_or_else(|| {
                    fail("EXECUTOR_NOT_FOUND", "No durable receipt for this attempt")
                })?;
                Self::check(&record, fence, instance)?;
                let stop_id = args["stop_request_id"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 256)
                    .ok_or_else(|| fail("INVALID_ARGUMENT", "Bounded stop_request_id required"))?;
                if record["phase"] == "stop_observed" {
                    if record["event"]["stop_request_id"] != stop_id {
                        return Err(fail(
                            "EXECUTOR_CONFLICT",
                            "Different stop request already observed",
                        ));
                    }
                    return Ok(Self::reply(&record));
                }
                if record["phase"] == "result" {
                    return Err(fail(
                        "EXECUTOR_TERMINAL",
                        "Completed result cannot be changed to stopped",
                    ));
                }
                let timestamp = now_ms();
                // A synthetic job has no external effects. Once its scheduled
                // completion has elapsed, preserve the result instead of lying
                // that a late stop prevented completion.
                if timestamp.saturating_sub(record["accepted_at_ms"].as_u64().unwrap_or(timestamp))
                    >= COMPLETE_AFTER_MS
                {
                    return self.apply("executor_poll", args);
                }
                let seq = record["event_seq"].as_u64().unwrap_or(0) + 1;
                let mut event = Self::event(&record, "stop_observed", seq, timestamp);
                event["stop_request_id"] = stop_id.into();
                event["outcome"] = "failed".into();
                event["owned_execution_ceased"] = true.into();
                event["effects"] = "none".into();
                event["evidence"] =
                    evidence(format!("synthetic:stopped:no-effects:{attempt}:{fence}"));
                record["phase"] = "stop_observed".into();
                record["event_seq"] = seq.into();
                record["event"] = event;
                self.save(attempt, &record)?;
                Ok(Self::reply(&record))
            }
            _ => Err(fail("EXECUTOR_TOOL", "Unsupported synthetic executor tool")),
        }
    }
}

/// Stdio server mode for the same executable. No ordinary stdout logging.
pub async fn serve_stdio(db: &Path) -> Result<(), String> {
    let mut engine = Engine::open(db)?;
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let stdout = std::io::stdout();
    let mut writer = stdout.lock();
    loop {
        let Some(line) = read_sync_line(&mut reader)? else {
            return Ok(());
        };
        let response = match mcp::parse_json(&line) {
            Ok(request) => {
                // One-way notifications never produce a response. This server
                // only runs short synchronous protocol calls, not long RPCs.
                if request.is_object()
                    && request["jsonrpc"] == "2.0"
                    && request.get("id").is_none()
                    && request["method"]
                        .as_str()
                        .is_some_and(|m| m.starts_with("notifications/"))
                {
                    continue;
                }
                mcp::handle_with_tools(
                    &request,
                    "iris-synthetic-executor",
                    &tools(),
                    &mut |op, args| engine.apply(op, args),
                )
            }
            Err(error) => mcp::error_response(None, &error),
        };
        let encoded = response.to_string();
        if encoded.len() > mcp::MAX_BYTES {
            return Err("Synthetic response byte limit exceeded".into());
        }
        writer
            .write_all(encoded.as_bytes())
            .and_then(|_| writer.write_all(b"\n"))
            .and_then(|_| writer.flush())
            .map_err(|_| "Cannot write synthetic MCP response")?;
    }
}
fn read_sync_line(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut line = Vec::new();
    loop {
        let buf = reader
            .fill_buf()
            .map_err(|_| "Cannot read synthetic MCP input")?;
        if buf.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err("Unterminated synthetic MCP message".into())
            };
        }
        let take = buf
            .iter()
            .position(|b| *b == b'\n')
            .map(|n| n + 1)
            .unwrap_or(buf.len());
        if line.len() + take > mcp::MAX_BYTES + 1 {
            return Err("Synthetic MCP input byte limit exceeded".into());
        }
        let done = buf[take - 1] == b'\n';
        line.extend_from_slice(&buf[..take]);
        reader.consume(take);
        if done {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}

pub struct Client {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    healthy: bool,
}
impl Client {
    pub async fn spawn(executable: &Path, db: &Path) -> Result<Self, String> {
        let mut command = Command::new(executable);
        command
            .args(["--synthetic-executor", "--db"])
            .arg(db)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .env_clear();
        if let Some(root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "Cannot start owned synthetic executor")?;
        let stdin = child.stdin.take().ok_or("Synthetic stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Synthetic stdout unavailable")?;
        let mut client = Self {
            child,
            stdin: Some(stdin),
            stdout: BufReader::new(stdout),
            next_id: 1,
            healthy: true,
        };
        let setup = async {
            let discovery = client.rpc("server/discover", json!({})).await?;
            if !discovery["supportedVersions"]
                .as_array()
                .is_some_and(|v| v.iter().any(|v| v == mcp::VERSION))
                || !discovery["capabilities"]["tools"].is_object()
            {
                return Err("Synthetic executor protocol or tool capability unavailable".into());
            }
            let list = client.rpc("tools/list", json!({})).await?;
            for required in [
                "capabilities",
                "executor_start",
                "executor_poll",
                "executor_stop",
            ] {
                if !list["tools"]
                    .as_array()
                    .is_some_and(|t| t.iter().any(|v| v["name"] == required))
                {
                    return Err("Required synthetic executor tool unavailable".into());
                }
            }
            let capabilities = client.call("capabilities", json!({})).await?;
            for required in [
                "synthetic",
                "durable_start_receipt",
                "query_by_attempt",
                "fenced_stop_proof",
                "result_sha256",
            ] {
                if capabilities[required] != true {
                    return Err(
                        "Required synthetic executor semantic capability unavailable".into(),
                    );
                }
            }
            if capabilities["external_effects"] != false {
                return Err("Executor must be synthetic without external effects".into());
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(e) = setup {
            let _ = client.shutdown().await;
            return Err(e);
        }
        Ok(client)
    }
    async fn rpc(&mut self, method: &str, params: Value) -> Result<Value, String> {
        if !self.healthy {
            return Err(
                "Synthetic transport unusable; reconcile persisted attempt before any new start"
                    .into(),
            );
        }
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or("Synthetic request ID exhausted")?;
        let encoded = mcp::request(id, method, params).to_string();
        if encoded.len() > mcp::MAX_BYTES {
            return Err("Synthetic request byte limit exceeded".into());
        }
        let result = timeout(REQUEST_TIMEOUT, async {
            let writer = self.stdin.as_mut().ok_or("Synthetic executor closed")?;
            writer
                .write_all(encoded.as_bytes())
                .await
                .map_err(|_| "Synthetic request delivery unknown")?;
            writer
                .write_all(b"\n")
                .await
                .map_err(|_| "Synthetic request delivery unknown")?;
            writer
                .flush()
                .await
                .map_err(|_| "Synthetic request delivery unknown")?;
            let line = read_async_line(&mut self.stdout).await?;
            let response =
                mcp::parse_json(&line).map_err(|_| "Invalid bounded synthetic response")?;
            if response["jsonrpc"] != "2.0" || response["id"] != id {
                return Err("Synthetic response identity mismatch".into());
            }
            if response.get("error").is_some() {
                return Err("Synthetic MCP peer rejected request".into());
            }
            if response["result"]["resultType"] != "complete" {
                return Err("Synthetic result profile mismatch".into());
            }
            Ok::<Value, String>(response["result"].clone())
        })
        .await;
        match result {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(e)) => {
                self.healthy = false;
                Err(e)
            }
            Err(_) => {
                self.healthy = false;
                Err("Synthetic request timeout; delivery/result unknown, no automatic retry".into())
            }
        }
    }
    pub async fn call(&mut self, tool: &str, args: Value) -> Result<Value, String> {
        if ![
            "capabilities",
            "executor_start",
            "executor_poll",
            "executor_stop",
        ]
        .contains(&tool)
        {
            return Err("Synthetic tool not permitted".into());
        }
        let result = self
            .rpc("tools/call", json!({"name":tool,"arguments":args}))
            .await?;
        if result["isError"] != false {
            return Err(format!(
                "Synthetic executor application error: {}",
                result["structuredContent"]["error"]["code"]
                    .as_str()
                    .unwrap_or("UNKNOWN")
            ));
        }
        if !result["structuredContent"].is_object() {
            return Err("Synthetic structured result required".into());
        }
        Ok(result["structuredContent"].clone())
    }
    pub async fn shutdown(&mut self) -> Result<(), String> {
        self.healthy = false;
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.shutdown().await;
            drop(stdin);
        }
        match timeout(REQUEST_TIMEOUT, self.child.wait()).await {
            Ok(Ok(_)) => Ok(()),
            _ => self
                .child
                .kill()
                .await
                .map_err(|_| "Cannot terminate owned synthetic executor".into()),
        }
    }
}
async fn read_async_line(reader: &mut BufReader<ChildStdout>) -> Result<Vec<u8>, String> {
    let mut line = Vec::new();
    loop {
        let buf = reader
            .fill_buf()
            .await
            .map_err(|_| "Cannot read synthetic executor response")?;
        if buf.is_empty() {
            return Err("Synthetic executor disconnected; result unknown".into());
        }
        let take = buf
            .iter()
            .position(|b| *b == b'\n')
            .map(|n| n + 1)
            .unwrap_or(buf.len());
        if line.len() + take > mcp::MAX_BYTES + 1 {
            return Err("Synthetic response byte limit exceeded".into());
        }
        let done = buf[take - 1] == b'\n';
        line.extend_from_slice(&buf[..take]);
        reader.consume(take);
        if done {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(line);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn start() -> Value {
        json!({"attempt_id":"attempt-a","fence":1,"executor_instance_id":"instance-a","instruction_hash":"instruction-a"})
    }
    fn key() -> Value {
        json!({"attempt_id":"attempt-a","fence":1,"executor_instance_id":"instance-a"})
    }
    #[test]
    fn duplicate_start_durable_lookup_and_content_conflict() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("executor.sqlite");
        let first;
        {
            let mut engine = Engine::open(&path).unwrap();
            first = engine.apply("executor_start", &start()).unwrap();
            assert_eq!(first, engine.apply("executor_start", &start()).unwrap());
            engine.apply("executor_poll", &key()).unwrap();
            assert_eq!(first, engine.apply("executor_start", &start()).unwrap());
        }
        let mut engine = Engine::open(&path).unwrap();
        assert_eq!(first, engine.apply("executor_start", &start()).unwrap());
        let mut changed = start();
        changed["instruction_hash"] = "different".into();
        assert_eq!(
            engine.apply("executor_start", &changed).unwrap_err().0,
            "EXECUTOR_CONFLICT"
        );
        let mut wrong = key();
        wrong["fence"] = 2.into();
        assert_eq!(
            engine.apply("executor_poll", &wrong).unwrap_err().0,
            "EXECUTOR_FENCE"
        );
        wrong = key();
        wrong["executor_instance_id"] = "other".into();
        assert_eq!(
            engine.apply("executor_poll", &wrong).unwrap_err().0,
            "EXECUTOR_FENCE"
        );
    }
    #[test]
    fn stop_proof_is_bound_durable_and_cannot_become_success() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("executor.sqlite");
        let mut engine = Engine::open(&path).unwrap();
        engine.apply("executor_start", &start()).unwrap();
        let mut args = key();
        args["stop_request_id"] = "stop-a".into();
        let stopped = engine.apply("executor_stop", &args).unwrap();
        assert_eq!(stopped["event"]["event_kind"], "stop_observed");
        assert_eq!(stopped["event"]["owned_execution_ceased"], true);
        assert_eq!(
            stopped["event"]["evidence"]["sha256"],
            digest("synthetic:stopped:no-effects:attempt-a:1")
        );
        assert_eq!(engine.apply("executor_stop", &args).unwrap(), stopped);
        args["stop_request_id"] = "stop-b".into();
        assert_eq!(
            engine.apply("executor_stop", &args).unwrap_err().0,
            "EXECUTOR_CONFLICT"
        );
        drop(engine);
        let mut engine = Engine::open(&path).unwrap();
        assert_eq!(engine.apply("executor_poll", &key()).unwrap(), stopped);
    }
    #[test]
    fn completed_evidence_is_exact_and_late_stop_does_not_overwrite_it() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("executor.sqlite");
        let mut engine = Engine::open(&path).unwrap();
        engine.apply("executor_start", &start()).unwrap();
        assert_eq!(
            engine.apply("executor_poll", &key()).unwrap()["event"]["event_kind"],
            "running"
        );
        // Advance only this synthetic record's fixed clock origin; no global sleep.
        let mut record = engine.read("attempt-a").unwrap().unwrap();
        record["accepted_at_ms"] = now_ms().saturating_sub(COMPLETE_AFTER_MS + 1).into();
        engine.save("attempt-a", &record).unwrap();
        let completed = engine.apply("executor_poll", &key()).unwrap();
        assert_eq!(completed["event"]["event_kind"], "result");
        assert_eq!(completed["event"]["outcome"], "succeeded");
        assert_eq!(
            completed["event"]["evidence"]["sha256"],
            digest("synthetic:completed:attempt-a:1:instruction-a")
        );
        let mut stop = key();
        stop["stop_request_id"] = "late-stop".into();
        assert_eq!(
            engine.apply("executor_stop", &stop).unwrap_err().0,
            "EXECUTOR_TERMINAL"
        );
        assert_eq!(engine.apply("executor_poll", &key()).unwrap(), completed);
    }
    #[test]
    fn foreign_future_and_corrupt_databases_are_not_reset() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("foreign.sqlite");
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE precious(data TEXT); INSERT INTO precious VALUES('keep');",
            )
            .unwrap();
        }
        assert!(Engine::open(&path).is_err());
        let db = Connection::open(&path).unwrap();
        assert_eq!(
            db.query_row("SELECT data FROM precious", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "keep"
        );
        drop(db);
        let future = temp.path().join("future.sqlite");
        {
            let db = Connection::open(&future).unwrap();
            db.execute_batch("PRAGMA user_version=42").unwrap();
        }
        assert!(Engine::open(&future).is_err());
    }
    #[test]
    fn stdio_line_framing_is_bounded_and_requires_newline() {
        assert_eq!(
            read_sync_line(&mut std::io::Cursor::new(b"{}\n")).unwrap(),
            Some(b"{}".to_vec())
        );
        assert!(read_sync_line(&mut std::io::Cursor::new(b"{}")).is_err());
        assert!(read_sync_line(&mut std::io::Cursor::new(vec![b'x'; mcp::MAX_BYTES + 2])).is_err());
        assert!(
            read_sync_line(&mut std::io::Cursor::new(Vec::<u8>::new()))
                .unwrap()
                .is_none()
        );
    }
}
