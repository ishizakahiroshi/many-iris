//! Explicit owned HTTP composition for the two adopted profile bindings only:
//! the default synthetic one, and the opt-in real-bounded one. The profile is
//! read once from the configuration file and nothing else picks or changes it.
//! The real-bounded profile's execution host is likewise the configured binding's
//! own `execution_host_id` (the user sets the CLI identity's value there); it has
//! no default, and the peer must report exactly that value before any intent is
//! stored. The default profile stays on the fixture host.
//! Only the real-bounded profile may also carry a `real_bounded` section: the
//! instruction file the CLI will read and 1 to 3 real-send tasks with distinct
//! plan, task and approval ids. It is read once here, at startup, and refused
//! unless the file is a bounded regular non-blank UTF-8 file of at most 64 KiB
//! without NUL; the store then holds those tasks and their instruction hash is
//! the SHA-256 of the file's bytes. The default profile refuses the section.
//! The real-project profile (`iris-owned-real-project/1`) instead carries a
//! `real_cases` list and no top-level binding or request: 1 to 3 cases, each with
//! its own markdown, instruction file, hashes, request id and binding (see
//! `real_project`). Loading never opens a case file. The scheduler then works
//! each case on its own: a case is connected only once the user has started its
//! plan, its instruction file is hashed again right before its intent is stored,
//! and an error belongs to that case alone.
//! Every attempted delivery is committed first. Native observations are retained
//! by Store without turning local cessation or payload equality into task proof.
use crate::{
    cli_binding::{CliBinding, OwnedProfile},
    cli_executor::Client,
    domain::{REAL_INSTRUCTION_LIMIT, RealFixture, RealTask, Store},
    mcp,
    real_project::{self, RealCase, RealProject},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

/// Per-case scheduler errors of the real-project profile, keyed by plan id.
pub type CaseErrors = Arc<Mutex<BTreeMap<String, String>>>;

pub enum ExecutorConfig {
    StdioSynthetic,
    OwnedHttp(OwnedConfig),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StdioConfig {
    schema_version: u64,
    profile: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnedConfig {
    schema_version: u64,
    profile: OwnedProfile,
    port: u16,
    credential_file: PathBuf,
    /// Required by the synthetic and real-bounded profiles; refused by the
    /// real-project profile, whose cases carry their own.
    binding: Option<CliBinding>,
    request_id: Option<String>,
    real_bounded: Option<RealBoundedConfig>,
    real_cases: Option<Vec<RealCase>>,
    /// Built from `real_bounded` by `ExecutorConfig::load`; never read from JSON.
    #[serde(skip)]
    real_fixture: Option<RealFixture>,
    /// Built from `real_cases` by `ExecutorConfig::load`; never read from JSON.
    #[serde(skip)]
    real_project: Option<RealProject>,
    /// What the scheduler sends: one entry for the synthetic and real-bounded
    /// profiles, one per case for the real-project profile.
    #[serde(skip)]
    sends: Vec<Outgoing>,
}

/// One binding the scheduler may send, with its request id. `case` is the
/// real-project case index it came from.
#[derive(Clone)]
struct Outgoing {
    binding: CliBinding,
    request_id: String,
    case: Option<usize>,
}

/// Settings only the `iris-owned-real-bounded/1` profile accepts.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RealBoundedConfig {
    /// The file the CLI reads and hashes; a relative path is relative to the
    /// configuration file.
    instruction_file: PathBuf,
    tasks: Vec<RealTask>,
}

impl OwnedConfig {
    /// The real-bounded tasks and instruction the store must be made from, if the
    /// configuration carried them.
    pub fn real_fixture(&self) -> Option<&RealFixture> {
        self.real_fixture.as_ref()
    }
    /// The real-project cases the store must be made from, if configured.
    pub fn real_project(&self) -> Option<&RealProject> {
        self.real_project.as_ref()
    }
    /// The profile the configuration names.
    pub fn profile(&self) -> OwnedProfile {
        self.profile
    }
}

/// `--real-cases-preview`: read a real-project configuration's case files and
/// report ids, sizes, the actual hashes, the scope hash they give and whether
/// each instruction holds its markdown. Never any content, never a store or a
/// connection. Hash agreement is reported, not required, so the report can be
/// used to fill a configuration in.
pub fn real_cases_preview(path: &Path) -> Result<Value, String> {
    let bytes = bounded_file(path, mcp::MAX_BYTES)?;
    let value = mcp::parse_json(&bytes).map_err(|_| "Invalid bounded executor configuration")?;
    if value["profile"] != OwnedProfile::RealProject.as_str() {
        return Err("The preview is only for the real-project profile".into());
    }
    let config: OwnedConfig =
        serde_json::from_value(value).map_err(|_| "Invalid owned executor configuration fields")?;
    let cases = config
        .real_cases
        .ok_or("The real-project profile needs real_cases")?;
    RealProject::check_shape(&cases).map_err(|e| format!("Invalid real cases: {e}"))?;
    Ok(real_project::preview(&cases))
}

fn valid_request(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// Do not create credentials, follow a credential symlink, or print config data.
fn bounded_file(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "Executor file unavailable")?;
    if !metadata.file_type().is_file() || metadata.len() > limit as u64 {
        return Err("Executor file must be a bounded regular file".into());
    }
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: inspect the opened final object rather
        // than following a replacement symlink between metadata and open.
        options.custom_flags(0x0020_0000);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Executor file unavailable")?;
    let opened = file.metadata().map_err(|_| "Executor file unavailable")?;
    if !opened.is_file() || opened.len() > limit as u64 {
        return Err("Executor file must be a bounded regular file".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.file_attributes() & 0x400 != 0 {
            return Err("Executor file alias unavailable".into());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
            return Err("Executor file identity changed".into());
        }
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Executor file unavailable")?;
    if bytes.len() > limit {
        return Err("Executor file exceeds byte limit".into());
    }
    Ok(bytes)
}

impl ExecutorConfig {
    pub fn load(path: &Path) -> Result<Self, String> {
        let bytes = bounded_file(path, mcp::MAX_BYTES)?;
        let value =
            mcp::parse_json(&bytes).map_err(|_| "Invalid bounded executor configuration")?;
        match value["profile"].as_str() {
            Some("stdio-synthetic/1") => {
                let config: StdioConfig = serde_json::from_value(value)
                    .map_err(|_| "Invalid stdio executor configuration fields")?;
                if config.schema_version != 1 || config.profile != "stdio-synthetic/1" {
                    return Err("Unsupported stdio executor configuration".into());
                }
                Ok(Self::StdioSynthetic)
            }
            // Only the exact adopted strings reach here; an unknown profile is
            // refused at startup by the arm below, never mapped to a default.
            Some(name) if OwnedProfile::parse(name).is_ok() => {
                // Presence, not value: a null section is not "unset" for a profile
                // that must not carry one.
                let has_real_bounded = value.get("real_bounded").is_some();
                let has_real_cases = value.get("real_cases").is_some();
                let has_top_binding =
                    value.get("binding").is_some() || value.get("request_id").is_some();
                let mut config: OwnedConfig = serde_json::from_value(value)
                    .map_err(|_| "Invalid owned executor configuration fields")?;
                let base = path.parent().unwrap_or_else(|| Path::new("."));
                if config.profile == OwnedProfile::RealProject {
                    if config.schema_version != 1
                        || config.port == 0
                        || config.credential_file.as_os_str().is_empty()
                    {
                        return Err(
                            "Owned executor configuration outside adopted profile scope".into()
                        );
                    }
                    if has_real_bounded || has_top_binding {
                        return Err(
                            "The real-project profile takes its bindings and requests from real_cases only"
                                .into(),
                        );
                    }
                    let cases = config
                        .real_cases
                        .take()
                        .ok_or("The real-project profile needs a real_cases list")?;
                    let project =
                        RealProject::new(cases).map_err(|e| format!("Invalid real cases: {e}"))?;
                    config.sends = project
                        .cases()
                        .iter()
                        .enumerate()
                        .map(|(i, case)| Outgoing {
                            binding: case.binding.clone(),
                            request_id: case.request_id.clone(),
                            case: Some(i),
                        })
                        .collect();
                    config.real_project = Some(project);
                    if config.credential_file.is_relative() {
                        config.credential_file = base.join(&config.credential_file);
                    }
                    return Ok(Self::OwnedHttp(config));
                }
                if has_real_cases {
                    return Err("Real cases are only for the real-project profile".into());
                }
                let (Some(binding), Some(request_id)) =
                    (config.binding.clone(), config.request_id.clone())
                else {
                    return Err("Invalid owned executor configuration fields".into());
                };
                binding
                    .validate()
                    .map_err(|_| "Invalid complete owned binding")?;
                if config.schema_version != 1
                    || config.port == 0
                    || config.credential_file.as_os_str().is_empty()
                    || !valid_request(&request_id)
                    || !config.profile.admits(&binding)
                {
                    return Err("Owned executor configuration outside adopted profile scope".into());
                }
                if has_real_bounded {
                    if config.profile != OwnedProfile::RealBounded {
                        return Err(
                            "Real-bounded settings are only for the real-bounded profile".into(),
                        );
                    }
                    let real = config
                        .real_bounded
                        .as_ref()
                        .ok_or("Real-bounded settings must be an object")?;
                    if real.instruction_file.as_os_str().is_empty() {
                        return Err("Real-bounded instruction file is missing".into());
                    }
                    let file = if real.instruction_file.is_relative() {
                        base.join(&real.instruction_file)
                    } else {
                        real.instruction_file.clone()
                    };
                    let bytes = bounded_file(&file, REAL_INSTRUCTION_LIMIT).map_err(|_| {
                        "Real-bounded instruction file must be an existing regular file of at most 64 KiB"
                    })?;
                    let fixture = RealFixture::new(&bytes, real.tasks.clone())
                        .map_err(|e| format!("Invalid real-bounded settings: {e}"))?;
                    // The binding must be one of the configured tasks and carry the
                    // hash of exactly the bytes the CLI will read.
                    let b = &binding;
                    if !fixture.tasks().iter().any(|t| {
                        t.plan_id == b.plan_id
                            && t.task_id == b.task_id
                            && t.approval_id == b.approval_id
                    }) || b.instruction_hash != fixture.instruction_hash()
                    {
                        return Err(
                            "Real-bounded binding is not one of the configured tasks and instruction"
                                .into(),
                        );
                    }
                    config.real_fixture = Some(fixture);
                }
                config.sends = vec![Outgoing {
                    binding,
                    request_id,
                    case: None,
                }];
                if config.credential_file.is_relative() {
                    config.credential_file = base.join(&config.credential_file);
                }
                Ok(Self::OwnedHttp(config))
            }
            _ => Err("Unsupported explicit executor profile".into()),
        }
    }
}

pub struct OwnedHttp {
    config: OwnedConfig,
    credential: String,
    query: Option<Client>,
    case_errors: CaseErrors,
}

impl OwnedHttp {
    pub fn new(config: OwnedConfig) -> Result<Self, String> {
        let bytes = bounded_file(&config.credential_file, 64)?;
        let credential =
            String::from_utf8(bytes).map_err(|_| "Invalid execution credential format")?;
        if credential.len() != 64 || !credential.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid execution credential format".into());
        }
        Ok(Self {
            config,
            credential,
            query: None,
            case_errors: Arc::new(Mutex::new(BTreeMap::new())),
        })
    }

    /// The profile named by the configuration; used for every call and receipt.
    pub fn profile(&self) -> OwnedProfile {
        self.config.profile
    }

    /// The real-project profile's latest error per case (plan id to code),
    /// replaced after every tick. Always empty for the other profiles, whose
    /// single error is the tick's own result.
    pub fn case_errors(&self) -> CaseErrors {
        self.case_errors.clone()
    }

    pub async fn tick(&mut self, store: &Arc<Mutex<Store>>) -> Result<(), String> {
        if self.config.profile != OwnedProfile::RealProject {
            let send = self.config.sends[0].clone();
            return self.tick_one(&send, store).await;
        }
        // Each case on its own: one case's error neither stops nor delays the
        // others, and is reported against that case only.
        let mut errors = BTreeMap::new();
        for send in self.config.sends.clone() {
            if let Err(error) = self.tick_one(&send, store).await {
                let code = error.split(':').next().unwrap_or("SCHEDULER").to_owned();
                errors.insert(send.binding.plan_id.clone(), code);
            }
        }
        *self.case_errors.lock().map_err(|_| "State lock")? = errors;
        Ok(())
    }

    async fn tick_one(&mut self, send: &Outgoing, store: &Arc<Mutex<Store>>) -> Result<(), String> {
        let profile = self.config.profile;
        let binding = &send.binding;
        let previous = {
            store
                .lock()
                .map_err(|_| "State lock")?
                .owned_request(binding)
                .map_err(|e| e.code)?
        };
        if previous.is_none() {
            // A real-project case is connected only after the user started its
            // plan; until then nothing is opened, stored or sent for it.
            let case = match send.case {
                Some(index) => {
                    let source = store
                        .lock()
                        .map_err(|_| "State lock")?
                        .real_case_source(binding)
                        .map_err(|e| e.code)?;
                    let Some(source) = source else {
                        return Ok(());
                    };
                    let project = self
                        .config
                        .real_project
                        .as_ref()
                        .ok_or("Real-project cases unavailable")?;
                    Some((project.cases()[index].clone(), source))
                }
                None => None,
            };
            // Read-only handshake precedes intent; only this admission connection
            // can send start. Once begin_owned commits, no later tick can resend.
            let mut client =
                Client::connect_owned_profile(self.config.port, &self.credential, profile).await?;
            if client.capabilities()["execution_host_id"] != binding.execution_host_id
                || client.capabilities()["executor_instance_id"] != binding.executor_instance_id
            {
                return Err("Owned execution registration changed before admission".into());
            }
            // The instruction file the CLI will read must still be the configured
            // bytes, and hold the stored markdown, right before the intent.
            if let Some((case, source)) = &case
                && let Err(code) = real_project::check_instruction(case, source)
            {
                let _ = client.shutdown().await;
                return Err(code.into());
            }
            let intent = {
                store
                    .lock()
                    .map_err(|_| "State lock")?
                    .begin_owned(binding, &send.request_id)
                    .map_err(|e| e.code)?
            };
            if intent["fresh"] == true {
                let reply = client
                    .call_owned(
                        "owned_start",
                        json!({
                            "profile":profile.as_str(), "binding":binding,
                            "request_id":send.request_id,
                        }),
                    )
                    .await;
                let _ = client.shutdown().await;
                if reply.is_err() {
                    return Err("OWNED_DELIVERY_UNKNOWN".into());
                }
                return Ok(());
            }
            let _ = client.shutdown().await;
            return Ok(());
        }
        let request_id = previous.ok_or("Owned request identity unavailable")?;
        if request_id != send.request_id {
            return Err("Owned configuration differs from original request identity".into());
        }
        // The user stop ID is persisted by request_stop. Claim commits the
        // one-time delivery marker before any socket is opened; never invent one.
        let stop = {
            let mut core = store.lock().map_err(|_| "State lock")?;
            match core.claim_owned_stop(binding) {
                Ok(stop) => stop,
                Err(error) if error.code == "RESTORE_HOLD" => None,
                Err(error) => return Err(error.code),
            }
        };
        if let Some(stop_id) = stop {
            let mut client =
                Client::connect_owned_stop_profile(self.config.port, &self.credential, profile)
                    .await?;
            let reply = client
                .call_owned(
                    "owned_stop",
                    json!({
                        "profile":profile.as_str(),"binding":binding,"request_id":stop_id,
                    }),
                )
                .await;
            let _ = client.shutdown().await;
            if reply.is_err() {
                return Err("OWNED_STOP_DELIVERY_UNKNOWN".into());
            }
        }
        if self.query.is_none() {
            self.query = Some(
                Client::inspect_owned_profile(self.config.port, &self.credential, profile).await?,
            );
        }
        let observation = self
            .query
            .as_mut()
            .ok_or("Owned query unavailable")?
            .call_owned(
                "owned_request",
                json!({"profile":profile.as_str(),"request_id":request_id}),
            )
            .await;
        match observation {
            Ok(observation) => {
                store
                    .lock()
                    .map_err(|_| "State lock")?
                    .observe_owned(binding, &request_id, &observation)
                    .map_err(|e| e.code)?;
                Ok(())
            }
            Err(_) => {
                if let Some(mut client) = self.query.take() {
                    let _ = client.shutdown().await;
                }
                Err("OWNED_QUERY_UNAVAILABLE".into())
            }
        }
    }

    pub async fn shutdown(&mut self) -> Result<(), String> {
        if let Some(mut client) = self.query.take() {
            client.shutdown().await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_executor::OWNED_PROFILE;
    use serde_json::Value;

    fn binding() -> Value {
        json!({"principal_id":"local-user","workspace_id":"synthetic-workspace","plan_id":"plan","plan_revision":1,"task_id":"task","instruction_revision":1,"instruction_hash":"a".repeat(64),"approval_id":"approval","approval_revision":1,"scope_hash":"b".repeat(64),"execution_host_id":"synthetic-host","executor_instance_id":"boot","attempt_id":"attempt","fence":1,"provider":"synthetic","profile_id":"synthetic"})
    }
    fn config() -> Value {
        json!({"schema_version":1,"profile":OWNED_PROFILE,"port":1,"credential_file":"credential","binding":binding(),"request_id":"start-request"})
    }
    #[test]
    fn configuration_is_explicit_strict_and_never_falls_back() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("executor.json");
        std::fs::write(
            &path,
            r#"{"schema_version":1,"profile":"stdio-synthetic/1"}"#,
        )
        .unwrap();
        assert!(matches!(
            ExecutorConfig::load(&path).unwrap(),
            ExecutorConfig::StdioSynthetic
        ));
        for value in [
            json!({"schema_version":1,"profile":"other"}),
            json!({"schema_version":1,"profile":"stdio-synthetic/1","port":1}),
        ] {
            std::fs::write(&path, value.to_string()).unwrap();
            assert!(ExecutorConfig::load(&path).is_err());
        }
        std::fs::write(
            &path,
            r#"{"schema_version":1,"profile":"stdio-synthetic/1","profile":"stdio-synthetic/1"}"#,
        )
        .unwrap();
        assert!(ExecutorConfig::load(&path).is_err());
    }
    #[test]
    fn owned_configuration_stays_in_fixed_synthetic_scope_and_requires_existing_credential() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("executor.json");
        for key in ["provider", "profile_id", "execution_host_id"] {
            let mut value = config();
            value["binding"][key] = json!("unadopted");
            std::fs::write(&path, value.to_string()).unwrap();
            assert!(ExecutorConfig::load(&path).is_err());
        }
        std::fs::write(&path, config().to_string()).unwrap();
        let ExecutorConfig::OwnedHttp(config) = ExecutorConfig::load(&path).unwrap() else {
            panic!()
        };
        assert!(OwnedHttp::new(config).is_err());
        assert!(!root.path().join("credential").exists());
        std::fs::write(root.path().join("credential"), "a".repeat(64)).unwrap();
        let ExecutorConfig::OwnedHttp(config) = ExecutorConfig::load(&path).unwrap() else {
            panic!()
        };
        assert!(OwnedHttp::new(config).is_ok());
    }
    #[test]
    fn the_profile_in_use_is_exactly_the_one_named_in_the_configuration() {
        const REAL: &str = "iris-owned-real-bounded/1";
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("executor.json");
        std::fs::write(root.path().join("credential"), "a".repeat(64)).unwrap();
        let load = |value: &Value| {
            std::fs::write(&path, value.to_string()).unwrap();
            match ExecutorConfig::load(&path) {
                Ok(ExecutorConfig::OwnedHttp(config)) => Some(OwnedHttp::new(config).unwrap()),
                _ => None,
            }
        };
        assert_eq!(load(&config()).unwrap().profile(), OwnedProfile::Synthetic);
        let mut real = config();
        real["profile"] = json!(REAL);
        real["binding"]["provider"] = json!("claude");
        real["binding"]["profile_id"] = json!("claude-example");
        assert_eq!(load(&real).unwrap().profile(), OwnedProfile::RealBounded);
        // Naming one profile with the other's binding never selects a third one.
        let mut mixed = real.clone();
        mixed["profile"] = json!(OWNED_PROFILE);
        assert!(load(&mixed).is_none());
        let mut mixed = config();
        mixed["profile"] = json!(REAL);
        assert!(load(&mixed).is_none());
        let mut unknown = real;
        unknown["profile"] = json!("iris-owned-real-bounded/2");
        assert!(load(&unknown).is_none());
    }
}
