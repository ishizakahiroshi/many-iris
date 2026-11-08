use crate::process::Job;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap, fs, os::windows::fs::OpenOptionsExt, path::PathBuf, time::Duration,
};

type Outcome<T> = Result<T, &'static str>;
fn storage<T>(value: rusqlite::Result<T>) -> Outcome<T> {
    value.map_err(|_| "STORAGE")
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn integer(v: &Value, key: &str) -> Outcome<i64> {
    v.get(key).and_then(Value::as_i64).ok_or("INVALID")
}
fn string<'a>(v: &'a Value, key: &str) -> Outcome<&'a str> {
    v.get(key).and_then(Value::as_str).ok_or("INVALID")
}
fn id<'a>(v: &'a Value, key: &str) -> Outcome<&'a str> {
    let s = string(v, key)?;
    if s.is_empty()
        || s.len() > 80
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("INVALID");
    }
    Ok(s)
}

pub struct Options {
    pub db: PathBuf,
    pub fixture: PathBuf,
    pub helper: PathBuf,
    pub python: PathBuf,
    pub test_mode: bool,
    pub restored: bool,
}

#[derive(Debug)]
struct Run {
    id: String,
    task_id: String,
    state: String,
    epoch: i64,
    attempt: i64,
    revision: Option<i64>,
    source_hash: Option<String>,
    expires_at: Option<i64>,
    pid: Option<i64>,
    events_path: Option<String>,
}
impl Run {
    fn json(&self) -> Value {
        json!({"run_id":self.id,"task_id":self.task_id,"state":self.state,
        "epoch":self.epoch,"attempt":self.attempt,"revision":self.revision,"source_hash":self.source_hash,
        "expires_at":self.expires_at,"pid":self.pid,"events_path":self.events_path})
    }
}

pub struct Core {
    db: Connection,
    options: Options,
    jobs: HashMap<String, Job>,
    _ownership: fs::File,
    epoch: i64,
}

impl Core {
    pub fn open(mut options: Options) -> Outcome<Self> {
        if !options.helper.is_file() || !options.python.is_file() {
            return Err("CONFIG");
        }
        // Resolve the final DB component: symlink aliases must select the same
        // sibling lock. Hardlinks have distinct paths, so reject multiple links.
        options.db = match fs::symlink_metadata(&options.db) {
            Ok(_) => {
                let canonical = fs::canonicalize(&options.db).map_err(|_| "CONFIG")?;
                if !canonical.is_file() {
                    return Err("CONFIG");
                }
                crate::process::require_single_link(&canonical)?;
                canonical
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let parent =
                    fs::canonicalize(options.db.parent().ok_or("CONFIG")?).map_err(|_| "CONFIG")?;
                parent.join(options.db.file_name().ok_or("CONFIG")?)
            }
            Err(_) => return Err("CONFIG"),
        };
        // Deny a second owner before it can increment epoch or inspect live state.
        // The file may remain after exit; Windows releases sharing lock on exit.
        let ownership = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .share_mode(0)
            .open(options.db.with_extension("owner-lock"))
            .map_err(|_| "DB_LOCKED")?;
        let db = storage(Connection::open(&options.db))?;
        storage(db.busy_timeout(Duration::from_millis(1000)))?;
        storage(db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,
              epoch INTEGER NOT NULL,now INTEGER NOT NULL,execution_enabled INTEGER NOT NULL,fault TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,source TEXT NOT NULL,
              source_hash TEXT NOT NULL,revision INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),
              request_id TEXT UNIQUE NOT NULL,state TEXT NOT NULL,epoch INTEGER NOT NULL,attempt INTEGER NOT NULL,
              revision INTEGER,source_hash TEXT,expires_at INTEGER,pid INTEGER,events_path TEXT,mode TEXT);
            CREATE UNIQUE INDEX IF NOT EXISTS one_active ON runs(task_id)
              WHERE state NOT IN ('completed','rejected','stopped');
            CREATE TABLE IF NOT EXISTS requests(request_id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id));"))?;
        let seeded: bool =
            storage(db.query_row("SELECT EXISTS(SELECT 1 FROM metadata)", [], |r| r.get(0)))?;
        if !seeded {
            let fixture: Value =
                serde_json::from_slice(&fs::read(&options.fixture).map_err(|_| "CONFIG")?)
                    .map_err(|_| "CONFIG")?;
            if integer(&fixture, "version")? != 1 {
                return Err("CONFIG");
            }
            let tasks = fixture
                .get("tasks")
                .and_then(Value::as_array)
                .ok_or("CONFIG")?;
            storage(db.execute_batch("BEGIN IMMEDIATE"))?;
            let seed_result = (|| {
                storage(db.execute(
                    "INSERT INTO metadata VALUES(1,1,0,?,1,'none')",
                    [integer(&fixture, "now")?],
                ))?;
                for task in tasks {
                    let source = string(task, "source")?;
                    if string(task, "source_hash")? != hash(source)
                        || integer(task, "revision")? != 1
                    {
                        return Err("CONFIG");
                    }
                    storage(db.execute(
                        "INSERT INTO tasks VALUES(?,?,?,?,?)",
                        params![
                            id(task, "id")?,
                            string(task, "title")?,
                            source,
                            hash(source),
                            1
                        ],
                    ))?;
                }
                Ok(())
            })();
            if seed_result.is_ok() {
                storage(db.execute_batch("COMMIT"))?;
            } else {
                let _ = db.execute_batch("ROLLBACK");
                seed_result?;
            }
        }
        let schema_version: i64 = storage(db.query_row(
            "SELECT schema_version FROM metadata WHERE id=1",
            [],
            |row| row.get(0),
        ))?;
        if schema_version != 1 {
            return Err("SCHEMA_VERSION");
        }
        storage(db.execute_batch("BEGIN IMMEDIATE"))?;
        storage(db.execute(
            "UPDATE metadata SET epoch=epoch+1,
            execution_enabled=CASE WHEN ? THEN 0 ELSE execution_enabled END",
            [options.restored],
        ))?;
        storage(db.execute_batch("
            UPDATE runs SET state='unknown' WHERE state IN ('running','dispatching','stopping');
            UPDATE runs SET state='waiting',revision=NULL,source_hash=NULL,expires_at=NULL,
              epoch=(SELECT epoch FROM metadata) WHERE state IN ('queued','approved','waiting'); COMMIT;"))?;
        let epoch = storage(
            db.query_row("SELECT epoch FROM metadata WHERE id=1", [], |row| {
                row.get(0)
            }),
        )?;
        Ok(Self {
            db,
            options,
            jobs: HashMap::new(),
            _ownership: ownership,
            epoch,
        })
    }

    pub fn sqlite_version(&self) -> String {
        rusqlite::version().to_owned()
    }

    fn run(&self, run_id: &str) -> Outcome<Run> {
        storage(self.db.query_row("SELECT id,task_id,state,epoch,attempt,revision,source_hash,expires_at,pid,events_path
            FROM runs WHERE id=?", [run_id], |r| Ok(Run { id:r.get(0)?, task_id:r.get(1)?,state:r.get(2)?,
              epoch:r.get(3)?,attempt:r.get(4)?,revision:r.get(5)?,source_hash:r.get(6)?,expires_at:r.get(7)?,
              pid:r.get(8)?,events_path:r.get(9)? })).optional())?.ok_or("NOT_FOUND")
    }
    fn task(&self, task_id: &str) -> Outcome<Value> {
        storage(self.db.query_row("SELECT id,title,source,source_hash,revision FROM tasks WHERE id=?", [task_id],
            |r| Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,
                "source":r.get::<_,String>(2)?,"source_hash":r.get::<_,String>(3)?,"revision":r.get::<_,i64>(4)?})))
            .optional())?.ok_or("NOT_FOUND")
    }
    fn metadata(&self) -> Outcome<(i64, i64, bool, String)> {
        storage(self.db.query_row(
            "SELECT epoch,now,execution_enabled,fault FROM metadata WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ))
    }
    fn valid_grant(&self, run: &Run) -> Outcome<()> {
        let (epoch, now, enabled, _) = self.metadata()?;
        if !enabled {
            return Err("RESTORE_HOLD");
        }
        let task = self.task(&run.task_id)?;
        if run.epoch != epoch
            || run.revision != task["revision"].as_i64()
            || run.source_hash.as_deref() != task["source_hash"].as_str()
            || run.expires_at.is_none_or(|expiry| expiry <= now)
        {
            return Err("STALE_APPROVAL");
        }
        Ok(())
    }
    fn state(&self, run_id: &str, state: &str) -> Outcome<()> {
        storage(
            self.db
                .execute("UPDATE runs SET state=? WHERE id=?", params![state, run_id]),
        )?;
        Ok(())
    }

    pub fn call(&mut self, input: Value) -> Outcome<Value> {
        let op = string(&input, "op")?.to_owned();
        let allowed: &[&str] = match op.as_str() {
            "list" => &["op", "offset", "limit"],
            "detail" | "revise" => {
                if op == "detail" {
                    &["op", "task_id"]
                } else {
                    &["op", "task_id", "source"]
                }
            }
            "start" => &["op", "task_id", "request_id"],
            "approve" => &["op", "run_id", "revision", "source_hash", "expires_at"],
            "reject" | "revoke" | "enqueue" | "status" | "stop" => &["op", "run_id"],
            "dispatch" => &["op", "run_id", "mode"],
            "result" => &[
                "op",
                "run_id",
                "epoch",
                "attempt",
                "revision",
                "source_hash",
            ],
            "snapshot" => &["op", "path"],
            "advance" => &["op", "seconds"],
            "fault" => &["op", "kind"],
            _ => return Err("INVALID"),
        };
        let object = input.as_object().ok_or("INVALID")?;
        if object.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err("INVALID");
        }
        if ["result", "snapshot", "advance", "revise", "fault"].contains(&op.as_str())
            && !self.options.test_mode
        {
            return Err("INVALID");
        }
        if !["list", "detail", "status", "snapshot"].contains(&op.as_str()) && !self.metadata()?.2 {
            return Err("RESTORE_HOLD");
        }
        // Serialize decisions durably; process launch/stop follows committed intent
        // under the same Core mutex. Uncertain dispatch gaps restart as unknown.
        storage(self.db.execute_batch("BEGIN IMMEDIATE"))?;
        let answer = self.transaction(&op, &input);
        match answer {
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error)
            }
            Ok(value) => {
                if let Err(error) = storage(self.db.execute_batch("COMMIT")) {
                    let _ = self.db.execute_batch("ROLLBACK");
                    return Err(error);
                }
                match op.as_str() {
                    "dispatch" => self.launch(id(&input, "run_id")?, string(&input, "mode")?),
                    "stop" => self.terminate(id(&input, "run_id")?),
                    "snapshot" => self.backup(string(&input, "path")?),
                    _ => Ok(value),
                }
            }
        }
    }

    fn transaction(&mut self, op: &str, input: &Value) -> Outcome<Value> {
        if !["list", "detail", "snapshot"].contains(&op) && self.metadata()?.0 != self.epoch {
            return Err("OWNER_CHANGED");
        }
        match op {
            "list" => {
                let offset = integer(input, "offset")?;
                let limit = integer(input, "limit")?;
                if offset < 0 || !(1..=100).contains(&limit) {
                    return Err("INVALID");
                }
                let mut query =
                    storage(self.db.prepare(
                        "SELECT id,title,revision FROM tasks ORDER BY id LIMIT ? OFFSET ?",
                    ))?;
                let mapped = storage(query.query_map(params![limit, offset], |r| {
                    Ok(json!({"id":r.get::<_,String>(0)?,
                    "title":r.get::<_,String>(1)?,"revision":r.get::<_,i64>(2)?}))
                }))?;
                let tasks = storage(mapped.collect::<rusqlite::Result<Vec<_>>>())?;
                let total: i64 = storage(self.db.query_row(
                    "SELECT COUNT(*) FROM tasks",
                    [],
                    |r| r.get(0),
                ))?;
                Ok(json!({"tasks":tasks,"total":total}))
            }
            "detail" => self.task(id(input, "task_id")?),
            "start" => {
                let task_id = id(input, "task_id")?;
                let request = id(input, "request_id")?;
                let previous: Option<String> = storage(
                    self.db
                        .query_row(
                            "SELECT task_id FROM requests WHERE request_id=?",
                            [request],
                            |r| r.get(0),
                        )
                        .optional(),
                )?;
                if let Some(previous) = previous {
                    if previous != task_id {
                        return Err("REQUEST_CONFLICT");
                    }
                    return Ok(self.run(request)?.json());
                }
                self.task(task_id)?;
                let active: bool = storage(self.db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM runs WHERE task_id=?
                    AND state NOT IN ('completed','rejected','stopped'))",
                    [task_id],
                    |r| r.get(0),
                ))?;
                if active {
                    return Err("ACTIVE_RUN");
                }
                storage(self.db.execute(
                    "INSERT INTO requests VALUES(?,?)",
                    params![request, task_id],
                ))?;
                storage(self.db.execute(
                    "INSERT INTO runs(id,task_id,request_id,state,epoch,attempt)
                    VALUES(?,?,?,'waiting',?,1)",
                    params![request, task_id, request, self.metadata()?.0],
                ))?;
                Ok(self.run(request)?.json())
            }
            "approve" => {
                let run = self.run(id(input, "run_id")?)?;
                if run.state != "waiting" {
                    return Err("STATE");
                }
                let task = self.task(&run.task_id)?;
                let (epoch, now, _, _) = self.metadata()?;
                let revision = integer(input, "revision")?;
                let source_hash = string(input, "source_hash")?;
                let expiry = integer(input, "expires_at")?;
                if revision != task["revision"].as_i64().ok_or("STORAGE")?
                    || Some(source_hash) != task["source_hash"].as_str()
                    || expiry <= now
                    || run.epoch != epoch
                {
                    return Err("STALE_APPROVAL");
                }
                storage(self.db.execute("UPDATE runs SET state='approved',revision=?,source_hash=?,expires_at=? WHERE id=?",
                    params![revision,source_hash,expiry,run.id]))?;
                Ok(self.run(&run.id)?.json())
            }
            "enqueue" => {
                let run = self.run(id(input, "run_id")?)?;
                if run.state != "approved" {
                    return Err("STATE");
                }
                self.valid_grant(&run)?;
                self.state(&run.id, "queued")?;
                Ok(self.run(&run.id)?.json())
            }
            "revoke" | "reject" => {
                let run = self.run(id(input, "run_id")?)?;
                let allowed = if op == "revoke" {
                    ["approved", "queued", ""]
                } else {
                    ["waiting", "approved", "queued"]
                };
                if !allowed.contains(&run.state.as_str()) {
                    return Err("STATE");
                }
                storage(self.db.execute("UPDATE runs SET state=?,revision=NULL,source_hash=NULL,expires_at=NULL WHERE id=?",
                    params![if op=="revoke" {"waiting"} else {"rejected"},run.id]))?;
                Ok(self.run(&run.id)?.json())
            }
            "dispatch" => {
                let run = self.run(id(input, "run_id")?)?;
                let mode = string(input, "mode")?;
                if !["success", "slow", "orphan"].contains(&mode)
                    || (!self.options.test_mode && mode != "success")
                {
                    return Err("INVALID");
                }
                if run.state != "queued" {
                    return Err("STATE");
                }
                self.valid_grant(&run)?;
                if ["intent_full", "busy"].contains(&self.metadata()?.3.as_str()) {
                    return Err("STORAGE");
                }
                let events = self
                    .options
                    .db
                    .parent()
                    .ok_or("CONFIG")?
                    .join(format!("{}.events.jsonl", run.id));
                if events.exists() {
                    return Err("STATE");
                }
                storage(self.db.execute(
                    "UPDATE runs SET state='dispatching',events_path=?,mode=? WHERE id=?",
                    params![events.to_string_lossy(), mode, run.id],
                ))?;
                Ok(self.run(&run.id)?.json())
            }
            "status" => self.poll(id(input, "run_id")?),
            "stop" => {
                let run = self.run(id(input, "run_id")?)?;
                match run.state.as_str() {
                    "waiting" | "approved" | "queued" => self.state(&run.id, "stopped")?,
                    "running" | "dispatching" | "stop_unconfirmed" => {
                        self.state(&run.id, "stopping")?
                    }
                    "unknown" => {
                        // Keep the outcome unresolved while durably withdrawing
                        // any remaining grant before stopping our owned Job.
                        storage(
                            self.db
                                .execute("UPDATE runs SET expires_at=NULL WHERE id=?", [&run.id]),
                        )?;
                    }
                    "stopped" | "completed" | "rejected" => {}
                    _ => return Err("STATE"),
                }
                Ok(self.run(&run.id)?.json())
            }
            "result" => {
                let run = self.run(id(input, "run_id")?)?;
                if run.epoch != integer(input, "epoch")?
                    || run.attempt != integer(input, "attempt")?
                    || run.revision != Some(integer(input, "revision")?)
                    || run.source_hash.as_deref() != Some(string(input, "source_hash")?)
                {
                    return Err("STALE_RESULT");
                }
                if run.state != "running" {
                    return Err("STATE");
                }
                // Injection cannot bypass observable process completion.
                let observed = self.poll(&run.id)?;
                if observed["state"] != "completed" {
                    return Err("STATE");
                }
                Ok(observed)
            }
            "advance" => {
                let seconds = integer(input, "seconds")?;
                if !(0..=86400).contains(&seconds) {
                    return Err("INVALID");
                }
                let now = self.metadata()?.1.checked_add(seconds).ok_or("INVALID")?;
                storage(self.db.execute("UPDATE metadata SET now=?", [now]))?;
                Ok(json!({"now":now}))
            }
            "fault" => {
                let kind = string(input, "kind")?;
                if !["none", "intent_full", "result_full", "busy"].contains(&kind) {
                    return Err("INVALID");
                }
                storage(self.db.execute("UPDATE metadata SET fault=?", [kind]))?;
                Ok(json!({"kind":kind}))
            }
            "revise" => {
                let task_id = id(input, "task_id")?;
                self.task(task_id)?;
                let source = string(input, "source")?;
                storage(self.db.execute(
                    "UPDATE tasks SET source=?,source_hash=?,revision=revision+1 WHERE id=?",
                    params![source, hash(source), task_id],
                ))?;
                storage(self.db.execute(
                    "UPDATE runs SET state='waiting',revision=NULL,source_hash=NULL,expires_at=NULL
                    WHERE task_id=? AND state IN ('approved','queued')",
                    [task_id],
                ))?;
                Ok(self.task(task_id)?)
            }
            "snapshot" => {
                self.backup_path(string(input, "path")?)?;
                Ok(json!({}))
            }
            _ => Err("INVALID"),
        }
    }

    fn launch(&mut self, run_id: &str, mode: &str) -> Outcome<Value> {
        let run = self.run(run_id)?;
        let path = PathBuf::from(run.events_path.as_ref().ok_or("STORAGE")?);
        match Job::spawn(
            &self.options.python,
            &self.options.helper,
            &path,
            mode,
            &run.id,
            run.epoch,
            run.attempt,
        ) {
            Ok(job) => {
                let pid = job.pid;
                self.jobs.insert(run.id.clone(), job);
                if storage(self.db.execute(
                    "UPDATE runs SET state='running',pid=? WHERE id=?",
                    params![pid, run.id],
                ))
                .is_err()
                {
                    if let Some(job) = self.jobs.remove(&run.id) {
                        job.stop();
                    }
                    let _ = self.state(&run.id, "unknown");
                    return Err("STORAGE");
                }
            }
            Err(_) => {
                self.state(&run.id, "unknown")?;
                return Err("PROCESS");
            }
        }
        Ok(self.run(run_id)?.json())
    }

    fn poll(&mut self, run_id: &str) -> Outcome<Value> {
        let run = self.run(run_id)?;
        if run.state != "running" {
            return Ok(run.json());
        }
        let Some(job) = self.jobs.get(run_id) else {
            self.state(run_id, "unknown")?;
            return Ok(self.run(run_id)?.json());
        };
        let (exited, active) = match (job.exited(), job.active()) {
            (Ok(exited), Ok(active)) => (exited, active),
            _ => {
                self.state(run_id, "unknown")?;
                return Ok(self.run(run_id)?.json());
            }
        };
        if let Some(code) = exited {
            if active > 0 {
                // Job accounting can briefly include a signaled parent. Keep
                // running during that lag; a count alone does not establish a
                // live descendant. Completion still requires active == 0.
                let text = fs::read_to_string(run.events_path.as_ref().ok_or("STORAGE")?)
                    .unwrap_or_default();
                let mut live_descendant = false;
                for event in text
                    .lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                {
                    if event["kind"] == "descendant"
                        && event["run_id"] == run.id
                        && event["epoch"] == run.epoch
                        && event["attempt"] == run.attempt
                    {
                        let Some(pid) = event["child_pid"]
                            .as_u64()
                            .and_then(|pid| u32::try_from(pid).ok())
                        else {
                            self.state(run_id, "unknown")?;
                            return Ok(self.run(run_id)?.json());
                        };
                        match job.live_descendant(pid) {
                            Ok(true) => live_descendant = true,
                            Ok(false) => {}
                            Err(_) => {
                                self.state(run_id, "unknown")?;
                                return Ok(self.run(run_id)?.json());
                            }
                        }
                    }
                }
                if live_descendant {
                    self.state(run_id, "stop_unconfirmed")?;
                }
            } else {
                let text = fs::read_to_string(run.events_path.as_ref().ok_or("STORAGE")?)
                    .unwrap_or_default();
                let complete = text
                    .lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .any(|event| {
                        event["kind"] == "completed"
                            && event["run_id"] == run.id
                            && event["epoch"] == run.epoch
                            && event["attempt"] == run.attempt
                    });
                let task = self.task(&run.task_id)?;
                let bound = task["revision"].as_i64() == run.revision
                    && task["source_hash"].as_str() == run.source_hash.as_deref();
                let state = if code == 0 && complete && bound && self.metadata()?.3 != "result_full"
                {
                    "completed"
                } else {
                    "unknown"
                };
                self.state(run_id, state)?;
                self.jobs.remove(run_id);
            }
        }
        Ok(self.run(run_id)?.json())
    }

    fn terminate(&mut self, run_id: &str) -> Outcome<Value> {
        let original_state = self.run(run_id)?.state;
        if original_state == "unknown" {
            // Numeric PID is never enough after restart. Only a Job retained
            // from this controller's own launch may be terminated. Even known
            // process cessation cannot reconcile an unknown external outcome.
            let stopped = self.jobs.get(run_id).is_some_and(Job::stop);
            if stopped {
                self.jobs.remove(run_id);
            }
            let mut response = self.run(run_id)?.json();
            response["process_stop_confirmed"] = json!(stopped);
            return Ok(response);
        }
        if original_state == "stopping" {
            let stopped = self.jobs.get(run_id).is_some_and(Job::stop);
            self.state(
                run_id,
                if stopped {
                    "stopped"
                } else {
                    "stop_unconfirmed"
                },
            )?;
            if stopped {
                self.jobs.remove(run_id);
            }
        }
        Ok(self.run(run_id)?.json())
    }

    fn backup_path(&self, requested: &str) -> Outcome<PathBuf> {
        let path = PathBuf::from(requested);
        if path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err("INVALID");
        }
        let parent =
            fs::canonicalize(self.options.db.parent().ok_or("CONFIG")?).map_err(|_| "INVALID")?;
        let candidate = if path.is_absolute() {
            path
        } else {
            parent.join(path)
        };
        if candidate.exists()
            || fs::canonicalize(candidate.parent().ok_or("INVALID")?).map_err(|_| "INVALID")?
                != parent
        {
            return Err("INVALID");
        }
        Ok(candidate)
    }
    fn backup(&self, requested: &str) -> Outcome<Value> {
        let path = self.backup_path(requested)?;
        // Atomic create-new reserves path; connection opens only our new file.
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| "INVALID")?;
        let mut destination = storage(Connection::open(&path))?;
        let backup = storage(rusqlite::backup::Backup::new(&self.db, &mut destination))?;
        storage(backup.run_to_completion(100, Duration::from_millis(1), None))?;
        Ok(json!({"path":path.to_string_lossy()}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn core(directory: &std::path::Path, test_mode: bool, restored: bool) -> Core {
        let fixture = directory.join("fixture.json");
        if !fixture.exists() {
            fs::write(&fixture,json!({"version":1,"now":2000000000,"tasks":[
                {"id":"task-0","title":"Synthetic","source":"synthetic","source_hash":hash("synthetic"),"revision":1},
                {"id":"task-1","title":"Synthetic","source":"synthetic","source_hash":hash("synthetic"),"revision":1}]}).to_string()).unwrap();
        }
        Core::open(Options {
            db: directory.join("state.db"),
            fixture,
            helper: fixture_placeholder(directory),
            python: fixture_placeholder(directory),
            test_mode,
            restored,
        })
        .unwrap()
    }
    fn fixture_placeholder(directory: &std::path::Path) -> PathBuf {
        directory.join("fixture.json")
    }
    fn start(core: &mut Core) -> Value {
        core.call(json!({"op":"start","task_id":"task-0","request_id":"run-0"}))
            .unwrap()
    }
    fn approve(core: &mut Core) {
        core.call(json!({"op":"approve","run_id":"run-0","revision":1,
        "source_hash":hash("synthetic"),"expires_at":2000000100}))
            .unwrap();
    }
    #[test]
    fn idempotency_and_single_active() {
        let d = tempfile::tempdir().unwrap();
        let mut c = core(d.path(), true, false);
        assert_eq!(start(&mut c), start(&mut c));
        assert_eq!(
            c.call(json!({"op":"start","task_id":"task-0","request_id":"other"})),
            Err("ACTIVE_RUN")
        );
        assert_eq!(
            c.call(json!({"op":"start","task_id":"task-1","request_id":"run-0"})),
            Err("REQUEST_CONFLICT")
        );
    }
    #[test]
    fn revoke_expiry_revision_and_fault_no_dispatch() {
        let d = tempfile::tempdir().unwrap();
        let mut c = core(d.path(), true, false);
        start(&mut c);
        approve(&mut c);
        c.call(json!({"op":"enqueue","run_id":"run-0"})).unwrap();
        c.call(json!({"op":"revoke","run_id":"run-0"})).unwrap();
        assert_eq!(
            c.call(json!({"op":"dispatch","run_id":"run-0","mode":"success"})),
            Err("STATE")
        );
        approve(&mut c);
        c.call(json!({"op":"enqueue","run_id":"run-0"})).unwrap();
        c.call(json!({"op":"advance","seconds":101})).unwrap();
        assert_eq!(
            c.call(json!({"op":"dispatch","run_id":"run-0","mode":"success"})),
            Err("STALE_APPROVAL")
        );
        assert!(!d.path().join("run-0.events.jsonl").exists());
    }
    #[test]
    fn storage_fault_prevents_launch() {
        let d = tempfile::tempdir().unwrap();
        let mut c = core(d.path(), true, false);
        start(&mut c);
        approve(&mut c);
        c.call(json!({"op":"enqueue","run_id":"run-0"})).unwrap();
        c.call(json!({"op":"fault","kind":"intent_full"})).unwrap();
        assert_eq!(
            c.call(json!({"op":"dispatch","run_id":"run-0","mode":"success"})),
            Err("STORAGE")
        );
        assert_eq!(c.run("run-0").unwrap().state, "queued");
        assert!(!d.path().join("run-0.events.jsonl").exists());
    }
    #[test]
    fn restart_invalidates_grants_and_restore_holds() {
        let d = tempfile::tempdir().unwrap();
        let mut c = core(d.path(), true, false);
        start(&mut c);
        approve(&mut c);
        c.call(json!({"op":"enqueue","run_id":"run-0"})).unwrap();
        drop(c);
        let mut c = core(d.path(), true, false);
        assert_eq!(c.run("run-0").unwrap().state, "waiting");
        assert_eq!(
            c.call(json!({"op":"dispatch","run_id":"run-0","mode":"success"})),
            Err("STATE")
        );
        drop(c);
        let mut c = core(d.path(), true, true);
        assert_eq!(
            c.call(json!({"op":"start","task_id":"task-1","request_id":"next"})),
            Err("RESTORE_HOLD")
        );
        assert!(c.call(json!({"op":"detail","task_id":"task-0"})).is_ok());
    }
    #[test]
    fn malformed_input_test_controls_and_snapshot_path() {
        let d = tempfile::tempdir().unwrap();
        let mut c = core(d.path(), false, false);
        assert_eq!(c.call(json!({"op":"advance","seconds":1})), Err("INVALID"));
        assert_eq!(
            c.call(json!({"op":"list","offset":0,"limit":50,"surprise":true})),
            Err("INVALID")
        );
        assert_eq!(
            c.call(json!({"op":"list","offset":true,"limit":50})),
            Err("INVALID")
        );
        assert_eq!(
            c.call(json!({"op":"detail","task_id":"../x"})),
            Err("INVALID")
        );
        drop(c);
        let mut c = core(d.path(), true, false);
        assert_eq!(
            c.call(json!({"op":"snapshot","path":"../outside.db"})),
            Err("INVALID")
        );
        c.call(json!({"op":"snapshot","path":"snapshot.db"}))
            .unwrap();
        assert_eq!(
            c.call(json!({"op":"snapshot","path":"snapshot.db"})),
            Err("INVALID")
        );
    }

    #[test]
    fn second_owner_cannot_change_epoch() {
        let d = tempfile::tempdir().unwrap();
        let c = core(d.path(), true, false);
        let before = c.metadata().unwrap().0;
        let fixture = d.path().join("fixture.json");
        let second = Core::open(Options {
            db: d.path().join("state.db"),
            fixture: fixture.clone(),
            helper: fixture.clone(),
            python: fixture,
            test_mode: true,
            restored: false,
        });
        assert!(matches!(second, Err("DB_LOCKED")));
        assert_eq!(c.metadata().unwrap().0, before);
    }

    #[test]
    fn source_change_invalidates_queued_and_delayed_result() {
        let d = tempfile::tempdir().unwrap();
        let mut c = core(d.path(), true, false);
        let original = start(&mut c);
        approve(&mut c);
        c.call(json!({"op":"enqueue","run_id":"run-0"})).unwrap();
        c.call(json!({"op":"revise","task_id":"task-0","source":"new synthetic source"}))
            .unwrap();
        assert_eq!(c.run("run-0").unwrap().state, "waiting");
        assert_eq!(
            c.call(json!({"op":"dispatch","run_id":"run-0","mode":"success"})),
            Err("STATE")
        );
        assert_eq!(
            c.call(
                json!({"op":"result","run_id":"run-0","epoch":original["epoch"],
            "attempt":1,"revision":1,"source_hash":hash("synthetic")})
            ),
            Err("STALE_RESULT")
        );
        assert!(!d.path().join("run-0.events.jsonl").exists());
    }

    #[test]
    fn hardlink_alias_rejected_before_epoch_changes() {
        let d = tempfile::tempdir().unwrap();
        let c = core(d.path(), true, false);
        let before = c.metadata().unwrap().0;
        let original = d.path().join("state.db");
        let alias = d.path().join("alias.db");
        fs::hard_link(original, &alias).unwrap();
        let fixture = d.path().join("fixture.json");
        let second = Core::open(Options {
            db: alias,
            fixture: fixture.clone(),
            helper: fixture.clone(),
            python: fixture,
            test_mode: true,
            restored: false,
        });
        assert!(matches!(second, Err("DB_ALIAS")));
        assert_eq!(c.metadata().unwrap().0, before);
    }

    #[test]
    fn durable_epoch_change_fences_existing_owner() {
        let d = tempfile::tempdir().unwrap();
        let mut c = core(d.path(), true, false);
        start(&mut c);
        c.db.execute("UPDATE metadata SET epoch=epoch+1", [])
            .unwrap();
        assert_eq!(
            c.call(json!({"op":"approve","run_id":"run-0","revision":1,
            "source_hash":hash("synthetic"),"expires_at":2000000100})),
            Err("OWNER_CHANGED")
        );
        assert_eq!(
            c.call(json!({"op":"status","run_id":"run-0"})),
            Err("OWNER_CHANGED")
        );
        assert!(c.call(json!({"op":"detail","task_id":"task-0"})).is_ok());
        assert_eq!(c.run("run-0").unwrap().state, "waiting");
    }

    #[test]
    fn restore_hold_survives_normal_restart() {
        let d = tempfile::tempdir().unwrap();
        let c = core(d.path(), true, false);
        let before = c.metadata().unwrap().0;
        drop(c);
        let c = core(d.path(), true, true);
        assert_eq!(c.metadata().unwrap().0, before + 1);
        assert!(!c.metadata().unwrap().2);
        drop(c);
        let mut c = core(d.path(), true, false);
        assert!(!c.metadata().unwrap().2);
        assert_eq!(
            c.call(json!({"op":"start","task_id":"task-1","request_id":"new-run"})),
            Err("RESTORE_HOLD")
        );
    }

    #[test]
    fn startup_failure_rolls_back_epoch_and_restore_hold_together() {
        let d = tempfile::tempdir().unwrap();
        let mut c = core(d.path(), true, false);
        start(&mut c);
        let before = c.metadata().unwrap().0;
        c.db.execute_batch(
            "CREATE TRIGGER fail_startup BEFORE UPDATE ON runs
            BEGIN SELECT RAISE(ABORT,'synthetic startup transaction failure'); END;",
        )
        .unwrap();
        drop(c);
        let fixture = d.path().join("fixture.json");
        let failed = Core::open(Options {
            db: d.path().join("state.db"),
            fixture: fixture.clone(),
            helper: fixture.clone(),
            python: fixture,
            test_mode: true,
            restored: true,
        });
        assert!(matches!(failed, Err("STORAGE")));
        let observed = Connection::open(d.path().join("state.db")).unwrap();
        let (epoch, enabled): (i64, bool) = observed
            .query_row("SELECT epoch,execution_enabled FROM metadata", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(epoch, before);
        assert!(enabled);
    }
}
