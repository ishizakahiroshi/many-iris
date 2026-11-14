// The board store inside one SQLite-backed Durable Object. A Durable Object
// runs one request at a time, and each write runs in `transactionSync`, so a
// failed write leaves nothing behind. Same tables and rules as iris/src/board.rs.
import {
  BoardError, HANDOFF_TARGETS, ITEM_COLUMNS, LIST_EVENT_LIMIT, MAX_DEPTH, MAX_EVENTS, MAX_ITEMS,
  PAGE_EVENT_LIMIT, WRITER_EVENT_KINDS, applyPatch, asObject, clearable, has, invalid,
  nonNegativeInteger, onlyKeys, optionalStr, requiredStr, sameContent, validHttpsUrl,
  validItemId, validLine, validateItem, type Item,
} from "./rules";

export interface Limits {
  items: number;
  events: number;
}
export const DEFAULT_LIMITS: Limits = { items: MAX_ITEMS, events: MAX_EVENTS };

// `owner` and `hold` are not writers: nobody takes such a request until the
// owner routes it again. No destination (NULL) means "let the board choose";
// until the board can choose, such a request can be taken by any writer as before.
const UNTAKEN_TARGETS = new Set(["owner", "hold"]);

/** The optional `to` argument: absent or null means no destination. */
function handoffTarget(obj: Record<string, unknown>): string | null {
  if (!has(obj, "to") || obj.to === null) return null;
  if (typeof obj.to !== "string" || !(HANDOFF_TARGETS as readonly string[]).includes(obj.to))
    throw invalid(`to must be one of ${HANDOFF_TARGETS.join(", ")} (or null for the board to choose)`);
  return obj.to;
}
const handedText = (request: string, to: string | null) => (to === null ? `handed over ${request}` : `handed over ${request} to ${to}`);

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
  // The dispatcher's memory of every session it started, one row per start:
  // it keeps a request that is still 'requested' between spawn and accept from
  // being sent twice, and caps retries and the number of starts per day.
  `CREATE TABLE IF NOT EXISTS dispatch_log(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  // The router's calls per UTC day and the neurons they are counted as, so the
  // board stops calling before the free allowance runs out (route.ts).
  // `counted_calls` is how many of them had no token count in the answer and
  // were counted from the characters sent instead.
  `CREATE TABLE IF NOT EXISTS route_usage(
    day TEXT PRIMARY KEY NOT NULL,
    calls INTEGER NOT NULL,
    neurons REAL NOT NULL,
    counted_calls INTEGER NOT NULL
  )`,
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
    // The owner's order of the pile. Added after the first boards were made, so
    // an existing table gets the column here (NULL = not ordered yet). It is not
    // one of the writers' fields: the Rust board does not have it.
    this.addColumn("pile_rank", "INTEGER");
    // Handing a piece of work to an AI: the owner asks (requested), one writer
    // takes it (accepted). Kept beside the item so that taking it is one
    // atomic step and no second writer can take the same request.
    this.addColumn("handoff_state", "TEXT");
    this.addColumn("handoff_request", "TEXT");
    this.addColumn("handoff_at", "INTEGER");
    this.addColumn("handoff_actor", "TEXT");
    this.addColumn("handoff_accepted_at", "INTEGER");
    // Who the request is for (HANDOFF_TARGETS); NULL = no destination yet.
    this.addColumn("handoff_to", "TEXT");
    // Who asked (the owner's page or a writer), who set the current destination
    // (the asker, a writer that routed it, or the dispatcher's router), and the
    // title as it was when the work was handed over. A taker that runs work
    // unattended reads these instead of trusting a title that may change later.
    this.addColumn("handoff_by", "TEXT");
    this.addColumn("handoff_to_by", "TEXT");
    this.addColumn("handoff_title", "TEXT");
  }
  /** Adds a column to `board_items` when an older board does not have it yet. */
  private addColumn(name: string, type: "INTEGER" | "TEXT"): void {
    try {
      this.sql.exec(`SELECT ${name} FROM board_items LIMIT 0`);
    } catch {
      this.sql.exec(`ALTER TABLE board_items ADD COLUMN ${name} ${type}`);
    }
  }
  /** Items whose handoff is still waiting to be taken (dispatcher's view). */
  pendingHandoffs(): Record<string, unknown> {
    const rows = this.sql.exec(
      "SELECT item_id,project,title,source_ref,handoff_request,handoff_at,handoff_to FROM board_items WHERE handoff_state='requested' ORDER BY handoff_at",
    ).toArray() as Row[];
    const items = rows.map((r) => ({
      item_id: str(r.item_id), project: str(r.project), title: str(r.title),
      source_ref: strOrNull(r.source_ref), request_id: strOrNull(r.handoff_request), requested_at: num(r.handoff_at),
      to: strOrNull(r.handoff_to ?? null),
    }));
    return { ok: true, items };
  }

  /** What the dispatcher already did for a request: when it last started a session, how many times, and how many starts happened since `since` in total. */
  dispatchState(request: string, since: number): Record<string, unknown> {
    const mine = this.sql.exec("SELECT MAX(at) AS at, COUNT(*) AS n FROM dispatch_log WHERE request_id=?", request).toArray() as Row[];
    const all = this.sql.exec("SELECT COUNT(*) AS n FROM dispatch_log WHERE at>=?", since).toArray() as Row[];
    return { ok: true, at: mine[0]?.at == null ? null : num(mine[0].at), count: num(mine[0]?.n ?? 0), total_since: num(all[0]?.n ?? 0) };
  }

  /** Record that a session was started for a request at `at`. */
  recordDispatch(request: string, at: number): Record<string, unknown> {
    this.sql.exec("INSERT INTO dispatch_log(request_id,at) VALUES(?,?)", request, at);
    return { ok: true, changed: true };
  }

  /** The router's use on one UTC day (`YYYY-MM-DD`). */
  routeUsage(day: string): Record<string, unknown> {
    const rows = this.sql.exec("SELECT calls,neurons,counted_calls FROM route_usage WHERE day=?", day).toArray() as Row[];
    const r = rows[0];
    return { ok: true, day, calls: r ? num(r.calls) : 0, neurons: r ? num(r.neurons) : 0, counted_calls: r ? num(r.counted_calls) : 0 };
  }

  /** Adds one router call to the day. `fromUsage` is false when the neurons were counted from the characters sent. */
  recordRouteUse(day: string, neurons: number, fromUsage: boolean): Record<string, unknown> {
    this.sql.exec(
      `INSERT INTO route_usage(day,calls,neurons,counted_calls) VALUES(?,1,?,?)
       ON CONFLICT(day) DO UPDATE SET calls=calls+1,neurons=neurons+excluded.neurons,counted_calls=counted_calls+excluded.counted_calls`,
      day, neurons, fromUsage ? 0 : 1,
    );
    return this.routeUsage(day);
  }

  /**
   * The router's answer for a request without a destination: sets it, unless the
   * request was taken, taken back or given a destination by the owner meanwhile.
   */
  routeHandoff(actor: string, itemId: string, request: string, to: string, text: string): Record<string, unknown> {
    if (!(HANDOFF_TARGETS as readonly string[]).includes(to)) throw invalid("unknown destination");
    return this.tx(() => {
      const handoff = this.loadHandoff(itemId);
      if (handoff === null || handoff.state !== "requested" || handoff.request_id !== request || handoff.to !== null)
        return { ok: true, changed: false, handoff };
      this.sql.exec("UPDATE board_items SET handoff_to=?,handoff_to_by=? WHERE item_id=?", to, actor, itemId);
      this.insertEvent(itemId, Date.now(), actor, "note", text, null);
      return { ok: true, changed: true, handoff: this.loadHandoff(itemId) };
    });
  }
  /** The hand-off columns of one item, or `null` when the work was not handed to anyone. */
  private handoffOf(r: Row, prefix = ""): Record<string, unknown> | null {
    const state = r[prefix + "handoff_state"] ?? null;
    if (state === null) return null;
    const at = r[prefix + "handoff_at"] ?? null;
    const acceptedAt = r[prefix + "handoff_accepted_at"] ?? null;
    return {
      state: str(state), request_id: strOrNull(r[prefix + "handoff_request"] ?? null),
      requested_at: at === null ? null : num(at),
      accepted_by: strOrNull(r[prefix + "handoff_actor"] ?? null),
      accepted_at: acceptedAt === null ? null : num(acceptedAt),
      to: strOrNull(r[prefix + "handoff_to"] ?? null),
      requested_by: strOrNull(r[prefix + "handoff_by"] ?? null),
      to_set_by: strOrNull(r[prefix + "handoff_to_by"] ?? null),
      title: strOrNull(r[prefix + "handoff_title"] ?? null),
    };
  }
  private loadHandoff(id: string): Record<string, unknown> | null {
    const rows = this.sql.exec(
      "SELECT handoff_state,handoff_request,handoff_at,handoff_actor,handoff_accepted_at,handoff_to,handoff_by,handoff_to_by,handoff_title FROM board_items WHERE item_id=?", id,
    ).toArray() as Row[];
    return rows.length ? this.handoffOf(rows[0]) : null;
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

  /**
   * The `board_accept_handoff` tool: a writer takes the request the owner made
   * for `item_id`. The request id must be the one on the item, and only the
   * first writer gets it; the item then becomes in progress under that writer.
   */
  acceptHandoff(actor: string, input: unknown): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["item_id", "request_id"]);
    const itemId = requiredStr(obj, "item_id");
    const request = requiredStr(obj, "request_id");
    const now = Date.now();
    this.tx(() => {
      if (this.loadItem(itemId) === null) throw new BoardError("NOT_FOUND", "No such item");
      const handoff = this.loadHandoff(itemId);
      if (handoff === null || handoff.state !== "requested" || handoff.request_id !== request)
        throw new BoardError("HANDOFF_CONFLICT", "This request is not open: it was taken, taken back, or the id is another one");
      // A request with a destination is only for that writer, so another one cannot pick it up by mistake.
      const to = handoff.to as string | null;
      if (to !== null && (UNTAKEN_TARGETS.has(to) || to !== actor))
        throw new BoardError("FORBIDDEN", UNTAKEN_TARGETS.has(to)
          ? `This request is on ${to}: nobody takes it until the owner routes it to someone`
          : `This request is for ${to}, not for ${actor}`);
      this.sql.exec(
        "UPDATE board_items SET handoff_state='accepted',handoff_actor=?,handoff_accepted_at=? WHERE item_id=?",
        actor, now, itemId,
      );
      this.insertEvent(itemId, now, actor, "note", `accepted ${request}`, null);
    });
    // The request is this writer's now; the state follows as an ordinary write.
    const item = this.loadItem(itemId);
    const written = item !== null && item.state === "planned" ? this.upsertItem(actor, { item_id: itemId, state: "in_progress" }) : { item };
    return { ok: true, changed: true, item: written.item, handoff: this.loadHandoff(itemId) };
  }

  /**
   * The `board_request_handoff` tool: a writer marks work on the pile as handed
   * over — the writer-side form of the page's "hand", so delegation does not
   * require the owner to open the board page. Returns the item with its new
   * handoff.request_id; whoever takes the work sends that id to
   * board_accept_handoff.
   */
  requestHandoff(actor: string, input: unknown, newId: (day: string | null, prefix?: string) => string): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["item_id", "day", "to"]);
    const itemId = requiredStr(obj, "item_id");
    const day = optionalStr(obj, "day");
    const to = handoffTarget(obj);
    return this.tx(() => {
      const item = this.loadItem(itemId);
      if (item === null) throw new BoardError("NOT_FOUND", "No such item");
      this.handOver(actor, item, day, to, newId);
      return { ok: true, changed: true, item, handoff: this.loadHandoff(itemId) };
    });
  }

  /** Marks work on the pile as requested (shared by the tool and the page's "hand"). Runs inside a transaction. */
  private handOver(actor: string, item: Item, day: string | null, to: string | null, newId: (day: string | null, prefix?: string) => string): void {
    if (item.kind !== "task" || item.state !== "planned")
      throw new BoardError("FORBIDDEN", "Only work on the pile (kind task, state planned) can be handed over");
    if (this.loadHandoff(item.item_id) !== null) throw new BoardError("HANDOFF_CONFLICT", "This work is handed over already");
    const request = newId(day, "REQ-");
    const now = Date.now();
    this.sql.exec(
      "UPDATE board_items SET handoff_state='requested',handoff_request=?,handoff_at=?,handoff_actor=NULL,handoff_accepted_at=NULL,handoff_to=?,handoff_by=?,handoff_to_by=?,handoff_title=? WHERE item_id=?",
      request, now, to, actor, to === null ? null : actor, item.title, item.item_id,
    );
    this.insertEvent(item.item_id, now, actor, "note", handedText(request, to), null);
  }

  /** Withdraws a request that nobody has taken yet, so the work is back on the pile. Runs inside a transaction. */
  private withdraw(actor: string, itemId: string, handoff: Record<string, unknown> | null, now: number): void {
    if (handoff === null || handoff.state !== "requested")
      throw new BoardError("HANDOFF_CONFLICT", "Only a request that nobody has taken yet can be taken back");
    this.sql.exec(
      "UPDATE board_items SET handoff_state=NULL,handoff_request=NULL,handoff_at=NULL,handoff_actor=NULL,handoff_accepted_at=NULL,handoff_to=NULL,handoff_by=NULL,handoff_to_by=NULL,handoff_title=NULL WHERE item_id=?",
      itemId,
    );
    this.insertEvent(itemId, now, actor, "note", `taken back ${String(handoff.request_id)}`, null);
  }

  /** Changes the destination of an open request; false when it already had that one. Runs inside a transaction. */
  private reroute(actor: string, itemId: string, handoff: Record<string, unknown> | null, to: string | null, now: number): boolean {
    if (handoff === null || handoff.state !== "requested")
      throw new BoardError("HANDOFF_CONFLICT", "Only a request that nobody has taken yet can be routed");
    if (handoff.to === to) return false;
    this.sql.exec("UPDATE board_items SET handoff_to=?,handoff_to_by=? WHERE item_id=?", to, to === null ? null : actor, itemId);
    this.insertEvent(itemId, now, actor, "note", `routed ${String(handoff.request_id)} to ${to ?? "the board's choice"}`, null);
    return true;
  }

  /**
   * The `board_route_handoff` tool: a writer changes the destination of a
   * request that nobody has taken yet — the writer-side form of the page's
   * "route" (owner decision 2026-11-14: re-routing should not need the page).
   * Any writer may do it, including to itself; the event names who did.
   */
  routeForTool(actor: string, input: unknown): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["item_id", "to"]);
    const itemId = requiredStr(obj, "item_id");
    if (!has(obj, "to")) throw invalid("to is required (null lets the board choose)");
    const to = handoffTarget(obj);
    return this.tx(() => {
      const item = this.loadItem(itemId);
      if (item === null) throw new BoardError("NOT_FOUND", "No such item");
      const handoff = this.loadHandoff(itemId);
      const changed = this.reroute(actor, itemId, handoff, to, Date.now());
      return { ok: true, changed, item, handoff: this.loadHandoff(itemId) };
    });
  }

  /**
   * The `board_take_back_handoff` tool: a writer withdraws a request that
   * nobody has taken yet — the writer-side form of the page's "take back".
   * Any writer may do it; the event names who did.
   */
  takeBackForTool(actor: string, input: unknown): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["item_id", "request_id"]);
    const itemId = requiredStr(obj, "item_id");
    const request = optionalStr(obj, "request_id");
    return this.tx(() => {
      const item = this.loadItem(itemId);
      if (item === null) throw new BoardError("NOT_FOUND", "No such item");
      const handoff = this.loadHandoff(itemId);
      // With the request id, only that request is withdrawn (not a newer one on the same item).
      if (request !== null && handoff !== null && handoff.request_id !== request)
        throw new BoardError("HANDOFF_CONFLICT", "This request is not the open one: it was taken back or the id is another one");
      this.withdraw(actor, itemId, handoff, Date.now());
      return { ok: true, changed: true, item, handoff: this.loadHandoff(itemId) };
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

  /** The data of the page. `can_write` tells the page that this board takes
   * the owner's own writes (`ownerWrite`); the Rust board does not send it. */
  pageData(): Record<string, unknown> {
    return { ...this.list(null, 0, PAGE_EVENT_LIMIT, true), generated_at: Date.now(), can_write: true };
  }

  /**
   * What the signed-in owner may do from the page, and nothing else:
   *   {op:"add", project, title, parent_id?, day?}   put a piece of work on the
   *     pile (kind task, state planned; the board makes the id, `day` is the
   *     page's calendar day for that id);
   *   {op:"attach", item_id, parent_id, expected_revision}   put a piece of
   *     work under another item, or under nothing (parent_id null);
   *   {op:"move", item_id, direction:"up"|"down"}   change the order of the
   *     pile (planned work of one project under one parent). The order is the
   *     owner's: it does not touch an item's revision or `updated_by`.
   *   {op:"hand", item_id, day?, to?}   ask for a piece of work on the pile to
   *     be done: it gets a request id and waits for one writer to take it
   *     (`acceptHandoff`); `to` is its destination (HANDOFF_TARGETS, absent or
   *     null = the board chooses). {op:"route", item_id, to} changes the
   *     destination of a request that nobody has taken yet (a request on
   *     `hold` gets one this way). {op:"take_back", item_id} withdraws a
   *     request that nobody has taken yet.
   * Titles, states and plans stay with the writers that own them.
   */
  ownerWrite(actor: string, input: unknown, newId: (day: string | null, prefix?: string) => string): Record<string, unknown> {
    const obj = asObject(input);
    const op = requiredStr(obj, "op");
    if (op === "hand" || op === "take_back" || op === "route") {
      onlyKeys(obj, op === "hand" ? ["op", "item_id", "day", "to"] : op === "route" ? ["op", "item_id", "to"] : ["op", "item_id"]);
      const itemId = requiredStr(obj, "item_id");
      const day = op === "hand" ? optionalStr(obj, "day") : null;
      if (op === "route" && !has(obj, "to")) throw invalid("to is required (null lets the board choose)");
      const to = op === "take_back" ? null : handoffTarget(obj);
      return this.tx(() => {
        const item = this.loadItem(itemId);
        if (item === null) throw new BoardError("NOT_FOUND", "No such item");
        const handoff = this.loadHandoff(itemId);
        const now = Date.now();
        if (op === "hand") {
          this.handOver(actor, item, day, to, newId);
        } else if (op === "route") {
          if (!this.reroute(actor, itemId, handoff, to, now)) return { ok: true, changed: false, item, handoff };
        } else {
          this.withdraw(actor, itemId, handoff, now);
        }
        return { ok: true, changed: true, item, handoff: this.loadHandoff(itemId) };
      });
    }
    if (op === "add") {
      onlyKeys(obj, ["op", "project", "title", "parent_id", "day"]);
      const project = requiredStr(obj, "project");
      const title = requiredStr(obj, "title");
      const parentId = optionalStr(obj, "parent_id");
      // A project is made by a writer; a typing slip here must not start a new one.
      const known = num((this.sql.exec("SELECT COUNT(*) AS n FROM board_items WHERE project=?", project).one() as Row).n);
      if (known === 0) throw new BoardError("NOT_FOUND", "No such project");
      // The page's own calendar day, for the id only (see newBacklogId).
      const day = optionalStr(obj, "day");
      const args: Record<string, unknown> = { item_id: newId(day), project, kind: "task", title, state: "planned", expected_revision: 0 };
      if (parentId !== null) args.parent_id = parentId;
      return this.upsertItem(actor, args);
    }
    if (op === "attach") {
      onlyKeys(obj, ["op", "item_id", "parent_id", "expected_revision"]);
      const itemId = requiredStr(obj, "item_id");
      if (!has(obj, "parent_id")) throw invalid("parent_id is required (null takes the work out from under its parent)");
      if (!has(obj, "expected_revision")) throw invalid("expected_revision is required");
      const item = this.loadItem(itemId);
      if (item === null) throw new BoardError("NOT_FOUND", "No such item");
      if (item.kind !== "task") throw new BoardError("FORBIDDEN", "Only work (kind task) can be moved from the page");
      return this.upsertItem(actor, { item_id: itemId, parent_id: obj.parent_id, expected_revision: obj.expected_revision });
    }
    if (op === "move") {
      onlyKeys(obj, ["op", "item_id", "direction"]);
      const itemId = requiredStr(obj, "item_id");
      const direction = requiredStr(obj, "direction");
      if (direction !== "up" && direction !== "down") throw invalid("direction must be up or down");
      return this.tx(() => {
        const item = this.loadItem(itemId);
        if (item === null) throw new BoardError("NOT_FOUND", "No such item");
        if (item.kind !== "task" || item.state !== "planned")
          throw new BoardError("FORBIDDEN", "Only work on the pile (kind task, state planned) can be reordered");
        // The pile this work is in: planned work of the same project under the same parent.
        const pile = (this.sql.exec(
          `SELECT item_id FROM board_items WHERE project=? AND kind='task' AND state='planned' AND parent_id IS ?
           ORDER BY (pile_rank IS NULL),pile_rank,created_at,item_id`,
          item.project, item.parent_id,
        ).toArray() as Row[]).map((r) => str(r.item_id));
        const at = pile.indexOf(itemId);
        const to = direction === "up" ? at - 1 : at + 1;
        if (to < 0 || to >= pile.length) return { ok: true, changed: false, order: pile };
        [pile[at], pile[to]] = [pile[to], pile[at]];
        pile.forEach((id, index) => this.sql.exec("UPDATE board_items SET pile_rank=? WHERE item_id=?", index + 1, id));
        return { ok: true, changed: true, order: pile };
      });
    }
    throw invalid("op must be add, attach, move, hand, route or take_back");
  }

  /** All items of the project (or of every project), each with its latest
   * event, and the events after `sinceSeq`: oldest first, or the newest ones
   * first when `newestFirst` is set. */
  list(project: string | null, sinceSeq: number, eventLimit: number, newestFirst: boolean): Record<string, unknown> {
    const itemCols = ITEM_COLUMNS.map((c) => `i.${c} AS i_${c}`).join(",");
    const itemRows = this.sql.exec(
      `SELECT ${itemCols},i.pile_rank AS i_pile_rank,i.handoff_state AS i_handoff_state,i.handoff_request AS i_handoff_request,
              i.handoff_at AS i_handoff_at,i.handoff_actor AS i_handoff_actor,i.handoff_accepted_at AS i_handoff_accepted_at,i.handoff_to AS i_handoff_to,i.handoff_by AS i_handoff_by,i.handoff_to_by AS i_handoff_to_by,i.handoff_title AS i_handoff_title,e.seq AS e_seq,e.at AS e_at,e.actor AS e_actor,e.kind AS e_kind,e.text AS e_text,e.ref AS e_ref
       FROM board_items i
       LEFT JOIN board_events e ON e.seq=(SELECT MAX(seq) FROM board_events WHERE item_id=i.item_id)
       WHERE (? IS NULL OR i.project=?) ORDER BY i.project,
         (CASE WHEN i.kind='task' AND i.state='planned' THEN i.pile_rank END) IS NULL,
         (CASE WHEN i.kind='task' AND i.state='planned' THEN i.pile_rank END),
         i.created_at,i.item_id`,
      project, project,
    ).toArray() as Row[];
    const items = itemRows.map((r) => ({
      ...rowItem(r, "i_"),
      rank: r.i_pile_rank === null ? null : num(r.i_pile_rank),
      handoff: this.handoffOf(r, "i_"),
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
