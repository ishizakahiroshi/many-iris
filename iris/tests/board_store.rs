//! The board's store and writer keys, without HTTP. Synthetic values only.
use many_iris::board::{
    AuthError, BoardError, BoardStore, Limits, MAX_DEPTH, MAX_EVENTS, MAX_ITEMS, Writers,
    add_writer, sha256_hex,
};
use many_iris::domain::Store;
use serde_json::{Value, json};
use std::path::PathBuf;

fn open_with(limits: Limits) -> (tempfile::TempDir, PathBuf, BoardStore) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("iris.sqlite3");
    let store = BoardStore::open_with_limits(&path, limits).unwrap();
    (dir, path, store)
}
fn open() -> (tempfile::TempDir, PathBuf, BoardStore) {
    open_with(Limits::default())
}
fn item(id: &str) -> Value {
    json!({"item_id": id, "project": "example-project", "kind": "task", "title": "Write the example", "state": "planned"})
}
fn with(mut base: Value, extra: Value) -> Value {
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}
fn code(r: Result<Value, BoardError>) -> String {
    r.expect_err("expected an error").code
}
fn rev(v: &Value) -> i64 {
    v["item"]["revision"].as_i64().unwrap()
}
fn events_of(store: &BoardStore) -> Vec<Value> {
    store.list(None, 0, 1000, false).unwrap()["events"]
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn limits_are_the_documented_ones() {
    assert_eq!(MAX_ITEMS, 5000);
    assert_eq!(MAX_EVENTS, 50000);
    assert_eq!(MAX_DEPTH, 6);
    let (_d, _p, store) = open();
    assert_eq!(store.limits().items, 5000);
    assert_eq!(store.limits().events, 50000);
}

#[test]
fn opening_again_changes_nothing_and_the_domain_store_still_opens() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("iris.sqlite3");
    {
        // The domain store is open while the board tables are added.
        let _domain = Store::open(&path).unwrap();
        let mut a = BoardStore::open(&path).unwrap();
        let mut b = BoardStore::open(&path).unwrap();
        a.upsert_item("writer-a", &item("one")).unwrap();
        b.upsert_item("writer-b", &item("two")).unwrap();
    }
    // Reopened: the domain schema check still passes and nothing was lost.
    let _domain = Store::open(&path).unwrap();
    let again = BoardStore::open(&path).unwrap();
    let listed = again.list(None, 0, 10, false).unwrap();
    assert_eq!(listed["items"].as_array().unwrap().len(), 2);
    let raw = rusqlite::Connection::open(&path).unwrap();
    let version: i64 = raw
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 1, "the board must not change user_version");
}

#[test]
fn the_actor_is_the_caller_and_a_body_actor_is_refused() {
    let (_d, _p, mut store) = open();
    let created = store.upsert_item("mary-bot", &item("a")).unwrap();
    assert_eq!(created["item"]["updated_by"], "mary-bot");
    assert_eq!(
        code(store.upsert_item(
            "mary-bot",
            &with(item("b"), json!({"actor": "someone-else"}))
        )),
        "INVALID"
    );
    assert_eq!(
        code(store.upsert_item(
            "mary-bot",
            &with(item("b"), json!({"updated_by": "someone-else"}))
        )),
        "INVALID"
    );
    assert!(store.upsert_item("mary-bot", &item("b")).is_ok());
    let event = store
        .add_event(
            "mary-bot",
            &json!({"item_id": "a", "kind": "note", "text": "hello"}),
        )
        .unwrap();
    assert_eq!(event["event"]["actor"], "mary-bot");
    assert_eq!(
        code(store.add_event(
            "mary-bot",
            &json!({"item_id": "a", "kind": "note", "text": "x", "actor": "other"})
        )),
        "INVALID"
    );
    let update = store
        .upsert_item("other-bot", &json!({"item_id": "a", "title": "Renamed"}))
        .unwrap();
    assert_eq!(update["item"]["updated_by"], "other-bot");
}

#[test]
fn creating_needs_project_kind_title_and_state() {
    let (_d, _p, mut store) = open();
    for missing in ["project", "kind", "title", "state"] {
        let mut v = item("a");
        v.as_object_mut().unwrap().remove(missing);
        assert_eq!(code(store.upsert_item("w", &v)), "INVALID", "{missing}");
    }
    assert_eq!(
        code(store.upsert_item("w", &json!({"item_id": "a", "mystery": 1}))),
        "INVALID"
    );
    assert_eq!(
        code(store.upsert_item("w", &with(item("a"), json!({"kind": "epic"})))),
        "INVALID"
    );
    assert_eq!(
        code(store.upsert_item("w", &with(item("a"), json!({"state": "finished"})))),
        "INVALID"
    );
}

#[test]
fn field_lengths_and_the_id_pattern() {
    let (_d, _p, mut store) = open();
    let (long_ok, long_bad) = ("x".repeat(128), "x".repeat(129));
    for ok in ["a", "A9._:/-", long_ok.as_str()] {
        assert!(
            store.upsert_item("w", &with(item(ok), json!({}))).is_ok(),
            "{ok}"
        );
    }
    for bad in ["", "has space", "ünï", "a;b", "a\\b", long_bad.as_str()] {
        assert_eq!(
            code(store.upsert_item("w", &with(item("z"), json!({"item_id": bad})))),
            "INVALID",
            "{bad:?}"
        );
    }
    assert!(
        store
            .upsert_item("w", &with(item("t1"), json!({"title": "字".repeat(200)})))
            .is_ok()
    );
    assert_eq!(
        code(store.upsert_item("w", &with(item("t2"), json!({"title": "字".repeat(201)})))),
        "INVALID"
    );
    assert_eq!(
        code(store.upsert_item("w", &with(item("t3"), json!({"title": "bad\ntitle"})))),
        "INVALID"
    );
    assert_eq!(
        code(store.upsert_item("w", &with(item("t4"), json!({"title": "   "})))),
        "INVALID"
    );
    assert!(
        store
            .upsert_item("w", &with(item("p1"), json!({"project": "p".repeat(80)})))
            .is_ok()
    );
    assert_eq!(
        code(store.upsert_item("w", &with(item("p2"), json!({"project": "p".repeat(81)})))),
        "INVALID"
    );
}

#[test]
fn source_ref_is_a_relative_path_or_https_only() {
    let (_d, _p, mut store) = open();
    for ok in ["docs/local/plan_x.md", "https://example.com/plan"] {
        assert!(
            store
                .upsert_item("w", &with(item("ok"), json!({"source_ref": ok})))
                .is_ok(),
            "{ok}"
        );
    }
    for bad in [
        "/etc/passwd",
        "C:\\Users\\example\\plan.md",
        "C:/example/plan.md",
        "file:///example/plan.md",
        "docs/../secrets.md",
        "docs/plan\u{7}.md",
        "http://example.com/plan",
        "javascript:alert(1)",
        "",
    ] {
        assert_eq!(
            code(store.upsert_item("w", &with(item("bad"), json!({"source_ref": bad})))),
            "INVALID",
            "{bad:?}"
        );
    }
    let long = format!("docs/{}", "a".repeat(496));
    assert_eq!(
        code(store.upsert_item("w", &with(item("bad"), json!({"source_ref": long})))),
        "INVALID"
    );
    // The rejected writes left nothing behind.
    assert!(load(&store, "bad").is_none());
    // null clears.
    let cleared = store
        .upsert_item("w", &json!({"item_id": "ok", "source_ref": null}))
        .unwrap();
    assert!(cleared["item"]["source_ref"].is_null());
}
fn load(store: &BoardStore, id: &str) -> Option<Value> {
    store.list(None, 0, 10, false).unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["item_id"] == id)
        .cloned()
}

#[test]
fn dates_must_be_real_and_ordered() {
    let (_d, _p, mut store) = open();
    let ok = with(
        item("d"),
        json!({"planned_start": "2026-11-06", "planned_end": "2026-11-06"}),
    );
    assert!(store.upsert_item("w", &ok).is_ok());
    for patch in [
        json!({"planned_start": "2026-02-30"}),
        json!({"planned_start": "2026/11/06"}),
        json!({"planned_end": "2026-11-05"}),
        json!({"planned_start": "2026-11-07"}),
    ] {
        assert_eq!(
            code(store.upsert_item("w", &with(json!({"item_id": "d"}), patch.clone()))),
            "INVALID",
            "{patch}"
        );
    }
    assert_eq!(
        code(store.upsert_item(
            "w",
            &with(
                item("e"),
                json!({"planned_start": "2026-11-07", "planned_end": "2026-11-06"})
            )
        )),
        "INVALID"
    );
}

#[test]
fn waiting_needs_a_reason_and_leaving_it_drops_the_reason() {
    let (_d, _p, mut store) = open();
    assert_eq!(
        code(store.upsert_item("w", &with(item("a"), json!({"state": "waiting"})))),
        "INVALID"
    );
    assert_eq!(
        code(store.upsert_item(
            "w",
            &with(
                item("a"),
                json!({"state": "waiting", "waiting_reason": "r".repeat(201)})
            )
        )),
        "INVALID"
    );
    assert_eq!(
        code(store.upsert_item(
            "w",
            &with(
                item("a"),
                json!({"state": "planned", "waiting_reason": "stray"})
            )
        )),
        "INVALID"
    );
    let waiting = store
        .upsert_item(
            "w",
            &with(
                item("a"),
                json!({"state": "waiting", "waiting_reason": "r".repeat(200)}),
            ),
        )
        .unwrap();
    assert_eq!(waiting["item"]["state"], "waiting");
    let done = store
        .upsert_item("w", &json!({"item_id": "a", "state": "done"}))
        .unwrap();
    assert!(done["item"]["waiting_reason"].is_null());
    // Waiting again without a new reason is refused.
    assert_eq!(
        code(store.upsert_item("w", &json!({"item_id": "a", "state": "waiting"}))),
        "INVALID"
    );
}

#[test]
fn revisions_refuse_a_stale_writer_instead_of_overwriting() {
    let (_d, _p, mut store) = open();
    assert_eq!(
        code(store.upsert_item("w", &with(item("a"), json!({"expected_revision": 3})))),
        "REVISION_CONFLICT"
    );
    let first = store
        .upsert_item("w", &with(item("a"), json!({"expected_revision": 0})))
        .unwrap();
    assert_eq!(rev(&first), 1);
    let second = store
        .upsert_item(
            "w",
            &json!({"item_id": "a", "title": "Second", "expected_revision": 1}),
        )
        .unwrap();
    assert_eq!(rev(&second), 2);
    assert_eq!(
        code(store.upsert_item(
            "w",
            &json!({"item_id": "a", "title": "Stale", "expected_revision": 1})
        )),
        "REVISION_CONFLICT"
    );
    assert_eq!(
        code(store.upsert_item(
            "w",
            &json!({"item_id": "a", "title": "Stale", "expected_revision": 0})
        )),
        "REVISION_CONFLICT"
    );
    assert_eq!(load(&store, "a").unwrap()["title"], "Second");
    // Without expected_revision the write goes through and bumps the revision.
    let third = store
        .upsert_item("w", &json!({"item_id": "a", "title": "Third"}))
        .unwrap();
    assert_eq!(rev(&third), 3);
}

#[test]
fn a_write_that_changes_nothing_keeps_the_revision() {
    let (_d, _p, mut store) = open();
    store.upsert_item("w", &item("a")).unwrap();
    let again = store.upsert_item("other", &item("a")).unwrap();
    assert_eq!(again["changed"], false);
    assert_eq!(rev(&again), 1);
    assert_eq!(again["item"]["updated_by"], "w");
}

#[test]
fn a_state_change_adds_exactly_one_event() {
    let (_d, _p, mut store) = open();
    store.upsert_item("alice", &item("a")).unwrap();
    assert!(
        events_of(&store).is_empty(),
        "creating is not a state change"
    );
    store
        .upsert_item("alice", &json!({"item_id": "a", "title": "Renamed"}))
        .unwrap();
    assert!(
        events_of(&store).is_empty(),
        "a rename is not a state change"
    );
    store
        .upsert_item("bob", &json!({"item_id": "a", "state": "in_progress"}))
        .unwrap();
    let events = events_of(&store);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["kind"], "state_change");
    assert_eq!(events[0]["actor"], "bob");
    assert_eq!(events[0]["item_id"], "a");
    assert!(
        events[0]["text"]
            .as_str()
            .unwrap()
            .contains("planned -> in_progress")
    );
    store
        .upsert_item(
            "bob",
            &json!({"item_id": "a", "state": "in_progress", "title": "Again"}),
        )
        .unwrap();
    assert_eq!(events_of(&store).len(), 1, "same state, no new event");
    store
        .upsert_item(
            "bob",
            &json!({"item_id": "a", "state": "waiting", "waiting_reason": "review"}),
        )
        .unwrap();
    let events = events_of(&store);
    assert_eq!(events.len(), 2);
    assert!(events[1]["text"].as_str().unwrap().contains("review"));
    // The latest event is shown with the item.
    assert_eq!(
        load(&store, "a").unwrap()["last_event"]["seq"],
        events[1]["seq"]
    );
}

#[test]
fn parents_must_exist_share_the_project_and_never_form_a_cycle() {
    let (_d, _p, mut store) = open();
    store.upsert_item("w", &item("a")).unwrap();
    assert_eq!(
        code(store.upsert_item("w", &with(item("b"), json!({"parent_id": "ghost"})))),
        "PARENT_NOT_FOUND"
    );
    assert_eq!(
        code(store.upsert_item("w", &json!({"item_id": "a", "parent_id": "a"}))),
        "CYCLE"
    );
    store
        .upsert_item("w", &with(item("b"), json!({"parent_id": "a"})))
        .unwrap();
    store
        .upsert_item("w", &with(item("c"), json!({"parent_id": "b"})))
        .unwrap();
    assert_eq!(
        code(store.upsert_item("w", &json!({"item_id": "a", "parent_id": "c"}))),
        "CYCLE"
    );
    assert_eq!(
        code(store.upsert_item("w", &json!({"item_id": "a", "parent_id": "b"}))),
        "CYCLE"
    );
    assert_eq!(load(&store, "a").unwrap()["parent_id"], Value::Null);
    let other = with(
        item("x"),
        json!({"project": "another-project", "parent_id": "a"}),
    );
    assert_eq!(code(store.upsert_item("w", &other)), "PROJECT_MISMATCH");
    assert_eq!(
        code(store.upsert_item("w", &json!({"item_id": "a", "project": "another-project"}))),
        "PROJECT_MISMATCH"
    );
    // null makes it a root again.
    let root = store
        .upsert_item("w", &json!({"item_id": "c", "parent_id": null}))
        .unwrap();
    assert!(root["item"]["parent_id"].is_null());
}

#[test]
fn depth_is_limited_to_six_levels() {
    let (_d, _p, mut store) = open();
    store.upsert_item("w", &item("n1")).unwrap();
    for level in 2..=MAX_DEPTH {
        let parent = format!("n{}", level - 1);
        store
            .upsert_item(
                "w",
                &with(item(&format!("n{level}")), json!({"parent_id": parent})),
            )
            .unwrap_or_else(|e| panic!("level {level}: {e:?}"));
    }
    let too_deep = with(item("n7"), json!({"parent_id": format!("n{MAX_DEPTH}")}));
    assert_eq!(code(store.upsert_item("w", &too_deep)), "DEPTH");
    assert!(load(&store, "n7").is_none());
    // Moving a root that has a subtree under a deep parent is refused as well.
    store.upsert_item("w", &item("s1")).unwrap();
    store
        .upsert_item("w", &with(item("s2"), json!({"parent_id": "s1"})))
        .unwrap();
    assert_eq!(
        code(store.upsert_item("w", &json!({"item_id": "s1", "parent_id": "n5"}))),
        "DEPTH"
    );
    assert!(
        store
            .upsert_item("w", &json!({"item_id": "s2", "parent_id": "n4"}))
            .is_ok()
    );
}

#[test]
fn the_item_limit_refuses_without_dropping_anything() {
    let (_d, _p, mut store) = open_with(Limits {
        items: 3,
        events: 100,
    });
    for id in ["a", "b", "c"] {
        store.upsert_item("w", &item(id)).unwrap();
    }
    assert_eq!(code(store.upsert_item("w", &item("d"))), "BOARD_ITEM_LIMIT");
    // Updating an existing item is still possible.
    assert!(
        store
            .upsert_item("w", &json!({"item_id": "a", "title": "Still editable"}))
            .is_ok()
    );
    assert_eq!(
        store.list(None, 0, 10, false).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn the_event_limit_refuses_without_dropping_anything() {
    let (_d, _p, mut store) = open_with(Limits {
        items: 10,
        events: 3,
    });
    store.upsert_item("w", &item("a")).unwrap();
    for n in 0..3 {
        store
            .add_event(
                "w",
                &json!({"item_id": "a", "kind": "note", "text": format!("note {n}")}),
            )
            .unwrap();
    }
    assert_eq!(
        code(store.add_event(
            "w",
            &json!({"item_id": "a", "kind": "note", "text": "one too many"})
        )),
        "BOARD_EVENT_LIMIT"
    );
    // A state change needs an event too, so it is refused whole: the state stays.
    assert_eq!(
        code(store.upsert_item("w", &json!({"item_id": "a", "state": "done"}))),
        "BOARD_EVENT_LIMIT"
    );
    assert_eq!(load(&store, "a").unwrap()["state"], "planned");
    assert_eq!(load(&store, "a").unwrap()["revision"], 1);
    let events = events_of(&store);
    assert_eq!(events.len(), 3);
    assert_eq!(events[0]["text"], "note 0");
}

#[test]
fn events_have_kinds_limits_and_an_existing_item() {
    let (_d, _p, mut store) = open();
    store.upsert_item("w", &item("a")).unwrap();
    assert_eq!(
        code(store.add_event(
            "w",
            &json!({"item_id": "ghost", "kind": "note", "text": "x"})
        )),
        "NOT_FOUND"
    );
    assert_eq!(
        code(store.add_event(
            "w",
            &json!({"item_id": "a", "kind": "state_change", "text": "x"})
        )),
        "INVALID"
    );
    assert_eq!(
        code(store.add_event("w", &json!({"item_id": "a", "kind": "shout", "text": "x"}))),
        "INVALID"
    );
    assert_eq!(
        code(store.add_event("w", &json!({"item_id": "a", "kind": "note", "text": ""}))),
        "INVALID"
    );
    assert_eq!(
        code(store.add_event(
            "w",
            &json!({"item_id": "a", "kind": "note", "text": "字".repeat(2001)})
        )),
        "INVALID"
    );
    assert!(
        store
            .add_event(
                "w",
                &json!({"item_id": "a", "kind": "note", "text": "字".repeat(2000)})
            )
            .is_ok()
    );
    assert!(
        store
            .add_event(
                "w",
                &json!({"item_id": "a", "kind": "note", "text": "two\nlines"})
            )
            .is_ok()
    );
    assert_eq!(
        code(store.add_event(
            "w",
            &json!({"item_id": "a", "kind": "note", "text": "x", "ref": "http://example.com/a"})
        )),
        "INVALID"
    );
    assert_eq!(
        code(store.add_event(
            "w",
            &json!({"item_id": "a", "kind": "note", "text": "x", "ref": "/etc/passwd"})
        )),
        "INVALID"
    );
    assert_eq!(code(store.add_event("w", &json!({"item_id": "a", "kind": "note", "text": "x", "ref": format!("https://example.com/{}", "a".repeat(500))}))), "INVALID");
    let ok = store.add_event("w", &json!({"item_id": "a", "kind": "session_start", "text": "x", "ref": "https://example.com/session/1"})).unwrap();
    assert_eq!(ok["event"]["ref"], "https://example.com/session/1");
    assert_eq!(events_of(&store).len(), 3);
}

#[test]
fn events_and_items_cannot_be_rewritten_or_deleted() {
    let (_d, path, mut store) = open();
    store.upsert_item("w", &item("a")).unwrap();
    store
        .add_event(
            "w",
            &json!({"item_id": "a", "kind": "note", "text": "kept"}),
        )
        .unwrap();
    let raw = rusqlite::Connection::open(&path).unwrap();
    assert!(raw.execute("DELETE FROM board_events", []).is_err());
    assert!(
        raw.execute("UPDATE board_events SET text='changed'", [])
            .is_err()
    );
    assert!(raw.execute("DELETE FROM board_items", []).is_err());
    assert_eq!(events_of(&store)[0]["text"], "kept");
}

#[test]
fn list_filters_by_project_and_sequence() {
    let (_d, _p, mut store) = open();
    store.upsert_item("w", &item("a")).unwrap();
    store
        .upsert_item("w", &with(item("b"), json!({"project": "second-project"})))
        .unwrap();
    for (id, text) in [("a", "one"), ("b", "two"), ("a", "three")] {
        store
            .add_event("w", &json!({"item_id": id, "kind": "note", "text": text}))
            .unwrap();
    }
    let all = store.list(None, 0, 10, false).unwrap();
    assert_eq!(all["items"].as_array().unwrap().len(), 2);
    assert_eq!(all["events"].as_array().unwrap().len(), 3);
    let second = store.list(Some("second-project"), 0, 10, false).unwrap();
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    assert_eq!(second["events"].as_array().unwrap().len(), 1);
    let first_seq = all["events"][0]["seq"].as_u64().unwrap();
    let later = store.list(None, first_seq, 10, false).unwrap();
    assert_eq!(later["events"].as_array().unwrap().len(), 2);
    assert_eq!(later["next_since_seq"], all["next_since_seq"]);
    let empty = store
        .list(None, all["next_since_seq"].as_u64().unwrap(), 10, false)
        .unwrap();
    assert!(empty["events"].as_array().unwrap().is_empty());
    assert_eq!(empty["next_since_seq"], all["next_since_seq"]);
    let cut = store.list(None, 0, 2, false).unwrap();
    assert_eq!(cut["events"].as_array().unwrap().len(), 2);
    assert_eq!(cut["events_truncated"], true);
    let newest = store.list(None, 0, 2, true).unwrap();
    assert_eq!(newest["events"][0]["text"], "three");
    assert_eq!(all["counts"], json!({"items": 2, "events": 3}));
    // The tool entry point takes the same two filters.
    let by_tool = store
        .list_for_tool(&json!({"project": "second-project", "since_seq": 0}))
        .unwrap();
    assert_eq!(by_tool["events"].as_array().unwrap().len(), 1);
    assert_eq!(
        code(store.list_for_tool(&json!({"project": "x", "extra": 1}))),
        "INVALID"
    );
}

// ------------------------------------------------------------------- writers

fn writers_json(entries: Value) -> Vec<u8> {
    json!({"schema_version": 1, "writers": entries})
        .to_string()
        .into_bytes()
}
const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn writers_file_is_strict() {
    assert!(Writers::parse(&writers_json(json!([]))).is_ok());
    assert!(
        Writers::parse(&writers_json(
            json!([{"actor": "many-ai-cli", "token_sha256": HASH_A, "enabled": true}])
        ))
        .is_ok()
    );
    for bad in [
        json!({"schema_version": 2, "writers": []}),
        json!({"writers": []}),
        json!({"schema_version": 1}),
        json!({"schema_version": 1, "writers": [], "extra": 1}),
        json!({"schema_version": 1, "writers": [{"actor": "Upper", "token_sha256": HASH_A, "enabled": true}]}),
        json!({"schema_version": 1, "writers": [{"actor": "has space", "token_sha256": HASH_A, "enabled": true}]}),
        json!({"schema_version": 1, "writers": [{"actor": "", "token_sha256": HASH_A, "enabled": true}]}),
        json!({"schema_version": 1, "writers": [{"actor": "a".repeat(33), "token_sha256": HASH_A, "enabled": true}]}),
        json!({"schema_version": 1, "writers": [{"actor": "a", "token_sha256": "abc", "enabled": true}]}),
        json!({"schema_version": 1, "writers": [{"actor": "a", "token_sha256": HASH_A}]}),
        json!({"schema_version": 1, "writers": [{"actor": "a", "token_sha256": HASH_A, "enabled": "yes"}]}),
        json!({"schema_version": 1, "writers": [{"actor": "a", "token_sha256": HASH_A, "enabled": true, "note": 1}]}),
        json!({"schema_version": 1, "writers": [
            {"actor": "a", "token_sha256": HASH_A, "enabled": true},
            {"actor": "a", "token_sha256": HASH_B, "enabled": true}]}),
        json!({"schema_version": 1, "writers": [
            {"actor": "a", "token_sha256": HASH_A, "enabled": true},
            {"actor": "b", "token_sha256": HASH_A, "enabled": true}]}),
    ] {
        assert!(Writers::parse(bad.to_string().as_bytes()).is_err(), "{bad}");
    }
    assert!(Writers::parse(br#"{"schema_version":1,"schema_version":1,"writers":[]}"#).is_err());
    assert!(Writers::parse(b"not json").is_err());
}

#[test]
fn a_key_resolves_to_the_actor_of_its_writer_only() {
    let key_a = "example-key-a";
    let key_b = "example-key-b";
    let key_off = "example-key-off";
    let writers = Writers::parse(&writers_json(json!([
        {"actor": "writer-a", "token_sha256": sha256_hex(key_a.as_bytes()), "enabled": true},
        {"actor": "writer-b", "token_sha256": sha256_hex(key_b.as_bytes()), "enabled": true},
        {"actor": "writer-off", "token_sha256": sha256_hex(key_off.as_bytes()), "enabled": false},
    ])))
    .unwrap();
    let bearer = |k: &str| format!("Bearer {k}");
    assert_eq!(
        writers.authenticate(Some(&bearer(key_a))).unwrap(),
        "writer-a"
    );
    assert_eq!(
        writers.authenticate(Some(&bearer(key_b))).unwrap(),
        "writer-b"
    );
    assert_eq!(
        writers.authenticate(Some(&bearer(key_off))),
        Err(AuthError::Disabled)
    );
    assert_eq!(
        writers.authenticate(Some(&bearer("example-key-c"))),
        Err(AuthError::Unknown)
    );
    // Presenting the stored hash as the key does not work.
    assert_eq!(
        writers.authenticate(Some(&bearer(&sha256_hex(key_a.as_bytes())))),
        Err(AuthError::Unknown)
    );
    for header in [
        None,
        Some(""),
        Some("Bearer "),
        Some("bearer example-key-a"),
        Some("Basic example-key-a"),
        Some("example-key-a"),
    ] {
        assert_eq!(
            writers.authenticate(header),
            Err(AuthError::Missing),
            "{header:?}"
        );
    }
    assert_eq!(
        writers.authenticate(Some(&bearer(&"k".repeat(513)))),
        Err(AuthError::Missing)
    );
}

#[test]
fn issuing_a_key_stores_only_its_hash_and_never_overwrites() {
    let dir = tempfile::tempdir().unwrap();
    let writers_path = dir.path().join("writers.json");
    let token_path = dir.path().join("many-ai-cli.key");
    add_writer(&writers_path, &token_path, "many-ai-cli").unwrap();
    let token = std::fs::read_to_string(&token_path).unwrap();
    assert_eq!(token.len(), 64);
    assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
    let file = std::fs::read_to_string(&writers_path).unwrap();
    assert!(
        !file.contains(&token),
        "the writers file must not hold the key"
    );
    assert!(file.contains(&sha256_hex(token.as_bytes())));
    let writers = Writers::load(&writers_path).unwrap();
    assert_eq!(
        writers
            .authenticate(Some(&format!("Bearer {token}")))
            .unwrap(),
        "many-ai-cli"
    );

    // A second writer is added to the same file; the first one keeps working.
    let second = dir.path().join("second.key");
    add_writer(&writers_path, &second, "second-writer").unwrap();
    let token2 = std::fs::read_to_string(&second).unwrap();
    assert_ne!(token, token2);
    let writers = Writers::load(&writers_path).unwrap();
    assert_eq!(
        writers
            .authenticate(Some(&format!("Bearer {token}")))
            .unwrap(),
        "many-ai-cli"
    );
    assert_eq!(
        writers
            .authenticate(Some(&format!("Bearer {token2}")))
            .unwrap(),
        "second-writer"
    );

    // Refusals leave both files exactly as they were.
    let before = std::fs::read(&writers_path).unwrap();
    assert!(add_writer(&writers_path, &token_path, "third-writer").is_err());
    assert_eq!(std::fs::read_to_string(&token_path).unwrap(), token);
    let unused = dir.path().join("unused.key");
    assert!(add_writer(&writers_path, &unused, "many-ai-cli").is_err());
    assert!(!unused.exists());
    assert!(add_writer(&writers_path, &unused, "Bad Name").is_err());
    assert!(!unused.exists());
    assert_eq!(std::fs::read(&writers_path).unwrap(), before);
}
