// The board store inside one SQLite-backed Durable Object. A Durable Object
// runs one request at a time, and each write runs in `transactionSync`, so a
// failed write leaves nothing behind. Same tables and rules as iris/src/board.rs.
import {
  BoardError, ITEM_COLUMNS, LIST_EVENT_LIMIT, MAX_DEPTH, MAX_EVENTS, MAX_ITEMS,
  PAGE_EVENT_LIMIT, WRITER_EVENT_KINDS, applyPatch, asObject, clearable, has, invalid,
  nonNegativeInteger, onlyKeys, optionalStr, requiredStr, sameContent, validHttpsUrl,
  validItemId, validLine, validateItem, type Item,
} from "./rules";

export interface Limits {
  items: number;
  events: number;
}
export const DEFAULT_LIMITS: Limits = { items: MAX_ITEMS, events: MAX_EVENTS };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS board_items(
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
  )`,
  `CREATE INDEX IF NOT EXISTS board_items_project ON board_items(project)`,
  `CREATE INDEX IF NOT EXISTS board_items_parent ON board_items(parent_id)`,
  // Events are never deleted, so the rowid alias only grows.
  `CREATE TABLE IF NOT EXISTS board_events(
    seq INTEGER PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES board_items(item_id),
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('session_start','session_end','note','state_change')),
    text TEXT NOT NULL,
    ref TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS board_events_item ON board_events(item_id, seq)`,
  `CREATE TRIGGER IF NOT EXISTS board_events_no_update BEFORE UPDATE ON board_events
   BEGIN SELECT RAISE(ABORT, 'board events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS board_events_no_delete BEFORE DELETE ON board_events
   BEGIN SELECT RAISE(ABORT, 'board events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS board_items_no_delete BEFORE DELETE ON board_items
   BEGIN SELECT RAISE(ABORT, 'board items are never deleted'); END`,
];

type Row = Record<string, SqlStorageValue>;
const str = (v: SqlStorageValue) => v as string;
const strOrNull = (v: SqlStorageValue) => (v === null ? null : (v as string));
const num = (v: SqlStorageValue) => Number(v);

function rowItem(r: Row, prefix = ""): Item {
  const g = (c: string) => r[prefix + c] ?? null;
  return {
    item_id: str(g("item_id")), project: str(g("project")), kind: str(g("kind")),
    title: str(g("title")), source_ref: strOrNull(g("source_ref")), parent_id: strOrNull(g("parent_id")),
    state: str(g("state")), waiting_reason: strOrNull(g("waiting_reason")),
    planned_start: strOrNull(g("planned_start")), planned_end: strOrNull(g("planned_end")),
    created_at: num(g("created_at")), updated_at: num(g("updated_at")),
    updated_by: str(g("updated_by")), revision: num(g("revision")),
  };
}

export class Store {
  constructor(
    private storage: DurableObjectStorage,
    private limits: Limits,
  ) {}

  private get sql() {
    return this.storage.sql;
  }

  init(): void {
    for (const statement of SCHEMA) this.sql.exec(statement);
  }

  private loadItem(id: string): Item | null {
    const rows = this.sql.exec(`SELECT ${ITEM_COLUMNS.join(",")} FROM board_items WHERE item_id=?`, id).toArray();
    return rows.length ? rowItem(rows[0] as Row) : null;
  }
  private count(table: "board_items" | "board_events"): number {
    const sql = table === "board_items" ? "SELECT COUNT(*) AS n FROM board_items" : "SELECT COUNT(*) AS n FROM board_events";
    return num((this.sql.exec(sql).one() as Row).n);
  }

  /** Runs `fn` in one transaction; a thrown error rolls everything back. */
  private tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  /** Creates or updates one item. `actor` comes from the writer's key. */
  upsertItem(actor: string, input: unknown): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, [
      "item_id", "project", "kind", "title", "source_ref", "parent_id", "state",
      "waiting_reason", "planned_start", "planned_end", "expected_revision",
    ]);
    const itemId = requiredStr(obj, "item_id");
    if (!validItemId(itemId)) throw invalid("item_id must match ^[A-Za-z0-9._:/-]{1,128}$");
    const project = optionalStr(obj, "project");
    const kind = optionalStr(obj, "kind");
    const title = optionalStr(obj, "title");
    const state = optionalStr(obj, "state");
    const sourceRef = clearable(obj, "source_ref");
    const parentId = clearable(obj, "parent_id");
    const waitingReason = clearable(obj, "waiting_reason");
    const plannedStart = clearable(obj, "planned_start");
    const plannedEnd = clearable(obj, "planned_end");
    let expected: number | null = null;
    if (has(obj, "expected_revision")) {
      if (!nonNegativeInteger(obj.expected_revision)) throw invalid("expected_revision must be a non-negative integer");
      expected = obj.expected_revision;
    }
    const now = Date.now();
    return this.tx(() => {
      const existing = this.loadItem(itemId);
      const current = existing ? existing.revision : 0;
      if (expected !== null && expected !== current)
        throw new BoardError("REVISION_CONFLICT", `expected_revision ${expected} does not match the current revision ${current}`);
      const isNew = existing === null;
      const need = (v: string | null, name: string) => {
        if (v === null) throw invalid(`${name} is required to create an item`);
        return v;
      };
      const item: Item = existing
        ? { ...existing }
        : {
            item_id: itemId, project: need(project, "project"), kind: need(kind, "kind"),
            title: need(title, "title"), source_ref: null, parent_id: null, state: need(state, "state"),
            waiting_reason: null, planned_start: null, planned_end: null,
            created_at: now, updated_at: now, updated_by: actor, revision: 0,
          };
      const oldState = existing ? existing.state : null;
      if (project !== null) item.project = project;
      if (kind !== null) item.kind = kind;
      if (title !== null) item.title = title;
      if (state !== null) item.state = state;
      item.source_ref = applyPatch(item.source_ref, sourceRef);
      item.parent_id = applyPatch(item.parent_id, parentId);
      item.planned_start = applyPatch(item.planned_start, plannedStart);
      item.planned_end = applyPatch(item.planned_end, plannedEnd);
      // Leaving "waiting" drops the reason unless the writer says otherwise.
      if (item.state !== "waiting" && waitingReason.kind === "absent") item.waiting_reason = null;
      else item.waiting_reason = applyPatch(item.waiting_reason, waitingReason);
      validateItem(item);
      this.checkTree(item, existing);
      if (existing && sameContent(existing, item)) return { ok: true, changed: false, item: existing };
      if (isNew && this.count("board_items") >= this.limits.items)
        throw new BoardError("BOARD_ITEM_LIMIT", `The board holds ${this.limits.items} items already; nothing was added`);
      item.revision = current + 1;
      item.updated_at = now;
      item.updated_by = actor;
      const values = [
        item.item_id, item.project, item.kind, item.title, item.source_ref, item.parent_id, item.state,
        item.waiting_reason, item.planned_start, item.planned_end,
      ];
      if (isNew) {
        this.sql.exec(
          `INSERT INTO board_items(${ITEM_COLUMNS.join(",")}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ...values, item.created_at, item.updated_at, item.updated_by, item.revision,
        );
      } else {
        this.sql.exec(
          `UPDATE board_items SET project=?,kind=?,title=?,source_ref=?,parent_id=?,state=?,waiting_reason=?,
           planned_start=?,planned_end=?,updated_at=?,updated_by=?,revision=? WHERE item_id=?`,
          ...values.slice(1), item.updated_at, item.updated_by, item.revision, item.item_id,
        );
      }
      if (oldState !== null && oldState !== item.state) {
        const text = item.waiting_reason !== null
          ? `${oldState} -> ${item.state} (${item.waiting_reason})`
          : `${oldState} -> ${item.state}`;
        this.insertEvent(item.item_id, now, actor, "state_change", text, null);
      }
      return { ok: true, changed: true, item };
    });
  }

  /** Appends one event to an existing item. `actor` comes from the writer's key. */
  addEvent(actor: string, input: unknown): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["item_id", "kind", "text", "ref"]);
    const itemId = requiredStr(obj, "item_id");
    const kind = requiredStr(obj, "kind");
    const text = requiredStr(obj, "text");
    const reference = optionalStr(obj, "ref");
    if (!(WRITER_EVENT_KINDS as readonly string[]).includes(kind))
      throw invalid("kind must be session_start, session_end or note (state_change is recorded by the board)");
    if (!validLine(text, 2000, true)) throw invalid("text must be 1 to 2000 characters");
    if (reference !== null && !validHttpsUrl(reference)) throw invalid("ref must be an https URL of 500 characters at most");
    return this.tx(() => {
      if (this.loadItem(itemId) === null) throw new BoardError("NOT_FOUND", "No such item");
      const at = Date.now();
      const seq = this.insertEvent(itemId, at, actor, kind, text, reference);
      return { ok: true, event: { seq, item_id: itemId, at, actor, kind, text, ref: reference } };
    });
  }

  /** The `board_list` tool: arguments `project` and `since_seq`. */
  listForTool(input: unknown): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["project", "since_seq"]);
    const project = optionalStr(obj, "project");
    let since = 0;
    if (has(obj, "since_seq")) {
      if (!nonNegativeInteger(obj.since_seq)) throw invalid("since_seq must be a non-negative integer");
      since = obj.since_seq;
    }
    return this.list(project, since, LIST_EVENT_LIMIT, false);
  }

  /** The data of the read-only page. */
  pageData(): Record<string, unknown> {
    return { ...this.list(null, 0, PAGE_EVENT_LIMIT, true), generated_at: Date.now() };
  }

  /** All items of the project (or of every project), each with its latest
   * event, and the events after `sinceSeq`: oldest first, or the newest ones
   * first when `newestFirst` is set. */
  list(project: string | null, sinceSeq: number, eventLimit: number, newestFirst: boolean): Record<string, unknown> {
    const itemCols = ITEM_COLUMNS.map((c) => `i.${c} AS i_${c}`).join(",");
    const itemRows = this.sql.exec(
      `SELECT ${itemCols},e.seq AS e_seq,e.at AS e_at,e.actor AS e_actor,e.kind AS e_kind,e.text AS e_text,e.ref AS e_ref
       FROM board_items i
       LEFT JOIN board_events e ON e.seq=(SELECT MAX(seq) FROM board_events WHERE item_id=i.item_id)
       WHERE (? IS NULL OR i.project=?) ORDER BY i.project,i.created_at,i.item_id`,
      project, project,
    ).toArray() as Row[];
    const items = itemRows.map((r) => ({
      ...rowItem(r, "i_"),
      last_event: r.e_seq === null
        ? null
        : { seq: num(r.e_seq), at: num(r.e_at), actor: str(r.e_actor), kind: str(r.e_kind), text: str(r.e_text), ref: strOrNull(r.e_ref) },
    }));
    const order = newestFirst ? "DESC" : "ASC";
    const eventRows = this.sql.exec(
      `SELECT e.seq,e.item_id,i.project,e.at,e.actor,e.kind,e.text,e.ref FROM board_events e
       JOIN board_items i ON i.item_id=e.item_id
       WHERE e.seq>? AND (? IS NULL OR i.project=?) ORDER BY e.seq ${order} LIMIT ?`,
      sinceSeq, project, project, eventLimit + 1,
    ).toArray() as Row[];
    const truncated = eventRows.length > eventLimit;
    const events = eventRows.slice(0, eventLimit).map((r) => ({
      seq: num(r.seq), item_id: str(r.item_id), project: str(r.project), at: num(r.at),
      actor: str(r.actor), kind: str(r.kind), text: str(r.text), ref: strOrNull(r.ref),
    }));
    const next = events.reduce((m, e) => Math.max(m, e.seq), sinceSeq);
    return {
      ok: true, items, events, events_truncated: truncated, next_since_seq: next,
      counts: { items: this.count("board_items"), events: this.count("board_events") },
      limits: { items: this.limits.items, events: this.limits.events },
    };
  }

  private insertEvent(itemId: string, at: number, actor: string, kind: string, text: string, ref: string | null): number {
    if (this.count("board_events") >= this.limits.events)
      throw new BoardError("BOARD_EVENT_LIMIT", `The board holds ${this.limits.events} events already; nothing was added`);
    const row = this.sql.exec(
      "INSERT INTO board_events(item_id,at,actor,kind,text,ref) VALUES(?,?,?,?,?,?) RETURNING seq",
      itemId, at, actor, kind, text, ref,
    ).one() as Row;
    return num(row.seq);
  }

  /** The parent must exist in the same project, the chain above it must not
   * contain the item (no cycle), and the deepest item under it must stay within
   * MAX_DEPTH. A project change must not split an item from its children. */
  private checkTree(item: Item, old: Item | null): void {
    let ancestors = 0;
    if (item.parent_id !== null) {
      if (item.parent_id === item.item_id) throw new BoardError("CYCLE", "An item cannot be its own parent");
      const parent = this.loadItem(item.parent_id);
      if (parent === null) throw new BoardError("PARENT_NOT_FOUND", "The parent item does not exist");
      if (parent.project !== item.project) throw new BoardError("PROJECT_MISMATCH", "The parent must belong to the same project");
      let current: Item = parent;
      for (;;) {
        ancestors += 1;
        if (current.item_id === item.item_id) throw new BoardError("CYCLE", "The parent chain would contain the item itself");
        if (ancestors > 64) throw new BoardError("CYCLE", "The parent chain is not a tree");
        if (current.parent_id === null) break;
        const next = this.loadItem(current.parent_id);
        if (next === null) throw new BoardError("STORAGE", "Board parent link is broken");
        current = next;
      }
    }
    let height = 1;
    if (old !== null) {
      if (old.project !== item.project) {
        const split = num((this.sql.exec(
          "SELECT COUNT(*) AS n FROM board_items WHERE parent_id=? AND project<>?", item.item_id, item.project,
        ).one() as Row).n);
        if (split > 0) throw new BoardError("PROJECT_MISMATCH", "The item has children in another project");
      }
      let frontier = [item.item_id];
      while (ancestors + height <= MAX_DEPTH) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const r of this.sql.exec("SELECT item_id FROM board_items WHERE parent_id=?", id).toArray() as Row[]) {
            next.push(str(r.item_id));
          }
        }
        if (next.length === 0) break;
        height += 1;
        frontier = next;
      }
    }
    if (ancestors + height > MAX_DEPTH)
      throw new BoardError("DEPTH", `Items may be nested ${MAX_DEPTH} levels deep at most`);
  }
}

/** Runs one store call and turns a board error into a plain result, so it can
 * cross the Durable Object boundary. Unexpected errors become STORAGE. */
export function guarded(fn: () => Record<string, unknown>): Record<string, unknown> {
  try {
    return fn();
  } catch (e) {
    if (e instanceof BoardError) return { ok: false, error: { code: e.code, detail: e.detail } };
    return { ok: false, error: { code: "STORAGE", detail: "Board storage error" } };
  }
}
