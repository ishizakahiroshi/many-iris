//! The opt-in real-bounded owned profile, through the public API only: it is used
//! solely when a configuration names it, only for the claude subscription scope,
//! and every other profile string or provider pair is refused. Synthetic fixture
//! values only; no Hub, provider or network is involved.
use many_iris::{
    cli_binding::CliBinding,
    domain::{RealFixture, RealTask, Store},
    mcp,
    owned_http::{ExecutorConfig, OwnedHttp},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

// Literal wire strings on purpose: a silent edit of a constant must fail here.
const SYNTHETIC: &str = "iris-owned-dispatch/1";
const REAL: &str = "iris-owned-real-bounded/1";

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn body(request: &str, operation: &str, payload: Value) -> Value {
    json!({"request_id":request,"principal_id":if matches!(operation,"record_executor_event"|"reconcile_attempt"){"synthetic-executor"}else{"local-user"},"workspace_id":"synthetic-workspace","payload":payload})
}
fn apply(
    store: &mut Store,
    op: &str,
    request: &str,
    payload: Value,
) -> Result<Value, many_iris::domain::DomainError> {
    store.apply(op, &body(request, op, payload))
}
fn started(path: &Path) -> Store {
    let mut store = Store::open(path).unwrap();
    let p = store.snapshot().unwrap()["plans"][0].clone();
    apply(&mut store,"start_plan","start",json!({"plan_id":p["plan_id"],"plan_revision":p["plan_revision"],"plan_hash":p["plan_hash"],"approval_id":p["approval"]["approval_id"],"approval_revision":p["approval"]["revision"]})).unwrap();
    store
}
fn binding(store: &Store, provider: &str, profile_id: &str) -> CliBinding {
    binding_on(store, provider, profile_id, "synthetic-host")
}
fn binding_on(store: &Store, provider: &str, profile_id: &str, host: &str) -> CliBinding {
    let p = store.snapshot().unwrap()["plans"][0].clone();
    let t = &p["tasks"][0];
    serde_json::from_value(json!({"principal_id":"local-user","workspace_id":"synthetic-workspace",
        "plan_id":p["plan_id"],"plan_revision":p["plan_revision"],"task_id":t["task_id"],
        "instruction_revision":t["instruction_revision"],"instruction_hash":t["instruction_hash"],
        "approval_id":p["approval"]["approval_id"],"approval_revision":p["approval"]["revision"],
        "scope_hash":p["approval"]["scope_hash"],"execution_host_id":host,
        "executor_instance_id":"owned-boot","attempt_id":format!("attempt-{}-1",t["task_id"].as_str().unwrap()),
        "fence":1,"provider":provider,"profile_id":profile_id})).unwrap()
}
/// The observation the CLI returns under `profile`. The synthetic profile's
/// `verification` is the verifier receipt itself; the real profile's is the
/// `real_bounded_verification` document that carries the receipt (CLI 8e959f2d).
fn native(profile: &str, b: &CliBinding) -> Value {
    let verification = if profile == REAL {
        real_verification(
            receipt(b, "pass"),
            json!(null),
            json!("folder-payload-only"),
            json!(null),
        )
    } else {
        receipt(b, "pass")
    };
    json!({"profile":profile,"binding":b,
        "request":{"request_receipt":{"binding":b,"request_id":"owned-start","operation":"start"},"current":{"binding":b}},
        "execution":{"binding":b,"owner":{"ticket":{"binding":b,"owner_id":"owner","owner_epoch":1},"local_tree_ceased":true}},
        "verification":verification})
}
/// A fixed-payload verifier receipt, in the shape the CLI's verifier writes.
fn receipt(b: &CliBinding, verdict: &str) -> Value {
    json!({"kind":"independent_verification","verifier":"synthetic-verifier","spec_hash":"d".repeat(64),
        "policy_id":"synthetic-policy","policy_revision":1,"binding":b,"owner_id":"owner","owner_epoch":1,
        "input_sha256":"c".repeat(64),"verdict":verdict,"observed_at_ms":1,
        "verification_scope":"fixed-payload-only","task_outcome_verified":false,
        "effects_verified":false,"remote_jobs_stopped":false})
}
/// The real profile's `verification` document, built the way the CLI builds it:
/// the verdict is copied from the receipt (null when there is none).
fn real_verification(
    receipt: Value,
    reason: Value,
    folder_effects: Value,
    folder_reason: Value,
) -> Value {
    json!({"kind":"real_bounded_verification","verdict":receipt["verdict"],"reason":reason,
        "folder_effects":folder_effects,"folder_reason":folder_reason,"receipt":receipt,
        "task_outcome_verified":false,"effects_verified":false,"remote_jobs_stopped":false})
}
fn config(profile: Value, provider: &str, profile_id: &str, host: &str) -> Value {
    json!({"schema_version":1,"profile":profile,"port":1,"credential_file":"credential",
        "binding":{"principal_id":"local-user","workspace_id":"synthetic-workspace","plan_id":"plan","plan_revision":1,
            "task_id":"task","instruction_revision":1,"instruction_hash":"a".repeat(64),"approval_id":"approval",
            "approval_revision":1,"scope_hash":"b".repeat(64),"execution_host_id":host,
            "executor_instance_id":"boot","attempt_id":"attempt","fence":1,"provider":provider,"profile_id":profile_id},
        "request_id":"start-request"})
}
fn loads(path: &Path, value: &Value) -> bool {
    std::fs::write(path, value.to_string()).unwrap();
    matches!(ExecutorConfig::load(path), Ok(ExecutorConfig::OwnedHttp(_)))
}

#[test]
fn configuration_names_the_profile_and_the_binding_must_be_that_profiles_exact_scope() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("executor.json");
    let host = "synthetic-host";
    // (profile, provider, profile_id, expected to load)
    for (profile, provider, profile_id, ok) in [
        (SYNTHETIC, "synthetic", "synthetic", true),
        (REAL, "claude", "claude-example", true),
        (REAL, "synthetic", "synthetic", false),
        (SYNTHETIC, "claude", "claude-example", false),
        (REAL, "claude", "synthetic", false),
        (REAL, "synthetic", "claude-example", false),
        // The real profile takes the configured subscription profile by its shape.
        (REAL, "claude", "claude-other", true),
        (REAL, "claude", "Claude-Example", true),
        (REAL, "claude", "claude other", false),
        (REAL, "claude", "claude.example", false),
        (REAL, "claude", "", false),
        (REAL, "codex", "claude-example", false),
        (REAL, "Claude", "claude-example", false),
        (SYNTHETIC, "claude", "synthetic", false),
        (SYNTHETIC, "synthetic", "claude-example", false),
    ] {
        assert_eq!(
            loads(&path, &config(json!(profile), provider, profile_id, host)),
            ok,
            "{profile} {provider} {profile_id}"
        );
    }
    // The real profile takes the configured host; the default one stays pinned.
    assert!(loads(
        &path,
        &config(json!(REAL), "claude", "claude-example", "other-host")
    ));
    assert!(!loads(
        &path,
        &config(json!(SYNTHETIC), "synthetic", "synthetic", "other-host")
    ));
}

#[test]
fn unknown_or_malformed_profile_choices_are_refused_at_startup_never_defaulted() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("executor.json");
    for profile in [
        "iris-owned-real-bounded/0",
        "iris-owned-real-bounded/2",
        "iris-owned-real-bounded",
        "iris-owned-real-bounded/1 ",
        " iris-owned-real-bounded/1",
        "iris-owned-real-bounded/1\n",
        "iris-owned-real-bounded/1\u{0}",
        "IRIS-OWNED-REAL-BOUNDED/1",
        "iris-owned-real-bounded/1/..",
        "iris-owned-dispatch/0",
        "iris-owned-dispatch/2",
        "iris-owned-dispatch",
        "iris-owned-dispatch/1 ",
        "iris-owned-/1",
        "iris-owned-real/1",
        "iris-owned-dispatch/1,iris-owned-real-bounded/1",
        "iris-execution/1",
        "stdio-synthetic/2",
        "claude",
        "real",
        "",
    ] {
        for (provider, profile_id) in [("synthetic", "synthetic"), ("claude", "claude-example")] {
            assert!(
                !loads(
                    &path,
                    &config(json!(profile), provider, profile_id, "synthetic-host")
                ),
                "{profile:?} {provider}"
            );
        }
    }
    for profile in [
        json!(null),
        json!(1),
        json!(["iris-owned-real-bounded/1"]),
        json!({}),
    ] {
        assert!(!loads(
            &path,
            &config(profile, "claude", "claude-example", "synthetic-host")
        ));
    }
    // No profile key at all is not completed with a default.
    let mut value = config(json!(REAL), "claude", "claude-example", "synthetic-host");
    value.as_object_mut().unwrap().remove("profile");
    assert!(!loads(&path, &value));
    // A second, conflicting profile key is refused rather than last-one-wins.
    let first = config(json!(SYNTHETIC), "synthetic", "synthetic", "synthetic-host").to_string();
    assert!(first.starts_with('{') && first.contains(SYNTHETIC));
    std::fs::write(&path, format!("{{\"profile\":\"{REAL}\",{}", &first[1..])).unwrap();
    assert!(ExecutorConfig::load(&path).is_err());
    // Extra fields that could widen scope are still refused for the real profile.
    let mut value = config(json!(REAL), "claude", "claude-example", "synthetic-host");
    value["launch_mode"] = json!("bounded-edit");
    assert!(!loads(&path, &value));
    value = config(json!(REAL), "claude", "claude-example", "synthetic-host");
    value["schema_version"] = json!(2);
    assert!(!loads(&path, &value));
}

#[test]
fn store_accepts_the_claude_scope_only_and_records_it_under_the_real_profile() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite3");
    let mut store = started(&path);
    let before = store.snapshot().unwrap();
    for (provider, profile_id) in [
        ("claude", "synthetic"),
        ("synthetic", "claude-example"),
        ("codex", "claude-example"),
        ("codex", "default"),
    ] {
        // Any configured subscription profile of the id shape is the claude scope;
        // the CLI refuses one its session does not run.
        let wrong = binding(&store, provider, profile_id);
        assert_eq!(
            store.begin_owned(&wrong, "owned-start").unwrap_err().code,
            "UNSUPPORTED_EXECUTOR",
            "{provider} {profile_id}"
        );
        assert_eq!(store.owned_request(&wrong).unwrap(), None);
        assert_eq!(store.snapshot().unwrap(), before);
    }
    let real = binding(&store, "claude", "claude-example");
    assert_eq!(
        store.begin_owned(&real, "owned-start").unwrap()["fresh"],
        true
    );
    let task = store.snapshot().unwrap()["plans"][0]["tasks"][0].clone();
    assert_eq!(task["transport_profile"], REAL);
    assert_eq!(task["owned_binding"]["provider"], "claude");
    assert_eq!(task["owned_binding"]["profile_id"], "claude-example");
    // The intent is already unknown: no success is implied by sending it.
    assert_eq!(task["outcome"], "unknown");
    assert_eq!(task["effects"], "unknown");
    assert_eq!(task["execution_state"], "unknown");
    // Replay and restart never turn the stored intent into a fresh send.
    assert_eq!(
        store.begin_owned(&real, "owned-start").unwrap()["fresh"],
        false
    );
    assert_eq!(
        store
            .begin_owned(&real, "different-request")
            .unwrap_err()
            .code,
        "REQUEST_CONFLICT"
    );
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(
        store.owned_request(&real).unwrap().as_deref(),
        Some("owned-start")
    );
    assert_eq!(
        store.begin_owned(&real, "owned-start").unwrap()["fresh"],
        false
    );
    // The same attempt cannot be looked up as another provider's binding.
    let other = binding(&store, "synthetic", "synthetic");
    assert!(store.owned_request(&other).is_err());
    assert!(store.begin_owned(&other, "owned-start").is_err());
}

#[test]
fn an_observation_must_name_the_profile_its_intent_was_recorded_under() {
    for (provider, profile_id, own, other) in [
        ("claude", "claude-example", REAL, SYNTHETIC),
        ("synthetic", "synthetic", SYNTHETIC, REAL),
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut store = started(&root.path().join("state.sqlite3"));
        let b = binding(&store, provider, profile_id);
        store.begin_owned(&b, "owned-start").unwrap();
        let before = store.snapshot().unwrap();
        for profile in [other, "iris-owned-real-bounded/2", ""] {
            assert_eq!(
                store
                    .observe_owned(&b, "owned-start", &native(profile, &b))
                    .unwrap_err()
                    .code,
                "STALE_BINDING",
                "{provider} observed as {profile:?}"
            );
            assert_eq!(store.snapshot().unwrap(), before);
        }
        // A forged verification is refused under either profile.
        for field in [
            "task_outcome_verified",
            "effects_verified",
            "remote_jobs_stopped",
        ] {
            let mut forged = native(own, &b);
            forged["verification"][field] = json!(true);
            assert_eq!(
                store
                    .observe_owned(&b, "owned-start", &forged)
                    .unwrap_err()
                    .code,
                "STALE_BINDING",
                "{provider} {field}"
            );
        }
        store
            .observe_owned(&b, "owned-start", &native(own, &b))
            .unwrap();
        let task = store.snapshot().unwrap()["plans"][0]["tasks"][0].clone();
        assert_eq!(task["outcome"], "unknown");
        assert_eq!(task["effects"], "unknown");
        assert!(
            !store.snapshot().unwrap()["plans"][0]["allowed_actions"]
                .as_array()
                .unwrap()
                .contains(&json!("handoff_task"))
        );
    }
}

#[test]
fn stop_delivery_is_claimed_once_and_restore_only_queries_for_the_real_profile() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite3");
    let mut store = started(&path);
    let b = binding(&store, "claude", "claude-example");
    store.begin_owned(&b, "owned-start").unwrap();
    apply(
        &mut store,
        "request_stop",
        "owned-stop",
        json!({"attempt_id":b.attempt_id,"fence":b.fence}),
    )
    .unwrap();
    assert_eq!(
        store.claim_owned_stop(&b).unwrap().as_deref(),
        Some("owned-stop")
    );
    assert_eq!(store.claim_owned_stop(&b).unwrap(), None);
    drop(store);
    let mut store = Store::open_restored(&path).unwrap();
    assert_eq!(
        store.owned_request(&b).unwrap().as_deref(),
        Some("owned-start")
    );
    assert_eq!(
        store.begin_owned(&b, "owned-start").unwrap()["fresh"],
        false
    );
    assert_eq!(store.claim_owned_stop(&b).unwrap(), None);
    assert_eq!(
        store
            .observe_owned(&b, "owned-start", &native(REAL, &b))
            .unwrap_err()
            .code,
        "RESTORE_HOLD"
    );
}

/// C4: a stored owned task whose profile string is unknown, or names the other
/// profile than its binding, is refused on normal open and on restore, rather
/// than silently re-read under a default profile.
#[test]
fn c4_tampered_stored_profile_or_profile_binding_pair_is_refused_on_open_and_restore() {
    for (provider, profile_id, tampered, ok) in [
        // Controls: rewriting the same value must still open.
        ("claude", "claude-example", REAL, true),
        ("synthetic", "synthetic", SYNTHETIC, true),
        ("claude", "claude-example", SYNTHETIC, false),
        ("synthetic", "synthetic", REAL, false),
        (
            "claude",
            "claude-example",
            "iris-owned-real-bounded/2",
            false,
        ),
        ("claude", "claude-example", "", false),
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state.sqlite3");
        let mut store = started(&path);
        let b = binding(&store, provider, profile_id);
        store.begin_owned(&b, "owned-start").unwrap();
        drop(store);
        {
            let db = rusqlite::Connection::open(&path).unwrap();
            let raw: String = db
                .query_row("SELECT document FROM domain_state WHERE id=1", [], |r| {
                    r.get(0)
                })
                .unwrap();
            let mut doc: Value = serde_json::from_str(&raw).unwrap();
            let tasks = doc["plans"][0]["tasks"].as_array_mut().unwrap();
            let task = tasks
                .iter_mut()
                .find(|t| t["attempt_id"] == json!(b.attempt_id))
                .unwrap();
            task["transport_profile"] = json!(tampered);
            db.execute(
                "UPDATE domain_state SET document=? WHERE id=1",
                [doc.to_string()],
            )
            .unwrap();
        }
        assert_eq!(
            Store::open(&path).is_ok(),
            ok,
            "open {provider} as {tampered:?}"
        );
        assert_eq!(
            Store::open_restored(&path).is_ok(),
            ok,
            "restore {provider} as {tampered:?}"
        );
    }
}

#[test]
fn a_real_provider_attempt_cannot_be_completed_through_the_synthetic_event_path() {
    let root = tempfile::tempdir().unwrap();
    let mut store = started(&root.path().join("state.sqlite3"));
    let b = binding(&store, "claude", "claude-example");
    store.begin_owned(&b, "owned-start").unwrap();
    let t = store.snapshot().unwrap()["plans"][0]["tasks"][0].clone();
    let before = store.snapshot().unwrap();
    for kind in ["accepted", "running", "result", "stop_observed"] {
        let mut event = json!({"attempt_id":t["attempt_id"],"fence":t["fence"],
            "executor_instance_id":t["executor_instance_id"],"event_seq":1,"event_kind":kind});
        if kind == "result" {
            event["outcome"] = json!("succeeded");
            event["owned_execution_ceased"] = json!(true);
            event["observed_at"] = json!(now());
            event["evidence"] = json!({"kind":"synthetic-sha256","sha256":"c".repeat(64),"payload":"claimed by the provider"});
        }
        assert_eq!(
            apply(
                &mut store,
                "record_executor_event",
                &format!("fake-{kind}"),
                event,
            )
            .unwrap_err()
            .code,
            "UNSUPPORTED_EXECUTOR",
            "{kind}"
        );
    }
    assert_eq!(store.snapshot().unwrap(), before);
}

// --- execution_host_id of the real profile comes from the configuration ---

/// ASCII letters, digits, `-` and `_`, 1 to 128 bytes: the user sets the same
/// value here as in the CLI's identity, whose rule is the same.
fn good_hosts() -> Vec<String> {
    vec![
        "h".into(),
        "claude-host-01".into(),
        "host-example-test".into(),
        "Lab_PC-2-local".into(),
        "h".repeat(128),
    ]
}
fn bad_hosts() -> Vec<String> {
    vec![
        String::new(),
        // The CLI refuses `.` in an identity, so Iris must too.
        ".".into(),
        "..".into(),
        "host.".into(),
        ".host".into(),
        "lab-pc.local".into(),
        "host.example.test".into(),
        "lab pc".into(),
        " host".into(),
        "host ".into(),
        "host\u{202e}".into(),
        "ホスト".into(),
        "ｈｏｓｔ".into(),
        "h".repeat(129),
        "h".repeat(257),
        "host\u{7}".into(),
        "host\nname".into(),
        "host\r".into(),
        "a\tb".into(),
        "host\u{0}".into(),
        "\u{7f}".into(),
        "\u{85}".into(),
    ]
}

#[test]
fn the_real_profile_takes_its_host_from_the_configuration_and_validates_it() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("executor.json");
    for host in good_hosts() {
        assert!(
            loads(
                &path,
                &config(json!(REAL), "claude", "claude-example", &host)
            ),
            "{host:?}"
        );
    }
    for host in bad_hosts() {
        assert!(
            !loads(
                &path,
                &config(json!(REAL), "claude", "claude-example", &host)
            ),
            "{host:?}"
        );
    }
    // The default profile keeps its single fixture host, whatever the value.
    for host in good_hosts() {
        assert!(
            !loads(
                &path,
                &config(json!(SYNTHETIC), "synthetic", "synthetic", &host)
            ),
            "{host:?}"
        );
    }
    // A missing or non-text host is never completed with a default.
    let mut value = config(json!(REAL), "claude", "claude-example", "claude-host-01");
    value["binding"]
        .as_object_mut()
        .unwrap()
        .remove("execution_host_id");
    assert!(!loads(&path, &value));
    for host in [json!(null), json!(1), json!(true), json!(["h"]), json!({})] {
        let mut value = config(json!(REAL), "claude", "claude-example", "claude-host-01");
        value["binding"]["execution_host_id"] = host;
        assert!(!loads(&path, &value));
    }
}

#[test]
fn the_store_keeps_the_configured_host_in_the_binding_and_the_plan_on_the_fixture_host() {
    for host in good_hosts() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state.sqlite3");
        let mut store = started(&path);
        let real = binding_on(&store, "claude", "claude-example", &host);
        assert_eq!(
            store.begin_owned(&real, "owned-start").unwrap()["fresh"],
            true,
            "{host:?}"
        );
        let snapshot = store.snapshot().unwrap();
        let task = &snapshot["plans"][0]["tasks"][0];
        assert_eq!(task["transport_profile"], REAL);
        assert_eq!(task["owned_binding"]["execution_host_id"], json!(host));
        // The approved synthetic plan still names only its own fixture host.
        assert_eq!(task["execution_host_id"], "synthetic-host");
        assert_eq!(
            snapshot["plans"][0]["approval"]["scope"]["execution_host_id"],
            "synthetic-host"
        );
        assert_eq!(task["outcome"], "unknown");
        assert_eq!(task["effects"], "unknown");
        // Replay and restart never turn the stored intent into a fresh send.
        assert_eq!(
            store.begin_owned(&real, "owned-start").unwrap()["fresh"],
            false
        );
        drop(store);
        let mut store = Store::open(&path).unwrap();
        assert_eq!(
            store.owned_request(&real).unwrap().as_deref(),
            Some("owned-start")
        );
        store
            .observe_owned(&real, "owned-start", &native(REAL, &real))
            .unwrap();
        // Another host is another binding: it neither finds nor re-sends it.
        let other = binding_on(&store, "claude", "claude-example", "another-host");
        assert!(store.owned_request(&other).is_err());
        assert!(store.begin_owned(&other, "owned-start").is_err());
        // The default profile's pair is never admitted on a configured host.
        let synthetic = binding_on(&store, "synthetic", "synthetic", &host);
        assert!(store.owned_request(&synthetic).is_err());
    }
}

#[test]
fn the_store_refuses_a_bad_host_and_the_default_profile_on_a_configured_host() {
    for host in bad_hosts() {
        let root = tempfile::tempdir().unwrap();
        let mut store = started(&root.path().join("state.sqlite3"));
        let before = store.snapshot().unwrap();
        let wrong = binding_on(&store, "claude", "claude-example", &host);
        assert_eq!(
            store.begin_owned(&wrong, "owned-start").unwrap_err().code,
            "INVALID_BINDING",
            "{host:?}"
        );
        assert_eq!(store.snapshot().unwrap(), before);
    }
    for host in good_hosts() {
        let root = tempfile::tempdir().unwrap();
        let mut store = started(&root.path().join("state.sqlite3"));
        let before = store.snapshot().unwrap();
        let wrong = binding_on(&store, "synthetic", "synthetic", &host);
        assert_eq!(
            store.begin_owned(&wrong, "owned-start").unwrap_err().code,
            "UNSUPPORTED_EXECUTOR",
            "{host:?}"
        );
        assert_eq!(store.owned_request(&wrong).unwrap(), None);
        assert_eq!(store.snapshot().unwrap(), before);
    }
}

const CREDENTIAL: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
type Seen = Arc<Mutex<Vec<(String, Value)>>>;

fn peer_caps(profile: &str, host: &str, live: bool) -> Value {
    json!({"contract_version":"iris-execution/1","execution_ready":false,"execution_host_id":host,
        "executor_instance_id":"owned-boot","synthetic":false,"external_effects":true,
        "owned_dispatch":{"profile":profile,"admission_enabled":true,"query_by_request":true,
            "automatic_handoff":false,"live_provider_execution":live}})
}
/// A loopback stand-in for the CLI's execution MCP; records every call it sees.
async fn peer(capabilities: Value) -> (u16, Seen, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let calls = seen.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut wire = Vec::new();
            let mut buf = [0; 4096];
            let end = loop {
                let n = stream.read(&mut buf).await.unwrap();
                if n == 0 {
                    return;
                }
                wire.extend_from_slice(&buf[..n]);
                if let Some(i) = wire.windows(4).position(|v| v == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let head = std::str::from_utf8(&wire[..end]).unwrap().to_owned();
            assert!(head.contains(&format!("Authorization: Bearer {CREDENTIAL}\r\n")));
            let length: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("Content-Length: "))
                .unwrap()
                .parse()
                .unwrap();
            while wire.len() - end < length {
                let n = stream.read(&mut buf).await.unwrap();
                assert!(n > 0);
                wire.extend_from_slice(&buf[..n]);
            }
            let request = mcp::parse_json(&wire[end..]).unwrap();
            let method = request["method"].as_str().unwrap();
            let name = request["params"]["name"].as_str().unwrap_or(method);
            calls
                .lock()
                .unwrap()
                .push((name.to_string(), request["params"]["arguments"].clone()));
            let result = match method {
                "server/discover" => {
                    json!({"resultType":"complete","supportedVersions":[mcp::VERSION],"capabilities":{"tools":{}}})
                }
                "tools/list" => {
                    let tools = [
                        "capabilities",
                        "executor_start",
                        "executor_poll",
                        "executor_stop",
                        "executor_request",
                        "owned_start",
                        "owned_request",
                        "owned_poll",
                        "owned_stop",
                        "owned_evidence",
                    ]
                    .map(|name| json!({"name":name}));
                    json!({"resultType":"complete","tools":tools})
                }
                _ if name == "capabilities" => {
                    json!({"resultType":"complete","isError":false,"structuredContent":capabilities})
                }
                _ => {
                    json!({"resultType":"complete","isError":false,"structuredContent":{"accepted":true}})
                }
            };
            let body = json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMCP-Protocol-Version: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                mcp::VERSION,
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
        }
    });
    (port, seen, task)
}
fn names(seen: &Seen) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .map(|(name, _)| name.clone())
        .collect()
}

// Rows: profile, provider, profile_id, host in the configuration, host the peer
// reports, and whether the start is expected to be delivered.
#[tokio::test]
async fn the_scheduler_sends_the_configured_host_and_refuses_a_peer_that_names_another() {
    let configured = "claude-host-01-example-test";
    for (profile, provider, profile_id, host, peer_host, delivered) in [
        (
            REAL,
            "claude",
            "claude-example",
            configured,
            configured,
            true,
        ),
        (
            REAL,
            "claude",
            "claude-example",
            configured,
            "other-host",
            false,
        ),
        (
            REAL,
            "claude",
            "claude-example",
            configured,
            "synthetic-host",
            false,
        ),
        (
            REAL,
            "claude",
            "claude-example",
            "synthetic-host",
            "synthetic-host",
            true,
        ),
        (REAL, "claude", "claude-example", configured, "", false),
        (
            REAL,
            "claude",
            "claude-example",
            configured,
            "host\u{7}",
            false,
        ),
        (
            REAL,
            "claude",
            "claude-example",
            configured,
            "claude host",
            false,
        ),
        (
            REAL,
            "claude",
            "claude-example",
            configured,
            " claude-host-01-example-test",
            false,
        ),
        (
            REAL,
            "claude",
            "claude-example",
            configured,
            "claude-host-01-example-test ",
            false,
        ),
        (
            REAL,
            "claude",
            "claude-example",
            configured,
            "claude-host\u{202e}",
            false,
        ),
        (
            REAL,
            "claude",
            "claude-example",
            configured,
            "クロード",
            false,
        ),
        // The default profile still sends only on the fixture host.
        (
            SYNTHETIC,
            "synthetic",
            "synthetic",
            "synthetic-host",
            "synthetic-host",
            true,
        ),
        (
            SYNTHETIC,
            "synthetic",
            "synthetic",
            "synthetic-host",
            configured,
            false,
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("credential"), CREDENTIAL).unwrap();
        let store = started(&root.path().join("state.sqlite3"));
        let b = binding_on(&store, provider, profile_id, host);
        let live = profile == REAL;
        let (port, seen, server) = peer(peer_caps(profile, peer_host, live)).await;
        let path = root.path().join("executor.json");
        std::fs::write(
            &path,
            json!({"schema_version":1,"profile":profile,"port":port,"credential_file":"credential",
                "binding":b,"request_id":"start-request"})
            .to_string(),
        )
        .unwrap();
        let ExecutorConfig::OwnedHttp(config) = ExecutorConfig::load(&path).unwrap() else {
            panic!()
        };
        let mut http = OwnedHttp::new(config).unwrap();
        let store = Arc::new(Mutex::new(store));
        let result = http.tick(&store).await;
        let label = format!("{profile} {host:?} peer {peer_host:?}");
        let recorded = store.lock().unwrap().owned_request(&b).unwrap();
        if delivered {
            assert!(result.is_ok(), "{label}: {result:?}");
            assert_eq!(
                names(&seen),
                [
                    "server/discover",
                    "tools/list",
                    "capabilities",
                    "owned_start"
                ],
                "{label}"
            );
            let calls = seen.lock().unwrap();
            let start = &calls[3].1;
            assert_eq!(start["profile"], profile, "{label}");
            assert_eq!(start["binding"]["execution_host_id"], host, "{label}");
            assert_eq!(start["request_id"], "start-request", "{label}");
            assert_eq!(recorded.as_deref(), Some("start-request"), "{label}");
        } else {
            // Refused before any intent is stored and before any start is sent.
            assert!(result.is_err(), "{label}");
            assert!(
                !names(&seen).contains(&"owned_start".to_string()),
                "{label}"
            );
            assert_eq!(recorded, None, "{label}");
        }
        server.abort();
    }
}

// --- C7: the real profile's instruction file and its own real-send tasks ---
//
// The CLI hashes the instruction file's bytes and sends those very bytes to the
// provider, so the hash Iris puts in the binding must be the SHA-256 of the file,
// and the real profile needs enough plans of its own (one grant scope each) for up
// to three attempts. The default profile and its fixture are not touched.

/// A synthetic connectivity instruction, copied byte for byte (the `\n` escapes
/// keep the bytes independent of any checkout line-ending conversion).
const C5_INSTRUCTION: &str = concat!(
    "This is a synthetic connectivity test. Do not read or write anything outside the current directory. Do not use the network.\n",
    "Create a file named answer.json in the current directory containing exactly this JSON object, with the words sorted alphabetically:\n",
    r#"{"sorted": [<the six words below, sorted>], "count": 6}"#,
    "\n",
    "Words: maple, cedar, birch, alder, spruce, larch\n",
    "After writing the file, stop. Do not create any other file.\n",
);
/// SHA-256 of the file the C5 acceptance sends (read from the file, not from Iris).
const C5_SHA256: &str = "24795025f11d4659dd2ef40edba6f61476198b075f0a2a89c9c0a780daa002d8";
/// The real file on the machine that runs the acceptance, named by the
/// `IRIS_C5_INSTRUCTION_FILE` environment variable. It is only ever read; when the
/// variable is unset or the file is missing, the tests use the pinned copy only.
fn c5_file() -> Option<std::path::PathBuf> {
    std::env::var_os("IRIS_C5_INSTRUCTION_FILE")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_file())
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn real_task(n: u32) -> RealTask {
    RealTask {
        plan_id: format!("real-plan-{n}"),
        task_id: format!("real-task-{n}"),
        approval_id: format!("real-approval-{n}"),
    }
}
fn real_tasks(count: u32) -> Vec<RealTask> {
    (1..=count).map(real_task).collect()
}
fn fixture_of(bytes: &[u8], count: u32) -> RealFixture {
    RealFixture::new(bytes, real_tasks(count)).unwrap()
}
/// A real-bounded configuration whose binding is the first task. The scope hash is
/// a placeholder: loading never checks it, `begin_owned` does.
fn real_config(instruction_hash: &str, file: &str, tasks: Value) -> Value {
    json!({"schema_version":1,"profile":REAL,"port":1,"credential_file":"credential",
        "binding":{"principal_id":"local-user","workspace_id":"synthetic-workspace","plan_id":"real-plan-1",
            "plan_revision":1,"task_id":"real-task-1","instruction_revision":1,
            "instruction_hash":instruction_hash,"approval_id":"real-approval-1","approval_revision":1,
            "scope_hash":"b".repeat(64),"execution_host_id":"synthetic-host","executor_instance_id":"boot",
            "attempt_id":"attempt-real-task-1-1","fence":1,"provider":"claude","profile_id":"claude-example"},
        "request_id":"start-request",
        "real_bounded":{"instruction_file":file,"tasks":tasks}})
}
fn refusal(path: &Path, value: &Value) -> Option<String> {
    std::fs::write(path, value.to_string()).unwrap();
    ExecutorConfig::load(path).err()
}
fn load_fixture(path: &Path, value: &Value) -> Option<RealFixture> {
    std::fs::write(path, value.to_string()).unwrap();
    match ExecutorConfig::load(path) {
        Ok(ExecutorConfig::OwnedHttp(config)) => config.real_fixture().cloned(),
        _ => None,
    }
}
/// A temporary directory holding `c5-instruction.txt` and the path for the config.
fn c5_dir() -> (tempfile::TempDir, std::path::PathBuf) {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("c5-instruction.txt"), C5_INSTRUCTION).unwrap();
    let config = root.path().join("executor.json");
    (root, config)
}
fn start_plan(store: &mut Store, index: usize) {
    let p = store.snapshot().unwrap()["plans"][index].clone();
    apply(store,"start_plan",&format!("start-{index}"),json!({"plan_id":p["plan_id"],"plan_revision":p["plan_revision"],"plan_hash":p["plan_hash"],"approval_id":p["approval"]["approval_id"],"approval_revision":p["approval"]["revision"]})).unwrap();
}
/// The binding of plan `index`'s only task, from the Store's own snapshot.
fn real_binding(store: &Store, index: usize) -> CliBinding {
    let p = store.snapshot().unwrap()["plans"][index].clone();
    let t = &p["tasks"][0];
    serde_json::from_value(json!({"principal_id":"local-user","workspace_id":"synthetic-workspace",
        "plan_id":p["plan_id"],"plan_revision":p["plan_revision"],"task_id":t["task_id"],
        "instruction_revision":t["instruction_revision"],"instruction_hash":t["instruction_hash"],
        "approval_id":p["approval"]["approval_id"],"approval_revision":p["approval"]["revision"],
        "scope_hash":p["approval"]["scope_hash"],"execution_host_id":"synthetic-host",
        "executor_instance_id":"owned-boot","attempt_id":format!("attempt-{}-1",t["task_id"].as_str().unwrap()),
        "fence":1,"provider":"claude","profile_id":"claude-example"})).unwrap()
}

#[test]
fn c7_the_copy_of_the_c5_instruction_is_byte_exact() {
    assert_eq!(sha(C5_INSTRUCTION.as_bytes()), C5_SHA256);
    assert!(C5_SHA256.starts_with("24795025"));
    assert_eq!(C5_INSTRUCTION.len(), 421);
    // Read only: where the acceptance file exists, the copy must equal it.
    match c5_file().map(std::fs::read) {
        Some(Ok(actual)) => {
            assert_eq!(actual, C5_INSTRUCTION.as_bytes());
            assert_eq!(sha(&actual), C5_SHA256);
            eprintln!(
                "c7: the copy equals the acceptance file ({} bytes)",
                actual.len()
            );
        }
        Some(Err(_)) | None => {
            eprintln!("c7: the acceptance file is not on this machine; pinned hash only")
        }
    }
}

#[test]
fn c7_iris_instruction_hash_equals_the_sha256_of_the_c5_instruction_file() {
    let (copy_dir, _) = c5_dir();
    let mut files = vec![copy_dir.path().join("c5-instruction.txt")];
    if let Some(file) = c5_file() {
        // Read only, through the same loader Iris uses at startup.
        files.push(file);
    } else {
        eprintln!("c7: the acceptance file is not on this machine; the copy only");
    }
    for file in &files {
        let dir = tempfile::tempdir().unwrap();
        let config = real_config(C5_SHA256, file.to_str().unwrap(), json!(real_tasks(1)));
        let fixture = load_fixture(&dir.path().join("executor.json"), &config)
            .unwrap_or_else(|| panic!("{file:?} was refused"));
        assert_eq!(fixture.instruction_hash(), C5_SHA256);
        let mut store =
            Store::open_with(&dir.path().join("state.sqlite3"), Some(&fixture)).unwrap();
        start_plan(&mut store, 0);
        let binding = real_binding(&store, 0);
        assert_eq!(binding.instruction_hash, C5_SHA256);
        assert!(binding.instruction_hash.starts_with("24795025"));
        // Iris itself accepts a binding carrying that hash (it is the stored one).
        assert_eq!(
            store.begin_owned(&binding, "owned-start").unwrap()["fresh"],
            true
        );
        let snapshot = store.snapshot().unwrap();
        let task = &snapshot["plans"][0]["tasks"][0];
        assert_eq!(task["instruction"], C5_INSTRUCTION);
        assert_eq!(task["instruction_hash"], C5_SHA256);
        assert_eq!(task["owned_binding"]["instruction_hash"], C5_SHA256);
        assert_eq!(task["transport_profile"], REAL);
        eprintln!("c7: Iris hash == file hash {C5_SHA256} for {file:?}");
    }
    // The default fixture is as before: its short synthetic sentence has another hash.
    let root = tempfile::tempdir().unwrap();
    let default = Store::open(&root.path().join("default.sqlite3")).unwrap();
    let snapshot = default.snapshot().unwrap();
    assert_eq!(snapshot["plans"].as_array().unwrap().len(), 2);
    assert!(snapshot.get("real_bounded_fixture").is_none());
    for (n, plan) in snapshot["plans"].as_array().unwrap().iter().enumerate() {
        assert_eq!(plan["tasks"].as_array().unwrap().len(), 3);
        let first = &plan["tasks"][0];
        let text = format!("Synthetic task {}-1; no external effects.", n + 1);
        assert_eq!(first["instruction"], text.as_str());
        assert_eq!(first["instruction_hash"], sha(text.as_bytes()).as_str());
        assert_ne!(first["instruction_hash"], C5_SHA256);
    }
}

#[test]
fn c7_instruction_bytes_are_hashed_exactly_and_survive_the_store_unchanged() {
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("crlf", b"first line\r\nsecond line\r\n".to_vec()),
        ("lone cr", b"a\rb\n".to_vec()),
        ("utf-8 bom", b"\xef\xbb\xbfWrite the file.\n".to_vec()),
        ("no final newline", b"Write the file.".to_vec()),
        ("trailing blanks", b"Write the file.  \n\n  ".to_vec()),
        ("leading blanks", b"  \n  Write the file.\n".to_vec()),
        (
            "control characters other than NUL",
            "tab\there\u{1b}[0m \u{7f}\n".as_bytes().to_vec(),
        ),
        (
            "non-ascii and a combining mark (no normalization)",
            "日本語 \u{1F600} e\u{301}\n".as_bytes().to_vec(),
        ),
        (
            "unicode separators and no-break space",
            "a\u{2028}b\u{2029}c\u{a0}d\n".as_bytes().to_vec(),
        ),
        (
            "escape-looking text",
            br#"{"a":"\n","b":"\u0000","c":"\\"}"#.to_vec(),
        ),
        ("exactly 64 KiB", vec![b'a'; 65536]),
    ];
    for (name, bytes) in cases {
        let (dir, config_path) = c5_dir();
        std::fs::write(dir.path().join("c5-instruction.txt"), &bytes).unwrap();
        let expected = sha(&bytes);
        let config = real_config(&expected, "c5-instruction.txt", json!(real_tasks(1)));
        let fixture = load_fixture(&config_path, &config)
            .unwrap_or_else(|| panic!("{name}: the file was refused"));
        assert_eq!(fixture.instruction_hash(), expected, "{name}");
        let db = dir.path().join("state.sqlite3");
        let mut store = Store::open_with(&db, Some(&fixture)).unwrap();
        start_plan(&mut store, 0);
        let binding = real_binding(&store, 0);
        assert_eq!(binding.instruction_hash, expected, "{name}");
        drop(store);
        // After a reopen the very same bytes come back out of the document.
        let mut store = Store::open_with(&db, Some(&fixture)).unwrap();
        let snapshot = store.snapshot().unwrap();
        let task = &snapshot["plans"][0]["tasks"][0];
        assert_eq!(
            task["instruction"].as_str().unwrap().as_bytes(),
            bytes.as_slice(),
            "{name}"
        );
        assert_eq!(task["instruction_hash"], expected.as_str(), "{name}");
        assert_eq!(
            store.begin_owned(&binding, "owned-start").unwrap()["fresh"],
            true,
            "{name}"
        );
    }
}

#[test]
fn c7_a_bad_instruction_file_is_refused_at_startup_without_leaking_it() {
    let secret = "SECRET-MARKER-0123";
    let mut utf16 = vec![0xff, 0xfe];
    utf16.extend("abc".encode_utf16().flat_map(u16::to_le_bytes));
    let bad: Vec<(&str, Option<Vec<u8>>)> = vec![
        ("missing", None),
        ("empty", Some(vec![])),
        ("spaces and newlines only", Some(b" \r\n\t \n".to_vec())),
        (
            "unicode blanks only",
            Some("\u{a0}\u{2003}\u{3000}\n".as_bytes().to_vec()),
        ),
        ("64 KiB plus one byte", Some(vec![b'a'; 65537])),
        ("1 MiB plus one byte", Some(vec![b'a'; 1_048_577])),
        (
            "NUL in the middle",
            Some(format!("{secret} a\0b").into_bytes()),
        ),
        ("NUL first", Some(b"\0abc".to_vec())),
        ("NUL last", Some(format!("{secret}\0").into_bytes())),
        ("only a NUL", Some(vec![0])),
        ("invalid utf-8", Some(b"abc \xff\xfe def".to_vec())),
        ("truncated utf-8", Some(b"abc \xe3\x81".to_vec())),
        ("utf-16 with bom", Some(utf16)),
    ];
    for (name, bytes) in bad {
        let (dir, config_path) = c5_dir();
        let file = dir.path().join("c5-instruction.txt");
        match &bytes {
            Some(bytes) => std::fs::write(&file, bytes).unwrap(),
            None => std::fs::remove_file(&file).unwrap(),
        }
        // Even a binding that carries the right hash for these bytes is refused.
        let hash = bytes.as_ref().map_or(C5_SHA256.to_string(), |b| sha(b));
        let config = real_config(&hash, "c5-instruction.txt", json!(real_tasks(1)));
        let message =
            refusal(&config_path, &config).unwrap_or_else(|| panic!("{name} was accepted"));
        assert!(!message.contains(secret), "{name}: {message}");
        assert!(!message.contains("c5-instruction"), "{name}: {message}");
        // Loading only reads: nothing is created, nothing is changed.
        match &bytes {
            Some(bytes) => assert_eq!(&std::fs::read(&file).unwrap(), bytes, "{name}"),
            None => assert!(!file.exists(), "{name}"),
        }
    }
    // Not a regular file, no path at all, a path that does not exist.
    let (dir, config_path) = c5_dir();
    std::fs::create_dir(dir.path().join("a-directory")).unwrap();
    for file in ["a-directory", "", "no-such-file.txt"] {
        let config = real_config(C5_SHA256, file, json!(real_tasks(1)));
        assert!(refusal(&config_path, &config).is_some(), "{file:?}");
    }
    assert!(!dir.path().join("no-such-file.txt").exists());
    for missing in [json!(null), json!(7), json!(["c5-instruction.txt"])] {
        let mut config = real_config(C5_SHA256, "c5-instruction.txt", json!(real_tasks(1)));
        config["real_bounded"]["instruction_file"] = missing;
        assert!(refusal(&config_path, &config).is_some());
    }
    let mut config = real_config(C5_SHA256, "c5-instruction.txt", json!(real_tasks(1)));
    config["real_bounded"]
        .as_object_mut()
        .unwrap()
        .remove("instruction_file");
    assert!(refusal(&config_path, &config).is_some());
    // The control: the same configuration with the right file loads.
    let config = real_config(C5_SHA256, "c5-instruction.txt", json!(real_tasks(1)));
    assert!(load_fixture(&config_path, &config).is_some());
    // The same rules at the one place that builds the fixture.
    assert!(RealFixture::new(b"ok", real_tasks(1)).is_ok());
    for bytes in [&b""[..], b"  \n", b"a\0", &[b'a'; 65537], b"\xff"] {
        assert_eq!(
            RealFixture::new(bytes, real_tasks(1)).unwrap_err().code,
            "INVALID_INSTRUCTION"
        );
    }
}

#[test]
fn c7_real_tasks_are_one_to_three_with_scopes_that_never_overlap() {
    let (dir, config_path) = c5_dir();
    let load = |tasks: Value, tweak: &dyn Fn(&mut Value)| {
        let mut config = real_config(C5_SHA256, "c5-instruction.txt", tasks);
        tweak(&mut config);
        load_fixture(&config_path, &config)
    };
    let nothing: &dyn Fn(&mut Value) = &|_| {};
    // 1, 2 and 3 tasks are accepted, in the order given.
    for count in 1..=3 {
        let fixture = load(json!(real_tasks(count)), nothing).unwrap();
        assert_eq!(fixture.tasks(), real_tasks(count).as_slice());
    }
    // None, and four or more, are refused (at the loader and at the builder).
    assert!(load(json!([]), nothing).is_none());
    assert!(load(json!(real_tasks(4)), nothing).is_none());
    assert!(load(json!(real_tasks(9)), nothing).is_none());
    assert_eq!(
        RealFixture::new(b"ok", vec![]).unwrap_err().code,
        "INVALID_REAL_TASKS"
    );
    assert_eq!(
        RealFixture::new(b"ok", real_tasks(4)).unwrap_err().code,
        "INVALID_REAL_TASKS"
    );
    // The list with one id of one entry replaced.
    let with = |index: usize, key: &str, value: &str| {
        let mut tasks = real_tasks(3);
        match key {
            "plan_id" => tasks[index].plan_id = value.into(),
            "task_id" => tasks[index].task_id = value.into(),
            _ => tasks[index].approval_id = value.into(),
        }
        tasks
    };
    // Any repeated id overlaps a grant scope (approval, plan or task). Each list
    // is refused by the builder itself, and the loader never gets past it either.
    for (name, tasks) in [
        ("same plan id", with(1, "plan_id", "real-plan-1")),
        ("same task id", with(2, "task_id", "real-task-1")),
        (
            "same approval id",
            with(1, "approval_id", "real-approval-1"),
        ),
        (
            "plan id equals another task id",
            with(1, "plan_id", "real-task-1"),
        ),
        (
            "task id equals another plan id",
            with(2, "task_id", "real-plan-1"),
        ),
        (
            "plan id equals its own task id",
            with(1, "plan_id", "real-task-2"),
        ),
        ("same entry twice", vec![real_task(1), real_task(1)]),
    ] {
        assert_eq!(
            RealFixture::new(b"ok", tasks.clone()).unwrap_err().code,
            "INVALID_REAL_TASKS",
            "{name}"
        );
        assert!(load(json!(tasks), nothing).is_none(), "{name}");
    }
    // Each id must be a plain id: ASCII letters, digits, `-` and `_`, 1 to 80 bytes.
    for bad in [
        "",
        "has space",
        "dot.id",
        "a/b",
        "日本語",
        "tab\tid",
        "nul\0id",
        &"x".repeat(81),
    ] {
        for key in ["plan_id", "task_id", "approval_id"] {
            let tasks = with(0, key, bad);
            assert_eq!(
                RealFixture::new(b"ok", tasks.clone()).unwrap_err().code,
                "INVALID_REAL_TASKS",
                "{key} {bad:?}"
            );
            assert!(load(json!(tasks), nothing).is_none(), "{key} {bad:?}");
        }
    }
    for good in ["a", "A-b_9", &"x".repeat(80)] {
        let tasks = with(0, "approval_id", good);
        assert!(RealFixture::new(b"ok", tasks).is_ok(), "{good:?}");
        let tweak: &dyn Fn(&mut Value) = &|config| {
            config["binding"]["approval_id"] = json!(good);
        };
        let mut tasks = json!(real_tasks(3));
        tasks[0]["approval_id"] = json!(good);
        assert!(load(tasks, tweak).is_some(), "{good:?}");
    }
    // Unknown fields, missing fields and wrong shapes are refused, not completed.
    let mut extra = json!(real_tasks(1));
    extra[0]["cwd"] = json!("F:/anywhere");
    assert!(load(extra, nothing).is_none());
    let mut missing = json!(real_tasks(1));
    missing[0].as_object_mut().unwrap().remove("approval_id");
    assert!(load(missing, nothing).is_none());
    for shape in [
        json!(null),
        json!("real-task-1"),
        json!({"plan_id":"a"}),
        json!([1]),
    ] {
        assert!(load(shape, nothing).is_none());
    }
    let no_tasks: &dyn Fn(&mut Value) = &|config| {
        config["real_bounded"]
            .as_object_mut()
            .unwrap()
            .remove("tasks");
    };
    assert!(load(json!(real_tasks(1)), no_tasks).is_none());
    let extra_key: &dyn Fn(&mut Value) = &|config| {
        config["real_bounded"]["launch_mode"] = json!("bounded-edit");
    };
    assert!(load(json!(real_tasks(1)), extra_key).is_none());
    // The binding must be exactly one of the listed tasks, with the file's hash.
    let another_hash = "a".repeat(64);
    let default_hash = sha(b"Synthetic task 1-1; no external effects.");
    for (name, key, value) in [
        ("unlisted plan", "plan_id", "real-plan-9"),
        ("unlisted task", "task_id", "real-task-9"),
        ("unlisted approval", "approval_id", "real-approval-9"),
        ("another listed task's task id", "task_id", "real-task-2"),
        ("another listed task's plan id", "plan_id", "real-plan-2"),
        (
            "another listed task's approval id",
            "approval_id",
            "real-approval-2",
        ),
        ("another hash", "instruction_hash", another_hash.as_str()),
        (
            "the hash of the default fixture's sentence",
            "instruction_hash",
            default_hash.as_str(),
        ),
    ] {
        let tweak: &dyn Fn(&mut Value) = &|config| {
            config["binding"][key] = json!(value);
        };
        assert!(load(json!(real_tasks(3)), tweak).is_none(), "{name}");
    }
    // Every listed task can be the binding (a second and a third attempt).
    for n in 2..=3 {
        let tweak: &dyn Fn(&mut Value) = &|config| {
            config["binding"]["plan_id"] = json!(format!("real-plan-{n}"));
            config["binding"]["task_id"] = json!(format!("real-task-{n}"));
            config["binding"]["approval_id"] = json!(format!("real-approval-{n}"));
        };
        assert!(load(json!(real_tasks(3)), tweak).is_some(), "task {n}");
    }
    drop(dir);
}

#[test]
fn c7_the_existing_profiles_refuse_the_real_bounded_settings() {
    let (dir, config_path) = c5_dir();
    let section = json!({"instruction_file":"c5-instruction.txt","tasks":real_tasks(1)});
    let synthetic = |extra: Option<(&str, Value)>| {
        let mut config = config(json!(SYNTHETIC), "synthetic", "synthetic", "synthetic-host");
        if let Some((key, value)) = extra {
            config[key] = value;
        }
        config
    };
    // Controls: neither profile is refused for lacking the section.
    assert!(loads(&config_path, &synthetic(None)));
    assert!(loads(
        &config_path,
        &config(json!(REAL), "claude", "claude-example", "synthetic-host")
    ));
    assert!(load_fixture(&config_path, &synthetic(None)).is_none());
    // The default profile refuses the section in every form, even a valid one.
    for value in [
        section.clone(),
        json!(null),
        json!({}),
        json!([]),
        json!("c5-instruction.txt"),
    ] {
        assert!(
            refusal(
                &config_path,
                &synthetic(Some(("real_bounded", value.clone())))
            )
            .is_some(),
            "{value}"
        );
    }
    // Same, with everything else in order (the binding names a listed task and the
    // file's hash), so that the profile rule alone is what refuses it.
    let mut aligned = synthetic(Some(("real_bounded", section.clone())));
    aligned["binding"]["plan_id"] = json!("real-plan-1");
    aligned["binding"]["task_id"] = json!("real-task-1");
    aligned["binding"]["approval_id"] = json!("real-approval-1");
    aligned["binding"]["instruction_hash"] = json!(C5_SHA256);
    assert!(refusal(&config_path, &aligned).is_some());
    assert!(!loads(&config_path, &aligned));
    // The control: the very same settings and binding load for the real profile.
    let mut allowed = aligned.clone();
    allowed["profile"] = json!(REAL);
    allowed["binding"]["provider"] = json!("claude");
    allowed["binding"]["profile_id"] = json!("claude-example");
    assert!(load_fixture(&config_path, &allowed).is_some());
    // The stdio profile has no such section either.
    let stdio = json!({"schema_version":1,"profile":"stdio-synthetic/1","real_bounded":section});
    assert!(refusal(&config_path, &stdio).is_some());
    // Neither profile accepts the settings spread over top-level keys.
    for profile in [
        (SYNTHETIC, "synthetic", "synthetic"),
        (REAL, "claude", "claude-example"),
    ] {
        for (key, value) in [
            ("instruction_file", json!("c5-instruction.txt")),
            ("tasks", json!(real_tasks(1))),
            ("real_tasks", json!(real_tasks(1))),
            ("real_fixture", json!(null)),
        ] {
            let mut value_config = config(json!(profile.0), profile.1, profile.2, "synthetic-host");
            value_config[key] = value;
            assert!(refusal(&config_path, &value_config).is_some(), "{key}");
        }
    }
    // The real profile refuses a null or non-object section instead of ignoring it.
    for value in [json!(null), json!([]), json!("x"), json!(1), json!({})] {
        let mut real = real_config(C5_SHA256, "c5-instruction.txt", json!(real_tasks(1)));
        real["real_bounded"] = value;
        assert!(refusal(&config_path, &real).is_some());
    }
    // A repeated section key is refused rather than last-one-wins.
    let good = real_config(C5_SHA256, "c5-instruction.txt", json!(real_tasks(1))).to_string();
    let duplicate = format!(
        "{},\"real_bounded\":{{\"instruction_file\":\"c5-instruction.txt\",\"tasks\":[]}}}}",
        &good[..good.len() - 1]
    );
    std::fs::write(&config_path, duplicate).unwrap();
    assert!(ExecutorConfig::load(&config_path).is_err());
    // The real profile with a synthetic-provider binding is still refused as before.
    let mut wrong = real_config(C5_SHA256, "c5-instruction.txt", json!(real_tasks(1)));
    wrong["binding"]["provider"] = json!("synthetic");
    wrong["binding"]["profile_id"] = json!("synthetic");
    assert!(refusal(&config_path, &wrong).is_some());
    // The control: the same real configuration loads.
    let real = real_config(C5_SHA256, "c5-instruction.txt", json!(real_tasks(1)));
    assert!(load_fixture(&config_path, &real).is_some());
    drop(dir);
}

#[test]
fn c7_up_to_three_real_attempts_each_have_their_own_grant_scope() {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("state.sqlite3");
    let fixture = fixture_of(C5_INSTRUCTION.as_bytes(), 3);
    let mut store = Store::open_with(&db, Some(&fixture)).unwrap();
    let snapshot = store.snapshot().unwrap();
    let plans = snapshot["plans"].as_array().unwrap();
    assert_eq!(plans.len(), 3);
    assert!(
        plans
            .iter()
            .all(|p| p["tasks"].as_array().unwrap().len() == 1)
    );
    assert_eq!(snapshot["restore_hold"], false);
    let mut bindings = Vec::new();
    for index in 0..3 {
        start_plan(&mut store, index);
        let binding = real_binding(&store, index);
        assert_eq!(binding.instruction_hash, C5_SHA256);
        bindings.push(binding);
    }
    // The CLI keys a grant by (principal, workspace, approval, plan, task); none of
    // the three may equal another in any part, so no two can ever conflict.
    let scopes: std::collections::BTreeSet<_> = bindings
        .iter()
        .map(|b| {
            (
                &b.principal_id,
                &b.workspace_id,
                &b.approval_id,
                &b.plan_id,
                &b.task_id,
            )
        })
        .collect();
    assert_eq!(scopes.len(), 3);
    for part in [
        bindings
            .iter()
            .map(|b| &b.approval_id)
            .collect::<std::collections::BTreeSet<_>>(),
        bindings.iter().map(|b| &b.plan_id).collect(),
        bindings.iter().map(|b| &b.task_id).collect(),
        bindings.iter().map(|b| &b.scope_hash).collect(),
        bindings.iter().map(|b| &b.attempt_id).collect(),
    ] {
        assert_eq!(part.len(), 3);
    }
    for (index, binding) in bindings.iter().enumerate() {
        assert_eq!(
            store
                .begin_owned(binding, &format!("start-request-{index}"))
                .unwrap()["fresh"],
            true,
            "attempt {index}"
        );
    }
    // The scope hash follows from the configured tasks alone, so a first start can
    // be read for it and a second store from the same settings gives the same one.
    let again = tempfile::tempdir().unwrap();
    let second = Store::open_with(&again.path().join("again.sqlite3"), Some(&fixture)).unwrap();
    for (index, binding) in bindings.iter().enumerate() {
        assert_eq!(real_binding(&second, index).scope_hash, binding.scope_hash);
    }
    drop(second);
    // A restart replays every stored intent and never makes one fresh again.
    drop(store);
    let mut store = Store::open_with(&db, Some(&fixture)).unwrap();
    for (index, binding) in bindings.iter().enumerate() {
        let request = format!("start-request-{index}");
        assert_eq!(
            store.owned_request(binding).unwrap().as_deref(),
            Some(request.as_str())
        );
        assert_eq!(
            store.begin_owned(binding, &request).unwrap()["fresh"],
            false
        );
    }
    // Two tasks are enough for two attempts and the third entry is simply absent.
    let two = fixture_of(C5_INSTRUCTION.as_bytes(), 2);
    let root = tempfile::tempdir().unwrap();
    let store = Store::open_with(&root.path().join("two.sqlite3"), Some(&two)).unwrap();
    assert_eq!(
        store.snapshot().unwrap()["plans"].as_array().unwrap().len(),
        2
    );
}

#[test]
fn c7_a_default_store_and_a_real_store_never_open_as_each_other() {
    let root = tempfile::tempdir().unwrap();
    let fixture = fixture_of(C5_INSTRUCTION.as_bytes(), 3);
    let default = root.path().join("default.sqlite3");
    let real = root.path().join("real.sqlite3");
    drop(Store::open(&default).unwrap());
    drop(Store::open_with(&real, Some(&fixture)).unwrap());
    let code = |r: Result<Store, many_iris::domain::DomainError>| r.err().map(|e| e.code);
    // The default store is refused by a real-bounded start, and the reverse.
    assert_eq!(
        code(Store::open_with(&default, Some(&fixture))).as_deref(),
        Some("FIXTURE_MISMATCH")
    );
    assert_eq!(
        code(Store::open_restored_with(&default, Some(&fixture))).as_deref(),
        Some("FIXTURE_MISMATCH")
    );
    assert_eq!(
        code(Store::open(&real)).as_deref(),
        Some("FIXTURE_MISMATCH")
    );
    assert_eq!(
        code(Store::open_restored(&real)).as_deref(),
        Some("FIXTURE_MISMATCH")
    );
    assert_eq!(
        code(Store::open_with(&real, None)).as_deref(),
        Some("FIXTURE_MISMATCH")
    );
    // A real store opens only for the very same tasks and instruction.
    let other_instruction = fixture_of(b"Another instruction.\n", 3);
    let fewer = fixture_of(C5_INSTRUCTION.as_bytes(), 2);
    let mut renamed_tasks = real_tasks(3);
    renamed_tasks[2].approval_id = "real-approval-9".into();
    let renamed = RealFixture::new(C5_INSTRUCTION.as_bytes(), renamed_tasks).unwrap();
    let mut reordered_tasks = real_tasks(3);
    reordered_tasks.swap(0, 1);
    let reordered = RealFixture::new(C5_INSTRUCTION.as_bytes(), reordered_tasks).unwrap();
    for (name, wrong) in [
        ("other instruction", &other_instruction),
        ("fewer tasks", &fewer),
        ("renamed approval", &renamed),
        ("reordered tasks", &reordered),
    ] {
        assert_eq!(
            code(Store::open_with(&real, Some(wrong))).as_deref(),
            Some("FIXTURE_MISMATCH"),
            "{name}"
        );
    }
    assert!(Store::open_with(&real, Some(&fixture)).is_ok());
    // A binding for the default profile cannot start a task of a real store.
    let mut store = Store::open_with(&real, Some(&fixture)).unwrap();
    start_plan(&mut store, 0);
    let mut synthetic = real_binding(&store, 0);
    synthetic.provider = "synthetic".into();
    synthetic.profile_id = "synthetic".into();
    let before = store.snapshot().unwrap();
    assert_eq!(
        store
            .begin_owned(&synthetic, "owned-start")
            .unwrap_err()
            .code,
        "UNSUPPORTED_EXECUTOR"
    );
    assert_eq!(store.snapshot().unwrap(), before);
    drop(store);
    // Last, because a restore holds the store for inspection only.
    assert!(Store::open_restored_with(&real, Some(&fixture)).is_ok());
}

#[test]
fn c7_tampering_with_a_real_document_is_refused_on_open_and_restore() {
    let fixture = fixture_of(C5_INSTRUCTION.as_bytes(), 3);
    type Edit = Box<dyn Fn(&mut Value)>;
    let edits: Vec<(&str, bool, Edit)> = vec![
        ("control: rewritten unchanged", true, Box::new(|_| {})),
        (
            "a fourth marker entry",
            false,
            Box::new(|doc| {
                doc["real_bounded_fixture"]["tasks"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"plan_id":"p4","task_id":"t4","approval_id":"a4"}));
            }),
        ),
        (
            "marker hash changed",
            false,
            Box::new(|doc| doc["real_bounded_fixture"]["instruction_hash"] = json!("f".repeat(64))),
        ),
        (
            "marker removed",
            false,
            Box::new(|doc| {
                doc.as_object_mut().unwrap().remove("real_bounded_fixture");
            }),
        ),
        (
            "marker with an extra key",
            false,
            Box::new(|doc| doc["real_bounded_fixture"]["extra"] = json!(true)),
        ),
        (
            "instruction replaced, hash kept",
            false,
            Box::new(|doc| {
                doc["plans"][0]["tasks"][0]["instruction"] = json!("Delete everything.")
            }),
        ),
        (
            "a human-decision step added",
            false,
            Box::new(|doc| doc["plans"][1]["tasks"][0]["requires_decision"] = json!(true)),
        ),
        (
            "plan renamed",
            false,
            Box::new(|doc| doc["plans"][2]["plan_id"] = json!("real-plan-9")),
        ),
        (
            "approval renamed",
            false,
            Box::new(|doc| doc["plans"][0]["approval"]["approval_id"] = json!("real-approval-9")),
        ),
        (
            "task renamed",
            false,
            Box::new(|doc| doc["plans"][1]["tasks"][0]["task_id"] = json!("real-task-9")),
        ),
        (
            "a plan dropped",
            false,
            Box::new(|doc| {
                doc["plans"].as_array_mut().unwrap().pop();
            }),
        ),
        (
            "a second task in a plan",
            false,
            Box::new(|doc| {
                let task = doc["plans"][0]["tasks"][0].clone();
                doc["plans"][0]["tasks"].as_array_mut().unwrap().push(task);
            }),
        ),
    ];
    for (name, ok, edit) in edits {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state.sqlite3");
        drop(Store::open_with(&path, Some(&fixture)).unwrap());
        {
            let db = rusqlite::Connection::open(&path).unwrap();
            let raw: String = db
                .query_row("SELECT document FROM domain_state WHERE id=1", [], |r| {
                    r.get(0)
                })
                .unwrap();
            let mut doc: Value = serde_json::from_str(&raw).unwrap();
            edit(&mut doc);
            db.execute(
                "UPDATE domain_state SET document=? WHERE id=1",
                [doc.to_string()],
            )
            .unwrap();
        }
        assert_eq!(
            Store::open_with(&path, Some(&fixture)).is_ok(),
            ok,
            "open: {name}"
        );
        assert_eq!(
            Store::open_restored_with(&path, Some(&fixture)).is_ok(),
            ok,
            "restore: {name}"
        );
    }
}

#[tokio::test]
async fn c7_the_scheduler_sends_the_instruction_files_hash_in_the_binding() {
    let (root, config_path) = c5_dir();
    std::fs::write(root.path().join("credential"), CREDENTIAL).unwrap();
    let fixture = fixture_of(C5_INSTRUCTION.as_bytes(), 3);
    let mut store = Store::open_with(&root.path().join("state.sqlite3"), Some(&fixture)).unwrap();
    // The second listed task: no attempt is tied to the first plan.
    start_plan(&mut store, 1);
    let binding = real_binding(&store, 1);
    let (port, seen, server) = peer(peer_caps(REAL, "synthetic-host", true)).await;
    let mut config = real_config(C5_SHA256, "c5-instruction.txt", json!(real_tasks(3)));
    config["port"] = json!(port);
    config["binding"] = json!(binding);
    std::fs::write(&config_path, config.to_string()).unwrap();
    let ExecutorConfig::OwnedHttp(config) = ExecutorConfig::load(&config_path).unwrap() else {
        panic!()
    };
    assert_eq!(config.real_fixture(), Some(&fixture));
    let mut http = OwnedHttp::new(config).unwrap();
    let store = Arc::new(Mutex::new(store));
    http.tick(&store).await.unwrap();
    assert_eq!(
        names(&seen),
        [
            "server/discover",
            "tools/list",
            "capabilities",
            "owned_start"
        ]
    );
    {
        let calls = seen.lock().unwrap();
        let start = &calls[3].1;
        assert_eq!(start["profile"], REAL);
        assert_eq!(start["binding"]["instruction_hash"], C5_SHA256);
        assert_eq!(start["binding"]["plan_id"], "real-plan-2");
        assert_eq!(start["binding"]["task_id"], "real-task-2");
        assert_eq!(start["binding"]["approval_id"], "real-approval-2");
        assert_eq!(start["binding"]["provider"], "claude");
        assert_eq!(start["binding"]["profile_id"], "claude-example");
        assert_eq!(start["request_id"], "start-request");
    }
    let recorded = store.lock().unwrap().owned_request(&binding).unwrap();
    assert_eq!(recorded.as_deref(), Some("start-request"));
    server.abort();
}

#[tokio::test]
async fn c7_a_placeholder_scope_hash_loads_but_nothing_is_stored_or_sent() {
    let (root, config_path) = c5_dir();
    std::fs::write(root.path().join("credential"), CREDENTIAL).unwrap();
    let fixture = fixture_of(C5_INSTRUCTION.as_bytes(), 1);
    let mut store = Store::open_with(&root.path().join("state.sqlite3"), Some(&fixture)).unwrap();
    start_plan(&mut store, 0);
    let real = real_binding(&store, 0);
    let (port, seen, server) = peer(peer_caps(REAL, "synthetic-host", true)).await;
    // real_config's binding carries a made-up scope hash and another instance.
    let mut config = real_config(C5_SHA256, "c5-instruction.txt", json!(real_tasks(1)));
    config["port"] = json!(port);
    config["binding"]["executor_instance_id"] = json!("owned-boot");
    config["binding"]["attempt_id"] = json!(real.attempt_id);
    assert_ne!(config["binding"]["scope_hash"], json!(real.scope_hash));
    std::fs::write(&config_path, config.to_string()).unwrap();
    let ExecutorConfig::OwnedHttp(config) = ExecutorConfig::load(&config_path).unwrap() else {
        panic!()
    };
    let mut http = OwnedHttp::new(config).unwrap();
    let store = Arc::new(Mutex::new(store));
    let error = http.tick(&store).await.unwrap_err();
    assert_eq!(error, "STALE_BINDING");
    assert!(!names(&seen).contains(&"owned_start".to_string()));
    // The binding read back from the store is the one that is accepted.
    assert_eq!(store.lock().unwrap().owned_request(&real).unwrap(), None);
    assert_eq!(
        store
            .lock()
            .unwrap()
            .begin_owned(&real, "start-request")
            .unwrap()["fresh"],
        true
    );
    server.abort();
}

// --- C10: the real profile's `verification` is the CLI's real_bounded_verification ---
//
// Since CLI 8e959f2d the real profile's owned_request/poll/evidence return a
// document that pairs the fixed-payload verdict with the folder effects, and
// carries the verifier receipt inside it. Iris must accept exactly that shape for
// the real profile, keep the old receipt-or-null shape for the synthetic one, and
// never read the verdict as a task outcome.

/// A started store with the real-profile intent recorded, and its binding.
fn c10_store(root: &Path) -> (Store, CliBinding) {
    let mut store = started(&root.join("state.sqlite3"));
    let b = binding(&store, "claude", "claude-example");
    store.begin_owned(&b, "owned-start").unwrap();
    (store, b)
}
fn with_verification(profile: &str, b: &CliBinding, verification: Value) -> Value {
    let mut observation = native(profile, b);
    observation["verification"] = verification;
    observation
}
/// The observation is stored, survives a reopen, and changes nothing else.
fn c10_accepted(root: &Path, verification: impl Fn(&CliBinding) -> Value, label: &str) {
    let (mut store, b) = c10_store(root);
    let observation = with_verification(REAL, &b, verification(&b));
    store
        .observe_owned(&b, "owned-start", &observation)
        .unwrap_or_else(|e| panic!("{label}: {}", e.code));
    let task = store.snapshot().unwrap()["plans"][0]["tasks"][0].clone();
    assert_eq!(task["native_observation"], observation, "{label}");
    // A verdict, pass or fail, is a record only: nothing is concluded from it.
    assert_eq!(task["status"], "unknown", "{label}");
    assert_eq!(task["outcome"], "unknown", "{label}");
    assert_eq!(task["effects"], "unknown", "{label}");
    assert_eq!(task["execution_state"], "unknown", "{label}");
    let actions = store.snapshot().unwrap()["plans"][0]["allowed_actions"].clone();
    assert!(
        !actions.as_array().unwrap().contains(&json!("handoff_task")),
        "{label}"
    );
    // The stored observation is checked again on open and on restore.
    drop(store);
    let path = root.join("state.sqlite3");
    let reopened = Store::open(&path).unwrap_or_else(|e| panic!("{label} reopen: {}", e.code));
    assert_eq!(
        reopened.snapshot().unwrap()["plans"][0]["tasks"][0]["native_observation"],
        observation,
        "{label}"
    );
    drop(reopened);
    assert!(Store::open_restored(&path).is_ok(), "{label} restore");
}
/// The observation is refused as STALE_BINDING and the store is unchanged.
fn c10_refused(store: &mut Store, b: &CliBinding, profile: &str, verification: Value, label: &str) {
    let before = store.snapshot().unwrap();
    let observation = with_verification(profile, b, verification);
    assert_eq!(
        store
            .observe_owned(b, "owned-start", &observation)
            .err()
            .map(|e| e.code),
        Some("STALE_BINDING".to_string()),
        "{label}"
    );
    assert_eq!(store.snapshot().unwrap(), before, "{label}");
}
fn pass_document(b: &CliBinding) -> Value {
    real_verification(
        receipt(b, "pass"),
        json!(null),
        json!("folder-payload-only"),
        json!(null),
    )
}

#[test]
fn c10_real_accepts_waiting_without_a_receipt() {
    let root = tempfile::tempdir().unwrap();
    c10_accepted(
        root.path(),
        |_| {
            real_verification(
                json!(null),
                json!("VERIFY_STOP_UNCONFIRMED"),
                json!(null),
                json!(null),
            )
        },
        "waiting",
    );
}

#[test]
fn c10_real_accepts_pass_paired_with_folder_payload_only() {
    let root = tempfile::tempdir().unwrap();
    c10_accepted(
        root.path(),
        |b| {
            let document = pass_document(b);
            assert_eq!(document["verdict"], "pass");
            assert_eq!(document["folder_effects"], "folder-payload-only");
            document
        },
        "pass",
    );
}

#[test]
fn c10_real_accepts_fail() {
    let root = tempfile::tempdir().unwrap();
    c10_accepted(
        root.path(),
        |b| {
            real_verification(
                receipt(b, "fail"),
                json!(null),
                json!("folder-unexpected-change"),
                json!(null),
            )
        },
        "fail",
    );
    let other = tempfile::tempdir().unwrap();
    // A failed folder observation: no effects, its fixed reason code only.
    c10_accepted(
        other.path(),
        |b| {
            real_verification(
                receipt(b, "fail"),
                json!(null),
                json!(null),
                json!("FOLDER_LIMIT"),
            )
        },
        "fail without folder effects",
    );
}

#[test]
fn c10_real_refuses_a_flag_that_is_not_exactly_false() {
    let root = tempfile::tempdir().unwrap();
    let (mut store, b) = c10_store(root.path());
    for field in [
        "task_outcome_verified",
        "effects_verified",
        "remote_jobs_stopped",
    ] {
        for value in [json!(true), json!("false"), json!(0), json!(null)] {
            let mut document = pass_document(&b);
            document[field] = value.clone();
            c10_refused(&mut store, &b, REAL, document, &format!("{field}={value}"));
            let mut document = pass_document(&b);
            document["receipt"][field] = value.clone();
            c10_refused(
                &mut store,
                &b,
                REAL,
                document,
                &format!("receipt {field}={value}"),
            );
        }
        let mut document = pass_document(&b);
        document.as_object_mut().unwrap().remove(field);
        c10_refused(&mut store, &b, REAL, document, &format!("{field} missing"));
    }
    // The waiting document's flags are checked too.
    let mut waiting = real_verification(
        json!(null),
        json!("VERIFY_STOP_UNCONFIRMED"),
        json!(null),
        json!(null),
    );
    waiting["effects_verified"] = json!(true);
    c10_refused(&mut store, &b, REAL, waiting, "waiting effects_verified");
}

#[test]
fn c10_real_refuses_a_verdict_that_differs_from_its_receipt() {
    let root = tempfile::tempdir().unwrap();
    let (mut store, b) = c10_store(root.path());
    for (receipt_verdict, verdict) in [
        ("pass", json!("fail")),
        ("fail", json!("pass")),
        ("pass", json!(null)),
        ("fail", json!(null)),
    ] {
        let mut document = pass_document(&b);
        document["receipt"] = receipt(&b, receipt_verdict);
        document["verdict"] = verdict.clone();
        c10_refused(
            &mut store,
            &b,
            REAL,
            document,
            &format!("receipt {receipt_verdict} verdict {verdict}"),
        );
    }
    // No receipt, but a verdict anyway.
    for verdict in ["pass", "fail"] {
        let mut document = real_verification(
            json!(null),
            json!("VERIFY_STOP_UNCONFIRMED"),
            json!(null),
            json!(null),
        );
        document["verdict"] = json!(verdict);
        c10_refused(
            &mut store,
            &b,
            REAL,
            document,
            &format!("no receipt {verdict}"),
        );
    }
    // A verdict outside null / "pass" / "fail", on both sides.
    for verdict in [
        json!("PASS"),
        json!("unknown"),
        json!(true),
        json!(1),
        json!(""),
    ] {
        let mut document = pass_document(&b);
        document["verdict"] = verdict.clone();
        document["receipt"]["verdict"] = verdict.clone();
        c10_refused(
            &mut store,
            &b,
            REAL,
            document,
            &format!("verdict {verdict}"),
        );
    }
}

#[test]
fn c10_real_refuses_a_receipt_for_another_binding_or_owner() {
    let root = tempfile::tempdir().unwrap();
    let (mut store, b) = c10_store(root.path());
    for (key, value) in [
        ("fence", json!(2)),
        ("attempt_id", json!("attempt-other")),
        ("execution_host_id", json!("another-host")),
        ("provider", json!("synthetic")),
        ("profile_id", json!("synthetic")),
    ] {
        let mut document = pass_document(&b);
        document["receipt"]["binding"][key] = value.clone();
        c10_refused(&mut store, &b, REAL, document, &format!("binding {key}"));
    }
    let mut document = pass_document(&b);
    document["receipt"]
        .as_object_mut()
        .unwrap()
        .remove("binding");
    c10_refused(&mut store, &b, REAL, document, "binding missing");
    for (key, value) in [
        ("owner_id", json!("another-owner")),
        ("owner_epoch", json!(2)),
        ("verification_scope", json!("folder-payload-only")),
        ("verification_scope", json!(null)),
    ] {
        let mut document = pass_document(&b);
        document["receipt"][key] = value.clone();
        c10_refused(&mut store, &b, REAL, document, &format!("{key}={value}"));
    }
}

#[test]
fn c10_real_refuses_unknown_missing_or_mistyped_keys() {
    let root = tempfile::tempdir().unwrap();
    let (mut store, b) = c10_store(root.path());
    for key in ["outcome", "binding", "task_succeeded", "Verdict", ""] {
        let mut document = pass_document(&b);
        document[key] = json!(null);
        c10_refused(
            &mut store,
            &b,
            REAL,
            document,
            &format!("unknown key {key:?}"),
        );
    }
    for key in [
        "kind",
        "verdict",
        "reason",
        "folder_effects",
        "folder_reason",
        "receipt",
    ] {
        let mut document = pass_document(&b);
        document.as_object_mut().unwrap().remove(key);
        c10_refused(&mut store, &b, REAL, document, &format!("{key} missing"));
    }
    for kind in [json!("independent_verification"), json!(null), json!("")] {
        let mut document = pass_document(&b);
        document["kind"] = kind.clone();
        c10_refused(&mut store, &b, REAL, document, &format!("kind {kind}"));
    }
    for key in ["reason", "folder_effects", "folder_reason"] {
        for value in [
            json!(1),
            json!(true),
            json!(["a"]),
            json!({"effects":"none"}),
        ] {
            let mut document = pass_document(&b);
            document[key] = value.clone();
            c10_refused(&mut store, &b, REAL, document, &format!("{key}={value}"));
        }
    }
    for receipt in [json!("receipt"), json!([]), json!(1)] {
        let mut document = pass_document(&b);
        document["receipt"] = receipt.clone();
        c10_refused(
            &mut store,
            &b,
            REAL,
            document,
            &format!("receipt {receipt}"),
        );
    }
    // The real profile no longer takes the bare receipt or null in its place.
    c10_refused(&mut store, &b, REAL, receipt(&b, "pass"), "bare receipt");
    c10_refused(&mut store, &b, REAL, json!(null), "null");
    c10_refused(&mut store, &b, REAL, json!("pass"), "string");
}

#[test]
fn c10_the_synthetic_profile_keeps_its_receipt_and_refuses_the_new_document() {
    let root = tempfile::tempdir().unwrap();
    let mut store = started(&root.path().join("state.sqlite3"));
    let b = binding(&store, "synthetic", "synthetic");
    store.begin_owned(&b, "owned-start").unwrap();
    for (label, document) in [
        ("pass", pass_document(&b)),
        (
            "waiting",
            real_verification(
                json!(null),
                json!("VERIFY_STOP_UNCONFIRMED"),
                json!(null),
                json!(null),
            ),
        ),
    ] {
        c10_refused(&mut store, &b, SYNTHETIC, document, label);
    }
    // Its own shapes are unchanged: null, then the bare receipt.
    let null = with_verification(SYNTHETIC, &b, json!(null));
    store.observe_owned(&b, "owned-start", &null).unwrap();
    let bare = with_verification(SYNTHETIC, &b, receipt(&b, "fail"));
    store.observe_owned(&b, "owned-start", &bare).unwrap();
    let task = store.snapshot().unwrap()["plans"][0]["tasks"][0].clone();
    assert_eq!(task["native_observation"], bare);
    assert_eq!(task["outcome"], "unknown");
}

/// Rewrites the stored real-profile observation's `verification` in place, as an
/// Iris before C10 would have stored it from a CLI before C10.
fn c10_store_verification(path: &Path, verification: Value) {
    let db = rusqlite::Connection::open(path).unwrap();
    let raw: String = db
        .query_row("SELECT document FROM domain_state WHERE id=1", [], |r| {
            r.get(0)
        })
        .unwrap();
    let mut doc: Value = serde_json::from_str(&raw).unwrap();
    doc["plans"][0]["tasks"][0]["native_observation"]["verification"] = verification;
    db.execute(
        "UPDATE domain_state SET document=? WHERE id=1",
        [doc.to_string()],
    )
    .unwrap();
}

#[test]
fn c10_a_real_observation_stored_before_c10_stays_readable_but_null_is_never_new() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite3");
    let (mut store, b) = c10_store(root.path());
    store
        .observe_owned(
            &b,
            "owned-start",
            &with_verification(REAL, &b, pass_document(&b)),
        )
        .unwrap();
    drop(store);
    // History from a CLI before C10: verification null, no verdict claimed.
    c10_store_verification(&path, json!(null));
    let mut store = Store::open(&path).unwrap_or_else(|e| panic!("reopen: {}", e.code));
    let task = store.snapshot().unwrap()["plans"][0]["tasks"][0].clone();
    assert!(task["native_observation"]["verification"].is_null());
    assert_eq!(task["outcome"], "unknown");
    // A new real observation still may not be null, and the store is unchanged.
    c10_refused(&mut store, &b, REAL, json!(null), "new null");
    // A new document replaces the old record. (Not the one first observed: an
    // observation already audited is returned as history and never re-applied.)
    let fresh = with_verification(
        REAL,
        &b,
        real_verification(
            receipt(&b, "fail"),
            json!(null),
            json!("folder-unexpected-change"),
            json!(null),
        ),
    );
    store.observe_owned(&b, "owned-start", &fresh).unwrap();
    assert_eq!(
        store.snapshot().unwrap()["plans"][0]["tasks"][0]["native_observation"],
        fresh
    );
    drop(store);
    assert!(Store::open_restored(&path).is_ok());
    // Only null is tolerated in history: a stored bare receipt still fails to open.
    c10_store_verification(&path, receipt(&b, "pass"));
    assert_eq!(
        Store::open(&path).err().map(|e| e.code),
        Some("STALE_BINDING".to_string())
    );
}
