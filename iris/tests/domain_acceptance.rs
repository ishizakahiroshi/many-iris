//! Independent acceptance cases against the public domain API.
use many_iris::domain::Store;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

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
fn start_payload(store: &Store) -> Value {
    let p = store.snapshot().unwrap()["plans"][0].clone();
    json!({"plan_id":p["plan_id"],"plan_revision":p["plan_revision"],"plan_hash":p["plan_hash"],"approval_id":p["approval"]["approval_id"],"approval_revision":p["approval"]["revision"]})
}
fn started(store: &mut Store) -> Value {
    let p = start_payload(store);
    apply(store, "start_plan", "start", p).unwrap();
    store.snapshot().unwrap()["plans"][0].clone()
}
fn dispatched(store: &mut Store) -> Value {
    let p = started(store);
    let t = &p["tasks"][0];
    apply(store,"dispatch_attempt","dispatch",json!({"run_id":p["run_id"],"task_id":t["task_id"],"instruction_revision":t["instruction_revision"],"instruction_hash":t["instruction_hash"],"executor_id":"synthetic-executor","executor_instance_id":"boot-test","execution_host_id":"synthetic-host"})).unwrap();
    store.snapshot().unwrap()["plans"][0]["tasks"][0].clone()
}
fn event(t: &Value, kind: &str, seq: u64) -> Value {
    json!({"attempt_id":t["attempt_id"],"fence":t["fence"],"executor_instance_id":t["executor_instance_id"],"event_seq":seq,"event_kind":kind})
}
fn result(t: &Value, seq: u64) -> Value {
    let payload = format!(
        "synthetic:completed:{}:{}:{}",
        t["attempt_id"].as_str().unwrap(),
        t["fence"],
        t["instruction_hash"].as_str().unwrap()
    );
    let mut e = event(t, "result", seq);
    e["outcome"] = "succeeded".into();
    e["owned_execution_ceased"] = true.into();
    e["observed_at"] = now().into();
    e["evidence"] = json!({"kind":"synthetic-sha256","sha256":format!("{:x}",Sha256::digest(payload.as_bytes())),"payload":payload});
    e
}

#[test]
fn receipt_replay_does_not_cross_identity_or_allow_changed_operation() {
    let temp = tempfile::tempdir().unwrap();
    let mut s = Store::open(&temp.path().join("state.sqlite")).unwrap();
    let p = start_payload(&s);
    let first = apply(&mut s, "start_plan", "same-request", p.clone()).unwrap();
    let replay = apply(&mut s, "start_plan", "same-request", p.clone()).unwrap();
    assert_eq!(first["receipt"], replay["receipt"]);
    let before = s.snapshot().unwrap();
    let mut forged = body("same-request", "start_plan", p);
    forged["principal_id"] = "other-user".into();
    assert_eq!(
        s.apply("start_plan", &forged).unwrap_err().code,
        "FORBIDDEN"
    );
    assert_eq!(
        apply(
            &mut s,
            "pause_plan",
            "same-request",
            json!({"run_id":before["plans"][0]["run_id"]})
        )
        .unwrap_err()
        .code,
        "REQUEST_CONFLICT"
    );
    assert_eq!(s.snapshot().unwrap(), before);
}

#[test]
fn stale_plan_or_approval_binding_cannot_start_or_cache_success() {
    for field in [
        "plan_revision",
        "approval_revision",
        "plan_hash",
        "approval_id",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let mut s = Store::open(&temp.path().join("state.sqlite")).unwrap();
        let mut p = start_payload(&s);
        let before = s.snapshot().unwrap();
        p[field] = if field.ends_with("revision") {
            json!(42)
        } else {
            json!("stale")
        };
        assert_eq!(
            apply(&mut s, "start_plan", "stale", p).unwrap_err().code,
            "STALE_APPROVAL"
        );
        assert_eq!(s.snapshot().unwrap(), before);
        let correct = start_payload(&s);
        assert!(apply(&mut s, "start_plan", "stale", correct).is_ok());
    }
}

#[test]
fn stale_event_fence_instance_and_sequence_have_no_partial_effect() {
    let temp = tempfile::tempdir().unwrap();
    let mut s = Store::open(&temp.path().join("state.sqlite")).unwrap();
    let t = dispatched(&mut s);
    let before = s.snapshot().unwrap();
    let mut wrong = event(&t, "accepted", 1);
    wrong["fence"] = 99.into();
    assert_eq!(
        apply(&mut s, "record_executor_event", "bad-fence", wrong)
            .unwrap_err()
            .code,
        "STALE_BINDING"
    );
    let mut wrong = event(&t, "accepted", 1);
    wrong["executor_instance_id"] = "old-instance".into();
    assert_eq!(
        apply(&mut s, "record_executor_event", "bad-instance", wrong)
            .unwrap_err()
            .code,
        "STALE_BINDING"
    );
    assert_eq!(
        apply(
            &mut s,
            "record_executor_event",
            "gap",
            event(&t, "running", 2)
        )
        .unwrap_err()
        .code,
        "SEQUENCE_GAP"
    );
    assert_eq!(s.snapshot().unwrap(), before);
}

#[test]
fn failure_in_audit_insert_rolls_back_state_and_request_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.sqlite");
    let mut s = Store::open(&path).unwrap();
    let p = start_payload(&s);
    let before = s.snapshot().unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    assert_eq!(
        apply(&mut s, "start_plan", "retry-after-storage", p.clone())
            .unwrap_err()
            .code,
        "STORAGE"
    );
    assert_eq!(s.snapshot().unwrap(), before);
    let receipts: i64 = db
        .query_row(
            "SELECT count(*) FROM requests WHERE request_id='retry-after-storage'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(receipts, 0);
    db.execute_batch("DROP TRIGGER reject_audit").unwrap();
    assert!(apply(&mut s, "start_plan", "retry-after-storage", p).is_ok());
}

#[test]
fn restart_keeps_unknown_and_rejects_handoff_without_stop_proof() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.sqlite");
    let t;
    {
        let mut s = Store::open(&path).unwrap();
        t = dispatched(&mut s);
    }
    let mut s = Store::open(&path).unwrap();
    assert_eq!(
        s.snapshot().unwrap()["plans"][0]["tasks"][0]["outcome"],
        "unknown"
    );
    assert_eq!(apply(&mut s,"handoff_task","unsafe-handoff",json!({"old_attempt_id":t["attempt_id"],"stop_receipt_id":"made-up","new_executor_id":"synthetic-executor-backup"})).unwrap_err().code,"STOP_UNCONFIRMED");
    assert!(apply(&mut s, "reconcile_attempt", "known-result", result(&t, 1)).is_ok());
    assert_eq!(
        s.snapshot().unwrap()["plans"][0]["tasks"][0]["outcome"],
        "succeeded"
    );
}

#[test]
fn restored_backup_rejects_replayed_grant_and_preserves_inspection() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.sqlite");
    let backup = temp.path().join("backup.sqlite");
    let mut s = Store::open(&path).unwrap();
    let p = start_payload(&s);
    apply(&mut s, "start_plan", "old-request", p.clone()).unwrap();
    s.backup_to(&backup).unwrap();
    let mut restored = Store::open_restored(&backup).unwrap();
    assert_eq!(restored.snapshot().unwrap()["restore_hold"], true);
    assert_eq!(
        apply(&mut restored, "start_plan", "old-request", p)
            .unwrap_err()
            .code,
        "RESTORE_HOLD"
    );
    assert!(
        restored.snapshot().unwrap()["plans"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["allowed_actions"] == json!([]))
    );
}

#[test]
fn stop_proof_cannot_be_for_another_request_or_predate_request() {
    let temp = tempfile::tempdir().unwrap();
    let mut s = Store::open(&temp.path().join("state.sqlite")).unwrap();
    let t = dispatched(&mut s);
    apply(
        &mut s,
        "request_stop",
        "stop-this",
        json!({"attempt_id":t["attempt_id"],"fence":t["fence"]}),
    )
    .unwrap();
    let before = s.snapshot().unwrap();
    for (request, observed) in [("different-stop", now()), ("stop-this", 0)] {
        let mut e = event(&t, "stop_observed", 1);
        e["stop_request_id"] = request.into();
        e["observed_at"] = observed.into();
        e["owned_execution_ceased"] = true.into();
        assert_eq!(
            apply(&mut s, "record_executor_event", "invalid-stop-evidence", e)
                .unwrap_err()
                .code,
            "INVALID_EVIDENCE"
        );
        assert_eq!(s.snapshot().unwrap(), before);
    }
}

#[test]
fn valid_completed_result_wins_race_with_stop_request() {
    let temp = tempfile::tempdir().unwrap();
    let mut s = Store::open(&temp.path().join("state.sqlite")).unwrap();
    let t = dispatched(&mut s);
    apply(
        &mut s,
        "request_stop",
        "stop-after-completion",
        json!({"attempt_id":t["attempt_id"],"fence":t["fence"]}),
    )
    .unwrap();
    // The owned synthetic executor returns its durable completed result when a
    // stop arrives after its completion deadline. Do not strand that truth.
    apply(
        &mut s,
        "record_executor_event",
        "completion-raced-stop",
        result(&t, 1),
    )
    .expect("valid completion proof must resolve stop race");
    assert_eq!(
        s.snapshot().unwrap()["plans"][0]["tasks"][0]["outcome"],
        "succeeded"
    );
}

#[test]
fn durable_terminal_query_resolves_missed_progress_after_restart() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.sqlite");
    let t;
    {
        let mut s = Store::open(&path).unwrap();
        t = dispatched(&mut s);
        apply(
            &mut s,
            "record_executor_event",
            "accepted",
            event(&t, "accepted", 1),
        )
        .unwrap();
    }
    let mut s = Store::open(&path).unwrap();
    // Executor has persisted running seq2, but that reply was lost. Its latest
    // durable terminal result is seq3. Recovery must reconcile this evidence
    // without starting a replacement or inventing a missing notification.
    apply(&mut s, "reconcile_attempt", "query-terminal", result(&t, 3))
        .expect("durable terminal query must have a recovery path after missed progress");
    assert_eq!(
        s.snapshot().unwrap()["plans"][0]["tasks"][0]["outcome"],
        "succeeded"
    );
}

#[test]
fn corrupted_plan_state_must_not_render_false_completion() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.sqlite");
    {
        let s = Store::open(&path).unwrap();
        assert_eq!(s.snapshot().unwrap()["plans"][0]["plan_state"], "ready");
    }
    // Keep SQLite pages and JSON syntactically valid, but corrupt the business
    // state invariant. Pending tasks without evidence cannot be a completed plan.
    {
        let db = rusqlite::Connection::open(&path).unwrap();
        let raw: String = db
            .query_row("SELECT document FROM domain_state WHERE id=1", [], |r| {
                r.get(0)
            })
            .unwrap();
        let mut doc: Value = serde_json::from_str(&raw).unwrap();
        doc["plans"][0]["plan_state"] = "completed".into();
        db.execute(
            "UPDATE domain_state SET document=? WHERE id=1",
            [doc.to_string()],
        )
        .unwrap();
    }
    assert!(
        Store::open(&path).is_err(),
        "semantically corrupted completion must fail closed, not be displayed as completed"
    );
}
