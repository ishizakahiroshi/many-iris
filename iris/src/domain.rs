//! Synthetic-only plan domain. SQLite owns the state, request receipts and audit.
use crate::cli_binding::{FIXTURE_HOST, OwnedProfile, sha256_hex};
use crate::real_project::{CaseContent, RealProject};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone)]
pub struct DomainError {
    pub code: String,
    pub detail: String,
}
impl std::fmt::Display for DomainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}
impl std::error::Error for DomainError {}
fn err(code: &str) -> DomainError {
    DomainError {
        code: code.into(),
        detail: match code {
            "OWNER_BUSY" => "Another Iris owner holds this database.",
            "STORAGE" => "State could not be safely read or persisted.",
            "SCHEMA" => "The database schema is unsupported.",
            "RESTORE_HOLD" => "Restored state allows inspection only.",
            "HUMAN_DECISION_REQUIRED" => "A matching human decision is required.",
            "OUTCOME_UNRESOLVED" => "The previous execution outcome is unresolved.",
            "INVALID_INSTRUCTION" => {
                "The instruction must be non-blank UTF-8 text of 1 to 65536 bytes without NUL."
            }
            "INVALID_REAL_TASKS" => {
                "The real-provider tasks must be 1 to 3 entries with distinct plan, task and approval ids."
            }
            "FIXTURE_MISMATCH" => "The stored plans do not belong to the configured real-provider tasks.",
            _ => "The request did not satisfy the domain contract.",
        }
        .into(),
    }
}
fn sql<T>(r: rusqlite::Result<T>) -> Result<T, DomainError> {
    r.map_err(|_| err("STORAGE"))
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, DomainError> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| err("INVALID"))
}
fn integer(v: &Value, key: &str) -> Result<u64, DomainError> {
    v.get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or_else(|| err("INVALID"))
}
fn id<'a>(v: &'a Value, key: &str) -> Result<&'a str, DomainError> {
    let s = text(v, key)?;
    if s.is_empty()
        || s.len() > 80
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Err(err("INVALID"))
    } else {
        Ok(s)
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn is(v: &Value, key: &str, want: &str) -> bool {
    v.get(key).and_then(Value::as_str) == Some(want)
}
fn fields(v: &Value, required: &[&str], optional: &[&str]) -> Result<(), DomainError> {
    let obj = v.as_object().ok_or_else(|| err("INVALID"))?;
    if required.iter().any(|k| !obj.contains_key(*k))
        || obj
            .keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        return Err(err("INVALID"));
    }
    Ok(())
}
fn plan_idx(doc: &Value, key: &str, value: &str) -> Result<usize, DomainError> {
    doc["plans"]
        .as_array()
        .ok_or_else(|| err("STORAGE"))?
        .iter()
        .position(|p| p[key] == value)
        .ok_or_else(|| err("NOT_FOUND"))
}
fn task_idx(doc: &Value, attempt: &str) -> Result<(usize, usize), DomainError> {
    for (p, plan) in doc["plans"]
        .as_array()
        .ok_or_else(|| err("STORAGE"))?
        .iter()
        .enumerate()
    {
        if let Some(t) = plan["tasks"]
            .as_array()
            .ok_or_else(|| err("STORAGE"))?
            .iter()
            .position(|t| t["attempt_id"] == attempt)
        {
            return Ok((p, t));
        }
    }
    Err(err("NOT_FOUND"))
}
fn first_pending(plan: &Value) -> Option<usize> {
    plan["tasks"]
        .as_array()?
        .iter()
        .position(|t| !is(t, "status", "completed"))
}
fn grant(plan: &Value, at: u64) -> Result<(), DomainError> {
    if !is(&plan["approval"], "status", "granted")
        || integer(&plan["approval"], "expires_at")? <= at
    {
        return Err(err("STALE_APPROVAL"));
    }
    scope_matches(plan)
}
fn scope_matches(plan: &Value) -> Result<(), DomainError> {
    if plan["plan_hash"] != hash(text(plan, "source_text")?)
        || plan["approval"]["scope_hash"] != hash(&plan["approval"]["scope"].to_string())
        || plan["approval"]["scope"]["plan_id"] != plan["plan_id"]
        || plan["approval"]["scope"]["plan_revision"] != plan["plan_revision"]
        || plan["approval"]["scope"]["plan_hash"] != plan["plan_hash"]
        || plan["approval"]["scope"]["approval_revision"] != plan["approval"]["revision"]
        || plan["approval"]["scope"]["task_bindings"] != task_bindings(&plan["tasks"])
        || plan["approval"]["scope"]["external_effects"] != false
    {
        return Err(err("STALE_APPROVAL"));
    }
    Ok(())
}
fn task_bindings(tasks: &Value) -> Value {
    json!(tasks.as_array().map(|tasks|tasks.iter().map(|task|json!({"task_id":task["task_id"],"instruction_revision":task["instruction_revision"],"instruction_hash":task["instruction_hash"],"requires_decision":task["requires_decision"]})).collect::<Vec<_>>()).unwrap_or_default())
}
fn instruction(task: &Value) -> Result<(), DomainError> {
    if task["instruction_hash"] != hash(text(task, "instruction")?) {
        Err(err("STALE_BINDING"))
    } else {
        Ok(())
    }
}
fn decision_ready(plan: &mut Value, t: usize) {
    if !plan["tasks"][t]["requires_decision"]
        .as_bool()
        .unwrap_or(false)
    {
        return;
    }
    if is(&plan["decision"], "status", "approved")
        && plan["decision"]["task_id"] == plan["tasks"][t]["task_id"]
    {
        return;
    }
    let task = &plan["tasks"][t];
    let revision = task["fence"].as_u64().unwrap_or(0) + 1;
    plan["decision"] = json!({"decision_id":format!("decision-{}-{}",task["task_id"].as_str().unwrap_or("task"),revision),"revision":revision,"content_hash":task["instruction_hash"],"task_id":task["task_id"],"status":"pending"});
    plan["tasks"][t]["status"] = json!("waiting_decision");
    plan["plan_state"] = json!("waiting_decision");
}

/// The most bytes a real-provider instruction file may hold. It matches the
/// artifact limit the CLI grant for that file carries, and the CLI refuses a
/// larger file, so Iris refuses it first.
pub const REAL_INSTRUCTION_LIMIT: usize = 65536;
/// The bounded acceptance sends at most three real tasks.
pub const REAL_TASK_LIMIT: usize = 3;
/// Top-level key that exists only in a store created for the real-bounded
/// profile's own tasks. The default fixture never carries it.
const REAL_MARKER: &str = "real_bounded_fixture";

fn ident(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn lower_hex_64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// One real-send task. Its plan, task and approval ids are what the CLI grant
/// scope (principal, workspace, approval, plan, task) is keyed by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RealTask {
    pub plan_id: String,
    pub task_id: String,
    pub approval_id: String,
}

/// The tasks must be 1 to 3 and must not overlap in any part of the grant scope:
/// no plan, task or approval id may repeat. Plan and task ids also share one
/// namespace in the stored document, so a plan id may not equal any task id.
pub(crate) fn real_tasks_valid(tasks: &[RealTask]) -> bool {
    if tasks.is_empty() || tasks.len() > REAL_TASK_LIMIT {
        return false;
    }
    let mut ids = BTreeSet::new();
    let mut approvals = BTreeSet::new();
    tasks.iter().all(|t| {
        ident(&t.plan_id)
            && ident(&t.task_id)
            && ident(&t.approval_id)
            && ids.insert(t.plan_id.as_str())
            && ids.insert(t.task_id.as_str())
            && approvals.insert(t.approval_id.as_str())
    })
}

/// The same instruction rule the CLI applies when it launches: UTF-8, not blank,
/// no NUL, and at most the artifact limit. Returns the text untouched.
fn real_instruction(bytes: &[u8]) -> Option<&str> {
    if bytes.is_empty() || bytes.len() > REAL_INSTRUCTION_LIMIT || bytes.contains(&0) {
        return None;
    }
    std::str::from_utf8(bytes)
        .ok()
        .filter(|text| !text.trim().is_empty())
}

/// Validated settings for the real-bounded profile's own store: the exact
/// instruction text the CLI will read, and one plan with one task per entry.
/// Nothing is normalized, so `instruction_hash()` is the SHA-256 of the file's
/// bytes. Built only from explicit configuration; the default store never uses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealFixture {
    instruction: String,
    tasks: Vec<RealTask>,
}
impl RealFixture {
    pub fn new(instruction: &[u8], tasks: Vec<RealTask>) -> Result<Self, DomainError> {
        let text = real_instruction(instruction).ok_or_else(|| err("INVALID_INSTRUCTION"))?;
        if !real_tasks_valid(&tasks) {
            return Err(err("INVALID_REAL_TASKS"));
        }
        Ok(Self {
            instruction: text.to_owned(),
            tasks,
        })
    }
    /// SHA-256 of the instruction bytes, as the binding carries it.
    pub fn instruction_hash(&self) -> String {
        sha256_hex(self.instruction.as_bytes())
    }
    pub fn tasks(&self) -> &[RealTask] {
        &self.tasks
    }
}

/// What a stored real-bounded document says it was built from.
struct RealMarker {
    instruction_hash: String,
    tasks: Vec<RealTask>,
}
fn real_marker(doc: &Value) -> Result<Option<RealMarker>, DomainError> {
    let Some(raw) = doc.get(REAL_MARKER) else {
        return Ok(None);
    };
    let invalid = || err("STORAGE");
    let object = raw.as_object().ok_or_else(invalid)?;
    if object.len() != 2 {
        return Err(invalid());
    }
    let instruction_hash = raw["instruction_hash"]
        .as_str()
        .filter(|h| lower_hex_64(h))
        .ok_or_else(invalid)?
        .to_owned();
    let tasks: Vec<RealTask> =
        serde_json::from_value(raw["tasks"].clone()).map_err(|_| invalid())?;
    if !real_tasks_valid(&tasks) {
        return Err(invalid());
    }
    Ok(Some(RealMarker {
        instruction_hash,
        tasks,
    }))
}

/// Top-level key that exists only in a store created for the real-project
/// profile's cases. It holds ids and hashes, never any text.
pub const REAL_PROJECT_MARKER: &str = "real_project_cases";

/// What a stored real-project document says each case was built from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectMarkerCase {
    plan_id: String,
    task_id: String,
    approval_id: String,
    source_sha256: String,
    instruction_sha256: String,
}
fn project_marker_of(project: &RealProject) -> Vec<ProjectMarkerCase> {
    project
        .cases()
        .iter()
        .map(|c| ProjectMarkerCase {
            plan_id: c.binding.plan_id.clone(),
            task_id: c.binding.task_id.clone(),
            approval_id: c.binding.approval_id.clone(),
            source_sha256: c.source_sha256.clone(),
            instruction_sha256: c.instruction_sha256.clone(),
        })
        .collect()
}
fn real_project_marker(doc: &Value) -> Result<Option<Vec<ProjectMarkerCase>>, DomainError> {
    let Some(raw) = doc.get(REAL_PROJECT_MARKER) else {
        return Ok(None);
    };
    let invalid = || err("STORAGE");
    if raw.as_object().is_none_or(|o| o.len() != 1) {
        return Err(invalid());
    }
    let cases: Vec<ProjectMarkerCase> =
        serde_json::from_value(raw["cases"].clone()).map_err(|_| invalid())?;
    let tasks: Vec<RealTask> = cases
        .iter()
        .map(|c| RealTask {
            plan_id: c.plan_id.clone(),
            task_id: c.task_id.clone(),
            approval_id: c.approval_id.clone(),
        })
        .collect();
    if !real_tasks_valid(&tasks)
        || cases
            .iter()
            .any(|c| !lower_hex_64(&c.source_sha256) || !lower_hex_64(&c.instruction_sha256))
    {
        return Err(invalid());
    }
    Ok(Some(cases))
}

/// The approval scope of one real-project case. It depends only on the ids and
/// the two hashes, so a configuration's `scope_hash` can be checked (and
/// `--real-cases-preview` can report it) without a store.
fn real_project_scope(
    plan_id: &str,
    task_id: &str,
    source_sha256: &str,
    instruction_sha256: &str,
) -> Value {
    let bindings = json!([{"task_id":task_id,"instruction_revision":1,"instruction_hash":instruction_sha256,"requires_decision":false}]);
    json!({"plan_id":plan_id,"plan_revision":1,"plan_hash":source_sha256,"approval_revision":1,
        "task_bindings":bindings,"task_ids":[task_id],"executor_ids":["synthetic-executor","synthetic-executor-backup"],
        "execution_host_id":FIXTURE_HOST,"external_effects":false})
}
/// SHA-256 of a real-project case's approval scope (the binding's `scope_hash`).
pub fn real_project_scope_hash(
    plan_id: &str,
    task_id: &str,
    source_sha256: &str,
    instruction_sha256: &str,
) -> String {
    hash(&real_project_scope(plan_id, task_id, source_sha256, instruction_sha256).to_string())
}

/// The text a real-project case may hold: the same rule as a real instruction.
fn real_case_text(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| real_instruction(text.as_bytes()).is_some())
}

/// Which store a caller wants: the synthetic fixture, the real-bounded tasks or
/// the real-project cases. A store is only ever opened as the kind it was made.
#[derive(Clone, Copy)]
enum Want<'a> {
    Synthetic,
    Bounded(&'a RealFixture),
    Project(&'a RealProject),
}

/// SQL schema 1: a singleton domain document, immutable successful request receipts,
/// and append-only audit rows. They are changed in the same SQLite transaction.
pub struct Store {
    db: Connection,
    _owner: Connection,
    state: Value,
    _path: PathBuf,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self, DomainError> {
        Self::open_inner(path, false, Want::Synthetic)
    }
    /// A store for the real-project cases. A new store reads each case's two
    /// files once, here, and keeps their text; an existing one is only compared
    /// with the configured ids and hashes (no file is read), and any other kind
    /// of store is FIXTURE_MISMATCH.
    pub fn open_real_project(path: &Path, project: &RealProject) -> Result<Self, DomainError> {
        Self::open_inner(path, false, Want::Project(project))
    }
    pub fn open_restored_real_project(
        path: &Path,
        project: &RealProject,
    ) -> Result<Self, DomainError> {
        if !path.is_file() {
            return Err(err("NOT_FOUND"));
        }
        Self::open_inner(path, true, Want::Project(project))
    }
    pub fn open_restored(path: &Path) -> Result<Self, DomainError> {
        Self::open_restored_with(path, None)
    }
    /// With `None` this is exactly `open`. With the real-bounded profile's tasks
    /// a new store holds those tasks instead of the synthetic fixture's plans,
    /// and an existing store must have been created from the very same tasks and
    /// instruction (the default store and a real-bounded one never open as each
    /// other).
    pub fn open_with(path: &Path, real: Option<&RealFixture>) -> Result<Self, DomainError> {
        Self::open_inner(path, false, real.map_or(Want::Synthetic, Want::Bounded))
    }
    pub fn open_restored_with(
        path: &Path,
        real: Option<&RealFixture>,
    ) -> Result<Self, DomainError> {
        if !path.is_file() {
            return Err(err("NOT_FOUND"));
        }
        Self::open_inner(path, true, real.map_or(Want::Synthetic, Want::Bounded))
    }
    fn open_inner(path: &Path, restored: bool, want: Want<'_>) -> Result<Self, DomainError> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let parent = parent.canonicalize().map_err(|_| err("STORAGE"))?;
        let supplied = parent.join(path.file_name().ok_or_else(|| err("INVALID"))?);
        let existed = supplied.exists();
        let path = if existed {
            supplied.canonicalize().map_err(|_| err("STORAGE"))?
        } else {
            supplied
        };
        if path.is_dir() {
            return Err(err("INVALID"));
        }
        if existed {
            require_single_link(&path)?;
        }
        // A new store's document is built before any database file exists, so
        // a case file that cannot be used leaves nothing behind.
        let initial = if existed {
            None
        } else {
            Some(match want {
                Want::Synthetic => fixture(),
                Want::Bounded(real) => real_fixture(real),
                Want::Project(project) => {
                    let contents = project.read_contents().map_err(|failure| DomainError {
                        code: failure.code.into(),
                        detail: format!(
                            "Real case {} could not be used; its content is not shown.",
                            failure.case
                        ),
                    })?;
                    real_project_fixture(project, &contents)
                }
            })
        };
        let mut lock_name = path.as_os_str().to_os_string();
        lock_name.push(".owner.sqlite3");
        let owner = sql(Connection::open(PathBuf::from(lock_name)))?;
        sql(owner.busy_timeout(Duration::ZERO))?;
        owner
            .execute_batch("BEGIN EXCLUSIVE")
            .map_err(|_| err("OWNER_BUSY"))?;
        let mut db = sql(Connection::open(&path))?;
        sql(db.busy_timeout(Duration::from_millis(1000)))?;
        let check: String = sql(db.query_row("PRAGMA quick_check", [], |r| r.get(0)))?;
        if check != "ok" {
            return Err(err("STORAGE"));
        }
        let version: i64 = sql(db.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
        if (existed && version != 1) || (!existed && version != 0) {
            return Err(err("SCHEMA"));
        }
        sql(db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        ))?;
        if let Some(initial) = initial {
            let tx = sql(db.transaction())?;
            sql(tx.execute_batch("CREATE TABLE domain_state(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL); CREATE TABLE requests(principal TEXT NOT NULL,workspace TEXT NOT NULL,request_id TEXT NOT NULL,operation TEXT NOT NULL,payload TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(principal,workspace,request_id)); CREATE TABLE audit(sequence INTEGER PRIMARY KEY, operation TEXT NOT NULL, receipt TEXT NOT NULL); PRAGMA user_version=1;"))?;
            sql(tx.execute(
                "INSERT INTO domain_state VALUES(1,?)",
                [initial.to_string()],
            ))?;
            sql(tx.commit())?;
        }
        let raw: String = sql(db.query_row(
            "SELECT document FROM domain_state WHERE id=1",
            [],
            |r| r.get(0),
        ))?;
        let mut state: Value = serde_json::from_str(&raw).map_err(|_| err("STORAGE"))?;
        validate_document(&state)?;
        let bounded = real_marker(&state)?;
        let project = real_project_marker(&state)?;
        let same_kind = match want {
            Want::Synthetic => bounded.is_none() && project.is_none(),
            Want::Bounded(want) => {
                project.is_none()
                    && bounded.is_some_and(|have| {
                        have.tasks == want.tasks && have.instruction_hash == want.instruction_hash()
                    })
            }
            Want::Project(want) => {
                bounded.is_none() && project.is_some_and(|have| have == project_marker_of(want))
            }
        };
        if !same_kind {
            return Err(err("FIXTURE_MISMATCH"));
        }
        let audit_revision: i64 = sql(db.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM audit",
            [],
            |r| r.get(0),
        ))?;
        let audit_count: i64 = sql(db.query_row("SELECT COUNT(*) FROM audit", [], |r| r.get(0)))?;
        if audit_revision != integer(&state, "revision")? as i64 || audit_count != audit_revision {
            return Err(err("STORAGE"));
        }
        let mut changed = false;
        for plan in state["plans"]
            .as_array_mut()
            .ok_or_else(|| err("STORAGE"))?
        {
            for task in plan["tasks"].as_array_mut().ok_or_else(|| err("STORAGE"))? {
                if matches!(
                    task["execution_state"].as_str(),
                    Some(
                        "dispatch_intent"
                            | "accepted"
                            | "running"
                            | "stop_requested"
                            | "stop_unconfirmed"
                    )
                ) {
                    task["execution_state"] = json!("unknown");
                    task["outcome"] = json!("unknown");
                    task["status"] = json!("unknown");
                    changed = true;
                }
            }
            if plan["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| is(t, "execution_state", "unknown"))
            {
                plan["plan_state"] = json!("blocked");
                plan["blocked_reason"] = json!("OUTCOME_UNRESOLVED");
            }
            if restored {
                plan["approval"]["status"] = json!("restore_hold");
            }
        }
        if restored {
            state["restore_hold"] = json!(true);
            changed = true;
        }
        if changed {
            let rev = integer(&state, "revision")? + 1;
            state["revision"] = json!(rev);
            state["observed_at"] = json!(now());
            let receipt = json!({"receipt_id":format!("receipt-{rev}"),"operation":"recovery","revision":rev,"restore_hold":state["restore_hold"]});
            state["history"]
                .as_array_mut()
                .ok_or_else(|| err("STORAGE"))?
                .push(receipt.clone());
            let tx = sql(db.transaction())?;
            sql(tx.execute(
                "UPDATE domain_state SET document=? WHERE id=1",
                [state.to_string()],
            ))?;
            sql(tx.execute(
                "INSERT INTO audit VALUES(?,?,?)",
                params![
                    i64::try_from(rev).map_err(|_| err("STORAGE"))?,
                    "recovery",
                    receipt.to_string()
                ],
            ))?;
            sql(tx.commit())?;
        }
        Ok(Self {
            db,
            _owner: owner,
            state,
            _path: path,
        })
    }
    pub fn snapshot(&self) -> Result<Value, DomainError> {
        Ok(project_snapshot(&self.state))
    }
    /// True for a store made for the real-project cases.
    pub fn is_real_project(&self) -> bool {
        self.state.get(REAL_PROJECT_MARKER).is_some()
    }
    /// The MCP surface may not start or continue a real-project case: only the
    /// user, in the local UI, starts one. Stop, pause and inspection stay open.
    pub fn mcp_operation_allowed(&self, operation: &str) -> bool {
        !(self.is_real_project()
            && matches!(operation, "start_plan" | "continue_plan" | "handoff_task"))
    }
    /// For a real-project case whose plan the user has started and whose task
    /// has not been dispatched, the stored markdown text (to check the
    /// instruction file against before an intent is stored). `None` when the
    /// case is not ready to send, so nothing is connected or sent for it.
    pub fn real_case_source(
        &self,
        binding: &crate::cli_binding::CliBinding,
    ) -> Result<Option<String>, DomainError> {
        if !self.is_real_project() {
            return Err(err("UNSUPPORTED_EXECUTOR"));
        }
        if self.state["restore_hold"] == true {
            return Ok(None);
        }
        let plan = &self.state["plans"][plan_idx(&self.state, "plan_id", &binding.plan_id)?];
        let task = &plan["tasks"][0];
        if !is(plan, "plan_state", "running")
            || !is(&plan["approval"], "status", "granted")
            || task["task_id"] != binding.task_id
            || !is(task, "execution_state", "not_dispatched")
            || task.get("transport_profile").is_some()
        {
            return Ok(None);
        }
        // A case whose approval ran out is not connected at all: the error is
        // that case's own, and the user sees it against the case.
        if integer(&plan["approval"], "expires_at")? <= now() {
            return Err(err("STALE_APPROVAL"));
        }
        Ok(Some(text(plan, "source_text")?.to_owned()))
    }
    pub fn backup_to(&self, destination: &Path) -> Result<(), DomainError> {
        use std::fs::OpenOptions;
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(|_| err("DESTINATION_EXISTS_OR_UNAVAILABLE"))?;
        drop(file);
        let mut dest = sql(Connection::open(destination))?;
        let backup = sql(rusqlite::backup::Backup::new(&self.db, &mut dest))?;
        sql(backup.run_to_completion(32, Duration::from_millis(10), None))?;
        Ok(())
    }
    pub fn apply(&mut self, operation: &str, body: &Value) -> Result<Value, DomainError> {
        fields(
            body,
            &["request_id", "principal_id", "workspace_id", "payload"],
            &[],
        )?;
        if body.to_string().len() > 65536 {
            return Err(err("INVALID"));
        }
        let request = id(body, "request_id")?;
        let principal = id(body, "principal_id")?;
        let workspace = id(body, "workspace_id")?;
        if workspace != "synthetic-workspace" {
            return Err(err("FORBIDDEN"));
        }
        let internal = matches!(operation, "record_executor_event" | "reconcile_attempt");
        if principal
            != if internal {
                "synthetic-executor"
            } else {
                "local-user"
            }
        {
            return Err(err("FORBIDDEN"));
        }
        // Restore hold is checked before the cache: old successful grants cannot replay.
        if self.state["restore_hold"] == true {
            return Err(err("RESTORE_HOLD"));
        }
        let payload = &body["payload"];
        let prior:Option<(String,String,String)>=sql(self.db.query_row("SELECT operation,payload,receipt FROM requests WHERE principal=? AND workspace=? AND request_id=?",params![principal,workspace,request],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional())?;
        if let Some((old_op, old_body, receipt)) = prior {
            let old_payload: Value = serde_json::from_str(&old_body).map_err(|_| err("STORAGE"))?;
            if old_op != operation || old_payload != *payload {
                return Err(err("REQUEST_CONFLICT"));
            }
            let receipt: Value = serde_json::from_str(&receipt).map_err(|_| err("STORAGE"))?;
            return Ok(json!({"ok":true,"receipt":receipt,"snapshot":self.snapshot()?}));
        }
        let at = now();
        let mut next = self.state.clone();
        let subject = execute(&mut next, operation, payload, request, at)?;
        self.persist_change(
            next, operation, request, principal, workspace, payload, subject, at,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn persist_change(
        &mut self,
        mut next: Value,
        operation: &str,
        request: &str,
        principal: &str,
        workspace: &str,
        payload: &Value,
        subject: Value,
        at: u64,
    ) -> Result<Value, DomainError> {
        let revision = integer(&next, "revision")? + 1;
        next["revision"] = json!(revision);
        next["observed_at"] = json!(at);
        let receipt = json!({"receipt_id":format!("receipt-{revision}"),"request_id":request,"operation":operation,"revision":revision,"observed_at":at,"subject":subject});
        next["history"]
            .as_array_mut()
            .ok_or_else(|| err("STORAGE"))?
            .push(receipt.clone());
        validate_document(&next)?;
        let tx = sql(self.db.transaction())?;
        sql(tx.execute(
            "UPDATE domain_state SET document=? WHERE id=1",
            [next.to_string()],
        ))?;
        sql(tx.execute(
            "INSERT INTO requests VALUES(?,?,?,?,?,?)",
            params![
                principal,
                workspace,
                request,
                operation,
                payload.to_string(),
                receipt.to_string()
            ],
        ))?;
        sql(tx.execute(
            "INSERT INTO audit VALUES(?,?,?)",
            params![
                i64::try_from(revision).map_err(|_| err("STORAGE"))?,
                operation,
                receipt.to_string()
            ],
        ))?;
        sql(tx.commit())?;
        self.state = next;
        Ok(json!({"ok":true,"receipt":receipt,"snapshot":self.snapshot()?}))
    }

    /// Trusted local composition only; there is no corresponding external MCP
    /// tool. Both adopted profiles stay on the existing approved synthetic
    /// fixture, which keeps naming its own fixture host; the binding's provider
    /// pair and host must be exactly one profile's scope (the real-bounded one
    /// takes the host the user configured for the CLI's identity).
    /// A native observation grants no synthetic authority.
    pub fn begin_owned(
        &mut self,
        binding: &crate::cli_binding::CliBinding,
        request: &str,
    ) -> Result<Value, DomainError> {
        binding.validate().map_err(|_| err("INVALID_BINDING"))?;
        id(&json!({"id":request}), "id")?;
        // A store made for the real-project cases serves that profile only, and
        // it is the only way that profile is chosen (its binding scope is the
        // real-bounded one's).
        let profile = if self.is_real_project() {
            Some(OwnedProfile::RealProject).filter(|p| p.admits(binding))
        } else {
            OwnedProfile::for_binding(binding)
        }
        .filter(|_| {
            binding.principal_id == "local-user" && binding.workspace_id == "synthetic-workspace"
        })
        .ok_or_else(|| err("UNSUPPORTED_EXECUTOR"))?;
        // A store made for the real-bounded tasks serves that profile only.
        if self.state.get(REAL_MARKER).is_some() && profile != OwnedProfile::RealBounded {
            return Err(err("UNSUPPORTED_EXECUTOR"));
        }
        if let Some(old) = self.owned_request(binding)? {
            if old != request {
                return Err(err("REQUEST_CONFLICT"));
            }
            return Ok(
                json!({"ok":true,"fresh":false,"request_id":old,"snapshot":self.snapshot()?}),
            );
        }
        if self.state["restore_hold"] == true {
            return Err(err("RESTORE_HOLD"));
        }
        let i = plan_idx(&self.state, "plan_id", &binding.plan_id)?;
        let plan = &self.state["plans"][i];
        let payload = json!({"run_id":plan["run_id"],"task_id":binding.task_id,
            "instruction_revision":binding.instruction_revision,"instruction_hash":binding.instruction_hash,
            "executor_id":"synthetic-executor","executor_instance_id":binding.executor_instance_id,
            "execution_host_id":FIXTURE_HOST});
        let at = now();
        let mut next = self.state.clone();
        execute(&mut next, "dispatch_attempt", &payload, request, at)?;
        let registration = crate::cli_binding::ExecutorRegistration::for_profile(
            profile,
            &binding.executor_instance_id,
            &binding.execution_host_id,
            &binding.profile_id,
        )
        .map_err(|_| err("INVALID_BINDING"))?;
        let actual = crate::cli_binding::from_snapshot(
            &project_snapshot(&next),
            &binding.plan_id,
            &binding.task_id,
            &registration,
            at,
        )
        .map_err(|_| err("STALE_BINDING"))?;
        if actual != *binding {
            return Err(err("STALE_BINDING"));
        }
        let (p, t) = task_idx(&next, &binding.attempt_id)?;
        let task = &mut next["plans"][p]["tasks"][t];
        task["transport_profile"] = json!(profile.as_str());
        task["owned_binding"] = json!(binding);
        task["owned_stop_delivery_attempted"] = json!(false);
        task["native_observation"] = Value::Null;
        task["status"] = json!("unknown");
        task["execution_state"] = json!("unknown");
        task["outcome"] = json!("unknown");
        task["effects"] = json!("unknown");
        next["plans"][p]["plan_state"] = json!("blocked");
        next["plans"][p]["blocked_reason"] = json!("OUTCOME_UNRESOLVED");
        let subject = subject(&next["plans"][p], Some(t));
        let result = self.persist_change(
            next,
            "owned_dispatch_intent",
            request,
            "owned-composition",
            &binding.workspace_id,
            &json!(binding),
            subject,
            at,
        )?;
        Ok(json!({"ok":true,"fresh":true,"request_id":request,"result":result}))
    }

    /// Lookup remains available for restored/expired attempts. A found request
    /// is a historical intent, never permission to submit it again.
    pub fn owned_request(
        &self,
        binding: &crate::cli_binding::CliBinding,
    ) -> Result<Option<String>, DomainError> {
        let p = plan_idx(&self.state, "plan_id", &binding.plan_id)?;
        let plan = &self.state["plans"][p];
        let task = plan["tasks"]
            .as_array()
            .ok_or_else(|| err("STORAGE"))?
            .iter()
            .find(|task| task["task_id"] == binding.task_id)
            .ok_or_else(|| err("NOT_FOUND"))?;
        if task.get("transport_profile").is_none() {
            return Ok(None);
        }
        validate_owned_task(plan, task)?;
        if task["owned_binding"] != json!(binding) {
            return Err(err("STALE_BINDING"));
        }
        Ok(Some(text(task, "dispatch_request_id")?.to_owned()))
    }

    /// Record the stop delivery attempt before using the network. A missing
    /// response cannot renew its effect authority on the next scheduler tick.
    pub fn claim_owned_stop(
        &mut self,
        binding: &crate::cli_binding::CliBinding,
    ) -> Result<Option<String>, DomainError> {
        if self.owned_request(binding)?.is_none() {
            return Err(err("NOT_FOUND"));
        }
        if self.state["restore_hold"] == true {
            return Ok(None);
        }
        let (p, t) = task_idx(&self.state, &binding.attempt_id)?;
        let task = &self.state["plans"][p]["tasks"][t];
        if task["owned_stop_delivery_attempted"] == true || task["stop_request_id"].is_null() {
            return Ok(None);
        }
        let request = text(task, "stop_request_id")?.to_owned();
        let mut next = self.state.clone();
        next["plans"][p]["tasks"][t]["owned_stop_delivery_attempted"] = json!(true);
        let subject = subject(&next["plans"][p], Some(t));
        let audit_id = format!("owned-stop-{}", &hash(&request)[..32]);
        self.persist_change(
            next,
            "owned_stop_delivery",
            &audit_id,
            "owned-composition",
            &binding.workspace_id,
            &json!({"binding":binding,"stop_request_id":request}),
            subject,
            now(),
        )?;
        Ok(Some(request))
    }

    pub fn observe_owned(
        &mut self,
        binding: &crate::cli_binding::CliBinding,
        request: &str,
        observation: &Value,
    ) -> Result<Value, DomainError> {
        if self.owned_request(binding)?.as_deref() != Some(request) {
            return Err(err("STALE_BINDING"));
        }
        if self.state["restore_hold"] == true {
            return Err(err("RESTORE_HOLD"));
        }
        let (p, t) = task_idx(&self.state, &binding.attempt_id)?;
        let profile = stored_profile(&self.state["plans"][p]["tasks"][t])?;
        validate_native_observation(profile, binding, request, observation, false)?;
        if self.state["plans"][p]["tasks"][t]["native_observation"] == *observation {
            return Ok(json!({"ok":true,"duplicate_observation":true,"snapshot":self.snapshot()?}));
        }
        let mut next = self.state.clone();
        next["plans"][p]["tasks"][t]["native_observation"] = observation.clone();
        let subject = subject(&next["plans"][p], Some(t));
        let audit_id = format!("owned-observe-{}", &hash(&observation.to_string())[..32]);
        let seen: bool = sql(self.db.query_row("SELECT EXISTS(SELECT 1 FROM requests WHERE principal='owned-composition' AND workspace=? AND request_id=?)",
            params![binding.workspace_id,audit_id],|r|r.get(0)))?;
        if seen {
            return Ok(
                json!({"ok":true,"historical_observation":true,"snapshot":self.snapshot()?}),
            );
        }
        self.persist_change(
            next,
            "owned_observation",
            &audit_id,
            "owned-composition",
            &binding.workspace_id,
            observation,
            subject,
            now(),
        )
    }
}

/// The stored transport profile must be exactly one of the adopted strings.
fn stored_profile(task: &Value) -> Result<OwnedProfile, DomainError> {
    task["transport_profile"]
        .as_str()
        .and_then(|name| OwnedProfile::parse(name).ok())
        .ok_or_else(|| err("STORAGE"))
}

fn validate_owned_task(plan: &Value, task: &Value) -> Result<(), DomainError> {
    let b: crate::cli_binding::CliBinding =
        serde_json::from_value(task["owned_binding"].clone()).map_err(|_| err("STORAGE"))?;
    b.validate().map_err(|_| err("STORAGE"))?;
    let profile = stored_profile(task)?;
    if !profile.admits(&b)
        || b.principal_id != "local-user"
        || b.workspace_id != "synthetic-workspace"
        || plan["plan_id"] != b.plan_id
        || plan["plan_revision"] != b.plan_revision
        || plan["approval"]["approval_id"] != b.approval_id
        || plan["approval"]["revision"] != b.approval_revision
        || plan["approval"]["scope_hash"] != b.scope_hash
        || task["task_id"] != b.task_id
        || task["instruction_revision"] != b.instruction_revision
        || task["instruction_hash"] != b.instruction_hash
        || task["attempt_id"] != b.attempt_id
        || task["fence"] != b.fence
        || task["executor_instance_id"] != b.executor_instance_id
        || task["executor_id"] != "synthetic-executor"
        || task["execution_host_id"] != FIXTURE_HOST
        || task["status"] != "unknown"
        || task["outcome"] != "unknown"
        || task["effects"] != "unknown"
        || !matches!(
            task["execution_state"].as_str(),
            Some("unknown" | "stop_requested" | "stop_unconfirmed")
        )
        || !task["owned_stop_delivery_attempted"].is_boolean()
        || !task["evidence"].is_null()
        || task["event_seq"] != 0
        || !task["executor_events"]
            .as_array()
            .is_some_and(|a| a.is_empty())
        || !task["dispatch_request_id"].is_string()
    {
        return Err(err("STORAGE"));
    }
    if !task["native_observation"].is_null() {
        validate_native_observation(
            profile,
            &b,
            text(task, "dispatch_request_id")?,
            &task["native_observation"],
            true,
        )?;
    }
    Ok(())
}

/// The observation must name the very profile the intent was recorded under.
///
/// `stored` is true only when an already stored observation is checked again
/// (open, restore, any later write). A real-profile observation stored from a
/// CLI before C10 carries `verification: null`; it claims no verdict, so it is
/// kept readable as history. A new real-profile observation must always carry
/// the `real_bounded_verification` document.
fn validate_native_observation(
    profile: OwnedProfile,
    binding: &crate::cli_binding::CliBinding,
    request: &str,
    observation: &Value,
    stored: bool,
) -> Result<(), DomainError> {
    if observation.to_string().len() > 65536
        || observation["profile"] != profile.as_str()
        || observation["binding"] != json!(binding)
        || observation["request"]["request_receipt"]["binding"] != json!(binding)
        || observation["request"]["request_receipt"]["request_id"] != request
        || observation["request"]["request_receipt"]["operation"] != "start"
        || observation["request"]["current"]["binding"] != json!(binding)
        || observation["execution"]["binding"] != json!(binding)
    {
        return Err(err("STALE_BINDING"));
    }
    let owner = &observation["execution"]["owner"];
    if owner.get("ticket").is_some() && owner["ticket"]["binding"] != json!(binding) {
        return Err(err("STALE_BINDING"));
    }
    let verification = &observation["verification"];
    let ticket = &owner["ticket"];
    let admitted = match profile {
        // The synthetic profile's verification is the receipt itself, or null.
        OwnedProfile::Synthetic => {
            verification.is_null() || fixed_payload_receipt(verification, binding, ticket)
        }
        // The real profile's is always the CLI's real_bounded_verification document.
        OwnedProfile::RealBounded => {
            (stored && verification.is_null())
                || real_bounded_verification(verification, binding, ticket)
        }
        // The real-project profile has no history before its record existed:
        // it is always the CLI's real_project_record.
        OwnedProfile::RealProject => real_project_record(verification),
    };
    if !admitted {
        return Err(err("STALE_BINDING"));
    }
    Ok(())
}

/// A fixed-payload verifier receipt for exactly this binding and owner ticket.
/// It records the payload check only: every "verified" flag must be false.
fn fixed_payload_receipt(
    receipt: &Value,
    binding: &crate::cli_binding::CliBinding,
    ticket: &Value,
) -> bool {
    receipt["binding"] == json!(binding)
        && receipt["owner_id"] == ticket["owner_id"]
        && receipt["owner_epoch"] == ticket["owner_epoch"]
        && receipt["task_outcome_verified"] == false
        && receipt["effects_verified"] == false
        && receipt["remote_jobs_stopped"] == false
        && receipt["verification_scope"] == "fixed-payload-only"
}

/// The keys of the real profile's `verification` document, and no others.
const REAL_VERIFICATION_KEYS: [&str; 9] = [
    "kind",
    "verdict",
    "reason",
    "folder_effects",
    "folder_reason",
    "receipt",
    "task_outcome_verified",
    "effects_verified",
    "remote_jobs_stopped",
];

/// The real profile's `verification` (CLI `real_bounded_verification_document`):
/// the fixed-payload verdict paired with the collector's folder effects, with the
/// receipt it was copied from, or null and a reason code while there is none.
/// It is a record only: Iris never reads the verdict as the task's outcome.
fn real_bounded_verification(
    doc: &Value,
    binding: &crate::cli_binding::CliBinding,
    ticket: &Value,
) -> bool {
    let Some(map) = doc.as_object() else {
        return false;
    };
    if map.len() != REAL_VERIFICATION_KEYS.len()
        || !REAL_VERIFICATION_KEYS.iter().all(|k| map.contains_key(*k))
    {
        return false;
    }
    let null_or_text = |key: &str| doc[key].is_null() || doc[key].is_string();
    let verdict = &doc["verdict"];
    let receipt = &doc["receipt"];
    let paired = if receipt.is_null() {
        verdict.is_null()
    } else {
        matches!(verdict.as_str(), Some("pass" | "fail"))
            && receipt["verdict"] == *verdict
            && fixed_payload_receipt(receipt, binding, ticket)
    };
    doc["kind"] == "real_bounded_verification"
        && doc["task_outcome_verified"] == false
        && doc["effects_verified"] == false
        && doc["remote_jobs_stopped"] == false
        && (verdict.is_null() || matches!(verdict.as_str(), Some("pass" | "fail")))
        && null_or_text("reason")
        && null_or_text("folder_effects")
        && null_or_text("folder_reason")
        && paired
}

/// The keys of the real-project profile's `verification` record, and no others
/// (so it never carries a `verdict`).
const REAL_PROJECT_RECORD_KEYS: [&str; 11] = [
    "kind",
    "reason",
    "folder_effects",
    "folder_reason",
    "change_count",
    "changes_sha256",
    "check",
    "unobserved",
    "task_outcome_verified",
    "effects_verified",
    "remote_jobs_stopped",
];
/// What the collector never observes: exactly these, in this order (the CLI
/// always writes this list as is).
const REAL_PROJECT_UNOBSERVED: [&str; 4] =
    ["outside-approved-cwd", "network", "remote-jobs", "acl"];
/// The watchdog's stop codes: the only reasons a filled record carries.
const REAL_PROJECT_STOP_REASONS: [&str; 2] = ["STOPPED_AWAITING_APPROVAL", "STOPPED_RUNTIME_LIMIT"];

fn reason_code(value: &Value) -> bool {
    value.as_str().is_some_and(|code| {
        !code.is_empty()
            && code.len() <= 64
            && code
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    })
}

/// The real-project profile's `verification` (the CLI's `real_project_record`),
/// in one of the two shapes the CLI builds. While the record waits, every
/// record field is null and `reason` is the waiting code (never a stop code).
/// Once filled, `reason` is null or a watchdog stop code, and the folder
/// effects come with the count and SHA-256 of the full change list as a pair:
/// "no change" is zero changes, a scoped change at least one, and only an
/// unexpected change may have neither (the list could not be written), with a
/// folder reason. It is a record only: the three flags are exactly false and
/// Iris never reads it as the task's outcome.
fn real_project_record(doc: &Value) -> bool {
    let Some(map) = doc.as_object() else {
        return false;
    };
    if map.len() != REAL_PROJECT_RECORD_KEYS.len()
        || !REAL_PROJECT_RECORD_KEYS
            .iter()
            .all(|k| map.contains_key(*k))
    {
        return false;
    }
    let reason = &doc["reason"];
    let effects = &doc["folder_effects"];
    let folder_reason = &doc["folder_reason"];
    let count = &doc["change_count"];
    let changes = &doc["changes_sha256"];
    let counted = match (count.as_u64(), changes.as_str()) {
        (Some(n), Some(hex)) if lower_hex_64(hex) => Some(n),
        _ => None,
    };
    let uncounted = count.is_null() && changes.is_null();
    let stop_reason = reason
        .as_str()
        .is_some_and(|code| REAL_PROJECT_STOP_REASONS.contains(&code));
    let shape = match effects.as_str() {
        // Waiting: a code that is not a stop code, and no record fields.
        None if effects.is_null() => {
            reason_code(reason) && !stop_reason && folder_reason.is_null() && uncounted
        }
        None => false,
        Some(effects) => {
            (reason.is_null() || stop_reason)
                && (folder_reason.is_null() || folder_reason.is_string())
                && match effects {
                    "folder-no-change" => counted == Some(0),
                    "folder-scoped-change" => counted.is_some_and(|n| n > 0),
                    "folder-unexpected-change" => {
                        counted.is_some() || (uncounted && folder_reason.is_string())
                    }
                    _ => false,
                }
        }
    };
    let unobserved = doc["unobserved"].as_array().is_some_and(|items| {
        items.len() == REAL_PROJECT_UNOBSERVED.len()
            && items
                .iter()
                .zip(REAL_PROJECT_UNOBSERVED)
                .all(|(item, name)| item.as_str() == Some(name))
    });
    doc["kind"] == "real_project_record"
        && doc["task_outcome_verified"] == false
        && doc["effects_verified"] == false
        && doc["remote_jobs_stopped"] == false
        && doc["check"] == json!({"status":"not-run-by-collector"})
        && shape
        && unobserved
}

fn validate_document(doc: &Value) -> Result<(), DomainError> {
    if doc["contract_version"] != "many-iris-domain/0.1"
        || doc["synthetic"] != true
        || !doc["restore_hold"].is_boolean()
        || !doc["revision"].is_u64()
        || !doc["history"].is_array()
        || !matches!(
            doc["connection_state"].as_str(),
            Some("online" | "stale" | "disconnected" | "authentication_required" | "unsupported")
        )
    {
        return Err(err("STORAGE"));
    }
    let plans = doc["plans"].as_array().ok_or_else(|| err("STORAGE"))?;
    // The synthetic fixture is two plans of three tasks. A document made for the
    // real-bounded tasks says so in its marker and then holds exactly one plan
    // with one task per configured entry.
    let marker = real_marker(doc)?;
    // A real-project document holds one plan per case, each with one task.
    let project = real_project_marker(doc)?;
    let (want_plans, want_tasks) = match (&marker, &project) {
        (None, None) => (2, 3),
        (Some(m), None) => (m.tasks.len(), 1),
        (None, Some(cases)) => (cases.len(), 1),
        (Some(_), Some(_)) => return Err(err("STORAGE")),
    };
    if plans.len() != want_plans {
        return Err(err("STORAGE"));
    }
    let mut ids = std::collections::BTreeSet::new();
    if doc["history"].as_array().unwrap().len() as u64
        != integer(doc, "revision").map_err(|_| err("STORAGE"))?
    {
        return Err(err("STORAGE"));
    }
    for (index, plan) in plans.iter().enumerate() {
        for k in [
            "plan_id",
            "project_id",
            "title",
            "project_title",
            "source_ref",
            "source_text",
            "plan_hash",
            "plan_state",
        ] {
            if !plan[k].is_string() {
                return Err(err("STORAGE"));
            }
        }
        if !ids.insert(text(plan, "plan_id")?)
            || !plan["approval"].is_object()
            || plan["tasks"]
                .as_array()
                .is_none_or(|t| t.len() != want_tasks)
            || !plan["plan_revision"].is_u64()
            || !(plan["run_id"].is_null() || plan["run_id"].is_string())
        {
            return Err(err("STORAGE"));
        }
        let approval = &plan["approval"];
        if !approval["scope"].is_object()
            || !approval["scope"]["task_ids"].is_array()
            || !approval["scope"]["executor_ids"].is_array()
            || !approval["expires_at"].is_u64()
            || !approval["revision"].is_u64()
        {
            return Err(err("STORAGE"));
        }
        for k in ["approval_id", "scope_hash", "status"] {
            if !approval[k].is_string() {
                return Err(err("STORAGE"));
            }
        }
        if !plan["decision"].is_null() {
            let d = &plan["decision"];
            if !d.is_object() || !d["revision"].is_u64() {
                return Err(err("STORAGE"));
            }
            for k in ["decision_id", "content_hash", "task_id", "status"] {
                if !d[k].is_string() {
                    return Err(err("STORAGE"));
                }
            }
        }
        for task in plan["tasks"].as_array().unwrap() {
            if !task.is_object()
                || !task["requires_decision"].is_boolean()
                || !task["executor_events"].is_array()
            {
                return Err(err("STORAGE"));
            }
            for k in [
                "task_id",
                "title",
                "instruction_hash",
                "instruction",
                "status",
                "execution_state",
                "outcome",
            ] {
                if !task[k].is_string() {
                    return Err(err("STORAGE"));
                }
            }
            for k in ["instruction_revision", "fence", "event_seq"] {
                if integer(task, k).is_err() {
                    return Err(err("STORAGE"));
                }
            }
            for k in [
                "attempt_id",
                "executor_id",
                "executor_instance_id",
                "execution_host_id",
                "stop_receipt_id",
                "stop_request_id",
            ] {
                if !(task[k].is_null() || task[k].is_string()) {
                    return Err(err("STORAGE"));
                }
            }
            if !ids.insert(text(task, "task_id")?) {
                return Err(err("STORAGE"));
            }
        }
        if let Some(m) = &marker {
            // The plan must be exactly the configured entry, carrying exactly
            // the configured instruction, with no human-decision step added.
            let entry = &m.tasks[index];
            let task = &plan["tasks"][0];
            if plan["plan_id"] != entry.plan_id
                || plan["approval"]["approval_id"] != entry.approval_id
                || task["task_id"] != entry.task_id
                || task["instruction_hash"] != m.instruction_hash
                || task["requires_decision"] != false
                || task["instruction"]
                    .as_str()
                    .is_none_or(|text| real_instruction(text.as_bytes()).is_none())
            {
                return Err(err("STORAGE"));
            }
        }
        if let Some(cases) = &project {
            // The plan must be exactly the configured case: its markdown (whose
            // SHA-256 is the plan hash) and its instruction, with no human
            // decision step.
            let entry = &cases[index];
            let task = &plan["tasks"][0];
            if plan["plan_id"] != entry.plan_id
                || plan["approval"]["approval_id"] != entry.approval_id
                || plan["plan_hash"] != entry.source_sha256
                || task["task_id"] != entry.task_id
                || task["instruction_hash"] != entry.instruction_sha256
                || task["requires_decision"] != false
                || !real_case_text(&plan["source_text"])
                || !real_case_text(&task["instruction"])
            {
                return Err(err("STORAGE"));
            }
        }
        // An owned intent's profile must be the store's kind: only a
        // real-project store holds real-project intents, and only those.
        for task in plan["tasks"].as_array().unwrap() {
            if task.get("transport_profile").is_some()
                && (stored_profile(task)? == OwnedProfile::RealProject) != project.is_some()
            {
                return Err(err("STORAGE"));
            }
        }
        validate_semantics(plan, doc["restore_hold"] == true)?;
    }
    Ok(())
}
fn validate_semantics(plan: &Value, restore_hold: bool) -> Result<(), DomainError> {
    let invalid = || err("STORAGE");
    scope_matches(plan).map_err(|_| invalid())?;
    if integer(plan, "plan_revision").is_err()
        || integer(plan, "plan_revision")? == 0
        || integer(&plan["approval"], "revision")? == 0
    {
        return Err(invalid());
    }
    if !matches!(
        plan["plan_state"].as_str(),
        Some("ready" | "running" | "waiting_decision" | "paused" | "completed" | "blocked")
    ) {
        return Err(invalid());
    }
    if !is(
        &plan["approval"],
        "status",
        if restore_hold {
            "restore_hold"
        } else {
            "granted"
        },
    ) {
        return Err(invalid());
    }
    let scope = &plan["approval"]["scope"];
    if scope["execution_host_id"] != "synthetic-host"
        || !scope["executor_ids"].as_array().is_some_and(|ids| {
            !ids.is_empty()
                && ids.iter().all(|id| {
                    matches!(
                        id.as_str(),
                        Some("synthetic-executor" | "synthetic-executor-backup")
                    )
                })
        })
    {
        return Err(invalid());
    }
    let tasks = plan["tasks"].as_array().ok_or_else(invalid)?;
    let expected_ids = json!(
        tasks
            .iter()
            .map(|t| t["task_id"].clone())
            .collect::<Vec<_>>()
    );
    if scope["task_ids"] != expected_ids {
        return Err(invalid());
    }
    for task in tasks {
        if task.get("transport_profile").is_some() {
            validate_owned_task(plan, task)?;
        }
        instruction(task).map_err(|_| invalid())?;
        id(task, "task_id").map_err(|_| invalid())?;
        if integer(task, "instruction_revision")? == 0 {
            return Err(invalid());
        }
        if !matches!(
            task["status"].as_str(),
            Some(
                "pending"
                    | "ready"
                    | "waiting_decision"
                    | "running"
                    | "completed"
                    | "rejected"
                    | "unknown"
                    | "stopped"
            )
        ) {
            return Err(invalid());
        }
        if !matches!(
            task["execution_state"].as_str(),
            Some(
                "not_dispatched"
                    | "dispatch_intent"
                    | "accepted"
                    | "running"
                    | "stop_requested"
                    | "stopped_confirmed"
                    | "stop_unconfirmed"
                    | "unknown"
            )
        ) {
            return Err(invalid());
        }
        if !matches!(
            task["outcome"].as_str(),
            Some("pending" | "succeeded" | "failed" | "rejected" | "unknown")
        ) {
            return Err(invalid());
        }
        let dispatched = !is(task, "execution_state", "not_dispatched");
        if dispatched {
            id(task, "attempt_id").map_err(|_| invalid())?;
            id(task, "executor_instance_id").map_err(|_| invalid())?;
            if integer(task, "fence")? == 0
                || !scope["executor_ids"]
                    .as_array()
                    .unwrap()
                    .contains(&task["executor_id"])
                || task["execution_host_id"] != "synthetic-host"
                || integer(task, "dispatch_at").is_err()
            {
                return Err(invalid());
            }
        }
        if is(task, "status", "completed") || is(task, "outcome", "succeeded") {
            if !is(task, "status", "completed")
                || !is(task, "outcome", "succeeded")
                || !is(task, "execution_state", "stopped_confirmed")
                || !evidence_valid(task, &task["evidence"], false)
            {
                return Err(invalid());
            }
            if task["requires_decision"] == true {
                let binding = &task["decision_binding"];
                if binding["approved"] != true
                    || binding["content_hash"] != task["instruction_hash"]
                    || binding["instruction_revision"] != task["instruction_revision"]
                {
                    return Err(invalid());
                }
            }
        }
        if is(task, "outcome", "failed")
            && (!is(task, "execution_state", "stopped_confirmed")
                || !is(task, "status", "stopped")
                || task["effects"] != "none"
                || !task["stop_receipt_id"].is_string()
                || !evidence_valid(task, &task["evidence"], true))
        {
            return Err(invalid());
        }
        if is(task, "execution_state", "not_dispatched")
            && (!matches!(task["outcome"].as_str(), Some("pending" | "rejected"))
                || !matches!(
                    task["status"].as_str(),
                    Some("pending" | "ready" | "waiting_decision" | "rejected")
                ))
        {
            return Err(invalid());
        }
        if matches!(
            task["execution_state"].as_str(),
            Some("dispatch_intent" | "accepted" | "running")
        ) && (!is(task, "outcome", "pending") || !is(task, "status", "running"))
        {
            return Err(invalid());
        }
        if is(task, "execution_state", "unknown")
            && (!is(task, "outcome", "unknown") || !is(task, "status", "unknown"))
        {
            return Err(invalid());
        }
        if matches!(
            task["execution_state"].as_str(),
            Some("stop_requested" | "stop_unconfirmed")
        ) && (!matches!(task["outcome"].as_str(), Some("pending" | "unknown"))
            || !task["stop_request_id"].is_string()
            || !task["stop_requested_at"].is_u64())
        {
            return Err(invalid());
        }
        let events = task["executor_events"].as_array().ok_or_else(invalid)?;
        let mut last = 0;
        for event in events {
            let payload = &event["payload"];
            let seq = integer(payload, "event_seq").map_err(|_| invalid())?;
            if seq <= last
                || payload["attempt_id"] != task["attempt_id"]
                || payload["fence"] != task["fence"]
                || payload["executor_instance_id"] != task["executor_instance_id"]
            {
                return Err(invalid());
            }
            last = seq;
        }
        if integer(task, "event_seq")? != last {
            return Err(invalid());
        }
    }
    let waiting = tasks
        .iter()
        .filter(|t| is(t, "status", "waiting_decision"))
        .collect::<Vec<_>>();
    let decision = &plan["decision"];
    if !decision.is_null() {
        let task = tasks
            .iter()
            .find(|t| t["task_id"] == decision["task_id"])
            .ok_or_else(invalid)?;
        if task["requires_decision"] != true
            || decision["content_hash"] != task["instruction_hash"]
            || !matches!(
                decision["status"].as_str(),
                Some("pending" | "approved" | "rejected")
            )
        {
            return Err(invalid());
        }
        if is(decision, "status", "pending")
            && (waiting.len() != 1
                || !is(task, "status", "waiting_decision")
                || !matches!(
                    plan["plan_state"].as_str(),
                    Some("waiting_decision" | "paused")
                ))
        {
            return Err(invalid());
        }
        if is(decision, "status", "rejected")
            && (!is(plan, "plan_state", "blocked") || plan["blocked_reason"] != "HUMAN_REJECTED")
        {
            return Err(invalid());
        }
    }
    if !waiting.is_empty()
        && (waiting.len() != 1
            || !is(decision, "status", "pending")
            || decision["task_id"] != waiting[0]["task_id"])
    {
        return Err(invalid());
    }
    match plan["plan_state"].as_str().unwrap() {
        "completed" => {
            if plan["run_id"].is_null()
                || tasks.iter().any(|t| {
                    !is(t, "status", "completed")
                        || !is(t, "outcome", "succeeded")
                        || !evidence_valid(t, &t["evidence"], false)
                })
            {
                return Err(invalid());
            }
        }
        "ready" => {
            if !plan["run_id"].is_null()
                || tasks.iter().any(|t| {
                    !is(t, "status", "pending") || !is(t, "execution_state", "not_dispatched")
                })
            {
                return Err(invalid());
            }
        }
        "waiting_decision" => {
            if waiting.len() != 1 || !is(decision, "status", "pending") {
                return Err(invalid());
            }
        }
        "blocked" => {
            if !matches!(
                plan["blocked_reason"].as_str(),
                Some("SAFETY_REFUSAL" | "HUMAN_REJECTED" | "OUTCOME_UNRESOLVED")
            ) {
                return Err(invalid());
            }
        }
        _ => {}
    }
    if !is(plan, "plan_state", "ready") {
        id(plan, "run_id").map_err(|_| invalid())?;
    }
    Ok(())
}
#[cfg(windows)]
fn require_single_link(path: &Path) -> Result<(), DomainError> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct FileInfo {
        attributes: u32,
        created: [u32; 2],
        accessed: [u32; 2],
        written: [u32; 2],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut FileInfo) -> i32;
    }
    let file = std::fs::File::open(path).map_err(|_| err("STORAGE"))?;
    let mut info = FileInfo {
        attributes: 0,
        created: [0; 2],
        accessed: [0; 2],
        written: [0; 2],
        volume: 0,
        size_high: 0,
        size_low: 0,
        links: 0,
        index_high: 0,
        index_low: 0,
    };
    // The read-only File owns the live handle for this call. FileInfo mirrors the
    // fixed Windows BY_HANDLE_FILE_INFORMATION integer layout; no pointers escape.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(err("STORAGE"));
    }
    if info.links != 1 {
        return Err(err("UNSAFE_DB_ALIAS"));
    }
    Ok(())
}
#[cfg(unix)]
fn require_single_link(path: &Path) -> Result<(), DomainError> {
    use std::os::unix::fs::MetadataExt;
    if std::fs::metadata(path).map_err(|_| err("STORAGE"))?.nlink() != 1 {
        return Err(err("UNSAFE_DB_ALIAS"));
    }
    Ok(())
}
#[cfg(not(any(unix, windows)))]
fn require_single_link(_path: &Path) -> Result<(), DomainError> {
    Err(err("UNSUPPORTED_PLATFORM"))
}
fn subject(plan: &Value, task: Option<usize>) -> Value {
    let mut v = json!({"plan_id":plan["plan_id"],"plan_revision":plan["plan_revision"],"plan_hash":plan["plan_hash"],"run_id":plan["run_id"],"plan_state":plan["plan_state"],"approval_id":plan["approval"]["approval_id"],"approval_revision":plan["approval"]["revision"]});
    if let Some(t) = task {
        for k in [
            "task_id",
            "instruction_revision",
            "instruction_hash",
            "attempt_id",
            "executor_id",
            "executor_instance_id",
            "fence",
            "execution_state",
            "outcome",
            "event_seq",
            "stop_receipt_id",
            "reconciled_gap",
        ] {
            v[k] = plan["tasks"][t][k].clone();
        }
    }
    v
}
fn execute(
    doc: &mut Value,
    operation: &str,
    p: &Value,
    request: &str,
    at: u64,
) -> Result<Value, DomainError> {
    match operation {
        "start_plan" => {
            fields(
                p,
                &[
                    "plan_id",
                    "plan_revision",
                    "plan_hash",
                    "approval_id",
                    "approval_revision",
                ],
                &[],
            )?;
            let i = plan_idx(doc, "plan_id", id(p, "plan_id")?)?;
            let plan = &mut doc["plans"][i];
            grant(plan, at)?;
            if plan["run_id"] != Value::Null {
                return Err(err("ACTIVE_RUN"));
            }
            for (a, b) in [
                ("plan_revision", "plan_revision"),
                ("plan_hash", "plan_hash"),
            ] {
                if p[a] != plan[b] {
                    return Err(err("STALE_APPROVAL"));
                }
            }
            if p["approval_id"] != plan["approval"]["approval_id"]
                || p["approval_revision"] != plan["approval"]["revision"]
            {
                return Err(err("STALE_APPROVAL"));
            }
            plan["run_id"] = json!(format!("run-{}", id(plan, "plan_id")?));
            plan["plan_state"] = json!("running");
            plan["tasks"][0]["status"] = json!("ready");
            Ok(subject(plan, Some(0)))
        }
        "continue_plan" => {
            fields(p, &["run_id"], &[])?;
            let i = plan_idx(doc, "run_id", id(p, "run_id")?)?;
            let plan = &mut doc["plans"][i];
            grant(plan, at)?;
            if matches!(plan["plan_state"].as_str(), Some("blocked" | "completed")) {
                return Err(err("STATE"));
            }
            let Some(t) = first_pending(plan) else {
                plan["plan_state"] = json!("completed");
                return Ok(subject(plan, None));
            };
            if !is(&plan["tasks"][t], "execution_state", "not_dispatched") {
                return Err(err("OUTCOME_UNRESOLVED"));
            }
            plan["plan_state"] = json!("running");
            plan["tasks"][t]["status"] = json!("ready");
            decision_ready(plan, t);
            Ok(subject(plan, Some(t)))
        }
        "pause_plan" => {
            fields(p, &["run_id"], &[])?;
            let i = plan_idx(doc, "run_id", id(p, "run_id")?)?;
            let plan = &mut doc["plans"][i];
            if is(plan, "plan_state", "completed") {
                return Err(err("STATE"));
            }
            plan["plan_state"] = json!("paused");
            Ok(subject(plan, None))
        }
        "submit_decision" => {
            fields(
                p,
                &[
                    "decision_id",
                    "decision_revision",
                    "content_hash",
                    "decision",
                ],
                &[],
            )?;
            let wanted = id(p, "decision_id")?;
            let i = doc["plans"]
                .as_array()
                .unwrap()
                .iter()
                .position(|pl| pl["decision"]["decision_id"] == wanted)
                .ok_or_else(|| err("NOT_FOUND"))?;
            let plan = &mut doc["plans"][i];
            grant(plan, at)?;
            let d = &plan["decision"];
            if !is(d, "status", "pending")
                || d["revision"] != p["decision_revision"]
                || d["content_hash"] != p["content_hash"]
            {
                return Err(err("STALE_APPROVAL"));
            }
            let t = plan["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .position(|t| t["task_id"] == d["task_id"])
                .ok_or_else(|| err("STORAGE"))?;
            instruction(&plan["tasks"][t])?;
            if plan["tasks"][t]["instruction_hash"] != p["content_hash"] {
                return Err(err("STALE_APPROVAL"));
            }
            match text(p, "decision")? {
                "approve" => {
                    let binding = json!({"decision_id":plan["decision"]["decision_id"],"revision":plan["decision"]["revision"],"content_hash":plan["decision"]["content_hash"],"instruction_revision":plan["tasks"][t]["instruction_revision"],"approved":true});
                    plan["decision"]["status"] = json!("approved");
                    plan["tasks"][t]["status"] = json!("ready");
                    plan["tasks"][t]["decision_binding"] = binding;
                    if !is(plan, "plan_state", "paused") {
                        plan["plan_state"] = json!("running");
                    }
                }
                "reject" => {
                    plan["decision"]["status"] = json!("rejected");
                    plan["tasks"][t]["status"] = json!("rejected");
                    plan["tasks"][t]["outcome"] = json!("rejected");
                    plan["plan_state"] = json!("blocked");
                    plan["blocked_reason"] = json!("HUMAN_REJECTED");
                }
                _ => return Err(err("INVALID")),
            }
            Ok(subject(plan, Some(t)))
        }
        "dispatch_attempt" => {
            fields(
                p,
                &[
                    "run_id",
                    "task_id",
                    "instruction_revision",
                    "instruction_hash",
                    "executor_id",
                    "executor_instance_id",
                    "execution_host_id",
                ],
                &[],
            )?;
            let i = plan_idx(doc, "run_id", id(p, "run_id")?)?;
            let plan = &mut doc["plans"][i];
            grant(plan, at)?;
            if !is(plan, "plan_state", "running") {
                return Err(err("STATE"));
            }
            if !matches!(
                text(p, "executor_id")?,
                "synthetic-executor" | "synthetic-executor-backup"
            ) || text(p, "execution_host_id")? != "synthetic-host"
            {
                return Err(err("UNSUPPORTED_EXECUTOR"));
            }
            id(p, "executor_instance_id")?;
            let t = first_pending(plan).ok_or_else(|| err("STATE"))?;
            let task = &plan["tasks"][t];
            if task["task_id"] != p["task_id"] {
                return Err(err("SCOPE_MISMATCH"));
            }
            if !plan["approval"]["scope"]["task_ids"]
                .as_array()
                .is_some_and(|ids| ids.contains(&task["task_id"]))
                || !plan["approval"]["scope"]["executor_ids"]
                    .as_array()
                    .is_some_and(|ids| ids.contains(&p["executor_id"]))
                || plan["approval"]["scope"]["execution_host_id"] != p["execution_host_id"]
            {
                return Err(err("SCOPE_MISMATCH"));
            }
            instruction(task)?;
            if task["instruction_revision"] != p["instruction_revision"]
                || task["instruction_hash"] != p["instruction_hash"]
            {
                return Err(err("STALE_BINDING"));
            }
            if !is(task, "execution_state", "not_dispatched") {
                return Err(err("OUTCOME_UNRESOLVED"));
            }
            if task["requires_decision"] == true
                && (!is(&plan["decision"], "status", "approved")
                    || plan["decision"]["task_id"] != task["task_id"]
                    || plan["decision"]["content_hash"] != task["instruction_hash"])
            {
                return Err(err("HUMAN_DECISION_REQUIRED"));
            }
            let task = &mut plan["tasks"][t];
            if task["attempt_id"] == Value::Null {
                task["fence"] = json!(integer(task, "fence")? + 1);
                task["attempt_id"] = json!(format!(
                    "attempt-{}-{}",
                    id(task, "task_id")?,
                    integer(task, "fence")?
                ));
            }
            task["executor_id"] = p["executor_id"].clone();
            task["executor_instance_id"] = p["executor_instance_id"].clone();
            task["execution_host_id"] = p["execution_host_id"].clone();
            task["execution_state"] = json!("dispatch_intent");
            task["status"] = json!("running");
            task["outcome"] = json!("pending");
            task["dispatch_request_id"] = json!(request);
            task["dispatch_at"] = json!(at);
            Ok(subject(plan, Some(t)))
        }
        "request_stop" => {
            fields(p, &["attempt_id", "fence"], &[])?;
            let (i, t) = task_idx(doc, id(p, "attempt_id")?)?;
            let plan = &mut doc["plans"][i];
            let task = &mut plan["tasks"][t];
            if task["fence"] != p["fence"] {
                return Err(err("STALE_BINDING"));
            }
            if !matches!(
                task["execution_state"].as_str(),
                Some(
                    "dispatch_intent"
                        | "accepted"
                        | "running"
                        | "unknown"
                        | "stop_unconfirmed"
                        | "stop_requested"
                )
            ) {
                return Err(err("STATE"));
            }
            if task["stop_request_id"].is_string() {
                return Err(err("STOP_ALREADY_REQUESTED"));
            }
            task["stop_request_id"] = json!(request);
            task["stop_requested_at"] = json!(at);
            task["execution_state"] = json!("stop_requested");
            plan["plan_state"] = json!("paused");
            Ok(subject(plan, Some(t)))
        }
        "record_executor_event" | "reconcile_attempt" => {
            executor_event(doc, p, request, at, operation == "reconcile_attempt")
        }
        "handoff_task" => {
            fields(
                p,
                &["old_attempt_id", "stop_receipt_id", "new_executor_id"],
                &[],
            )?;
            let (i, t) = task_idx(doc, id(p, "old_attempt_id")?)?;
            let plan = &mut doc["plans"][i];
            grant(plan, at)?;
            if !matches!(
                text(p, "new_executor_id")?,
                "synthetic-executor" | "synthetic-executor-backup"
            ) {
                return Err(err("UNSUPPORTED_EXECUTOR"));
            }
            let task = &plan["tasks"][t];
            if !is(task, "execution_state", "stopped_confirmed")
                || task["stop_receipt_id"] != p["stop_receipt_id"]
            {
                return Err(err("STOP_UNCONFIRMED"));
            }
            if !is(task, "outcome", "failed")
                || task["effects"] != "none"
                || !evidence_valid(task, &task["evidence"], true)
            {
                return Err(err("OUTCOME_UNRESOLVED"));
            }
            if plan["blocked_reason"] == "SAFETY_REFUSAL" {
                return Err(err("SAFETY_REFUSAL"));
            }
            let task = &mut plan["tasks"][t];
            let fence = integer(task, "fence")? + 1;
            task["attempt_id"] = json!(format!("attempt-{}-{fence}", id(task, "task_id")?));
            task["fence"] = json!(fence);
            task["executor_id"] = p["new_executor_id"].clone();
            task["executor_instance_id"] = Value::Null;
            task["execution_state"] = json!("not_dispatched");
            task["outcome"] = json!("pending");
            task["status"] = json!("ready");
            task["event_seq"] = json!(0);
            for key in [
                "stop_request_id",
                "stop_requested_at",
                "stop_receipt_id",
                "evidence",
                "effects",
                "decision_binding",
            ] {
                task[key] = Value::Null;
            }
            task["executor_events"] = json!([]);
            plan["decision"] = Value::Null;
            plan["plan_state"] = json!("running");
            plan["blocked_reason"] = Value::Null;
            decision_ready(plan, t);
            Ok(subject(plan, Some(t)))
        }
        _ => Err(err("INVALID")),
    }
}

fn evidence_valid(task: &Value, e: &Value, stopped: bool) -> bool {
    if !is(e, "kind", "synthetic-sha256") {
        return false;
    }
    let Some(attempt) = task["attempt_id"].as_str() else {
        return false;
    };
    let Some(fence) = task["fence"].as_u64() else {
        return false;
    };
    let expected = if stopped {
        format!("synthetic:stopped:no-effects:{attempt}:{fence}")
    } else {
        format!(
            "synthetic:completed:{attempt}:{fence}:{}",
            task["instruction_hash"].as_str().unwrap_or("")
        )
    };
    e["payload"] == expected && e["sha256"] == hash(&expected)
}
fn executor_event(
    doc: &mut Value,
    p: &Value,
    request: &str,
    at: u64,
    reconcile: bool,
) -> Result<Value, DomainError> {
    fields(
        p,
        &[
            "attempt_id",
            "fence",
            "executor_instance_id",
            "event_seq",
            "event_kind",
        ],
        &[
            "outcome",
            "owned_execution_ceased",
            "evidence",
            "effects",
            "stop_request_id",
            "observed_at",
            "reason_class",
        ],
    )?;
    let (i, t) = task_idx(doc, id(p, "attempt_id")?)?;
    let plan = &mut doc["plans"][i];
    let task = &mut plan["tasks"][t];
    if task.get("transport_profile").is_some() {
        return Err(err("UNSUPPORTED_EXECUTOR"));
    }
    if task["fence"] != p["fence"] || task["executor_instance_id"] != p["executor_instance_id"] {
        return Err(err("STALE_BINDING"));
    }
    let seq = integer(p, "event_seq")?;
    let current = integer(task, "event_seq")?;
    if seq <= current {
        if let Some(old) = task["executor_events"]
            .as_array()
            .and_then(|events| events.iter().find(|e| e["payload"]["event_seq"] == seq))
        {
            if old["payload"] == *p {
                return Ok(
                    json!({"duplicate_event":true,"original_request_id":old["request_id"],"attempt_id":task["attempt_id"],"fence":task["fence"],"event_seq":seq}),
                );
            }
        }
        return Err(err("RECEIPT_CONFLICT"));
    }
    let event = text(p, "event_kind")?;
    let reconcilable = is(task, "outcome", "unknown")
        || (is(task, "outcome", "pending")
            && matches!(
                task["execution_state"].as_str(),
                Some("stop_requested" | "stop_unconfirmed")
            ));
    let terminal_proof = p["owned_execution_ceased"] == true
        && match event {
            "result" => {
                is(p, "outcome", "succeeded") && evidence_valid(task, &p["evidence"], false)
            }
            "stop_observed" => {
                is(p, "outcome", "failed")
                    && is(p, "effects", "none")
                    && evidence_valid(task, &p["evidence"], true)
            }
            _ => false,
        };
    if seq != current + 1 {
        // Only explicit recovery with a complete current-attempt terminal proof
        // can bridge a missing event. Ordinary notifications never skip ahead.
        if !reconcile || !reconcilable || !terminal_proof {
            return Err(err("SEQUENCE_GAP"));
        }
        task["reconciled_gap"] =
            json!({"after_event_seq":current,"terminal_event_seq":seq,"evidence":p["evidence"]});
    }
    if reconcile && (!reconcilable || !matches!(event, "result" | "stop_observed")) {
        return Err(err("STATE"));
    }
    match event {
        "accepted" | "running" => {
            let legal = if event == "accepted" {
                is(task, "execution_state", "dispatch_intent")
            } else {
                matches!(
                    task["execution_state"].as_str(),
                    Some("dispatch_intent" | "accepted" | "running")
                )
            };
            if !legal {
                return Err(err("STATE"));
            }
            task["execution_state"] = json!(event);
        }
        "waiting_decision" => {
            return Err(err("HUMAN_DECISION_REQUIRED"));
        }
        "disconnected" => {
            doc["connection_state"] = json!("disconnected");
            return record_event(doc, i, t, p, request);
        }
        "result" => {
            if !matches!(
                task["execution_state"].as_str(),
                Some(
                    "dispatch_intent"
                        | "accepted"
                        | "running"
                        | "stop_requested"
                        | "stop_unconfirmed"
                )
            ) && !(reconcile
                && matches!(
                    task["execution_state"].as_str(),
                    Some("unknown" | "stopped_confirmed")
                ))
            {
                return Err(err("STATE"));
            }
            let observed = integer(p, "observed_at")?;
            if observed < integer(task, "dispatch_at")?
                || observed > at + 60
                || p["owned_execution_ceased"] != true
            {
                return Err(err("INVALID_EVIDENCE"));
            }
            if p["reason_class"] == "safety_refusal" {
                task["outcome"] = json!("rejected");
                task["execution_state"] = json!("stopped_confirmed");
                task["status"] = json!("rejected");
                plan["plan_state"] = json!("blocked");
                plan["blocked_reason"] = json!("SAFETY_REFUSAL");
            } else {
                if !is(p, "outcome", "succeeded") || !evidence_valid(task, &p["evidence"], false) {
                    return Err(err("INVALID_EVIDENCE"));
                }
                task["outcome"] = json!("succeeded");
                task["execution_state"] = json!("stopped_confirmed");
                task["status"] = json!("completed");
                task["evidence"] = p["evidence"].clone();
                plan["blocked_reason"] = Value::Null;
                if !is(plan, "plan_state", "paused") {
                    if first_pending(plan).is_none() {
                        plan["plan_state"] = json!("completed");
                    } else {
                        plan["plan_state"] = json!("running");
                    }
                }
            }
        }
        "stop_observed" => {
            if !matches!(
                task["execution_state"].as_str(),
                Some("stop_requested" | "stop_unconfirmed" | "unknown")
            ) && !(reconcile && is(task, "execution_state", "stopped_confirmed"))
            {
                return Err(err("STATE"));
            }
            let stop = id(p, "stop_request_id")?;
            let observed = integer(p, "observed_at")?;
            if task["stop_request_id"] != stop
                || observed < integer(task, "stop_requested_at")?
                || observed > at + 60
                || p["owned_execution_ceased"] != true
            {
                return Err(err("INVALID_EVIDENCE"));
            }
            task["execution_state"] = json!("stopped_confirmed");
            task["stop_receipt_id"] = json!(request);
            task["status"] = json!("stopped");
            if is(p, "outcome", "failed")
                && is(p, "effects", "none")
                && evidence_valid(task, &p["evidence"], true)
            {
                task["outcome"] = json!("failed");
                task["effects"] = json!("none");
                task["evidence"] = p["evidence"].clone();
            } else {
                task["outcome"] = json!("unknown");
                task["effects"] = Value::Null;
                task["evidence"] = Value::Null;
            }
            plan["plan_state"] = json!("paused");
        }
        _ => return Err(err("INVALID")),
    }
    doc["connection_state"] = json!("online");
    record_event(doc, i, t, p, request)
}
fn record_event(
    doc: &mut Value,
    i: usize,
    t: usize,
    p: &Value,
    request: &str,
) -> Result<Value, DomainError> {
    let task = &mut doc["plans"][i]["tasks"][t];
    task["event_seq"] = p["event_seq"].clone();
    task["executor_events"]
        .as_array_mut()
        .ok_or_else(|| err("STORAGE"))?
        .push(json!({"request_id":request,"payload":p}));
    Ok(subject(&doc["plans"][i], Some(t)))
}
fn project_snapshot(state: &Value) -> Value {
    let mut out = state.clone();
    for plan in out["plans"].as_array_mut().unwrap() {
        let mut actions = Vec::new();
        if out_hold(state) { /* inspection only */
        } else if plan["run_id"].is_null() {
            actions.push("start_plan");
        } else if is(plan, "plan_state", "waiting_decision") {
            actions.push("submit_decision");
            actions.push("pause_plan");
        } else if is(plan, "plan_state", "running") {
            actions.push("pause_plan");
            actions.push("continue_plan");
        } else if is(plan, "plan_state", "paused")
            && first_pending(plan)
                .is_none_or(|t| is(&plan["tasks"][t], "execution_state", "not_dispatched"))
        {
            actions.push("continue_plan");
        }
        if !out_hold(state)
            && plan["tasks"].as_array().unwrap().iter().any(|t| {
                matches!(
                    t["execution_state"].as_str(),
                    Some("dispatch_intent" | "accepted" | "running" | "unknown")
                ) && t["stop_request_id"].is_null()
            })
        {
            actions.push("request_stop");
        }
        if !out_hold(state)
            && plan["tasks"].as_array().unwrap().iter().any(|t| {
                is(t, "execution_state", "stopped_confirmed")
                    && is(t, "outcome", "failed")
                    && t["effects"] == "none"
            })
        {
            actions.push("handoff_task");
        }
        plan["allowed_actions"] = json!(actions);
        for task in plan["tasks"].as_array_mut().unwrap() {
            task.as_object_mut().unwrap().remove("executor_events");
        }
    }
    out
}
fn out_hold(v: &Value) -> bool {
    v["restore_hold"] == true
}
fn fixture() -> Value {
    let at = now();
    let mut plans = Vec::new();
    for n in 1..=2 {
        let plan_id = format!("plan-{n}");
        let source = format!(
            "Synthetic plan {n}: complete three local fake tasks; no real records or external effects."
        );
        let mut tasks = Vec::new();
        for t in 1..=3 {
            let instruction = format!("Synthetic task {n}-{t}; no external effects.");
            tasks.push(json!({"task_id":format!("{plan_id}-task-{t}"),"title":if t==2{"Review the synthetic action"}else{"Complete a synthetic step"},"instruction_revision":1,"instruction_hash":hash(&instruction),"instruction":instruction,"requires_decision":t==2,"status":"pending","attempt_id":null,"executor_id":null,"executor_instance_id":null,"execution_host_id":null,"fence":0,"execution_state":"not_dispatched","outcome":"pending","event_seq":0,"evidence":null,"effects":null,"stop_receipt_id":null,"stop_request_id":null,"stop_requested_at":null,"executor_events":[]}));
        }
        let scope = json!({"plan_id":plan_id,"plan_revision":1,"plan_hash":hash(&source),"approval_revision":1,"task_bindings":task_bindings(&json!(tasks)),"task_ids":tasks.iter().map(|t|t["task_id"].clone()).collect::<Vec<_>>(),"executor_ids":["synthetic-executor","synthetic-executor-backup"],"execution_host_id":"synthetic-host","external_effects":false});
        plans.push(json!({"plan_id":plan_id,"project_id":format!("project-{n}"),"title":format!("Synthetic plan {n}"),"project_title":format!("Synthetic project {n}"),"source_ref":format!("synthetic://plan-{n}"),"source_text":source,"plan_revision":1,"plan_hash":hash(&source),"approval":{"approval_id":format!("approval-{n}"),"revision":1,"scope_hash":hash(&scope.to_string()),"scope":scope,"expires_at":at+86400,"status":"granted"},"plan_state":"ready","run_id":null,"tasks":tasks,"decision":null,"allowed_actions":["start_plan"],"blocked_reason":null}));
    }
    json!({"contract_version":"many-iris-domain/0.1","synthetic":true,"revision":0,"observed_at":at,"restore_hold":false,"connection_state":"online","plans":plans,"history":[],"capabilities":{"executor":"synthetic-only","executors":[{"id":"synthetic-executor","label":"合成担当A","synthetic":true},{"id":"synthetic-executor-backup","label":"合成担当B","synthetic":true}],"real_execution":false,"durable_request_receipts":true,"stop_evidence":"synthetic-only"}})
}
/// The document of a store made for the real-bounded profile: the default
/// fixture's envelope (so nothing else about the document changes), with its
/// plans replaced by one plan per configured task. Each plan has its own plan,
/// task and approval id (so each task's grant scope is its own), a single task
/// and no human-decision step; the task carries the exact instruction text, so
/// its `instruction_hash` is the SHA-256 of the instruction file's bytes. The
/// plan still names the fixture host and stays synthetic: it grants nothing, the
/// CLI's own grant does.
fn real_fixture(real: &RealFixture) -> Value {
    let at = now();
    let instruction_hash = real.instruction_hash();
    let mut plans = Vec::new();
    for (n, entry) in real.tasks.iter().enumerate() {
        let n = n + 1;
        let source = format!(
            "Real-provider bounded plan {n}: one task that sends the configured instruction file."
        );
        let tasks = vec![
            json!({"task_id":entry.task_id,"title":"Send the configured instruction","instruction_revision":1,"instruction_hash":instruction_hash,"instruction":real.instruction,"requires_decision":false,"status":"pending","attempt_id":null,"executor_id":null,"executor_instance_id":null,"execution_host_id":null,"fence":0,"execution_state":"not_dispatched","outcome":"pending","event_seq":0,"evidence":null,"effects":null,"stop_receipt_id":null,"stop_request_id":null,"stop_requested_at":null,"executor_events":[]}),
        ];
        let scope = json!({"plan_id":entry.plan_id,"plan_revision":1,"plan_hash":hash(&source),"approval_revision":1,"task_bindings":task_bindings(&json!(tasks)),"task_ids":tasks.iter().map(|t|t["task_id"].clone()).collect::<Vec<_>>(),"executor_ids":["synthetic-executor","synthetic-executor-backup"],"execution_host_id":"synthetic-host","external_effects":false});
        plans.push(json!({"plan_id":entry.plan_id,"project_id":format!("real-project-{n}"),"title":format!("Real-provider bounded plan {n}"),"project_title":format!("Real-provider bounded project {n}"),"source_ref":format!("real-bounded://{}",entry.plan_id),"source_text":source,"plan_revision":1,"plan_hash":hash(&source),"approval":{"approval_id":entry.approval_id,"revision":1,"scope_hash":hash(&scope.to_string()),"scope":scope,"expires_at":at+86400,"status":"granted"},"plan_state":"ready","run_id":null,"tasks":tasks,"decision":null,"allowed_actions":["start_plan"],"blocked_reason":null}));
    }
    let mut doc = fixture();
    doc["plans"] = json!(plans);
    doc[REAL_MARKER] = json!({"instruction_hash":instruction_hash,"tasks":real.tasks});
    doc
}

/// The document of a store made for the real-project cases: the default
/// fixture's envelope with one plan per case. The plan's source is the case's
/// markdown text (its plan hash is the SHA-256 of the file's bytes) and its one
/// task carries the case's instruction text (its hash is the SHA-256 the CLI's
/// grant names). Ids are the binding's own; the plan still names the fixture
/// host and grants nothing by itself. The marker keeps ids and hashes only.
fn real_project_fixture(project: &RealProject, contents: &[CaseContent]) -> Value {
    let at = now();
    let mut plans = Vec::new();
    for (n, (case, content)) in project.cases().iter().zip(contents).enumerate() {
        let n = n + 1;
        let b = &case.binding;
        let source_hash = hash(&content.source);
        let instruction_hash = hash(&content.instruction);
        let tasks = vec![
            json!({"task_id":b.task_id,"title":"Send this case's instruction","instruction_revision":1,"instruction_hash":instruction_hash,"instruction":content.instruction,"requires_decision":false,"status":"pending","attempt_id":null,"executor_id":null,"executor_instance_id":null,"execution_host_id":null,"fence":0,"execution_state":"not_dispatched","outcome":"pending","event_seq":0,"evidence":null,"effects":null,"stop_receipt_id":null,"stop_request_id":null,"stop_requested_at":null,"executor_events":[]}),
        ];
        let scope = real_project_scope(&b.plan_id, &b.task_id, &source_hash, &instruction_hash);
        plans.push(json!({"plan_id":b.plan_id,"project_id":format!("real-project-{n}"),"title":case.title,"project_title":case.project_title,"source_ref":format!("real-project://{}",b.plan_id),"source_text":content.source,"plan_revision":1,"plan_hash":source_hash,"approval":{"approval_id":b.approval_id,"revision":1,"scope_hash":hash(&scope.to_string()),"scope":scope,"expires_at":at+86400,"status":"granted"},"plan_state":"ready","run_id":null,"tasks":tasks,"decision":null,"allowed_actions":["start_plan"],"blocked_reason":null}));
    }
    let mut doc = fixture();
    doc["plans"] = json!(plans);
    doc[REAL_PROJECT_MARKER] = json!({"cases":project_marker_of(project)});
    doc
}

/// Replace a real-project snapshot's markdown and instruction text with their
/// SHA-256 and byte length, in place. Applies to a snapshot and to a result
/// that carries one under `snapshot`; anything else is left unchanged. Used for
/// every MCP output; the local human UI and `--backup-to` are not routed here.
pub fn redact_real_project_text(value: &mut Value) {
    fn summary(text: &Value) -> Value {
        match text.as_str() {
            Some(text) => json!({"redacted":true,"sha256":hash(text),"bytes":text.len()}),
            None => Value::Null,
        }
    }
    fn redact(snapshot: &mut Value) {
        if snapshot.get(REAL_PROJECT_MARKER).is_none() {
            return;
        }
        let Some(plans) = snapshot["plans"].as_array_mut() else {
            return;
        };
        for plan in plans {
            plan["source_text"] = summary(&plan["source_text"]);
            if let Some(tasks) = plan["tasks"].as_array_mut() {
                for task in tasks {
                    task["instruction"] = summary(&task["instruction"]);
                }
            }
        }
    }
    redact(value);
    if let Some(snapshot) = value.get_mut("snapshot") {
        redact(snapshot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owned_binding(s: &Store) -> crate::cli_binding::CliBinding {
        let p = s.snapshot().unwrap()["plans"][0].clone();
        let t = &p["tasks"][0];
        serde_json::from_value(json!({"principal_id":"local-user","workspace_id":"synthetic-workspace",
            "plan_id":p["plan_id"],"plan_revision":p["plan_revision"],"task_id":t["task_id"],
            "instruction_revision":t["instruction_revision"],"instruction_hash":t["instruction_hash"],
            "approval_id":p["approval"]["approval_id"],"approval_revision":p["approval"]["revision"],
            "scope_hash":p["approval"]["scope_hash"],"execution_host_id":"synthetic-host",
            "executor_instance_id":"owned-boot","attempt_id":format!("attempt-{}-1",t["task_id"].as_str().unwrap()),
            "fence":1,"provider":"synthetic","profile_id":"synthetic"})).unwrap()
    }
    fn native(b: &crate::cli_binding::CliBinding) -> Value {
        json!({"profile":"iris-owned-dispatch/1","binding":b,
            "request":{"request_receipt":{"binding":b,"request_id":"owned-start","operation":"start"},"current":{"binding":b}},
            "execution":{"binding":b,"owner":{"ticket":{"binding":b,"owner_id":"owner","owner_epoch":1},"local_tree_ceased":true}},
            "verification":{"binding":b,"owner_id":"owner","owner_epoch":1,"verdict":"pass","task_outcome_verified":false,
                "effects_verified":false,"remote_jobs_stopped":false,"verification_scope":"fixed-payload-only"}})
    }
    #[test]
    fn owned_intent_is_unknown_and_reopened_intent_never_becomes_fresh() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("owned-db");
        let mut s = Store::open(&path).unwrap();
        start(&mut s);
        let b = owned_binding(&s);
        assert_eq!(s.begin_owned(&b, "owned-start").unwrap()["fresh"], true);
        assert_eq!(s.state["plans"][0]["tasks"][0]["outcome"], "unknown");
        assert_eq!(s.owned_request(&b).unwrap().as_deref(), Some("owned-start"));
        assert_eq!(s.begin_owned(&b, "owned-start").unwrap()["fresh"], false);
        assert_eq!(
            s.begin_owned(&b, "different-request").unwrap_err().code,
            "REQUEST_CONFLICT"
        );
        drop(s);
        let mut s = Store::open(&path).unwrap();
        assert_eq!(s.begin_owned(&b, "owned-start").unwrap()["fresh"], false);
        s.observe_owned(&b, "owned-start", &native(&b)).unwrap();
        assert_eq!(s.state["plans"][0]["tasks"][0]["outcome"], "unknown");
        assert_eq!(s.state["plans"][0]["tasks"][0]["effects"], "unknown");
        assert!(
            !s.snapshot().unwrap()["plans"][0]["allowed_actions"]
                .as_array()
                .unwrap()
                .contains(&json!("handoff_task"))
        );
        let task = s.state["plans"][0]["tasks"][0].clone();
        assert_eq!(
            call(
                &mut s,
                "record_executor_event",
                "fake-result",
                event(&task, "result", 1)
            )
            .unwrap_err()
            .code,
            "UNSUPPORTED_EXECUTOR"
        );
    }
    #[test]
    fn owned_stop_delivery_is_committed_once_and_restore_only_queries() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("owned-db");
        let mut s = Store::open(&path).unwrap();
        start(&mut s);
        let b = owned_binding(&s);
        s.begin_owned(&b, "owned-start").unwrap();
        call(
            &mut s,
            "request_stop",
            "owned-stop",
            json!({"attempt_id":b.attempt_id,"fence":b.fence}),
        )
        .unwrap();
        assert_eq!(
            s.claim_owned_stop(&b).unwrap().as_deref(),
            Some("owned-stop")
        );
        assert_eq!(s.claim_owned_stop(&b).unwrap(), None);
        drop(s);
        let mut s = Store::open_restored(&path).unwrap();
        assert_eq!(s.owned_request(&b).unwrap().as_deref(), Some("owned-start"));
        assert_eq!(s.begin_owned(&b, "owned-start").unwrap()["fresh"], false);
        assert_eq!(s.claim_owned_stop(&b).unwrap(), None);
        assert_eq!(
            s.observe_owned(&b, "owned-start", &native(&b))
                .unwrap_err()
                .code,
            "RESTORE_HOLD"
        );
    }
    #[test]
    fn owned_intent_atomic_rollback_and_wrong_native_binding() {
        let d = tempfile::tempdir().unwrap();
        let mut s = Store::open(&d.path().join("owned-db")).unwrap();
        start(&mut s);
        let b = owned_binding(&s);
        let before = s.snapshot().unwrap();
        s.db.execute_batch("CREATE TRIGGER deny_owned BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'synthetic fault'); END;").unwrap();
        assert_eq!(
            s.begin_owned(&b, "owned-start").unwrap_err().code,
            "STORAGE"
        );
        assert_eq!(s.snapshot().unwrap(), before);
        assert_eq!(s.owned_request(&b).unwrap(), None);
        s.db.execute_batch("DROP TRIGGER deny_owned").unwrap();
        s.begin_owned(&b, "owned-start").unwrap();
        let before = s.snapshot().unwrap();
        let mut wrong = native(&b);
        wrong["verification"]["owner_epoch"] = json!(2);
        assert_eq!(
            s.observe_owned(&b, "owned-start", &wrong).unwrap_err().code,
            "STALE_BINDING"
        );
        assert_eq!(s.snapshot().unwrap(), before);
    }
    #[test]
    fn regression_corrupted_plan_state_must_not_render_false_completion() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("db");
        let s = Store::open(&path).unwrap();
        let mut state = s.state.clone();
        drop(s);
        state["plans"][0]["plan_state"] = json!("completed");
        let db = Connection::open(&path).unwrap();
        db.execute(
            "UPDATE domain_state SET document=? WHERE id=1",
            [state.to_string()],
        )
        .unwrap();
        drop(db);
        assert!(
            Store::open(&path).is_err(),
            "pending tasks without receipts must never render as a completed plan"
        );
    }
    #[test]
    fn corrupted_hash_decision_and_task_semantics_fail_closed() {
        let cases: Vec<fn(&mut Value)> = vec![
            |s| s["plans"][0]["plan_state"] = json!("waiting_decision"),
            |s| s["plans"][0]["tasks"][0]["instruction"] = json!("changed without hash"),
            |s| s["plans"][0]["approval"]["scope_hash"] = json!("wrong"),
            |s| s["plans"][0]["tasks"][0]["status"] = json!("completed"),
            |s| s["plans"][0]["tasks"][0]["outcome"] = json!("succeeded"),
            |s| s["plans"][0]["plan_revision"] = json!(2),
        ];
        for change in cases {
            let d = tempfile::tempdir().unwrap();
            let path = d.path().join("db");
            let s = Store::open(&path).unwrap();
            let mut state = s.state.clone();
            drop(s);
            change(&mut state);
            let db = Connection::open(&path).unwrap();
            db.execute(
                "UPDATE domain_state SET document=? WHERE id=1",
                [state.to_string()],
            )
            .unwrap();
            drop(db);
            assert!(Store::open(&path).is_err());
        }
    }
    #[test]
    fn regression_stop_completion_race() {
        let d = tempfile::tempdir().unwrap();
        let mut s = Store::open(&d.path().join("db")).unwrap();
        start(&mut s);
        let task = dispatch(&mut s, 0, "dispatch");
        call(
            &mut s,
            "request_stop",
            "stop",
            json!({"attempt_id":task["attempt_id"],"fence":1}),
        )
        .unwrap();
        let mut e = event(&task, "result", 1);
        e["outcome"] = json!("succeeded");
        e["observed_at"] = json!(now());
        e["owned_execution_ceased"] = json!(true);
        e["evidence"] = proof(&task, false);
        call(&mut s, "record_executor_event", "raced-result", e)
            .expect("bound completion must reconcile a pending stop");
        let snap = s.snapshot().unwrap();
        assert_eq!(snap["plans"][0]["tasks"][0]["outcome"], "succeeded");
        assert_eq!(snap["plans"][0]["plan_state"], "paused");
    }
    #[test]
    fn regression_terminal_reconcile_sequence_gap() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("db");
        let mut s = Store::open(&path).unwrap();
        start(&mut s);
        let task = dispatch(&mut s, 0, "dispatch");
        call(
            &mut s,
            "record_executor_event",
            "accepted",
            event(&task, "accepted", 1),
        )
        .unwrap();
        drop(s);
        let mut s = Store::open(&path).unwrap();
        let mut e = event(&task, "result", 3);
        e["outcome"] = json!("succeeded");
        e["observed_at"] = json!(now());
        e["owned_execution_ceased"] = json!(true);
        e["evidence"] = proof(&task, false);
        assert_eq!(
            call(&mut s, "record_executor_event", "ordinary-gap", e.clone())
                .unwrap_err()
                .code,
            "SEQUENCE_GAP"
        );
        let mut forged = e.clone();
        forged["evidence"]["sha256"] = json!("forged");
        assert!(call(&mut s, "reconcile_attempt", "forged-gap", forged).is_err());
        call(&mut s, "reconcile_attempt", "terminal-reconcile", e)
            .expect("trusted terminal proof must resolve an explicit recovery gap");
        let snap = s.snapshot().unwrap();
        assert_eq!(snap["plans"][0]["tasks"][0]["outcome"], "succeeded");
        assert_eq!(snap["plans"][0]["tasks"][0]["event_seq"], 3);
    }
    fn call(s: &mut Store, op: &str, id: &str, p: Value) -> Result<Value, DomainError> {
        s.apply(op,&json!({"request_id":id,"principal_id":if matches!(op,"record_executor_event"|"reconcile_attempt"){"synthetic-executor"}else{"local-user"},"workspace_id":"synthetic-workspace","payload":p}))
    }
    fn start(s: &mut Store) -> Value {
        let p = s.snapshot().unwrap()["plans"][0].clone();
        call(s,"start_plan","start",json!({"plan_id":p["plan_id"],"plan_revision":p["plan_revision"],"plan_hash":p["plan_hash"],"approval_id":p["approval"]["approval_id"],"approval_revision":1})).unwrap();
        s.snapshot().unwrap()["plans"][0].clone()
    }
    fn dispatch(s: &mut Store, t: usize, r: &str) -> Value {
        let p = s.snapshot().unwrap()["plans"][0].clone();
        let task = &p["tasks"][t];
        call(s,"dispatch_attempt",r,json!({"run_id":p["run_id"],"task_id":task["task_id"],"instruction_revision":1,"instruction_hash":task["instruction_hash"],"executor_id":"synthetic-executor","executor_instance_id":"boot-1","execution_host_id":"synthetic-host"})).unwrap();
        s.snapshot().unwrap()["plans"][0]["tasks"][t].clone()
    }
    fn event(t: &Value, kind: &str, seq: u64) -> Value {
        json!({"attempt_id":t["attempt_id"],"fence":t["fence"],"executor_instance_id":t["executor_instance_id"],"event_seq":seq,"event_kind":kind})
    }
    fn proof(t: &Value, stop: bool) -> Value {
        let payload = if stop {
            format!(
                "synthetic:stopped:no-effects:{}:{}",
                t["attempt_id"].as_str().unwrap(),
                t["fence"]
            )
        } else {
            format!(
                "synthetic:completed:{}:{}:{}",
                t["attempt_id"].as_str().unwrap(),
                t["fence"],
                t["instruction_hash"].as_str().unwrap()
            )
        };
        json!({"kind":"synthetic-sha256","sha256":hash(&payload),"payload":payload})
    }
    fn complete(s: &mut Store, t: &Value, r: &str) {
        let mut e = event(t, "result", 1);
        e["outcome"] = json!("succeeded");
        e["observed_at"] = json!(now());
        e["owned_execution_ceased"] = json!(true);
        e["evidence"] = proof(t, false);
        call(s, "record_executor_event", r, e).unwrap();
    }
    #[test]
    fn owner_receipt_and_recovery() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("db");
        let mut s = Store::open(&path).unwrap();
        assert_eq!(Store::open(&path).err().unwrap().code, "OWNER_BUSY");
        let p = start(&mut s);
        let body = json!({"run_id":p["run_id"]});
        let first = call(&mut s, "pause_plan", "pause", body.clone()).unwrap();
        let same = call(&mut s, "pause_plan", "pause", body).unwrap();
        assert_eq!(first["receipt"], same["receipt"]);
        assert_eq!(
            call(
                &mut s,
                "continue_plan",
                "pause",
                json!({"run_id":p["run_id"]})
            )
            .unwrap_err()
            .code,
            "REQUEST_CONFLICT"
        );
        drop(s);
        let s = Store::open(&path).unwrap();
        assert_eq!(s.snapshot().unwrap()["plans"][0]["plan_state"], "paused");
    }
    #[test]
    fn full_plan_human_gate_and_isolation() {
        let d = tempfile::tempdir().unwrap();
        let mut s = Store::open(&d.path().join("db")).unwrap();
        let p = start(&mut s);
        let t = dispatch(&mut s, 0, "dispatch-1");
        let mut forged = event(&t, "result", 1);
        forged["outcome"] = json!("succeeded");
        forged["owned_execution_ceased"] = json!(true);
        forged["observed_at"] = json!(now());
        forged["evidence"] =
            json!({"kind":"synthetic-sha256","payload":"forged","sha256":hash("forged")});
        assert_eq!(
            call(&mut s, "record_executor_event", "forged", forged)
                .unwrap_err()
                .code,
            "INVALID_EVIDENCE"
        );
        complete(&mut s, &t, "complete-1");
        call(
            &mut s,
            "continue_plan",
            "continue-1",
            json!({"run_id":p["run_id"]}),
        )
        .unwrap();
        let decision = s.snapshot().unwrap()["plans"][0]["decision"].clone();
        let mut pd = json!({"decision_id":decision["decision_id"],"decision_revision":decision["revision"],"content_hash":"wrong","decision":"approve"});
        assert_eq!(
            call(&mut s, "submit_decision", "bad-decision", pd.clone())
                .unwrap_err()
                .code,
            "STALE_APPROVAL"
        );
        pd["content_hash"] = decision["content_hash"].clone();
        call(&mut s, "submit_decision", "decision", pd).unwrap();
        let t = dispatch(&mut s, 1, "dispatch-2");
        complete(&mut s, &t, "complete-2");
        call(
            &mut s,
            "continue_plan",
            "continue-2",
            json!({"run_id":p["run_id"]}),
        )
        .unwrap();
        let t = dispatch(&mut s, 2, "dispatch-3");
        complete(&mut s, &t, "complete-3");
        let snap = s.snapshot().unwrap();
        assert_eq!(snap["plans"][0]["plan_state"], "completed");
        assert_eq!(snap["plans"][1]["plan_state"], "ready");
        drop(s);
        let restored = Store::open(&d.path().join("db")).unwrap();
        assert_eq!(
            restored.snapshot().unwrap()["plans"][0]["plan_state"],
            "completed"
        );
    }
    #[test]
    fn unknown_stop_proof_and_handoff() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("db");
        let mut s = Store::open(&path).unwrap();
        start(&mut s);
        let t = dispatch(&mut s, 0, "dispatch");
        drop(s);
        let mut s = Store::open(&path).unwrap();
        assert_eq!(
            s.snapshot().unwrap()["plans"][0]["tasks"][0]["outcome"],
            "unknown"
        );
        assert_eq!(call(&mut s,"handoff_task","early",json!({"old_attempt_id":t["attempt_id"],"stop_receipt_id":"invented","new_executor_id":"synthetic-executor"})).unwrap_err().code,"STOP_UNCONFIRMED");
        call(
            &mut s,
            "request_stop",
            "stop",
            json!({"attempt_id":t["attempt_id"],"fence":t["fence"]}),
        )
        .unwrap();
        let mut e = event(&t, "stop_observed", 1);
        e["stop_request_id"] = json!("other-stop");
        e["observed_at"] = json!(now());
        e["owned_execution_ceased"] = json!(true);
        e["effects"] = json!("none");
        e["outcome"] = json!("failed");
        e["evidence"] = proof(&t, true);
        assert_eq!(
            call(&mut s, "record_executor_event", "bad-proof", e.clone())
                .unwrap_err()
                .code,
            "INVALID_EVIDENCE"
        );
        e["stop_request_id"] = json!("stop");
        call(&mut s, "record_executor_event", "stop-proof", e).unwrap();
        call(&mut s,"handoff_task","handoff",json!({"old_attempt_id":t["attempt_id"],"stop_receipt_id":"stop-proof","new_executor_id":"synthetic-executor"})).unwrap();
        assert_eq!(s.snapshot().unwrap()["plans"][0]["tasks"][0]["fence"], 2);
        assert!(
            call(
                &mut s,
                "record_executor_event",
                "old",
                event(&t, "running", 2)
            )
            .is_err()
        );
    }
    #[test]
    fn backup_restore_and_schema_fail_closed() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("db");
        let backup = d.path().join("backup");
        let mut s = Store::open(&path).unwrap();
        start(&mut s);
        s.backup_to(&backup).unwrap();
        assert!(s.backup_to(&backup).is_err());
        let mut restored = Store::open_restored(&backup).unwrap();
        assert_eq!(restored.snapshot().unwrap()["restore_hold"], true);
        assert_eq!(
            call(
                &mut restored,
                "pause_plan",
                "x",
                json!({"run_id":"run-plan-1"})
            )
            .unwrap_err()
            .code,
            "RESTORE_HOLD"
        );
        let future = d.path().join("future");
        let db = Connection::open(&future).unwrap();
        db.execute_batch("PRAGMA user_version=99").unwrap();
        drop(db);
        assert_eq!(Store::open(&future).err().unwrap().code, "SCHEMA");
    }
    #[test]
    fn stale_expired_scope_and_principal_cannot_dispatch() {
        let d = tempfile::tempdir().unwrap();
        let mut s = Store::open(&d.path().join("db")).unwrap();
        start(&mut s);
        let plan = s.state["plans"][0].clone();
        let task = plan["tasks"][0].clone();
        let p = json!({"run_id":plan["run_id"],"task_id":task["task_id"],"instruction_revision":1,"instruction_hash":task["instruction_hash"],"executor_id":"synthetic-executor","executor_instance_id":"boot-1","execution_host_id":"synthetic-host"});
        let mut stale = p.clone();
        stale["instruction_revision"] = json!(2);
        assert_eq!(
            call(&mut s, "dispatch_attempt", "stale", stale)
                .unwrap_err()
                .code,
            "STALE_BINDING"
        );
        let mut scope = p.clone();
        scope["task_id"] = json!("plan-2-task-1");
        assert_eq!(
            call(&mut s, "dispatch_attempt", "scope", scope)
                .unwrap_err()
                .code,
            "SCOPE_MISMATCH"
        );
        let body = json!({"request_id":"fake-user","principal_id":"other-user","workspace_id":"synthetic-workspace","payload":p});
        assert_eq!(
            s.apply("dispatch_attempt", &body).unwrap_err().code,
            "FORBIDDEN"
        );
        s.state["plans"][0]["approval"]["expires_at"] = json!(0);
        assert_eq!(
            call(&mut s, "dispatch_attempt", "expired", p)
                .unwrap_err()
                .code,
            "STALE_APPROVAL"
        );
        assert!(s.state["plans"][0]["tasks"][0]["attempt_id"].is_null());
    }
    #[test]
    fn event_binding_sequence_and_query_purity() {
        let d = tempfile::tempdir().unwrap();
        let mut s = Store::open(&d.path().join("db")).unwrap();
        start(&mut s);
        let t = dispatch(&mut s, 0, "dispatch");
        let before = s.snapshot().unwrap();
        assert_eq!(before, s.snapshot().unwrap());
        let mut wrong = event(&t, "accepted", 1);
        wrong["executor_instance_id"] = json!("another-boot");
        assert_eq!(
            call(&mut s, "record_executor_event", "wrong-instance", wrong)
                .unwrap_err()
                .code,
            "STALE_BINDING"
        );
        assert_eq!(
            call(
                &mut s,
                "record_executor_event",
                "gap",
                event(&t, "running", 2)
            )
            .unwrap_err()
            .code,
            "SEQUENCE_GAP"
        );
        let e = event(&t, "accepted", 1);
        let original = call(&mut s, "record_executor_event", "accepted", e.clone()).unwrap();
        let retry = call(&mut s, "record_executor_event", "accepted", e.clone()).unwrap();
        assert_eq!(original["receipt"], retry["receipt"]);
        let mut changed = e;
        changed["event_kind"] = json!("running");
        assert_eq!(
            call(&mut s, "record_executor_event", "same-seq-changed", changed)
                .unwrap_err()
                .code,
            "RECEIPT_CONFLICT"
        );
        assert_eq!(
            s.snapshot().unwrap()["plans"][0]["tasks"][0]["execution_state"],
            "accepted"
        );
    }
    #[test]
    fn stop_without_outcome_proof_stays_unresolved() {
        let d = tempfile::tempdir().unwrap();
        let mut s = Store::open(&d.path().join("db")).unwrap();
        start(&mut s);
        let t = dispatch(&mut s, 0, "dispatch");
        call(
            &mut s,
            "request_stop",
            "stop",
            json!({"attempt_id":t["attempt_id"],"fence":1}),
        )
        .unwrap();
        let mut e = event(&t, "stop_observed", 1);
        e["stop_request_id"] = json!("stop");
        e["observed_at"] = json!(now());
        e["owned_execution_ceased"] = json!(true);
        call(&mut s, "record_executor_event", "partial-proof", e).unwrap();
        assert_eq!(
            s.state["plans"][0]["tasks"][0]["execution_state"],
            "stopped_confirmed"
        );
        assert_eq!(s.state["plans"][0]["tasks"][0]["outcome"], "unknown");
        assert_eq!(call(&mut s,"handoff_task","handoff",json!({"old_attempt_id":t["attempt_id"],"stop_receipt_id":"partial-proof","new_executor_id":"synthetic-executor-backup"})).unwrap_err().code,"OUTCOME_UNRESOLVED");
        let mut no_proof = event(&t, "result", 2);
        no_proof["observed_at"] = json!(now());
        no_proof["owned_execution_ceased"] = json!(true);
        no_proof["outcome"] = json!("succeeded");
        assert_eq!(
            call(&mut s, "reconcile_attempt", "reconcile", no_proof)
                .unwrap_err()
                .code,
            "INVALID_EVIDENCE"
        );
    }
    #[test]
    fn storage_failure_rolls_back_state_receipt_and_audit() {
        let d = tempfile::tempdir().unwrap();
        let mut s = Store::open(&d.path().join("db")).unwrap();
        let plan = s.state["plans"][0].clone();
        let before = s.snapshot().unwrap();
        s.db.execute_batch("CREATE TRIGGER deny_request BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT,'synthetic storage fault'); END;").unwrap();
        let p = json!({"plan_id":plan["plan_id"],"plan_revision":1,"plan_hash":plan["plan_hash"],"approval_id":"approval-1","approval_revision":1});
        assert_eq!(
            call(&mut s, "start_plan", "fault", p.clone())
                .unwrap_err()
                .code,
            "STORAGE"
        );
        assert_eq!(s.snapshot().unwrap(), before);
        assert_eq!(
            s.db.query_row("SELECT COUNT(*) FROM audit", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            s.db.query_row("SELECT COUNT(*) FROM requests", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        s.db.execute_batch("DROP TRIGGER deny_request").unwrap();
        call(&mut s, "start_plan", "fault", p).unwrap();
    }
    #[test]
    fn corrupt_document_and_hardlinked_alias_fail_closed() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("db");
        let s = Store::open(&path).unwrap();
        drop(s);
        let alias = d.path().join("alias");
        std::fs::hard_link(&path, &alias).unwrap();
        assert_eq!(Store::open(&alias).err().unwrap().code, "UNSAFE_DB_ALIAS");
        std::fs::remove_file(alias).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute(
            "UPDATE domain_state SET document=? WHERE id=1",
            ["{\"synthetic\":true}"],
        )
        .unwrap();
        drop(db);
        assert_eq!(Store::open(&path).err().unwrap().code, "STORAGE");
    }
    #[test]
    fn safety_refusal_blocks_without_automatic_handoff() {
        let d = tempfile::tempdir().unwrap();
        let mut s = Store::open(&d.path().join("db")).unwrap();
        start(&mut s);
        let t = dispatch(&mut s, 0, "dispatch");
        let mut e = event(&t, "result", 1);
        e["outcome"] = json!("rejected");
        e["reason_class"] = json!("safety_refusal");
        e["observed_at"] = json!(now());
        e["owned_execution_ceased"] = json!(true);
        call(&mut s, "record_executor_event", "refusal", e).unwrap();
        assert_eq!(s.state["plans"][0]["plan_state"], "blocked");
        assert_eq!(
            call(
                &mut s,
                "continue_plan",
                "no-retry",
                json!({"run_id":"run-plan-1"})
            )
            .unwrap_err()
            .code,
            "STATE"
        );
        assert!(
            !s.snapshot().unwrap()["plans"][0]["allowed_actions"]
                .as_array()
                .unwrap()
                .contains(&json!("handoff_task"))
        );
    }
}
