//! The board (kanban): a small, durable list of projects, plans, issues and
//! tasks with a log of what happened to each.
//!
//! It lives in the same SQLite file as the rest of Many Iris but only adds its
//! own tables (`board_items`, `board_events`). It never reads or changes the
//! existing domain tables and never touches `user_version`.
//!
//! Writers are identified by a key (a bearer token). Only the SHA-256 of a
//! key is stored. The actor recorded on an item or an event always comes from
//! the key, never from the request body.
use crate::mcp;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const MAX_ITEMS: i64 = 5000;
pub const MAX_EVENTS: i64 = 50000;
/// Depth of the deepest item, counting a root as 1.
pub const MAX_DEPTH: usize = 6;
pub const KINDS: &[&str] = &["project", "plan", "context", "issue", "pr", "task"];
pub const STATES: &[&str] = &["planned", "in_progress", "waiting", "done", "stopped"];
/// Kinds a writer may add. `state_change` is recorded by the board itself.
pub const WRITER_EVENT_KINDS: &[&str] = &["session_start", "session_end", "note"];
/// Events returned by one `board_list` call.
const LIST_EVENT_LIMIT: usize = 500;
/// Recent events shown on the page.
const PAGE_EVENT_LIMIT: usize = 100;
const MAX_WRITERS: usize = 64;
const WRITERS_FILE_LIMIT: u64 = 65_536;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardError {
    pub code: String,
    pub detail: String,
}
fn berr(code: &str, detail: impl Into<String>) -> BoardError {
    BoardError {
        code: code.into(),
        detail: detail.into(),
    }
}
fn invalid(detail: impl Into<String>) -> BoardError {
    berr("INVALID", detail)
}
impl From<rusqlite::Error> for BoardError {
    fn from(_: rusqlite::Error) -> Self {
        berr("STORAGE", "Board storage error")
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub items: i64,
    pub events: i64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            items: MAX_ITEMS,
            events: MAX_EVENTS,
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
fn random_hex() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "System random source unavailable".to_string())?;
    Ok(hex(&bytes))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn sha256_hex(input: &[u8]) -> String {
    hex(&Sha256::digest(input))
}
/// Compares without stopping at the first different byte.
fn ct_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |v, (x, y)| v | (x ^ y)) == 0
}

// ---------------------------------------------------------------- validation

fn char_len(s: &str) -> usize {
    s.chars().count()
}
/// Control characters, line/paragraph separators, and invisible direction or
/// joiner characters that can make text look different from what it is.
fn has_forbidden_char(s: &str, allow_layout: bool) -> bool {
    s.chars().any(|c| {
        (c.is_control() && !(allow_layout && matches!(c, '\n' | '\r' | '\t')))
            || matches!(
                c,
                '\u{200B}'..='\u{200F}'
                    | '\u{2028}'..='\u{202E}'
                    | '\u{2060}'..='\u{2064}'
                    | '\u{2066}'..='\u{2069}'
                    | '\u{FEFF}'
            )
    })
}
/// 1..=max characters, not blank, no hidden control characters.
fn valid_line(s: &str, max: usize, allow_layout: bool) -> bool {
    let n = char_len(s);
    n >= 1 && n <= max && !s.trim().is_empty() && !has_forbidden_char(s, allow_layout)
}
pub fn valid_item_id(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c))
}
pub fn valid_actor(s: &str) -> bool {
    (1..=32).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}
fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}
/// `YYYY-MM-DD`, a real calendar date.
pub fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if !(digits(0..4) && digits(5..7) && digits(8..10)) {
        return false;
    }
    let year: u32 = s[0..4].parse().unwrap_or(0);
    let month: u32 = s[5..7].parse().unwrap_or(0);
    let day: u32 = s[8..10].parse().unwrap_or(0);
    year >= 1 && (1..=12).contains(&month) && day >= 1 && day <= days_in_month(year, month)
}
fn no_dot_dot(path: &str) -> bool {
    !path.split('/').any(|segment| segment == "..")
}
/// `https://host[:port][/path]` with an ASCII host, no user info, no spaces.
pub fn valid_https_url(s: &str) -> bool {
    if char_len(s) > 500 || has_forbidden_char(s, false) || s.chars().any(char::is_whitespace) {
        return false;
    }
    let Some(rest) = s.strip_prefix("https://") else {
        return false;
    };
    if rest.contains('\\') {
        return false;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    !authority.is_empty()
        && authority
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-:[]".contains(&c))
        && authority.bytes().any(|c| c.is_ascii_alphanumeric())
        && no_dot_dot(tail.split(['?', '#']).next().unwrap_or(""))
}
/// A repository-relative path such as `docs/local/plan_x.md`, or an https URL.
/// Absolute paths, drive letters, `file:` and `..` are refused.
pub fn valid_source_ref(s: &str) -> bool {
    if s.is_empty() || char_len(s) > 500 {
        return false;
    }
    if s.starts_with("https://") {
        return valid_https_url(s);
    }
    !(has_forbidden_char(s, false)
        || s.chars().any(char::is_whitespace)
        || s.starts_with('/')
        || s.starts_with('~')
        || s.contains(['\\', ':'])
        || s.split('/')
            .any(|seg| seg.is_empty() || seg == ".." || seg == "."))
}

// --------------------------------------------------------------------- items

#[derive(Debug, Clone, PartialEq)]
struct Item {
    item_id: String,
    project: String,
    kind: String,
    title: String,
    source_ref: Option<String>,
    parent_id: Option<String>,
    state: String,
    waiting_reason: Option<String>,
    planned_start: Option<String>,
    planned_end: Option<String>,
    created_at: i64,
    updated_at: i64,
    updated_by: String,
    revision: i64,
}
impl Item {
    fn to_json(&self) -> Value {
        json!({
            "item_id": self.item_id, "project": self.project, "kind": self.kind,
            "title": self.title, "source_ref": self.source_ref, "parent_id": self.parent_id,
            "state": self.state, "waiting_reason": self.waiting_reason,
            "planned_start": self.planned_start, "planned_end": self.planned_end,
            "created_at": self.created_at, "updated_at": self.updated_at,
            "updated_by": self.updated_by, "revision": self.revision,
        })
    }
    /// The fields a writer controls (not the bookkeeping ones).
    fn same_content(&self, other: &Item) -> bool {
        self.project == other.project
            && self.kind == other.kind
            && self.title == other.title
            && self.source_ref == other.source_ref
            && self.parent_id == other.parent_id
            && self.state == other.state
            && self.waiting_reason == other.waiting_reason
            && self.planned_start == other.planned_start
            && self.planned_end == other.planned_end
    }
    fn validate(&self) -> Result<(), BoardError> {
        if !valid_item_id(&self.item_id) {
            return Err(invalid("item_id must match ^[A-Za-z0-9._:/-]{1,128}$"));
        }
        if !valid_line(&self.project, 80, false) {
            return Err(invalid("project must be 1 to 80 characters"));
        }
        if !KINDS.contains(&self.kind.as_str()) {
            return Err(invalid("kind is not one of the allowed values"));
        }
        if !valid_line(&self.title, 200, false) {
            return Err(invalid("title must be 1 to 200 characters"));
        }
        if let Some(r) = &self.source_ref
            && !valid_source_ref(r)
        {
            return Err(invalid(
                "source_ref must be a repository-relative path or an https URL (500 characters at most)",
            ));
        }
        if !STATES.contains(&self.state.as_str()) {
            return Err(invalid("state is not one of the allowed values"));
        }
        match (&self.waiting_reason, self.state == "waiting") {
            (Some(r), true) if valid_line(r, 200, false) => {}
            (None, true) | (Some(_), true) => {
                return Err(invalid(
                    "waiting_reason (1 to 200 characters) is required when state is waiting",
                ));
            }
            (Some(_), false) => {
                return Err(invalid(
                    "waiting_reason is only allowed when state is waiting",
                ));
            }
            (None, false) => {}
        }
        for date in [&self.planned_start, &self.planned_end]
            .into_iter()
            .flatten()
        {
            if !valid_date(date) {
                return Err(invalid("planned dates must be real YYYY-MM-DD dates"));
            }
        }
        if let (Some(start), Some(end)) = (&self.planned_start, &self.planned_end)
            && end < start
        {
            return Err(invalid("planned_end must not be before planned_start"));
        }
        Ok(())
    }
}

const ITEM_COLUMNS: &str = "item_id,project,kind,title,source_ref,parent_id,state,waiting_reason,planned_start,planned_end,created_at,updated_at,updated_by,revision";
fn row_item(r: &rusqlite::Row) -> rusqlite::Result<Item> {
    Ok(Item {
        item_id: r.get(0)?,
        project: r.get(1)?,
        kind: r.get(2)?,
        title: r.get(3)?,
        source_ref: r.get(4)?,
        parent_id: r.get(5)?,
        state: r.get(6)?,
        waiting_reason: r.get(7)?,
        planned_start: r.get(8)?,
        planned_end: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
        updated_by: r.get(12)?,
        revision: r.get(13)?,
    })
}
fn load_item(conn: &Connection, id: &str) -> Result<Option<Item>, BoardError> {
    Ok(conn
        .query_row(
            &format!("SELECT {ITEM_COLUMNS} FROM board_items WHERE item_id=?1"),
            [id],
            row_item,
        )
        .optional()?)
}
fn count(conn: &Connection, table: &str) -> Result<i64, BoardError> {
    let sql = match table {
        "board_items" => "SELECT COUNT(*) FROM board_items",
        _ => "SELECT COUNT(*) FROM board_events",
    };
    Ok(conn.query_row(sql, [], |r| r.get(0))?)
}

/// A field a writer may leave alone, set, or clear (JSON `null`).
enum Patch {
    Absent,
    Clear,
    Set(String),
}
fn clearable(obj: &Map<String, Value>, key: &str) -> Result<Patch, BoardError> {
    match obj.get(key) {
        None => Ok(Patch::Absent),
        Some(Value::Null) => Ok(Patch::Clear),
        Some(Value::String(s)) if !s.is_empty() => Ok(Patch::Set(s.clone())),
        Some(_) => Err(invalid(format!(
            "{key} must be a non-empty string, or null to clear it"
        ))),
    }
}
fn optional_str(obj: &Map<String, Value>, key: &str) -> Result<Option<String>, BoardError> {
    match obj.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(invalid(format!("{key} must be a string"))),
    }
}
fn required_str(obj: &Map<String, Value>, key: &str) -> Result<String, BoardError> {
    optional_str(obj, key)?.ok_or_else(|| invalid(format!("{key} is required")))
}
fn apply(slot: &mut Option<String>, patch: Patch) {
    match patch {
        Patch::Absent => {}
        Patch::Clear => *slot = None,
        Patch::Set(v) => *slot = Some(v),
    }
}
fn only_keys(obj: &Map<String, Value>, allowed: &[&str]) -> Result<(), BoardError> {
    match obj.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(_) => Err(invalid("Unknown field")),
        None => Ok(()),
    }
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS board_items(
  item_id TEXT PRIMARY KEY NOT NULL,
  project TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('project','plan','context','issue','pr','task')),
  title TEXT NOT NULL,
  source_ref TEXT,
  parent_id TEXT REFERENCES board_items(item_id),
  state TEXT NOT NULL CHECK(state IN ('planned','in_progress','waiting','done','stopped')),
  waiting_reason TEXT,
  planned_start TEXT,
  planned_end TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1)
);
CREATE INDEX IF NOT EXISTS board_items_project ON board_items(project);
CREATE INDEX IF NOT EXISTS board_items_parent ON board_items(parent_id);
CREATE TABLE IF NOT EXISTS board_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES board_items(item_id),
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('session_start','session_end','note','state_change')),
  text TEXT NOT NULL,
  ref TEXT
);
CREATE INDEX IF NOT EXISTS board_events_item ON board_events(item_id, seq);
CREATE TRIGGER IF NOT EXISTS board_events_no_update BEFORE UPDATE ON board_events
BEGIN SELECT RAISE(ABORT, 'board events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS board_events_no_delete BEFORE DELETE ON board_events
BEGIN SELECT RAISE(ABORT, 'board events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS board_items_no_delete BEFORE DELETE ON board_items
BEGIN SELECT RAISE(ABORT, 'board items are never deleted'); END;
";

pub struct BoardStore {
    conn: Connection,
    limits: Limits,
}
impl BoardStore {
    pub fn open(path: &Path) -> Result<Self, BoardError> {
        Self::open_with_limits(path, Limits::default())
    }
    /// Opens (creating the board tables if they are missing) in the same file as
    /// the rest of Many Iris. Opening again changes nothing.
    pub fn open_with_limits(path: &Path, limits: Limits) -> Result<Self, BoardError> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_millis(5000))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        )?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn, limits })
    }
    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// Creates or updates one item. `actor` comes from the writer's key.
    pub fn upsert_item(&mut self, actor: &str, input: &Value) -> Result<Value, BoardError> {
        let obj = input
            .as_object()
            .ok_or_else(|| invalid("Arguments must be an object"))?;
        only_keys(
            obj,
            &[
                "item_id",
                "project",
                "kind",
                "title",
                "source_ref",
                "parent_id",
                "state",
                "waiting_reason",
                "planned_start",
                "planned_end",
                "expected_revision",
            ],
        )?;
        let item_id = required_str(obj, "item_id")?;
        if !valid_item_id(&item_id) {
            return Err(invalid("item_id must match ^[A-Za-z0-9._:/-]{1,128}$"));
        }
        let project = optional_str(obj, "project")?;
        let kind = optional_str(obj, "kind")?;
        let title = optional_str(obj, "title")?;
        let state = optional_str(obj, "state")?;
        let source_ref = clearable(obj, "source_ref")?;
        let parent_id = clearable(obj, "parent_id")?;
        let waiting_reason = clearable(obj, "waiting_reason")?;
        let planned_start = clearable(obj, "planned_start")?;
        let planned_end = clearable(obj, "planned_end")?;
        let expected = match obj.get("expected_revision") {
            None => None,
            Some(v) => Some(
                v.as_u64()
                    .ok_or_else(|| invalid("expected_revision must be a non-negative integer"))?,
            ),
        };
        let now = now_ms();
        let limits = self.limits;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = load_item(&tx, &item_id)?;
        let current = existing.as_ref().map_or(0, |i| i.revision as u64);
        if let Some(expected) = expected
            && expected != current
        {
            return Err(berr(
                "REVISION_CONFLICT",
                format!(
                    "expected_revision {expected} does not match the current revision {current}"
                ),
            ));
        }
        let is_new = existing.is_none();
        let mut item = match &existing {
            Some(old) => old.clone(),
            None => {
                let need = |v: &Option<String>, name: &str| {
                    v.clone()
                        .ok_or_else(|| invalid(format!("{name} is required to create an item")))
                };
                Item {
                    item_id: item_id.clone(),
                    project: need(&project, "project")?,
                    kind: need(&kind, "kind")?,
                    title: need(&title, "title")?,
                    source_ref: None,
                    parent_id: None,
                    state: need(&state, "state")?,
                    waiting_reason: None,
                    planned_start: None,
                    planned_end: None,
                    created_at: now,
                    updated_at: now,
                    updated_by: actor.to_owned(),
                    revision: 0,
                }
            }
        };
        let old_state = existing.as_ref().map(|i| i.state.clone());
        if let Some(v) = project {
            item.project = v;
        }
        if let Some(v) = kind {
            item.kind = v;
        }
        if let Some(v) = title {
            item.title = v;
        }
        if let Some(v) = state {
            item.state = v;
        }
        apply(&mut item.source_ref, source_ref);
        apply(&mut item.parent_id, parent_id);
        apply(&mut item.planned_start, planned_start);
        apply(&mut item.planned_end, planned_end);
        // Leaving "waiting" drops the reason unless the writer says otherwise.
        if item.state != "waiting" && matches!(waiting_reason, Patch::Absent) {
            item.waiting_reason = None;
        } else {
            apply(&mut item.waiting_reason, waiting_reason);
        }
        item.validate()?;
        check_tree(&tx, &item, existing.as_ref())?;
        if let Some(old) = &existing
            && old.same_content(&item)
        {
            return Ok(json!({"ok": true, "changed": false, "item": old.to_json()}));
        }
        if is_new && count(&tx, "board_items")? >= limits.items {
            return Err(berr(
                "BOARD_ITEM_LIMIT",
                format!(
                    "The board holds {} items already; nothing was added",
                    limits.items
                ),
            ));
        }
        item.revision = current as i64 + 1;
        item.updated_at = now;
        item.updated_by = actor.to_owned();
        if is_new {
            tx.execute(
                &format!("INSERT INTO board_items({ITEM_COLUMNS}) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)"),
                params![
                    item.item_id, item.project, item.kind, item.title, item.source_ref,
                    item.parent_id, item.state, item.waiting_reason, item.planned_start,
                    item.planned_end, item.created_at, item.updated_at, item.updated_by,
                    item.revision
                ],
            )?;
        } else {
            tx.execute(
                "UPDATE board_items SET project=?2,kind=?3,title=?4,source_ref=?5,parent_id=?6,state=?7,waiting_reason=?8,planned_start=?9,planned_end=?10,updated_at=?11,updated_by=?12,revision=?13 WHERE item_id=?1",
                params![
                    item.item_id, item.project, item.kind, item.title, item.source_ref,
                    item.parent_id, item.state, item.waiting_reason, item.planned_start,
                    item.planned_end, item.updated_at, item.updated_by, item.revision
                ],
            )?;
        }
        if let Some(old_state) = old_state
            && old_state != item.state
        {
            let text = match &item.waiting_reason {
                Some(reason) => format!("{old_state} -> {} ({reason})", item.state),
                None => format!("{old_state} -> {}", item.state),
            };
            insert_event(
                &tx,
                limits,
                &item.item_id,
                now,
                actor,
                "state_change",
                &text,
                None,
            )?;
        }
        tx.commit()?;
        Ok(json!({"ok": true, "changed": true, "item": item.to_json()}))
    }

    /// Appends one event to an existing item. `actor` comes from the writer's key.
    pub fn add_event(&mut self, actor: &str, input: &Value) -> Result<Value, BoardError> {
        let obj = input
            .as_object()
            .ok_or_else(|| invalid("Arguments must be an object"))?;
        only_keys(obj, &["item_id", "kind", "text", "ref"])?;
        let item_id = required_str(obj, "item_id")?;
        let kind = required_str(obj, "kind")?;
        let text = required_str(obj, "text")?;
        let reference = optional_str(obj, "ref")?;
        if !WRITER_EVENT_KINDS.contains(&kind.as_str()) {
            return Err(invalid(
                "kind must be session_start, session_end or note (state_change is recorded by the board)",
            ));
        }
        if !valid_line(&text, 2000, true) {
            return Err(invalid("text must be 1 to 2000 characters"));
        }
        if let Some(r) = &reference
            && !valid_https_url(r)
        {
            return Err(invalid(
                "ref must be an https URL of 500 characters at most",
            ));
        }
        let limits = self.limits;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if load_item(&tx, &item_id)?.is_none() {
            return Err(berr("NOT_FOUND", "No such item"));
        }
        let at = now_ms();
        let seq = insert_event(
            &tx,
            limits,
            &item_id,
            at,
            actor,
            &kind,
            &text,
            reference.as_deref(),
        )?;
        tx.commit()?;
        Ok(json!({"ok": true, "event": {
            "seq": seq, "item_id": item_id, "at": at, "actor": actor,
            "kind": kind, "text": text, "ref": reference,
        }}))
    }

    /// The `board_list` tool: arguments `project` and `since_seq`.
    pub fn list_for_tool(&self, input: &Value) -> Result<Value, BoardError> {
        let obj = input
            .as_object()
            .ok_or_else(|| invalid("Arguments must be an object"))?;
        only_keys(obj, &["project", "since_seq"])?;
        let project = optional_str(obj, "project")?;
        let since = match obj.get("since_seq") {
            None => 0,
            Some(v) => v
                .as_u64()
                .ok_or_else(|| invalid("since_seq must be a non-negative integer"))?,
        };
        self.list(project.as_deref(), since, LIST_EVENT_LIMIT, false)
    }

    /// All items of the project (or of every project), each with its latest
    /// event, and the events after `since_seq`: oldest first, or the newest
    /// ones first when `newest_first` is set.
    pub fn list(
        &self,
        project: Option<&str>,
        since_seq: u64,
        event_limit: usize,
        newest_first: bool,
    ) -> Result<Value, BoardError> {
        let since = i64::try_from(since_seq).unwrap_or(i64::MAX);
        let mut items = Vec::new();
        {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT {cols},e.seq,e.at,e.actor,e.kind,e.text,e.ref FROM board_items i \
                 LEFT JOIN board_events e ON e.seq=(SELECT MAX(seq) FROM board_events WHERE item_id=i.item_id) \
                 WHERE (?1 IS NULL OR i.project=?1) ORDER BY i.project,i.created_at,i.item_id",
                cols = ITEM_COLUMNS
                    .split(',')
                    .map(|c| format!("i.{c}"))
                    .collect::<Vec<_>>()
                    .join(",")
            ))?;
            let rows = stmt.query_map(params![project], |r| {
                let item = row_item(r)?;
                let seq: Option<i64> = r.get(14)?;
                let last = match seq {
                    Some(seq) => json!({
                        "seq": seq, "at": r.get::<_, i64>(15)?, "actor": r.get::<_, String>(16)?,
                        "kind": r.get::<_, String>(17)?, "text": r.get::<_, String>(18)?,
                        "ref": r.get::<_, Option<String>>(19)?,
                    }),
                    None => Value::Null,
                };
                let mut value = item.to_json();
                value["last_event"] = last;
                Ok(value)
            })?;
            for row in rows {
                items.push(row?);
            }
        }
        let order = if newest_first { "DESC" } else { "ASC" };
        let mut events = Vec::new();
        {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT e.seq,e.item_id,i.project,e.at,e.actor,e.kind,e.text,e.ref FROM board_events e \
                 JOIN board_items i ON i.item_id=e.item_id \
                 WHERE e.seq>?1 AND (?2 IS NULL OR i.project=?2) ORDER BY e.seq {order} LIMIT ?3"
            ))?;
            let rows = stmt.query_map(params![since, project, event_limit as i64 + 1], |r| {
                Ok(json!({
                    "seq": r.get::<_, i64>(0)?, "item_id": r.get::<_, String>(1)?,
                    "project": r.get::<_, String>(2)?, "at": r.get::<_, i64>(3)?,
                    "actor": r.get::<_, String>(4)?, "kind": r.get::<_, String>(5)?,
                    "text": r.get::<_, String>(6)?, "ref": r.get::<_, Option<String>>(7)?,
                }))
            })?;
            for row in rows {
                events.push(row?);
            }
        }
        let truncated = events.len() > event_limit;
        events.truncate(event_limit);
        let next = events
            .iter()
            .filter_map(|e| e["seq"].as_i64())
            .max()
            .unwrap_or(since);
        Ok(json!({
            "ok": true,
            "items": items,
            "events": events,
            "events_truncated": truncated,
            "next_since_seq": next,
            "counts": {
                "items": count(&self.conn, "board_items")?,
                "events": count(&self.conn, "board_events")?,
            },
            "limits": {"items": self.limits.items, "events": self.limits.events},
        }))
    }
}

#[allow(clippy::too_many_arguments)]
fn insert_event(
    tx: &Connection,
    limits: Limits,
    item_id: &str,
    at: i64,
    actor: &str,
    kind: &str,
    text: &str,
    reference: Option<&str>,
) -> Result<i64, BoardError> {
    if count(tx, "board_events")? >= limits.events {
        return Err(berr(
            "BOARD_EVENT_LIMIT",
            format!(
                "The board holds {} events already; nothing was added",
                limits.events
            ),
        ));
    }
    tx.execute(
        "INSERT INTO board_events(item_id,at,actor,kind,text,ref) VALUES(?1,?2,?3,?4,?5,?6)",
        params![item_id, at, actor, kind, text, reference],
    )?;
    Ok(tx.last_insert_rowid())
}

/// The parent must exist in the same project, the chain above it must not
/// contain the item (no cycle), and the deepest item under it must stay within
/// `MAX_DEPTH`. A project change must not split an item from its children.
fn check_tree(conn: &Connection, item: &Item, old: Option<&Item>) -> Result<(), BoardError> {
    let mut ancestors = 0usize;
    if let Some(parent_id) = &item.parent_id {
        if parent_id == &item.item_id {
            return Err(berr("CYCLE", "An item cannot be its own parent"));
        }
        let parent = load_item(conn, parent_id)?
            .ok_or_else(|| berr("PARENT_NOT_FOUND", "The parent item does not exist"))?;
        if parent.project != item.project {
            return Err(berr(
                "PROJECT_MISMATCH",
                "The parent must belong to the same project",
            ));
        }
        let mut current = parent;
        loop {
            ancestors += 1;
            if current.item_id == item.item_id {
                return Err(berr(
                    "CYCLE",
                    "The parent chain would contain the item itself",
                ));
            }
            if ancestors > 64 {
                return Err(berr("CYCLE", "The parent chain is not a tree"));
            }
            match &current.parent_id {
                Some(next) => {
                    current = load_item(conn, next)?
                        .ok_or_else(|| berr("STORAGE", "Board parent link is broken"))?;
                }
                None => break,
            }
        }
    }
    let mut height = 1usize;
    if let Some(old) = old {
        if old.project != item.project {
            let split: i64 = conn.query_row(
                "SELECT COUNT(*) FROM board_items WHERE parent_id=?1 AND project<>?2",
                params![item.item_id, item.project],
                |r| r.get(0),
            )?;
            if split > 0 {
                return Err(berr(
                    "PROJECT_MISMATCH",
                    "The item has children in another project",
                ));
            }
        }
        let mut frontier = vec![item.item_id.clone()];
        while ancestors + height <= MAX_DEPTH {
            let mut next = Vec::new();
            let mut stmt = conn.prepare("SELECT item_id FROM board_items WHERE parent_id=?1")?;
            for id in &frontier {
                for child in stmt.query_map([id], |r| r.get::<_, String>(0))? {
                    next.push(child?);
                }
            }
            if next.is_empty() {
                break;
            }
            height += 1;
            frontier = next;
        }
    }
    if ancestors + height > MAX_DEPTH {
        return Err(berr(
            "DEPTH",
            format!("Items may be nested {MAX_DEPTH} levels deep at most"),
        ));
    }
    Ok(())
}

// ------------------------------------------------------------------- writers

#[derive(Debug, Clone)]
struct WriterEntry {
    actor: String,
    token_sha256: String,
    enabled: bool,
}
#[derive(Debug, Clone, Default)]
pub struct Writers {
    entries: Vec<WriterEntry>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    /// No usable `Authorization: Bearer` header.
    Missing,
    /// The key matches no writer.
    Unknown,
    /// The key matches a writer that is switched off.
    Disabled,
    /// The writers file cannot be read or is invalid; nobody is let in.
    Unavailable,
}

impl Writers {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let value = mcp::parse_json(bytes).map_err(|_| "Writers file is not valid JSON")?;
        let obj = value.as_object().ok_or("Writers file must be an object")?;
        if obj
            .keys()
            .any(|k| !["schema_version", "writers"].contains(&k.as_str()))
            || obj.get("schema_version") != Some(&json!(1))
        {
            return Err("Writers file must have schema_version 1 and a writers list".into());
        }
        let list = obj
            .get("writers")
            .and_then(Value::as_array)
            .ok_or("Writers file needs a writers list")?;
        if list.len() > MAX_WRITERS {
            return Err("Too many writers".into());
        }
        let mut entries: Vec<WriterEntry> = Vec::new();
        for entry in list {
            let o = entry.as_object().ok_or("Each writer must be an object")?;
            if o.keys()
                .any(|k| !["actor", "token_sha256", "enabled"].contains(&k.as_str()))
            {
                return Err("Unknown writer field".into());
            }
            let actor = o
                .get("actor")
                .and_then(Value::as_str)
                .filter(|a| valid_actor(a))
                .ok_or("Writer actor must match ^[a-z0-9-]{1,32}$")?;
            let hash = o
                .get("token_sha256")
                .and_then(Value::as_str)
                .filter(|h| h.len() == 64 && h.bytes().all(|c| c.is_ascii_hexdigit()))
                .ok_or("Writer token_sha256 must be 64 hex digits")?
                .to_ascii_lowercase();
            let enabled = o
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or("Writer enabled must be true or false")?;
            if entries
                .iter()
                .any(|e| e.actor == actor || e.token_sha256 == hash)
            {
                return Err("Duplicate writer actor or key".into());
            }
            entries.push(WriterEntry {
                actor: actor.to_owned(),
                token_sha256: hash,
                enabled,
            });
        }
        Ok(Self { entries })
    }
    pub fn load(path: &Path) -> Result<Self, String> {
        use std::io::Read;
        let file = std::fs::File::open(path).map_err(|_| "Cannot read the writers file")?;
        let mut bytes = Vec::new();
        file.take(WRITERS_FILE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read the writers file")?;
        if bytes.len() as u64 > WRITERS_FILE_LIMIT {
            return Err("Writers file is too large".into());
        }
        Self::parse(&bytes)
    }
    fn to_json(&self) -> Value {
        json!({
            "schema_version": 1,
            "writers": self.entries.iter().map(|e| json!({
                "actor": e.actor, "token_sha256": e.token_sha256, "enabled": e.enabled,
            })).collect::<Vec<_>>(),
        })
    }
    /// Resolves an `Authorization` header value to the actor of the key. All
    /// writers are compared (no early exit) in constant time per comparison.
    pub fn authenticate(&self, authorization: Option<&str>) -> Result<String, AuthError> {
        let token = authorization
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|t| !t.is_empty() && t.len() <= 512)
            .ok_or(AuthError::Missing)?;
        let digest = sha256_hex(token.as_bytes());
        let mut found: Option<&WriterEntry> = None;
        for entry in &self.entries {
            if ct_eq(&entry.token_sha256, &digest) {
                found = Some(entry);
            }
        }
        match found {
            Some(e) if e.enabled => Ok(e.actor.clone()),
            Some(_) => Err(AuthError::Disabled),
            None => Err(AuthError::Unknown),
        }
    }
}

/// `--board-add-writer`: writes a new random key to `token_out` (never over an
/// existing file) and adds its hash to the writers file. The key is not
/// printed anywhere.
pub fn add_writer(writers_path: &Path, token_out: &Path, actor: &str) -> Result<(), String> {
    use std::io::Write;
    if !valid_actor(actor) {
        return Err("Writer actor must match ^[a-z0-9-]{1,32}$".into());
    }
    let mut writers = match std::fs::metadata(writers_path) {
        Ok(_) => Writers::load(writers_path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Writers::default(),
        Err(_) => return Err("Cannot read the writers file".into()),
    };
    if writers.entries.iter().any(|e| e.actor == actor) {
        return Err("That writer already exists; use another name or edit the writers file".into());
    }
    if writers.entries.len() >= MAX_WRITERS {
        return Err("Too many writers".into());
    }
    let token = random_hex()?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(token_out).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            "The key file already exists; it is not overwritten".to_string()
        } else {
            "Cannot create the key file".to_string()
        }
    })?;
    let saved = file
        .write_all(token.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot save the key file".to_string());
    drop(file);
    if let Err(message) = saved {
        let _ = std::fs::remove_file(token_out);
        return Err(message);
    }
    let hash = sha256_hex(token.as_bytes());
    writers.entries.push(WriterEntry {
        actor: actor.to_owned(),
        token_sha256: hash.clone(),
        enabled: true,
    });
    let result = (|| -> Result<(), String> {
        let mut name = writers_path
            .file_name()
            .ok_or("Invalid writers file path")?
            .to_os_string();
        name.push(format!(".{}.tmp", &hash[..8]));
        let temp = writers_path.with_file_name(name);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options
            .open(&temp)
            .map_err(|_| "Cannot create the writers file")?;
        let body = serde_json::to_vec_pretty(&writers.to_json())
            .map_err(|_| "Cannot encode the writers file")?;
        let written = file.write_all(&body).and_then(|_| file.sync_all());
        drop(file);
        if written.is_err() || std::fs::rename(&temp, writers_path).is_err() {
            let _ = std::fs::remove_file(&temp);
            return Err("Cannot save the writers file".into());
        }
        Ok(())
    })();
    if let Err(message) = result {
        let _ = std::fs::remove_file(token_out);
        return Err(message);
    }
    Ok(())
}

// ------------------------------------------------------------- public origin

/// The one public `https://host[:port]` origin that may reach the board
/// through a tunnel or relay. The server still listens on 127.0.0.1 only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicOrigin {
    origin: String,
    host: String,
}
impl PublicOrigin {
    pub fn parse(value: &str) -> Result<Self, String> {
        let invalid =
            || "Public origin must look like https://host or https://host:port".to_string();
        let authority = value.strip_prefix("https://").ok_or_else(invalid)?;
        let (host, port) = match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        };
        let label_ok = |l: &str| {
            !l.is_empty()
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        };
        if host.is_empty() || !host.split('.').all(label_ok) {
            return Err(invalid());
        }
        if let Some(port) = port
            && !(port.bytes().all(|c| c.is_ascii_digit())
                && port.parse::<u16>().is_ok_and(|p| p != 0))
        {
            return Err(invalid());
        }
        let host = authority.to_ascii_lowercase();
        Ok(Self {
            origin: format!("https://{host}"),
            host,
        })
    }
    pub fn origin(&self) -> &str {
        &self.origin
    }
    pub fn host_matches(&self, host: &str) -> bool {
        host.eq_ignore_ascii_case(&self.host)
    }
    pub fn origin_matches(&self, origin: &str) -> bool {
        origin.eq_ignore_ascii_case(&self.origin)
    }
}

// ------------------------------------------------------------------- runtime

pub fn board_tools() -> Vec<Value> {
    let text = |d: &str| json!({"type": "string", "description": d});
    let clearable = |d: &str| json!({"type": ["string", "null"], "description": d});
    let mut upsert = mcp::tool(
        "board_upsert_item",
        json!({
            "item_id": text("Stable id, ^[A-Za-z0-9._:/-]{1,128}$"),
            "project": text("Project name, 1 to 80 characters"),
            "kind": {"type": "string", "enum": KINDS},
            "title": text("1 to 200 characters"),
            "state": {"type": "string", "enum": STATES},
            "source_ref": clearable("Repository-relative path or https URL; null clears"),
            "parent_id": clearable("Id of an existing item in the same project; null clears"),
            "waiting_reason": clearable("Required while state is waiting"),
            "planned_start": clearable("YYYY-MM-DD; null clears"),
            "planned_end": clearable("YYYY-MM-DD, not before planned_start; null clears"),
            "expected_revision": {"type": "integer", "description": "Refuses the write when the item is at another revision (0 = must not exist)"},
        }),
        &["item_id"],
    );
    upsert["description"] = json!(
        "Create an item (project, kind, title and state are required) or update the given fields of an existing one. The writer is taken from the key, not from the request."
    );
    let mut event = mcp::tool(
        "board_add_event",
        json!({
            "item_id": text("An existing item"),
            "kind": {"type": "string", "enum": WRITER_EVENT_KINDS},
            "text": text("1 to 2000 characters"),
            "ref": text("Optional https URL"),
        }),
        &["item_id", "kind", "text"],
    );
    event["description"] = json!("Append an event to an item. The writer is taken from the key.");
    let mut list = mcp::tool(
        "board_list",
        json!({
            "project": text("Only this project"),
            "since_seq": {"type": "integer", "description": "Only events after this sequence number"},
        }),
        &[],
    );
    list["description"] = json!(
        "Read the items (each with its latest event) and the events after since_seq, oldest first."
    );
    vec![upsert, event, list]
}

/// A running board: its store and the writers file it checks on every request
/// (so a key can be added or switched off without a restart).
pub struct Board {
    store: Mutex<BoardStore>,
    writers_path: PathBuf,
}
impl Board {
    /// Opens the board tables in the Many Iris database file and checks that the
    /// writers file is valid.
    pub fn open(db: &Path, writers_path: &Path) -> Result<Self, String> {
        Writers::load(writers_path)?;
        let store = BoardStore::open(db).map_err(|e| format!("{}: {}", e.code, e.detail))?;
        Ok(Self {
            store: Mutex::new(store),
            writers_path: writers_path.to_owned(),
        })
    }
    pub fn authenticate(&self, authorization: Option<&str>) -> Result<String, AuthError> {
        // Read afresh each time; an unreadable or invalid file lets nobody in.
        match Writers::load(&self.writers_path) {
            Ok(writers) => writers.authenticate(authorization),
            Err(_) => Err(AuthError::Unavailable),
        }
    }
    /// The data of the read-only page.
    pub fn page_data(&self) -> Result<Value, BoardError> {
        let store = self
            .store
            .lock()
            .map_err(|_| berr("STORAGE", "Board unavailable"))?;
        let mut data = store.list(None, 0, PAGE_EVENT_LIMIT, true)?;
        data["generated_at"] = json!(now_ms());
        Ok(data)
    }
    /// One MCP request from an authenticated writer. Returns the HTTP status and
    /// the JSON-RPC body (`Value::Null` means 202 with no body).
    pub fn handle_mcp(
        &self,
        actor: &str,
        headers: &[(&str, &str)],
        request: &Value,
    ) -> (u16, Value) {
        if let Err(e) = mcp::validate_http(headers, request) {
            return (400, mcp::error_response(request.get("id"), &e));
        }
        let tools = board_tools();
        let mut context = |tool: &str, args: &Value| -> Result<Value, (String, String)> {
            let mut store = self
                .store
                .lock()
                .map_err(|_| ("STORAGE".to_string(), "Board unavailable".to_string()))?;
            let result = match tool {
                "board_upsert_item" => store.upsert_item(actor, args),
                "board_add_event" => store.add_event(actor, args),
                "board_list" => store.list_for_tool(args),
                _ => Err(berr("FORBIDDEN", "Operation unavailable")),
            };
            result.map_err(|e| (e.code, e.detail))
        };
        let response = mcp::handle_with_tools(request, "many-iris-board", &tools, &mut context);
        if response.is_null() {
            (202, Value::Null)
        } else if response["error"]["code"] == -32601 {
            (404, response)
        } else {
            (200, response)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_ref_accepts_only_relative_paths_and_https() {
        for ok in [
            "docs/local/plan_x.md",
            "README.md",
            "https://example.com/a/b?x=1",
            "https://example.com:8443/a",
        ] {
            assert!(valid_source_ref(ok), "{ok}");
        }
        for bad in [
            "",
            "/etc/passwd",
            "C:/work/x.md",
            "C:\\work\\x.md",
            "\\\\server\\share\\x",
            "file:///etc/passwd",
            "file:docs/x.md",
            "docs/../secret.md",
            "../secret.md",
            "docs//x.md",
            "docs/x.md/",
            "./docs/x.md",
            "~/x.md",
            "docs/x\n.md",
            "docs/x\u{0}.md",
            "docs/with space.md",
            "http://example.com/a",
            "https://",
            "https://user:pw@example.com/a",
            "https://example.com/a/../b",
            "https://exa mple.com",
            "ftp://example.com",
        ] {
            assert!(!valid_source_ref(bad), "{bad:?}");
        }
        assert!(!valid_source_ref(&format!("docs/{}", "a".repeat(496))));
        assert!(valid_source_ref(&format!("docs/{}", "a".repeat(495))));
    }

    #[test]
    fn dates_are_real_calendar_dates() {
        for ok in ["2026-11-06", "2028-02-29", "2000-02-29"] {
            assert!(valid_date(ok), "{ok}");
        }
        for bad in [
            "2026-02-29",
            "1900-02-29",
            "2026-13-01",
            "2026-00-10",
            "2026-11-31",
            "2026-1-1",
            "20261106",
            "2026/11/06",
            " 2026-11-06",
        ] {
            assert!(!valid_date(bad), "{bad}");
        }
    }

    #[test]
    fn public_origin_is_https_host_and_optional_port_only() {
        let p = PublicOrigin::parse("https://Board.Example.com").unwrap();
        assert_eq!(p.origin(), "https://board.example.com");
        assert!(p.host_matches("board.example.com"));
        assert!(p.origin_matches("https://board.example.com"));
        assert!(!p.origin_matches("http://board.example.com"));
        assert!(PublicOrigin::parse("https://board.example.com:8443").is_ok());
        for bad in [
            "http://board.example.com",
            "board.example.com",
            "https://",
            "https://board.example.com/",
            "https://board.example.com/x",
            "https://user@board.example.com",
            "https://board.example.com:0",
            "https://board.example.com:99999",
            "https://-bad.example.com",
            "https://exa mple.com",
            "https://a..b",
        ] {
            assert!(PublicOrigin::parse(bad).is_err(), "{bad}");
        }
    }
}
