//! Read-only conversion of a trusted Store snapshot to the CLI's full identity.
//! This is neither admission nor evidence: callers must obtain a fresh snapshot
//! directly from Store and keep its write/dispatch gate authoritative. Hashes
//! bind content; they do not authenticate arbitrary caller-supplied JSON.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

/// Wire-compatible with many-ai-cli::hub::iris_execution_journal::Binding.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CliBinding {
    pub principal_id: String,
    pub workspace_id: String,
    pub plan_id: String,
    pub plan_revision: u64,
    pub task_id: String,
    pub instruction_revision: u64,
    pub instruction_hash: String,
    pub approval_id: String,
    pub approval_revision: u64,
    pub scope_hash: String,
    pub execution_host_id: String,
    pub executor_instance_id: String,
    pub attempt_id: String,
    pub fence: u64,
    pub provider: String,
    pub profile_id: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BindingError(&'static str);
impl BindingError {
    pub fn code(&self) -> &'static str {
        self.0
    }
}
impl std::fmt::Display for BindingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for BindingError {}
fn error(code: &'static str) -> BindingError {
    BindingError(code)
}
fn valid_id(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
/// The shape of an execution host identity as the user configures it on both
/// sides: ASCII letters, digits, `-` and `_` only, 1 to 128 bytes. That is the
/// id rule every other binding field already follows and the rule the CLI's
/// identity and binding check apply, so a value Iris accepts is never one the
/// CLI refuses. A dotted name such as `lab-pc.local` is refused here for that
/// reason; write the CLI identity's value without `.`. Spaces, Unicode
/// (including format characters) and control characters are refused as well.
/// This is a shape check only; which host a profile accepts is
/// `OwnedProfile::admits_host`.
pub fn valid_host_id(value: &str) -> bool {
    valid_id(value, 128)
}
/// Lowercase hex SHA-256 of exactly these bytes. This is the one place that turns
/// instruction bytes into the `instruction_hash` the CLI compares with the bytes of
/// the instruction file it reads: nothing is trimmed, and no newline, BOM or
/// Unicode form is converted.
pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hash(value: &str) -> String {
    sha256_hex(value.as_bytes())
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn positive(value: u64) -> bool {
    value > 0 && value <= i64::MAX as u64
}
impl CliBinding {
    /// Structural validation also supports read-only inspection of real-provider
    /// receipts. It does not grant execution or make such receipts synthetic.
    pub fn validate(&self) -> Result<(), BindingError> {
        for value in [
            &self.principal_id,
            &self.workspace_id,
            &self.plan_id,
            &self.task_id,
            &self.approval_id,
            &self.executor_instance_id,
            &self.attempt_id,
            &self.provider,
            &self.profile_id,
        ] {
            if !valid_id(value, 128) {
                return Err(error("INVALID_BINDING"));
            }
        }
        // The host follows the same rule as the ids above; the profile then
        // decides which hosts it admits.
        if !valid_host_id(&self.execution_host_id) {
            return Err(error("INVALID_BINDING"));
        }
        if ![
            self.plan_revision,
            self.instruction_revision,
            self.approval_revision,
            self.fence,
        ]
        .into_iter()
        .all(positive)
            || !valid_hash(&self.instruction_hash)
            || !valid_hash(&self.scope_hash)
        {
            return Err(error("INVALID_BINDING"));
        }
        Ok(())
    }
}

/// Wire string of the default, synthetic-only owned profile.
pub const OWNED_PROFILE_SYNTHETIC: &str = "iris-owned-dispatch/1";
/// Wire string of the opt-in real-provider bounded profile.
pub const OWNED_PROFILE_REAL_BOUNDED: &str = "iris-owned-real-bounded/1";
/// Wire string of the opt-in real-project profile (the user's approved cases).
pub const OWNED_PROFILE_REAL_PROJECT: &str = "iris-owned-real-project/1";
/// The host the approved synthetic plan itself names (its scope and its tasks).
/// It is the only host the Iris domain knows. The default profile's binding must
/// name it; the real-bounded profile's binding names a configured host instead,
/// and the plan keeps naming this one.
pub const FIXTURE_HOST: &str = "synthetic-host";
/// The subscription profile the default, synthetic-only profile names.
pub const SYNTHETIC_PROFILE_ID: &str = "synthetic";

/// The only owned CLI profiles Iris speaks. This is the single place that maps a
/// profile string to the exact provider scope its binding may name; any other
/// string or provider pair is refused. Nothing selects, upgrades or falls back
/// between profiles: the caller must name one from its explicit configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub enum OwnedProfile {
    Synthetic,
    RealBounded,
    /// Shares the real-bounded profile's binding scope (claude, configured
    /// subscription profile, configured host), so it is never inferred from a binding: only an explicit
    /// configuration or a store made for real-project cases names it.
    RealProject,
}
impl OwnedProfile {
    pub fn parse(value: &str) -> Result<Self, BindingError> {
        match value {
            OWNED_PROFILE_SYNTHETIC => Ok(Self::Synthetic),
            OWNED_PROFILE_REAL_BOUNDED => Ok(Self::RealBounded),
            OWNED_PROFILE_REAL_PROJECT => Ok(Self::RealProject),
            _ => Err(error("UNSUPPORTED_PROFILE")),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Synthetic => OWNED_PROFILE_SYNTHETIC,
            Self::RealBounded => OWNED_PROFILE_REAL_BOUNDED,
            Self::RealProject => OWNED_PROFILE_REAL_PROJECT,
        }
    }
    pub fn provider(self) -> &'static str {
        match self {
            Self::Synthetic => "synthetic",
            Self::RealBounded | Self::RealProject => "claude",
        }
    }
    /// The default profile admits only the synthetic subscription profile. The
    /// real profiles admit the CLI subscription profile the user configured
    /// (there is no default name): Iris checks only its shape and that it is not
    /// `synthetic`; the CLI refuses a binding whose profile is not the one its
    /// session actually runs.
    pub fn admits_profile_id(self, profile_id: &str) -> bool {
        match self {
            Self::Synthetic => profile_id == SYNTHETIC_PROFILE_ID,
            Self::RealBounded | Self::RealProject => {
                valid_id(profile_id, 128) && profile_id != SYNTHETIC_PROFILE_ID
            }
        }
    }
    /// True for the profiles that send to a real provider.
    pub fn is_real(self) -> bool {
        !matches!(self, Self::Synthetic)
    }
    /// The default profile admits only the fixture host. The real profiles admit
    /// the host the user configured, which must be the same value as the CLI
    /// identity's `execution_host_id`; Iris only checks its shape and that the
    /// peer reports exactly it, and never substitutes a default.
    pub fn admits_host(self, host: &str) -> bool {
        match self {
            Self::Synthetic => host == FIXTURE_HOST,
            Self::RealBounded | Self::RealProject => valid_host_id(host),
        }
    }
    /// The Iris domain still runs the synthetic fixture for both profiles; the
    /// provider and subscription profile differ, and so may the host.
    pub fn admits(self, binding: &CliBinding) -> bool {
        binding.provider == self.provider()
            && self.admits_profile_id(&binding.profile_id)
            && self.admits_host(&binding.execution_host_id)
    }
    /// The one profile whose scope this binding is inside, if any. The
    /// real-project profile is never returned here (see `RealProject`).
    pub fn for_binding(binding: &CliBinding) -> Option<Self> {
        [Self::Synthetic, Self::RealBounded]
            .into_iter()
            .find(|profile| profile.admits(binding))
    }
}
impl TryFrom<String> for OwnedProfile {
    type Error = BindingError;
    fn try_from(value: String) -> Result<Self, BindingError> {
        Self::parse(&value)
    }
}

/// Composition-owned registration, deliberately not Deserialize and with no
/// externally selectable identity. The domain executor slot stays the primary
/// synthetic one; the provider/profile written into the CLI binding come only
/// from the explicitly chosen owned profile, and the host only from the value
/// the caller names (checked against that profile). Backup executors need a new
/// design.
#[derive(Debug, Clone)]
pub struct ExecutorRegistration {
    instance: String,
    profile: OwnedProfile,
    host: String,
    profile_id: String,
}
impl ExecutorRegistration {
    pub fn synthetic(instance: &str) -> Result<Self, BindingError> {
        Self::for_profile(
            OwnedProfile::Synthetic,
            instance,
            FIXTURE_HOST,
            SYNTHETIC_PROFILE_ID,
        )
    }
    /// There is no default host or subscription profile: the caller passes the
    /// configured ones, and the profile refuses a value it does not admit.
    pub fn for_profile(
        profile: OwnedProfile,
        instance: &str,
        host: &str,
        profile_id: &str,
    ) -> Result<Self, BindingError> {
        if !valid_id(instance, 80)
            || !profile.admits_host(host)
            || !profile.admits_profile_id(profile_id)
        {
            return Err(error("INVALID_REGISTRATION"));
        }
        Ok(Self {
            instance: instance.into(),
            profile,
            host: host.into(),
            profile_id: profile_id.into(),
        })
    }
    pub fn executor_id(&self) -> &'static str {
        "synthetic-executor"
    }
    pub fn executor_instance_id(&self) -> &str {
        &self.instance
    }
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, BindingError> {
    value[key].as_str().ok_or_else(|| error("INVALID_SNAPSHOT"))
}
fn id<'a>(value: &'a Value, key: &str) -> Result<&'a str, BindingError> {
    let value = text(value, key)?;
    if !valid_id(value, 80) {
        return Err(error("INVALID_SNAPSHOT"));
    }
    Ok(value)
}
fn number(value: &Value, key: &str) -> Result<u64, BindingError> {
    value[key]
        .as_u64()
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or_else(|| error("INVALID_SNAPSHOT"))
}
fn revision(value: &Value, key: &str) -> Result<u64, BindingError> {
    number(value, key).and_then(|n| {
        if positive(n) {
            Ok(n)
        } else {
            Err(error("INVALID_SNAPSHOT"))
        }
    })
}
fn select<'a>(values: &'a [Value], key: &str, wanted: &str) -> Result<&'a Value, BindingError> {
    let mut found = values.iter().filter(|value| value[key] == wanted);
    let result = found.next().ok_or_else(|| error("NOT_FOUND"))?;
    if found.next().is_some() {
        return Err(error("AMBIGUOUS_BINDING"));
    }
    Ok(result)
}

/// Convert only a persisted, current attempt; never invent its ID or next fence.
/// dispatch_intent/accepted/running/unknown/stop_requested/stop_unconfirmed and
/// stopped_confirmed can be represented for inspection. This does not authorize
/// retrying an unknown/terminal attempt. Unsent handoff attempts are rejected.
/// Expired grants (including now == expires_at) and restored stores are rejected.
pub fn from_snapshot(
    snapshot: &Value,
    plan_id: &str,
    task_id: &str,
    registration: &ExecutorRegistration,
    now: u64,
) -> Result<CliBinding, BindingError> {
    if now > i64::MAX as u64 || !valid_id(plan_id, 80) || !valid_id(task_id, 80) {
        return Err(error("INVALID_SELECTION"));
    }
    if snapshot["contract_version"] != "many-iris-domain/0.1" || snapshot["synthetic"] != true {
        return Err(error("UNSUPPORTED_SNAPSHOT"));
    }
    if snapshot["restore_hold"] != false {
        return Err(error("RESTORE_HOLD"));
    }
    let plans = snapshot["plans"]
        .as_array()
        .ok_or_else(|| error("INVALID_SNAPSHOT"))?;
    let plan = select(plans, "plan_id", plan_id)?;
    id(plan, "plan_id")?;
    id(plan, "run_id")?;
    let plan_revision = revision(plan, "plan_revision")?;
    let approval = &plan["approval"];
    if approval["status"] != "granted" || number(approval, "expires_at")? <= now {
        return Err(error("STALE_APPROVAL"));
    }
    let approval_revision = revision(approval, "revision")?;
    let scope = &approval["scope"];
    let scope_object = scope.as_object().ok_or_else(|| error("SCOPE_MISMATCH"))?;
    let keys = [
        "plan_id",
        "plan_revision",
        "plan_hash",
        "approval_revision",
        "task_bindings",
        "task_ids",
        "executor_ids",
        "execution_host_id",
        "external_effects",
    ];
    if scope_object.len() != keys.len() || scope_object.keys().any(|k| !keys.contains(&k.as_str()))
    {
        return Err(error("SCOPE_MISMATCH"));
    }
    if plan["plan_hash"] != hash(text(plan, "source_text")?)
        || scope["plan_id"] != plan["plan_id"]
        || scope["plan_revision"] != plan["plan_revision"]
        || scope["plan_hash"] != plan["plan_hash"]
        || scope["approval_revision"] != approval["revision"]
        || approval["scope_hash"] != hash(&scope.to_string())
        || scope["external_effects"] != false
        || scope["execution_host_id"] != FIXTURE_HOST
    {
        return Err(error("SCOPE_MISMATCH"));
    }
    let executor_ids = scope["executor_ids"]
        .as_array()
        .ok_or_else(|| error("SCOPE_MISMATCH"))?;
    if !executor_ids.contains(&json!(registration.executor_id()))
        || executor_ids.iter().any(|v| {
            !matches!(
                v.as_str(),
                Some("synthetic-executor" | "synthetic-executor-backup")
            )
        })
    {
        return Err(error("UNSUPPORTED_EXECUTOR"));
    }
    let tasks = plan["tasks"]
        .as_array()
        .ok_or_else(|| error("INVALID_SNAPSHOT"))?;
    let mut ids = BTreeSet::new();
    let mut task_bindings = Vec::new();
    for task in tasks {
        if !ids.insert(id(task, "task_id")?) {
            return Err(error("AMBIGUOUS_BINDING"));
        }
        revision(task, "instruction_revision")?;
        if task["instruction_hash"] != hash(text(task, "instruction")?)
            || !task["requires_decision"].is_boolean()
        {
            return Err(error("STALE_BINDING"));
        }
        task_bindings.push(json!({"task_id":task["task_id"],"instruction_revision":task["instruction_revision"],"instruction_hash":task["instruction_hash"],"requires_decision":task["requires_decision"]}));
    }
    if scope["task_ids"]
        != json!(
            tasks
                .iter()
                .map(|t| t["task_id"].clone())
                .collect::<Vec<_>>()
        )
        || scope["task_bindings"] != json!(task_bindings)
    {
        return Err(error("SCOPE_MISMATCH"));
    }
    let task = select(tasks, "task_id", task_id)?;
    let state = text(task, "execution_state")?;
    if !matches!(
        state,
        "dispatch_intent"
            | "accepted"
            | "running"
            | "unknown"
            | "stop_requested"
            | "stop_unconfirmed"
            | "stopped_confirmed"
    ) {
        return Err(error("NO_CURRENT_ATTEMPT"));
    }
    if state != "stopped_confirmed"
        && tasks
            .iter()
            .find(|t| t["status"] != "completed")
            .is_none_or(|first| first["task_id"] != task_id)
    {
        return Err(error("STALE_BINDING"));
    }
    if !matches!(
        plan["plan_state"].as_str(),
        Some("running" | "paused" | "waiting_decision" | "completed" | "blocked")
    ) {
        return Err(error("STALE_BINDING"));
    }
    if task["executor_id"] != registration.executor_id()
        || task["executor_instance_id"] != registration.instance
        || task["execution_host_id"] != FIXTURE_HOST
    {
        return Err(error("REGISTRATION_MISMATCH"));
    }
    let attempt = id(task, "attempt_id")?;
    let fence = revision(task, "fence")?;
    if attempt != format!("attempt-{task_id}-{fence}") {
        return Err(error("STALE_BINDING"));
    }
    let occurrences = plans
        .iter()
        .filter_map(|p| p["tasks"].as_array())
        .flatten()
        .filter(|t| t["attempt_id"] == attempt)
        .count();
    if occurrences != 1 {
        return Err(error("AMBIGUOUS_BINDING"));
    }
    let dispatched = number(task, "dispatch_at")?;
    if dispatched > now || dispatched >= number(approval, "expires_at")? {
        return Err(error("STALE_BINDING"));
    }
    let consistent = match state {
        "dispatch_intent" | "accepted" | "running" => {
            task["status"] == "running" && task["outcome"] == "pending"
        }
        "unknown" => task["status"] == "unknown" && task["outcome"] == "unknown",
        "stop_requested" | "stop_unconfirmed" => {
            matches!(task["outcome"].as_str(), Some("pending" | "unknown"))
                && matches!(task["status"].as_str(), Some("running" | "unknown"))
                && id(task, "stop_request_id").is_ok()
                && number(task, "stop_requested_at").is_ok_and(|n| n <= now)
        }
        "stopped_confirmed" => match task["outcome"].as_str() {
            Some("succeeded") => task["status"] == "completed",
            Some("failed" | "unknown") => task["status"] == "stopped",
            Some("rejected") => task["status"] == "rejected",
            _ => false,
        },
        _ => false,
    };
    if !consistent {
        return Err(error("STALE_BINDING"));
    }
    if task["requires_decision"] == true {
        let decision = &task["decision_binding"];
        if decision["approved"] != true
            || decision["content_hash"] != task["instruction_hash"]
            || decision["instruction_revision"] != task["instruction_revision"]
            || revision(decision, "revision").is_err()
            || id(decision, "decision_id").is_err()
        {
            return Err(error("HUMAN_DECISION_REQUIRED"));
        }
        if state != "stopped_confirmed"
            && (plan["decision"]["status"] != "approved"
                || plan["decision"]["task_id"] != task["task_id"]
                || plan["decision"]["content_hash"] != task["instruction_hash"]
                || plan["decision"]["decision_id"] != decision["decision_id"]
                || plan["decision"]["revision"] != decision["revision"])
        {
            return Err(error("HUMAN_DECISION_REQUIRED"));
        }
    }
    let binding = CliBinding {
        principal_id: "local-user".into(),
        workspace_id: "synthetic-workspace".into(),
        plan_id: plan_id.into(),
        plan_revision,
        task_id: task_id.into(),
        instruction_revision: revision(task, "instruction_revision")?,
        instruction_hash: text(task, "instruction_hash")?.into(),
        approval_id: id(approval, "approval_id")?.into(),
        approval_revision,
        scope_hash: text(approval, "scope_hash")?.into(),
        // The plan above is checked against the fixture host; the binding names
        // the host the registration was given for its profile.
        execution_host_id: registration.host.clone(),
        executor_instance_id: registration.instance.clone(),
        attempt_id: attempt.into(),
        fence,
        provider: registration.profile.provider().into(),
        profile_id: registration.profile_id.clone(),
    };
    binding.validate()?;
    Ok(binding)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestOperation {
    Start,
    Poll,
    Stop,
    Query,
}
impl RequestOperation {
    fn name(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Poll => "poll",
            Self::Stop => "stop",
            Self::Query => "query",
        }
    }
}
/// Versioned canonical content identity, not a grant or proof of delivery.
/// Stop requires its persisted domain stop ID; other operations reject one.
pub fn request_id(
    operation: RequestOperation,
    binding: &CliBinding,
    stop_request_id: Option<&str>,
) -> Result<String, BindingError> {
    binding.validate()?;
    match (operation, stop_request_id) {
        (RequestOperation::Stop, Some(id)) if valid_id(id, 128) => {}
        (RequestOperation::Start | RequestOperation::Poll | RequestOperation::Query, None) => {}
        _ => return Err(error("INVALID_REQUEST_CONTENT")),
    }
    let content = json!({"contract":"many-iris-cli-request/1","operation":operation.name(),"binding":binding,"stop_request_id":stop_request_id});
    Ok(format!(
        "iris-{}-{}",
        operation.name(),
        hash(&content.to_string())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Value, u64) {
        let root = tempfile::tempdir().unwrap();
        let mut store = crate::domain::Store::open(&root.path().join("domain.sqlite3")).unwrap();
        let snapshot = store.snapshot().unwrap();
        let p = &snapshot["plans"][0];
        let envelope = |request: &str, payload: Value| json!({"request_id":request,"principal_id":"local-user","workspace_id":"synthetic-workspace","payload":payload});
        store.apply("start_plan",&envelope("start",json!({"plan_id":p["plan_id"],"plan_revision":p["plan_revision"],"plan_hash":p["plan_hash"],"approval_id":p["approval"]["approval_id"],"approval_revision":p["approval"]["revision"]}))).unwrap();
        let snapshot = store.snapshot().unwrap();
        let p = &snapshot["plans"][0];
        let t = &p["tasks"][0];
        store.apply("dispatch_attempt",&envelope("dispatch",json!({"run_id":p["run_id"],"task_id":t["task_id"],"instruction_revision":t["instruction_revision"],"instruction_hash":t["instruction_hash"],"executor_id":"synthetic-executor","executor_instance_id":"boot-1","execution_host_id":"synthetic-host"}))).unwrap();
        let snapshot = store.snapshot().unwrap();
        let now = snapshot["plans"][0]["tasks"][0]["dispatch_at"]
            .as_u64()
            .unwrap();
        (root, snapshot, now)
    }
    fn convert(snapshot: &Value, now: u64) -> Result<CliBinding, BindingError> {
        from_snapshot(
            snapshot,
            "plan-1",
            "plan-1-task-1",
            &ExecutorRegistration::synthetic("boot-1").unwrap(),
            now,
        )
    }
    #[test]
    fn real_store_attempt_converts_all_sixteen_fields_without_evidence() {
        let (_root, snapshot, now) = fixture();
        let b = convert(&snapshot, now).unwrap();
        let value = serde_json::to_value(&b).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 16);
        assert_eq!(b.attempt_id, "attempt-plan-1-task-1-1");
        assert_eq!(b.provider, "synthetic");
        assert_eq!(b.profile_id, "synthetic");
        assert_eq!(b.scope_hash, snapshot["plans"][0]["approval"]["scope_hash"]);
        assert_eq!(serde_json::from_value::<CliBinding>(value).unwrap(), b);
    }
    #[test]
    fn stale_scope_source_instruction_restore_expiry_and_registration_fail_closed() {
        let (_root, snapshot, now) = fixture();
        for mutate in [
            (|v: &mut Value| v["plans"][0]["source_text"] = json!("changed")) as fn(&mut Value),
            |v| v["plans"][0]["tasks"][0]["instruction"] = json!("changed"),
            |v| v["plans"][0]["plan_revision"] = json!(2),
            |v| v["plans"][0]["approval"]["revision"] = json!(2),
            |v| v["plans"][0]["approval"]["status"] = json!("revoked"),
            |v| v["restore_hold"] = json!(true),
            |v| v["synthetic"] = json!(false),
            |v| v["plans"][0]["tasks"][0]["executor_instance_id"] = json!("stale-boot"),
            |v| v["plans"][0]["tasks"][0]["execution_host_id"] = json!("other-host"),
            |v| v["plans"][0]["tasks"][0]["executor_id"] = json!("synthetic-executor-backup"),
            |v| v["plans"][0]["tasks"][0]["fence"] = json!(2),
        ] {
            let mut v = snapshot.clone();
            mutate(&mut v);
            assert!(convert(&v, now).is_err());
        }
        let expires = snapshot["plans"][0]["approval"]["expires_at"]
            .as_u64()
            .unwrap();
        assert!(convert(&snapshot, expires).is_err());
        let mut extended = snapshot.clone();
        extended["plans"][0]["approval"]["scope"]["allow_any_provider"] = json!(true);
        extended["plans"][0]["approval"]["scope_hash"] =
            json!(hash(&extended["plans"][0]["approval"]["scope"].to_string()));
        assert!(convert(&extended, now).is_err());
    }
    #[test]
    fn unknown_and_stop_recovery_keep_exact_identity_without_authorizing_retry() {
        let (_root, snapshot, now) = fixture();
        let original = convert(&snapshot, now).unwrap();
        let mut unknown = snapshot.clone();
        unknown["plans"][0]["tasks"][0]["execution_state"] = json!("unknown");
        unknown["plans"][0]["tasks"][0]["status"] = json!("unknown");
        unknown["plans"][0]["tasks"][0]["outcome"] = json!("unknown");
        assert_eq!(convert(&unknown, now).unwrap(), original);
        unknown["plans"][0]["tasks"][0]["execution_state"] = json!("stop_unconfirmed");
        unknown["plans"][0]["tasks"][0]["stop_request_id"] = json!("stop-1");
        unknown["plans"][0]["tasks"][0]["stop_requested_at"] = json!(now);
        assert_eq!(convert(&unknown, now).unwrap(), original);
        unknown["plans"][0]["tasks"][0]["execution_state"] = json!("not_dispatched");
        assert!(convert(&unknown, now).is_err());
    }
    #[test]
    fn strict_shape_and_request_content_identity_include_every_binding_field() {
        let (_root, snapshot, now) = fixture();
        let b = convert(&snapshot, now).unwrap();
        let mut value = serde_json::to_value(&b).unwrap();
        value["surprise"] = json!(true);
        assert!(serde_json::from_value::<CliBinding>(value).is_err());
        let baseline = request_id(RequestOperation::Start, &b, None).unwrap();
        assert_eq!(
            baseline,
            request_id(RequestOperation::Start, &b, None).unwrap()
        );
        for operation in [RequestOperation::Poll, RequestOperation::Query] {
            assert_ne!(baseline, request_id(operation, &b, None).unwrap());
        }
        for key in serde_json::to_value(&b)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
        {
            let mut changed = serde_json::to_value(&b).unwrap();
            changed[key] = if changed[key].is_u64() {
                json!(changed[key].as_u64().unwrap() + 1)
            } else if key.ends_with("hash") {
                json!("f".repeat(64))
            } else {
                json!(format!("{}x", changed[key].as_str().unwrap()))
            };
            let other: CliBinding = serde_json::from_value(changed).unwrap();
            assert_ne!(
                baseline,
                request_id(RequestOperation::Start, &other, None).unwrap(),
                "{key}"
            );
        }
        assert!(request_id(RequestOperation::Stop, &b, None).is_err());
        assert!(request_id(RequestOperation::Start, &b, Some("stop-1")).is_err());
        assert_ne!(
            request_id(RequestOperation::Stop, &b, Some("stop-1")).unwrap(),
            request_id(RequestOperation::Stop, &b, Some("stop-2")).unwrap()
        );
        let mut real = b;
        real.provider = "codex".into();
        real.profile_id = "default".into();
        assert!(real.validate().is_ok());
    }

    #[test]
    fn sha256_hex_hashes_the_exact_bytes_without_conversion() {
        // FIPS 180 test vectors.
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        // Newline style, BOM and trailing space are part of the identity.
        let plain = sha256_hex(b"a\nb");
        for other in [&b"a\r\nb"[..], b"a\nb ", b"a\nb\n", b"\xef\xbb\xbfa\nb"] {
            assert_ne!(sha256_hex(other), plain);
        }
        assert_eq!(hash("a\nb"), plain);
    }

    #[test]
    fn owned_profile_table_has_exactly_two_exact_entries() {
        assert_eq!(
            OwnedProfile::parse("iris-owned-dispatch/1").unwrap(),
            OwnedProfile::Synthetic
        );
        assert_eq!(
            OwnedProfile::parse("iris-owned-real-bounded/1").unwrap(),
            OwnedProfile::RealBounded
        );
        for profile in [OwnedProfile::Synthetic, OwnedProfile::RealBounded] {
            assert_eq!(OwnedProfile::parse(profile.as_str()).unwrap(), profile);
        }
        assert_eq!(OwnedProfile::Synthetic.provider(), "synthetic");
        assert!(OwnedProfile::Synthetic.admits_profile_id("synthetic"));
        assert!(!OwnedProfile::Synthetic.admits_profile_id("claude-example"));
        assert_eq!(OwnedProfile::RealBounded.provider(), "claude");
        // The real profiles have no built-in subscription profile: any configured
        // name of the id shape is admitted, except the synthetic one.
        for configured in ["claude-example", "work_2", "A", &"p".repeat(128)] {
            assert!(
                OwnedProfile::RealBounded.admits_profile_id(configured),
                "{configured:?}"
            );
            assert!(
                OwnedProfile::RealProject.admits_profile_id(configured),
                "{configured:?}"
            );
        }
        for bad in [
            "",
            "synthetic",
            "claude example",
            "claude.example",
            " claude",
            "claude\u{7}",
            "claude\u{202e}",
            "プロファイル",
            &"p".repeat(129),
        ] {
            assert!(!OwnedProfile::RealBounded.admits_profile_id(bad), "{bad:?}");
            assert!(!OwnedProfile::RealProject.admits_profile_id(bad), "{bad:?}");
        }
        for unknown in [
            "",
            "iris-owned-real-bounded",
            "iris-owned-real-bounded/0",
            "iris-owned-real-bounded/2",
            "iris-owned-real-bounded/1 ",
            " iris-owned-real-bounded/1",
            "iris-owned-real-bounded/10",
            "IRIS-OWNED-REAL-BOUNDED/1",
            "iris-owned-dispatch/2",
            "iris-owned-dispatch/10",
            "iris-owned-/1",
            "iris-execution/1",
            "stdio-synthetic/1",
            "claude",
        ] {
            assert!(OwnedProfile::parse(unknown).is_err(), "{unknown:?}");
            assert!(
                serde_json::from_value::<OwnedProfile>(json!(unknown)).is_err(),
                "{unknown:?}"
            );
        }
        for not_text in [json!(null), json!(1), json!(true), json!(["x"])] {
            assert!(serde_json::from_value::<OwnedProfile>(not_text).is_err());
        }
        assert_eq!(
            serde_json::from_value::<OwnedProfile>(json!("iris-owned-real-bounded/1")).unwrap(),
            OwnedProfile::RealBounded
        );
    }
    #[test]
    fn each_profile_admits_only_its_own_provider_pair_and_host_scope() {
        let (_root, snapshot, now) = fixture();
        let synthetic = convert(&snapshot, now).unwrap();
        assert!(OwnedProfile::Synthetic.admits(&synthetic));
        assert!(!OwnedProfile::RealBounded.admits(&synthetic));
        assert_eq!(
            OwnedProfile::for_binding(&synthetic),
            Some(OwnedProfile::Synthetic)
        );
        let mut real = synthetic.clone();
        real.provider = "claude".into();
        real.profile_id = "claude-example".into();
        assert!(OwnedProfile::RealBounded.admits(&real));
        assert!(!OwnedProfile::Synthetic.admits(&real));
        assert_eq!(
            OwnedProfile::for_binding(&real),
            Some(OwnedProfile::RealBounded)
        );
        for (provider, profile_id, host) in [
            ("claude", "synthetic", "synthetic-host"),
            ("synthetic", "claude-example", "synthetic-host"),
            ("claude", "claude other", "synthetic-host"),
            ("claude", "", "synthetic-host"),
            ("codex", "claude-example", "synthetic-host"),
            ("codex", "default", "synthetic-host"),
            ("Claude", "claude-example", "synthetic-host"),
            ("claude", "claude-example", ""),
            ("claude", "claude-example", "host\u{7}"),
            ("synthetic", "synthetic", "other-host"),
            ("synthetic", "synthetic", "host-example-test"),
            ("synthetic", "synthetic", ""),
        ] {
            let mut other = real.clone();
            other.provider = provider.into();
            other.profile_id = profile_id.into();
            other.execution_host_id = host.into();
            assert!(
                !OwnedProfile::RealBounded.admits(&other),
                "{provider} {host:?}"
            );
            assert!(
                !OwnedProfile::Synthetic.admits(&other),
                "{provider} {host:?}"
            );
            assert_eq!(OwnedProfile::for_binding(&other), None);
        }
        // The real profile takes the configured host; the default one never does.
        for host in [
            "other-host",
            "host-example-test",
            "Lab_PC-1-local",
            &"h".repeat(128),
        ] {
            let mut configured = real.clone();
            configured.execution_host_id = host.into();
            assert!(OwnedProfile::RealBounded.admits(&configured), "{host:?}");
            assert_eq!(
                OwnedProfile::for_binding(&configured),
                Some(OwnedProfile::RealBounded)
            );
            let mut default = synthetic.clone();
            default.execution_host_id = host.into();
            assert!(!OwnedProfile::Synthetic.admits(&default), "{host:?}");
            assert_eq!(OwnedProfile::for_binding(&default), None);
        }
        assert!(OwnedProfile::Synthetic.admits_host("synthetic-host"));
        assert!(OwnedProfile::RealBounded.admits_host("synthetic-host"));
    }
    #[test]
    fn host_is_ascii_letters_digits_dash_underscore_of_one_to_128_bytes() {
        for host in [
            "h",
            "-",
            "_",
            "synthetic-host",
            "host-example-test",
            "Lab_PC-2-local",
            "UPPER_lower-09-x",
            &"h".repeat(128),
        ] {
            assert!(valid_host_id(host), "{host:?}");
        }
        let bad = [
            "",
            // `.` is refused everywhere, as in the CLI's identity and binding
            // check: alone, doubled, leading, trailing and inside a dotted name.
            ".",
            "..",
            "host.",
            ".host",
            "a..b",
            "lab-pc.local",
            "host.example.test",
            "Lab_PC-2.local",
            "lab pc",
            " host",
            "host ",
            "host\u{202e}",
            "host\u{200b}",
            "\u{feff}host",
            "ホスト",
            "ｈｏｓｔ",
            "h\u{e9}",
            "host:80",
            "host/x",
            "host,x",
            "a\u{0}b",
            "a\u{1f}b",
            "a\u{7f}b",
            "a\u{85}b",
            "a\tb",
            "a\nb",
            "a\rb",
            "a\u{1b}[31mb",
            &"h".repeat(129),
            &"h".repeat(257),
            &"あ".repeat(60),
        ];
        for host in bad {
            assert!(!valid_host_id(host), "{host:?}");
            assert!(!OwnedProfile::RealBounded.admits_host(host), "{host:?}");
            assert!(!OwnedProfile::Synthetic.admits_host(host), "{host:?}");
        }
        // The same rule applies to the binding as a whole: validate() is no
        // looser about the host than the profiles are.
        let (_root, snapshot, now) = fixture();
        let mut b = convert(&snapshot, now).unwrap();
        for host in ["host-example-test", "Lab_PC-2-local", &"h".repeat(128)] {
            b.execution_host_id = host.into();
            assert!(b.validate().is_ok(), "{host:?}");
            assert!(request_id(RequestOperation::Start, &b, None).is_ok());
        }
        for host in bad {
            b.execution_host_id = host.into();
            assert!(b.validate().is_err(), "{host:?}");
            assert!(request_id(RequestOperation::Start, &b, None).is_err());
        }
    }
    #[test]
    fn registration_writes_only_the_chosen_profiles_pair_and_keeps_every_snapshot_check() {
        let (_root, snapshot, now) = fixture();
        let synthetic = convert(&snapshot, now).unwrap();
        let registration = ExecutorRegistration::for_profile(
            OwnedProfile::RealBounded,
            "boot-1",
            FIXTURE_HOST,
            "claude-example",
        )
        .unwrap();
        let real = from_snapshot(&snapshot, "plan-1", "plan-1-task-1", &registration, now).unwrap();
        assert_eq!(real.provider, "claude");
        assert_eq!(real.profile_id, "claude-example");
        // The binding names the registration's configured subscription profile.
        let other_profile = ExecutorRegistration::for_profile(
            OwnedProfile::RealBounded,
            "boot-1",
            FIXTURE_HOST,
            "work_2",
        )
        .unwrap();
        let other =
            from_snapshot(&snapshot, "plan-1", "plan-1-task-1", &other_profile, now).unwrap();
        assert_eq!(other.profile_id, "work_2");
        assert_ne!(
            request_id(RequestOperation::Start, &real, None).unwrap(),
            request_id(RequestOperation::Start, &other, None).unwrap()
        );
        for bad in ["", "synthetic", "claude example", &"p".repeat(129)] {
            assert!(
                ExecutorRegistration::for_profile(
                    OwnedProfile::RealBounded,
                    "boot-1",
                    FIXTURE_HOST,
                    bad
                )
                .is_err(),
                "{bad:?}"
            );
        }
        assert!(
            ExecutorRegistration::for_profile(
                OwnedProfile::Synthetic,
                "boot-1",
                FIXTURE_HOST,
                "claude-example"
            )
            .is_err()
        );
        let mut rest = real.clone();
        rest.provider = synthetic.provider.clone();
        rest.profile_id = synthetic.profile_id.clone();
        assert_eq!(rest, synthetic);
        assert_ne!(
            request_id(RequestOperation::Start, &real, None).unwrap(),
            request_id(RequestOperation::Start, &synthetic, None).unwrap()
        );
        assert!(
            ExecutorRegistration::for_profile(
                OwnedProfile::RealBounded,
                "bad id",
                FIXTURE_HOST,
                "claude-example"
            )
            .is_err()
        );
        assert!(
            ExecutorRegistration::for_profile(
                OwnedProfile::RealBounded,
                "",
                FIXTURE_HOST,
                "claude-example"
            )
            .is_err()
        );
        for mutate in [
            (|v: &mut Value| v["plans"][0]["source_text"] = json!("changed")) as fn(&mut Value),
            |v| v["plans"][0]["approval"]["status"] = json!("revoked"),
            |v| v["restore_hold"] = json!(true),
            |v| v["synthetic"] = json!(false),
            |v| v["plans"][0]["tasks"][0]["executor_instance_id"] = json!("stale-boot"),
            |v| v["plans"][0]["tasks"][0]["execution_host_id"] = json!("other-host"),
        ] {
            let mut v = snapshot.clone();
            mutate(&mut v);
            assert!(from_snapshot(&v, "plan-1", "plan-1-task-1", &registration, now).is_err());
        }
        let expires = snapshot["plans"][0]["approval"]["expires_at"]
            .as_u64()
            .unwrap();
        assert!(
            from_snapshot(&snapshot, "plan-1", "plan-1-task-1", &registration, expires).is_err()
        );
    }

    #[test]
    fn the_binding_host_is_the_registrations_host_while_the_plan_stays_on_the_fixture_host() {
        let (_root, snapshot, now) = fixture();
        let synthetic = convert(&snapshot, now).unwrap();
        assert_eq!(synthetic.execution_host_id, FIXTURE_HOST);
        for host in ["claude-host-01", "host-example-test", "Lab_PC-2-local"] {
            let registration = ExecutorRegistration::for_profile(
                OwnedProfile::RealBounded,
                "boot-1",
                host,
                "claude-example",
            )
            .unwrap();
            let real =
                from_snapshot(&snapshot, "plan-1", "plan-1-task-1", &registration, now).unwrap();
            assert_eq!(real.execution_host_id, host);
            assert!(OwnedProfile::RealBounded.admits(&real));
            let mut rest = real.clone();
            rest.provider = synthetic.provider.clone();
            rest.profile_id = synthetic.profile_id.clone();
            rest.execution_host_id = synthetic.execution_host_id.clone();
            assert_eq!(rest, synthetic);
            // The host is part of the request's content identity.
            let on_fixture = ExecutorRegistration::for_profile(
                OwnedProfile::RealBounded,
                "boot-1",
                FIXTURE_HOST,
                "claude-example",
            )
            .unwrap();
            let fixture_binding =
                from_snapshot(&snapshot, "plan-1", "plan-1-task-1", &on_fixture, now).unwrap();
            assert_ne!(
                request_id(RequestOperation::Start, &real, None).unwrap(),
                request_id(RequestOperation::Start, &fixture_binding, None).unwrap()
            );
            // The approved plan and its task keep the fixture host: a snapshot
            // that names the configured host is not accepted for either profile.
            for mutate in [
                (|v: &mut Value, h: &str| v["plans"][0]["tasks"][0]["execution_host_id"] = json!(h))
                    as fn(&mut Value, &str),
                |v, h| v["plans"][0]["approval"]["scope"]["execution_host_id"] = json!(h),
            ] {
                let mut v = snapshot.clone();
                mutate(&mut v, host);
                assert!(
                    from_snapshot(&v, "plan-1", "plan-1-task-1", &registration, now).is_err(),
                    "{host:?}"
                );
            }
        }
        // The default profile's registration admits only the fixture host, and no
        // registration may be built without an admitted host.
        for host in ["claude-host-01", "other-host", "", "host\u{7}"] {
            assert!(
                ExecutorRegistration::for_profile(
                    OwnedProfile::Synthetic,
                    "boot-1",
                    host,
                    SYNTHETIC_PROFILE_ID
                )
                .is_err(),
                "{host:?}"
            );
        }
        for host in [
            "",
            "host\u{7}",
            "host\nname",
            "lab pc",
            " host",
            "host ",
            "host\u{202e}",
            "ホスト",
            &"h".repeat(129),
            &"h".repeat(257),
        ] {
            assert!(
                ExecutorRegistration::for_profile(
                    OwnedProfile::RealBounded,
                    "boot-1",
                    host,
                    "claude-example"
                )
                .is_err(),
                "{host:?}"
            );
        }
        assert!(
            ExecutorRegistration::for_profile(
                OwnedProfile::Synthetic,
                "boot-1",
                FIXTURE_HOST,
                SYNTHETIC_PROFILE_ID
            )
            .is_ok()
        );
    }

    #[test]
    fn stale_human_decision_cannot_be_substituted_for_current_approval() {
        let (_root, mut snapshot, now) = fixture();
        let p = &mut snapshot["plans"][0];
        p["tasks"][0]["requires_decision"] = json!(true);
        p["approval"]["scope"]["task_bindings"][0]["requires_decision"] = json!(true);
        p["approval"]["scope_hash"] = json!(hash(&p["approval"]["scope"].to_string()));
        assert_eq!(
            convert(&snapshot, now).unwrap_err().code(),
            "HUMAN_DECISION_REQUIRED"
        );
        let p = &mut snapshot["plans"][0];
        p["tasks"][0]["decision_binding"] = json!({"decision_id":"decision-1","revision":1,"content_hash":p["tasks"][0]["instruction_hash"],"instruction_revision":1,"approved":true});
        p["decision"] = json!({"decision_id":"decision-1","revision":1,"task_id":"plan-1-task-1","content_hash":p["tasks"][0]["instruction_hash"],"status":"approved"});
        assert!(convert(&snapshot, now).is_ok());
        snapshot["plans"][0]["decision"]["revision"] = json!(2);
        assert_eq!(
            convert(&snapshot, now).unwrap_err().code(),
            "HUMAN_DECISION_REQUIRED"
        );
    }
}
