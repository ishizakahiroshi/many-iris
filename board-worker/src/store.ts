// The board store inside one SQLite-backed Durable Object. A Durable Object
// runs one request at a time, and each write runs in `transactionSync`, so a
// failed write leaves nothing behind. Same tables and rules as iris/src/board.rs.
import {
  BoardError, HANDOFF_TARGETS, ITEM_COLUMNS, LIST_EVENT_LIMIT, MAX_DEPTH, MAX_EVENTS, MAX_ITEMS,
  PAGE_EVENT_LIMIT, WRITER_EVENT_KINDS, applyPatch, asObject, clearable, has, invalid,
  nonNegativeInteger, onlyKeys, optionalStr, requiredStr, sameContent, validHttpsUrl,
  validItemId, validLine, validateItem, type Item,
} from "./rules";
import {
  ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, ATTACHMENT_MAX_UNSENT, ATTACHMENT_PER_MESSAGE, ATTACHMENT_TOTAL_BYTES,
  ATTACHMENT_TTL_MS, IMAGE_MAX_BYTES, READ_MAX_CHARS, isImageType, markerText, validAttachmentId,
} from "./attachments";
import { deriveLifecycle, type LifecycleInput } from "./lifecycle";
import { ALIVE_MS, DEFAULT_ORDER, ORDERABLE, isAlive, isLocalTarget, parseOrder, parseVersions } from "./route";
import {
  HANDOFF_LEASE_MS, canMarkUnknown, canReleaseUnknown, canResumeUnknown, checkFence,
  checkGenericWrite, isLegacyRun, leaseExpired, nextGeneration, type GenericFence, type HandoffView,
} from "./resume";
import {
  STATUS_ONLY_COMPLETION, STATUS_ONLY_PROGRESS, statusOnlyActors, type StatusOnlyEntry,
} from "./status-only";

export interface Limits {
  items: number;
  events: number;
  /** Test-only override of the handoff lease (resume.ts HANDOFF_LEASE_MS). */
  leaseMs?: number;
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
/** The item of a session on the owner's PC (many-ai-cli's board sync names them so). */
const SESSION_ITEM = /^session\/\d+(?:\/\d+)?$/;
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
  // The calls of the Clef-flash router the board used until 2026-11-21 (the
  // owner's order replaced it). Nothing writes it any more; it stays as the
  // record of those calls.
  `CREATE TABLE IF NOT EXISTS route_usage(
    day TEXT PRIMARY KEY NOT NULL,
    calls INTEGER NOT NULL,
    neurons REAL NOT NULL,
    counted_calls INTEGER NOT NULL
  )`,
  // The owner's settings from the page, one JSON value per key. Today one key:
  // `route_order`, the order "おまかせ" goes down (route.ts).
  `CREATE TABLE IF NOT EXISTS board_settings(
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL
  )`,
  // When each writer last came to the board (any tool call with its key), so
  // the owner's order can pass over a taker that is not running (route.ts isAlive).
  `CREATE TABLE IF NOT EXISTS writer_seen(
    actor TEXT PRIMARY KEY NOT NULL,
    at INTEGER NOT NULL
  )`,
];

/** Conversations with the server's AI workers ("話す"), kept apart from the
 * events: a message may be far longer than an event (CHAT_TEXT_MAX), and the
 * events keep the Rust board's limits. Owner messages are turns waiting for
 * an answer (status waiting → taken → answered | failed, or context_waiting
 * when the owner must confirm a new turn); agent messages
 * are the answers. Never deleted. */
const CHAT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS chat_messages(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL REFERENCES board_items(item_id),
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','agent')),
    to_target TEXT,
    text TEXT NOT NULL,
    ref TEXT,
    status TEXT,
    taken_by TEXT,
    taken_at INTEGER,
    context_confirmed INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS chat_messages_item ON chat_messages(item_id, seq)`,
  `CREATE INDEX IF NOT EXISTS chat_messages_open ON chat_messages(status, to_target)`,
  // Text attachments: the body is in R2 (key att/<att_id>); only the name, the
  // sizes and the first lines are kept here. seq is NULL until the message
  // that carries it is sent.
  `CREATE TABLE IF NOT EXISTS chat_attachments(
    att_id TEXT PRIMARY KEY NOT NULL,
    item_id TEXT NOT NULL REFERENCES board_items(item_id),
    seq INTEGER,
    at INTEGER NOT NULL,
    name TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    chars INTEGER NOT NULL,
    head TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS chat_attachments_item ON chat_attachments(item_id, seq)`,
];
/** The longest message in a conversation (characters). */
export const CHAT_TEXT_MAX = 20000;
/** Who can be talked to: the server's workers (owner decision 2026-11-21). */
export /** The project of a chat started with no project (the chat page's 案件なし). */
const CHAT_PROJECT = "chat";
const CHAT_TARGETS = ["vps-claude", "vps-devin"] as const;
/** A turn taken this long ago without an answer may be taken again by the same worker (its run died). */
export const CHAT_TAKE_MS = 40 * 60 * 1000;
const MAX_CHAT_MESSAGES = 100000;
/** What a worker is given as the conversation so far: the newest entries up to this many characters. */
const CHAT_TRANSCRIPT_CHARS = 120000;
const CHAT_RESULT_LINKS = 10;
const isChatTarget = (v: unknown): v is string => typeof v === "string" && (CHAT_TARGETS as readonly string[]).includes(v);

/** writer_seen is written at most this often per writer, not on every call. */
const SEEN_EVERY_MS = 30 * 1000;

type Row = Record<string, SqlStorageValue>;
const str = (v: SqlStorageValue) => v as string;
const strOrNull = (v: SqlStorageValue) => (v === null ? null : (v as string));
const num = (v: SqlStorageValue) => Number(v);

/** The hand-off columns, in the order handoffOf reads them (loadHandoff and list select these). */
const HANDOFF_COLUMNS = [
  "handoff_state", "handoff_request", "handoff_at", "handoff_actor", "handoff_accepted_at", "handoff_to", "handoff_by",
  "handoff_to_by", "handoff_title", "handoff_generation", "handoff_heartbeat_at", "handoff_lease_until",
  "handoff_versions", "handoff_result_ref", "handoff_result_commit", "handoff_phase", "handoff_phase_at",
];
// Only exact notes from the current, fenced run can change its reported phase.
const PHASE_NOTE = /^工程：(作業コマンド起動|調査中|実装中|テスト中|回答待ち)$/u;
/** A finished run's result link and commit, or null when it gave neither. */
function resultOf(r: Row, prefix: string): { ref: string | null; commit: string | null } | null {
  const ref = r[prefix + "handoff_result_ref"] ?? null;
  const commit = r[prefix + "handoff_result_commit"] ?? null;
  return ref === null && commit === null ? null : { ref: ref === null ? null : String(ref), commit: commit === null ? null : String(commit) };
}
/** A commit id as a run reports it: 7 to 40 lowercase hex characters. */
const COMMIT = /^[0-9a-f]{7,40}$/;
/** An event text kept within the 2,000 characters an event may have. */
const truncateLine = (s: string) => ([...s].length <= 2000 ? s : `${[...s].slice(0, 1999).join("")}…`);

function withoutParent<T extends { parent_id?: unknown }>(item: T): Omit<T, "parent_id"> {
  const { parent_id: _parentId, ...safe } = item;
  return safe;
}

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
  /** project -> its status-only takers (#50). From the Worker's environment, never from a request. */
  private statusOnlyMap: Map<string, Set<string>>;
  constructor(
    private storage: DurableObjectStorage,
    private limits: Limits,
    private chatOrigin: string | null = null,
    statusOnlyEntries: StatusOnlyEntry[] = [],
  ) {
    this.statusOnlyMap = statusOnlyActors(statusOnlyEntries);
  }

  private get sql() {
    return this.storage.sql;
  }
  private get leaseMs(): number {
    return this.limits.leaseMs ?? HANDOFF_LEASE_MS;
  }

  init(): void {
    for (const statement of SCHEMA) this.sql.exec(statement);
    for (const statement of CHAT_SCHEMA) this.sql.exec(statement);
    try { this.sql.exec("SELECT context_confirmed FROM chat_messages LIMIT 0"); } catch {
      this.sql.exec("ALTER TABLE chat_messages ADD COLUMN context_confirmed INTEGER NOT NULL DEFAULT 0");
    }
    // The owner's order of the pile. Added after the first boards were made, so
    // an existing table gets the column here (NULL = not ordered yet). It is not
    // one of the writers' fields: the Rust board does not have it.
    this.addColumn("pile_rank", "INTEGER");
    // Images came after text: a row without a type is text.
    try { this.sql.exec("SELECT mime FROM chat_attachments LIMIT 0"); } catch { this.sql.exec("ALTER TABLE chat_attachments ADD COLUMN mime TEXT"); }
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
    // Safe resumption of an accepted run (resume.ts): a fencing generation that
    // only grows, and a lease the run keeps alive by heartbeating. The
    // generation is never cleared, not even when the handoff itself is, so a
    // token from an earlier run can never match a later one.
    this.addColumn("handoff_generation", "INTEGER");
    this.addColumn("handoff_heartbeat_at", "INTEGER");
    this.addColumn("handoff_lease_until", "INTEGER");
    // The dispatcher's claim on a start (dispatch.ts): a row is written
    // BEFORE the session is started, with its outcome as the status —
    // claimed, started, unknown (the start's answer was lost; never retried
    // on its own), refused (Devin answered no, so nothing started) or
    // resolved (a person cleared an unknown claim). Rows
    // written before claims existed have no status and count as started:
    // recording used to happen after the start, so that is what they were.
    this.addDispatchColumn("status", "TEXT");
    this.addDispatchColumn("session_id", "TEXT");
    // What the taker said it runs with (picker, rules, skills commits; Q8 of
    // #46), and the run's result link and commit, so the card can show them.
    this.addColumn("handoff_versions", "TEXT");
    this.addColumn("handoff_result_ref", "TEXT");
    this.addColumn("handoff_result_commit", "TEXT");
    this.addColumn("handoff_phase", "TEXT");
    this.addColumn("handoff_phase_at", "INTEGER");
    // Every tool call looks for requested handoffs (watchTargets, after each
    // answer) and the dispatcher does every ten minutes; without this index
    // each look read the whole item table (issue #38).
    this.sql.exec("CREATE INDEX IF NOT EXISTS board_items_handoff ON board_items(handoff_state)");
    this.initCounts();
    // The snapshot covers items, events and the chat summary. Presence and
    // owner settings are cheap live fields, independent of this revision.
    this.sql.exec("CREATE TABLE IF NOT EXISTS page_revision(id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL, version INTEGER NOT NULL)");
    this.sql.exec("INSERT OR IGNORE INTO page_revision VALUES(1,lower(hex(randomblob(16))),0)");
    for (const [table, operations] of [
      ["board_items", ["INSERT", "UPDATE"]],
      ["board_events", ["INSERT"]],
      ["chat_messages", ["INSERT", "UPDATE", "DELETE"]],
    ] as const) {
      for (const op of operations) this.sql.exec(`CREATE TRIGGER IF NOT EXISTS page_${table}_${op} AFTER ${op} ON ${table}
        BEGIN UPDATE page_revision SET version=version+1 WHERE id=1; END`);
    }
    // Older notes remain activity. Only a recorded handoff operation may
    // label a note as a request or an acceptance on the historical timeline.
    try { this.sql.exec("SELECT milestone FROM board_events LIMIT 0"); } catch {
      this.sql.exec("ALTER TABLE board_events ADD COLUMN milestone TEXT");
    }
  }
  /** The item and event counts the limits are checked against, kept in
   * `board_counts` by insert triggers (rows are never deleted, see the
   * no-delete triggers). A board made before the table counts its rows once,
   * here; after that a count is one row instead of the whole table. */
  private initCounts(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS board_counts(
      name TEXT PRIMARY KEY NOT NULL CHECK(name IN ('board_items','board_events')),
      n INTEGER NOT NULL CHECK(n >= 0)
    )`);
    for (const table of ["board_items", "board_events"] as const) {
      this.sql.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_count AFTER INSERT ON ${table}
        BEGIN UPDATE board_counts SET n=n+1 WHERE name='${table}'; END`);
      const known = this.sql.exec("SELECT 1 FROM board_counts WHERE name=?", table).toArray().length > 0;
      if (!known) this.sql.exec(`INSERT INTO board_counts(name,n) SELECT '${table}',COUNT(*) FROM ${table}`);
    }
  }
  /** Adds a column to `dispatch_log` when an older board does not have it yet. */
  private addDispatchColumn(name: string, type: "INTEGER" | "TEXT"): void {
    try {
      this.sql.exec(`SELECT ${name} FROM dispatch_log LIMIT 0`);
    } catch {
      this.sql.exec(`ALTER TABLE dispatch_log ADD COLUMN ${name} ${type}`);
    }
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
      "SELECT item_id,project,title,source_ref,handoff_request,handoff_at,handoff_to,handoff_by FROM board_items WHERE handoff_state='requested' ORDER BY handoff_at",
    ).toArray() as Row[];
    const items = rows.map((r) => ({
      item_id: str(r.item_id), project: str(r.project), title: str(r.title),
      source_ref: strOrNull(r.source_ref), request_id: strOrNull(r.handoff_request), requested_at: num(r.handoff_at),
      to: strOrNull(r.handoff_to ?? null), requested_by: strOrNull(r.handoff_by ?? null),
    }));
    return { ok: true, items };
  }

  /** Actors that have work waiting for them right now: a requested handoff
   * addressed to them, or a waiting conversation turn. The board's WebSocket
   * watch uses this to wake only the watchers it concerns. */
  watchTargets(): string[] {
    // While the owner has stopped everything, nobody is woken: nothing may be taken.
    if (this.pauseState().paused) return [];
    const actors = new Set<string>();
    for (const r of this.sql.exec(
      "SELECT DISTINCT handoff_to AS a FROM board_items WHERE handoff_state='requested' AND handoff_to IS NOT NULL",
    ).toArray() as Row[]) { const a = strOrNull(r.a); if (a !== null) actors.add(a); }
    for (const r of this.sql.exec(
      "SELECT DISTINCT to_target AS a FROM chat_messages WHERE role='owner' AND status='waiting'",
    ).toArray() as Row[]) { const a = strOrNull(r.a); if (a !== null) actors.add(a); }
    return [...actors];
  }

  /** One dispatch_log row, with the pre-claim rows (status NULL) read as started. */
  private dispatchRows(request: string): { at: number; status: string }[] {
    return (this.sql.exec("SELECT at,status FROM dispatch_log WHERE request_id=?", request).toArray() as Row[])
      .map((r) => ({ at: num(r.at), status: r.status === null ? "started" : str(r.status) }));
  }

  /** What the dispatcher already did for a request: when a session was last
   * confirmed started, how many attempts were made, how many rows were
   * written since `since` in total, and whether a claim is in flight or an
   * outcome is unknown (either one blocks any new start). */
  dispatchState(request: string, since: number): Record<string, unknown> {
    const rows = this.dispatchRows(request);
    const started = rows.filter((r) => r.status === "started");
    const all = this.sql.exec("SELECT COUNT(*) AS n FROM dispatch_log WHERE at>=?", since).toArray() as Row[];
    return {
      ok: true,
      at: started.length ? Math.max(...started.map((r) => r.at)) : null,
      count: rows.length,
      total_since: num(all[0]?.n ?? 0),
      blocked: rows.some((r) => r.status === "claimed" || r.status === "unknown"),
    };
  }

  /**
   * Claims a request for one start, atomically: the check and the insert run
   * in one transaction inside the Durable Object, so two dispatcher ticks
   * racing each other cannot both claim the same request. The claim is
   * written BEFORE anything is started; what happens next is recorded on
   * the same row (confirmDispatch / markDispatchUnknown). A request with a
   * claim in flight or an unknown outcome is never claimed again on its
   * own — an unknown outcome waits for a person (resolveDispatch).
   */
  claimDispatch(
    request: string, at: number,
    limits: { dedupeMs: number; maxPerRequest: number; daySince: number; maxPerDay: number },
  ): Record<string, unknown> {
    return this.tx(() => {
      // 全部止める: no Devin session is started while it is on.
      if (this.pauseState().paused) return { ok: true, claimed: false, reason: "paused" };
      const rows = this.dispatchRows(request);
      if (rows.some((r) => r.status === "claimed" || r.status === "unknown"))
        return { ok: true, claimed: false, reason: "blocked" };
      if (rows.length >= limits.maxPerRequest) return { ok: true, claimed: false, reason: "per_request_cap" };
      const started = rows.filter((r) => r.status === "started");
      if (started.length && at - Math.max(...started.map((r) => r.at)) < limits.dedupeMs)
        return { ok: true, claimed: false, reason: "dedupe" };
      const day = this.sql.exec("SELECT COUNT(*) AS n FROM dispatch_log WHERE at>=?", limits.daySince).toArray() as Row[];
      if (num(day[0]?.n ?? 0) >= limits.maxPerDay) return { ok: true, claimed: false, reason: "day_cap" };
      const row = this.sql.exec(
        "INSERT INTO dispatch_log(request_id,at,status) VALUES(?,?,?) RETURNING seq", request, at, "claimed",
      ).one() as Row;
      return { ok: true, claimed: true, claim_id: num(row.seq) };
    });
  }

  /** Records the claim's session: the start answered, with its session id. */
  confirmDispatch(claimId: number, sessionId: string | null): Record<string, unknown> {
    return this.tx(() => {
      const rows = this.sql.exec("SELECT status FROM dispatch_log WHERE seq=?", claimId).toArray() as Row[];
      if (!rows.length || rows[0].status !== "claimed") return { ok: true, changed: false };
      this.sql.exec("UPDATE dispatch_log SET status='started',session_id=? WHERE seq=?", sessionId, claimId);
      return { ok: true, changed: true };
    });
  }

  /** Records that the start's outcome is unknown (the call failed or its
   * answer was lost after the claim). Nothing retries this on its own; the
   * claim blocks the dispatcher until a person resolves it. */
  markDispatchUnknown(claimId: number): Record<string, unknown> {
    return this.tx(() => {
      const rows = this.sql.exec("SELECT status FROM dispatch_log WHERE seq=?", claimId).toArray() as Row[];
      if (!rows.length || rows[0].status !== "claimed") return { ok: true, changed: false };
      this.sql.exec("UPDATE dispatch_log SET status='unknown' WHERE seq=?", claimId);
      return { ok: true, changed: true };
    });
  }

  /** Records that Devin refused the start (it answered with a 4xx), so no
   * session exists. Unlike an unknown outcome this blocks nothing and needs
   * no person; the row still counts toward the per-request and day caps. */
  refuseDispatch(claimId: number): Record<string, unknown> {
    return this.tx(() => {
      const rows = this.sql.exec("SELECT status FROM dispatch_log WHERE seq=?", claimId).toArray() as Row[];
      if (!rows.length || rows[0].status !== "claimed") return { ok: true, changed: false };
      this.sql.exec("UPDATE dispatch_log SET status='refused' WHERE seq=?", claimId);
      return { ok: true, changed: true };
    });
  }

  /**
   * The `board_resolve_dispatch` tool: a person settles a dispatch whose
   * outcome was unknown, after looking at the Devin side themselves.
   * `retry` states that no session is running for the request, so the
   * dispatcher may claim it again (the settled attempt still counts toward
   * the per-request cap). `started` states that a session IS running, with
   * its id: it will take the work itself with board_accept_handoff, and the
   * dispatcher leaves the request alone. Only an `unknown` row can be
   * resolved; anything else means there is nothing waiting for a person.
   */
  resolveDispatch(actor: string, input: unknown): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["request_id", "resolution", "session_id"]);
    const request = requiredStr(obj, "request_id");
    const resolution = requiredStr(obj, "resolution");
    if (resolution !== "retry" && resolution !== "started") throw invalid("resolution must be retry or started");
    const sessionId = optionalStr(obj, "session_id");
    if (resolution === "started" && (sessionId === null || !validLine(sessionId, 200, false)))
      throw invalid("session_id is required when the resolution is started");
    if (resolution === "retry" && sessionId !== null) throw invalid("session_id is only for the started resolution");
    return this.tx(() => {
      const rows = this.sql.exec(
        "SELECT seq FROM dispatch_log WHERE request_id=? AND status='unknown' ORDER BY seq DESC", request,
      ).toArray() as Row[];
      if (!rows.length)
        throw new BoardError("HANDOFF_CONFLICT", "No dispatch of this request is waiting for a person: its outcome is not unknown");
      const seq = num(rows[0].seq);
      if (resolution === "retry") this.sql.exec("UPDATE dispatch_log SET status='resolved' WHERE seq=?", seq);
      else this.sql.exec("UPDATE dispatch_log SET status='started',session_id=? WHERE seq=?", sessionId, seq);
      const items = this.sql.exec("SELECT item_id FROM board_items WHERE handoff_request=?", request).toArray() as Row[];
      if (items.length) {
        this.insertEvent(str(items[0].item_id), Date.now(), actor, "note",
          resolution === "retry"
            ? `dispatch of ${request} settled by ${actor}: no session is running, so the dispatcher may start one again`
            : `dispatch of ${request} settled by ${actor}: session ${sessionId} is running and will take the work itself`, null);
      }
      return { ok: true, changed: true, request_id: request, resolution };
    });
  }

  /** Notes that a writer came to the board (at most every SEEN_EVERY_MS). */
  noteSeen(actor: string, now: number): void {
    this.sql.exec(
      `INSERT INTO writer_seen(actor,at) VALUES(?,?)
       ON CONFLICT(actor) DO UPDATE SET at=excluded.at WHERE excluded.at - writer_seen.at >= ?`,
      actor, now, SEEN_EVERY_MS,
    );
  }

  /** One owner setting as parsed JSON, with when and by whom it was set; `bad` when the stored value does not parse. */
  private setting(key: string): { value: unknown; bad: boolean; at: number; by: string } | null {
    const rows = this.sql.exec("SELECT value,updated_at,updated_by FROM board_settings WHERE key=?", key).toArray() as Row[];
    if (!rows.length) return null;
    let value: unknown = null;
    let bad = false;
    try { value = JSON.parse(str(rows[0].value)); } catch { bad = true; }
    return { value, bad, at: num(rows[0].updated_at), by: str(rows[0].updated_by) };
  }
  private putSetting(key: string, value: unknown, actor: string): void {
    this.sql.exec(
      `INSERT INTO board_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
      key, JSON.stringify(value), Date.now(), actor,
    );
  }

  /**
   * The owner's "全部止める" (#46 Q7, owner decision 2026-11-22). While it is
   * on, no handed-over work and no conversation turn is taken, the
   * dispatcher starts no Devin session, nobody is woken, and every run is
   * told at its next heartbeat to stop (`stop: true`). A stored value that
   * does not parse counts as on: when in doubt, nothing starts.
   */
  pauseState(): { paused: boolean; at: number | null; by: string | null } {
    const s = this.setting("paused");
    if (s === null) return { paused: false, at: null, by: null };
    return { paused: s.bad || s.value === true, at: s.at, by: s.by };
  }
  private refuseWhilePaused(): void {
    if (this.pauseState().paused)
      throw new BoardError("PAUSED", "The owner stopped everything on the board (全部止める): nothing is taken until the owner resumes");
  }
  /** What a run's answer carries while everything is stopped: the run stops at this heartbeat. */
  private stopSignal(): Record<string, unknown> {
    return this.pauseState().paused ? { stop: true, stop_reason: "paused" } : {};
  }

  /**
   * Projects the owner marked 手元だけ (#46 Q6, owner decision 2026-11-22):
   * their work is taken only on the owner's PC (local-* writers). Every
   * other project is どこでもよい. A stored value that does not parse is
   * read as no marks, and the page shows the setting as it is read.
   */
  projectScopes(): Record<string, "local"> {
    const s = this.setting("project_scopes");
    const out: Record<string, "local"> = {};
    if (s === null || s.bad || s.value === null || typeof s.value !== "object" || Array.isArray(s.value)) return out;
    for (const [project, scope] of Object.entries(s.value as Record<string, unknown>)) if (scope === "local") out[project] = "local";
    return out;
  }
  private projectIsLocal(project: string): boolean {
    return this.projectScopes()[project] === "local";
  }
  /** Refuses a destination outside a 手元だけ project's range (owner and hold are not takers, so they stay allowed). */
  private checkScope(project: string, to: string | null): void {
    if (to === null || UNTAKEN_TARGETS.has(to) || isLocalTarget(to) || !this.projectIsLocal(project)) return;
    throw new BoardError("FORBIDDEN", `Project ${project} is 手元だけ: only the owner's PC (local-*) takes its work, not ${to}`);
  }

  /** The owner's order (or the default until one is set) and when each writer last came. */
  routeOrder(): Record<string, unknown> {
    const rows = this.sql.exec("SELECT value,updated_at FROM board_settings WHERE key='route_order'").toArray() as Row[];
    let order: string[] | null = null;
    if (rows.length) {
      try { order = parseOrder(JSON.parse(str(rows[0].value))); } catch { order = null; }
    }
    const seen: Record<string, number> = {};
    for (const r of this.sql.exec("SELECT actor,at FROM writer_seen").toArray() as Row[]) seen[str(r.actor)] = num(r.at);
    return {
      ok: true, order: order ?? [...DEFAULT_ORDER], set_by_owner: order !== null,
      updated_at: rows.length ? num(rows[0].updated_at) : null, seen, scopes: this.projectScopes(),
    };
  }

  /** The order and, for every destination that can be in it, whether it is picking up now (for the page). */
  private routeView(route: Record<string, unknown>, devinReady: boolean, now: number): Record<string, unknown> {
    const seen = route.seen as Record<string, number>;
    const targets = ORDERABLE.map((target) => ({
      target, alive: isAlive(target, seen, now, devinReady), seen_at: target === "devin" ? null : (seen[target] ?? null),
    }));
    return { order: route.order, set_by_owner: route.set_by_owner, updated_at: route.updated_at, alive_ms: ALIVE_MS, targets };
  }

  // --- conversations ("話す") ------------------------------------------

  /** The sent attachments of an item, by the seq of the message that carries them. */
  private attachmentsBySeq(itemId: string): Map<number, Record<string, unknown>[]> {
    const out = new Map<number, Record<string, unknown>[]>();
    const expired = Date.now() - ATTACHMENT_TTL_MS;
    for (const r of this.sql.exec(
      "SELECT att_id,seq,at,name,bytes,chars,head,mime FROM chat_attachments WHERE item_id=? AND seq IS NOT NULL ORDER BY at, att_id", itemId,
    ).toArray() as Row[]) {
      const list = out.get(num(r.seq)) ?? [];
      list.push({ id: str(r.att_id), name: str(r.name), bytes: num(r.bytes), chars: num(r.chars), head: str(r.head), mime: strOrNull(r.mime ?? null), expired: num(r.at) < expired });
      out.set(num(r.seq), list);
    }
    return out;
  }
  private chatRows(itemId: string): Record<string, unknown>[] {
    const attachments = this.attachmentsBySeq(itemId);
    return (this.sql.exec(
      "SELECT seq,at,actor,role,to_target,text,ref,status FROM chat_messages WHERE item_id=? ORDER BY seq", itemId,
    ).toArray() as Row[]).map((r) => ({
      seq: num(r.seq), at: num(r.at), actor: str(r.actor), role: str(r.role), to: strOrNull(r.to_target ?? null),
      text: str(r.text), ref: strOrNull(r.ref ?? null), status: strOrNull(r.status ?? null),
      attachments: attachments.get(num(r.seq)) ?? [],
    }));
  }
  /** A message as the worker reads it: its text, then a marker per attachment (never the body). */
  private withMarkers(m: Record<string, unknown>): string {
    const list = (m.attachments as Record<string, unknown>[] | undefined) ?? [];
    const marks = list.map((a) => markerText(a as { id: string; name: string; bytes: number; chars: number; head: string; mime: string | null }));
    return [m.text as string, ...marks].filter((t) => t !== "").join("\n");
  }

  /** Reserve an uploaded text (the body goes to R2 right after). One conversation holds a bounded number and total size. */
  attachmentAdd(itemId: string, id: string, name: string, bytes: number, chars: number, head: string, mime: string | null = null): Record<string, unknown> {
    if (!validItemId(itemId) || !validAttachmentId(id)) throw invalid("item_id or attachment id is not valid");
    if (mime !== null && !isImageType(mime)) throw invalid("mime is not an image type");
    const max = mime === null ? ATTACHMENT_MAX_BYTES : IMAGE_MAX_BYTES;
    if (bytes < 1 || bytes > max) throw invalid(`An attachment is 1 to ${max} bytes`);
    return this.tx(() => {
      const item = this.loadItem(itemId);
      if (item === null) throw new BoardError("NOT_FOUND", "No such item");
      if (item.kind !== "task") throw new BoardError("FORBIDDEN", "Only work (kind task) has a conversation");
      const sums = this.sql.exec(
        "SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b, COALESCE(SUM(CASE WHEN seq IS NULL THEN 1 ELSE 0 END),0) AS u FROM chat_attachments WHERE item_id=?", itemId,
      ).one() as Row;
      if (num(sums.n) >= ATTACHMENT_MAX_COUNT) throw new BoardError("BOARD_EVENT_LIMIT", "This conversation holds as many attachments as it may");
      if (num(sums.b) + bytes > ATTACHMENT_TOTAL_BYTES) throw new BoardError("BOARD_EVENT_LIMIT", "The attachments of this conversation are full");
      if (num(sums.u) >= ATTACHMENT_MAX_UNSENT) throw new BoardError("BOARD_EVENT_LIMIT", "Too many attachments wait to be sent");
      const at = Date.now();
      this.sql.exec("INSERT INTO chat_attachments(att_id,item_id,seq,at,name,bytes,chars,head,mime) VALUES(?,?,NULL,?,?,?,?,?,?)", id, itemId, at, name, bytes, chars, head, mime);
      return { ok: true, attachment: { id, name, bytes, chars, head, mime, at } };
    });
  }
  /** Forget an attachment that was not sent yet (the owner took the card away, or the R2 write failed). */
  attachmentDrop(itemId: string, id: string): Record<string, unknown> {
    if (!validItemId(itemId) || !validAttachmentId(id)) throw invalid("item_id or attachment id is not valid");
    return this.tx(() => {
      const rows = this.sql.exec("SELECT seq FROM chat_attachments WHERE att_id=? AND item_id=?", id, itemId).toArray() as Row[];
      if (!rows.length) throw new BoardError("NOT_FOUND", "No such attachment");
      if (rows[0].seq !== null) throw new BoardError("FORBIDDEN", "A sent attachment stays");
      this.sql.exec("DELETE FROM chat_attachments WHERE att_id=?", id);
      return { ok: true, changed: true };
    });
  }
  /** One attachment's record, or NOT_FOUND (also once it is older than the 30 days). */
  attachmentMeta(id: string): { id: string; item_id: string; name: string; bytes: number; chars: number; mime: string | null } {
    if (!validAttachmentId(id)) throw invalid("attachment id is not valid");
    const rows = this.sql.exec("SELECT att_id,item_id,at,name,bytes,chars,mime FROM chat_attachments WHERE att_id=?", id).toArray() as Row[];
    if (!rows.length) throw new BoardError("NOT_FOUND", "No such attachment");
    if (num(rows[0].at) < Date.now() - ATTACHMENT_TTL_MS) throw new BoardError("NOT_FOUND", "This attachment has expired");
    return { id, item_id: str(rows[0].item_id), name: str(rows[0].name), bytes: num(rows[0].bytes), chars: num(rows[0].chars), mime: strOrNull(rows[0].mime ?? null) };
  }
  /** The `board_chat_attachment` tool's checks: only the server's workers read attachments. */
  attachmentForWorker(actor: string, input: unknown): { meta: ReturnType<Store["attachmentMeta"]>; offset: number; limit: number } {
    const obj = asObject(input);
    onlyKeys(obj, ["attachment_id", "offset", "limit"]);
    if (!isChatTarget(actor)) throw new BoardError("FORBIDDEN", "Only the server's workers read attachments");
    const meta = this.attachmentMeta(requiredStr(obj, "attachment_id"));
    const offset = has(obj, "offset") ? obj.offset : 0;
    const limit = has(obj, "limit") ? obj.limit : READ_MAX_CHARS;
    if (!nonNegativeInteger(offset)) throw invalid("offset must be a non-negative integer");
    if (!nonNegativeInteger(limit) || (limit as number) < 1) throw invalid("limit must be a positive integer");
    return { meta, offset: offset as number, limit: Math.min(limit as number, READ_MAX_CHARS) };
  }
  /** The item's notes written by the server's workers (its runs' progress and results), oldest first. */
  private workerNotes(itemId: string): Record<string, unknown>[] {
    return (this.sql.exec(
      `SELECT seq,at,actor,text,ref FROM board_events WHERE item_id=? AND kind<>'state_change' AND actor IN (${CHAT_TARGETS.map(() => "?").join(",")}) ORDER BY seq`,
      itemId, ...CHAT_TARGETS,
    ).toArray() as Row[]).map((r) => ({ seq: num(r.seq), at: num(r.at), actor: str(r.actor), text: str(r.text), ref: strOrNull(r.ref ?? null) }));
  }
  /** Who the next message goes to by default: the last one talked to, else the worker the work was handed to. */
  private chatPartner(itemId: string, handoff: Record<string, unknown> | null): string {
    const last = this.sql.exec(
      "SELECT to_target FROM chat_messages WHERE item_id=? AND role='owner' ORDER BY seq DESC LIMIT 1", itemId,
    ).toArray() as Row[];
    if (last.length && isChatTarget(last[0].to_target)) return str(last[0].to_target);
    if (handoff && isChatTarget(handoff.accepted_by)) return handoff.accepted_by as string;
    if (handoff && isChatTarget(handoff.to)) return handoff.to as string;
    return CHAT_TARGETS[0];
  }
  /** One conversation for the page: the work, what the workers reported, the messages, and the open turn. */
  chatView(itemId: string): Record<string, unknown> {
    const item = this.loadItem(itemId);
    if (item === null) throw new BoardError("NOT_FOUND", "No such item");
    const handoff = this.loadHandoff(itemId);
    const messages = this.chatRows(itemId);
    const open = messages.find((m) => m.role === "owner" && (m.status === "waiting" || m.status === "taken")) ?? null;
    return {
      ok: true,
      item: { item_id: item.item_id, project: item.project, title: item.title, state: item.state, kind: item.kind },
      handoff, notes: this.workerNotes(itemId), messages, open,
      partner: this.chatPartner(itemId, handoff), targets: [...CHAT_TARGETS], text_max: CHAT_TEXT_MAX,
      attachment_limits: {
        max_bytes: ATTACHMENT_MAX_BYTES, image_max_bytes: IMAGE_MAX_BYTES, total_bytes: ATTACHMENT_TOTAL_BYTES, max_count: ATTACHMENT_MAX_COUNT,
        per_message: ATTACHMENT_PER_MESSAGE, ttl_days: Math.round(ATTACHMENT_TTL_MS / 86400000),
      },
    };
  }
  /** Per item: how many messages, whether a turn waits for an answer, and the newest message's time (cards and the chat list). */
  chatSummary(): Map<string, { messages: number; open: boolean; last_at: number }> {
    const out = new Map<string, { messages: number; open: boolean; last_at: number }>();
    for (const r of this.sql.exec(
      "SELECT item_id,COUNT(*) AS n,SUM(CASE WHEN status IN ('waiting','taken') THEN 1 ELSE 0 END) AS o,MAX(at) AS last_at FROM chat_messages GROUP BY item_id",
    ).toArray() as Row[]) out.set(str(r.item_id), { messages: num(r.n), open: num(r.o) > 0, last_at: num(r.last_at) });
    return out;
  }
  /** The owner sends a message (from the page only: ownerWrite). One open turn per item. */
  private chatSend(actor: string, obj: Record<string, unknown>): Record<string, unknown> {
    onlyKeys(obj, ["op", "item_id", "text", "to", "attachments", "context_confirmed"]);
    const itemId = requiredStr(obj, "item_id");
    // Attachments (ids from the upload). With at least one, the text may be empty.
    const ids = has(obj, "attachments") ? obj.attachments : [];
    if (!Array.isArray(ids) || ids.length > ATTACHMENT_PER_MESSAGE || !ids.every(validAttachmentId) || new Set(ids).size !== ids.length)
      throw invalid(`attachments must be up to ${ATTACHMENT_PER_MESSAGE} distinct attachment ids`);
    const typed = has(obj, "text") ? obj.text : "";
    if (typeof typed !== "string") throw invalid("text must be text");
    const text = ids.length > 0 && typed.trim() === "" ? "" : requiredStr(obj, "text");
    if (text !== "" && !validLine(text, CHAT_TEXT_MAX, true)) throw invalid(`text must be 1 to ${CHAT_TEXT_MAX} characters`);
    const confirmed = has(obj, "context_confirmed") ? obj.context_confirmed : 0;
    if (!nonNegativeInteger(confirmed) || (has(obj, "context_confirmed") && confirmed === 0))
      throw invalid("context_confirmed must be the number of the waiting turn");
    if (confirmed && text.trim() === "") throw invalid("A confirmation needs a new written instruction");
    const to = has(obj, "to") ? obj.to : null;
    if (to !== null && !isChatTarget(to)) throw invalid(`to must be one of ${CHAT_TARGETS.join(", ")}`);
    return this.tx(() => {
      const item = this.loadItem(itemId);
      if (item === null) throw new BoardError("NOT_FOUND", "No such item");
      if (item.kind !== "task") throw new BoardError("FORBIDDEN", "Only work (kind task) has a conversation");
      // The conversation partners are the server's workers: a 手元だけ project's work does not go to the server.
      if (this.projectIsLocal(item.project))
        throw new BoardError("FORBIDDEN", `Project ${item.project} is 手元だけ: its work is not talked over with the server's AI`);
      const open = num((this.sql.exec(
        "SELECT COUNT(*) AS n FROM chat_messages WHERE item_id=? AND status IN ('waiting','taken')", itemId,
      ).one() as Row).n);
      if (open > 0) throw new BoardError("HANDOFF_CONFLICT", "The last message has not been answered yet");
      if (confirmed) {
        const lastOwner = this.sql.exec("SELECT seq,status FROM chat_messages WHERE item_id=? AND role='owner' ORDER BY seq DESC LIMIT 1", itemId).toArray() as Row[];
        if (lastOwner[0]?.status !== "context_waiting" || num(lastOwner[0].seq) !== confirmed)
          throw new BoardError("HANDOFF_CONFLICT", "The turn waiting for confirmation has changed");
      }
      if (num((this.sql.exec("SELECT COUNT(*) AS n FROM chat_messages").one() as Row).n) >= MAX_CHAT_MESSAGES)
        throw new BoardError("BOARD_EVENT_LIMIT", "The conversations are full");
      const target = (to as string | null) ?? this.chatPartner(itemId, this.loadHandoff(itemId));
      this.sql.exec(
        "INSERT INTO chat_messages(item_id,at,actor,role,to_target,text,status,context_confirmed) VALUES(?,?,?,'owner',?,?,'waiting',?)",
        itemId, Date.now(), actor, target, text, confirmed,
      );
      if (ids.length > 0) {
        const seq = num((this.sql.exec("SELECT MAX(seq) AS s FROM chat_messages").one() as Row).s);
        for (const id of ids as string[]) {
          const own = this.sql.exec("SELECT att_id FROM chat_attachments WHERE att_id=? AND item_id=? AND seq IS NULL", id, itemId).toArray();
          if (!own.length) throw new BoardError("NOT_FOUND", "An attachment was not found (or was sent already)");
          this.sql.exec("UPDATE chat_attachments SET seq=? WHERE att_id=?", seq, id);
        }
      }
      return this.chatView(itemId);
    });
  }
  /** The `board_chat_pending` tool: turns waiting for this worker, oldest first (and its own turns whose run died). */
  chatPending(actor: string): Record<string, unknown> {
    if (!isChatTarget(actor)) return { ok: true, turns: [] };
    if (this.pauseState().paused) return { ok: true, turns: [], paused: true };
    const stale = Date.now() - CHAT_TAKE_MS;
    const turns = (this.sql.exec(
      `SELECT c.seq,c.item_id,c.at,i.project,i.title FROM chat_messages c JOIN board_items i ON i.item_id=c.item_id
       WHERE c.role='owner' AND c.to_target=? AND (c.status='waiting' OR (c.status='taken' AND c.taken_by=? AND c.taken_at<?))
       ORDER BY c.seq LIMIT 20`,
      actor, actor, stale,
    ).toArray() as Row[]).map((r) => ({ item_id: str(r.item_id), seq: num(r.seq), at: num(r.at), project: str(r.project), title: str(r.title) }));
    return { ok: true, turns };
  }
  /** The `board_chat_take` tool: take one turn (atomically) and get the conversation so far. */
  chatTake(actor: string, input: unknown): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["item_id", "seq"]);
    const itemId = requiredStr(obj, "item_id");
    if (!nonNegativeInteger(obj.seq)) throw invalid("seq must be the turn's number");
    const seq = obj.seq as number;
    if (!isChatTarget(actor)) throw new BoardError("FORBIDDEN", "Only the server's workers answer conversations");
    return this.tx(() => {
      this.refuseWhilePaused();
      const rows = this.sql.exec(
        "SELECT role,to_target,status,taken_by,context_confirmed FROM chat_messages WHERE seq=? AND item_id=?", seq, itemId,
      ).toArray() as Row[];
      if (!rows.length || rows[0].role !== "owner") throw new BoardError("NOT_FOUND", "No such turn");
      const r = rows[0];
      if (r.to_target !== actor) throw new BoardError("FORBIDDEN", `This turn is for ${String(r.to_target)}, not for ${actor}`);
      const mine = r.status === "taken" && r.taken_by === actor;
      if (!(r.status === "waiting" || mine)) throw new BoardError("HANDOFF_CONFLICT", "This turn is not open");
      const item = this.loadItem(itemId) as Item;
      const handoff = this.loadHandoff(itemId);
      // The conversation so far, oldest first: the work as handed over, what
      // the workers reported on the item, and the messages. The newest
      // entries are kept when it is longer than CHAT_TRANSCRIPT_CHARS.
      const messages = this.chatRows(itemId);
      const turn = messages.find((m) => m.seq === seq)!;
      const entries: { at: number; who: string; actor: string; text: string; ref: string | null }[] = [];
      for (const n of this.workerNotes(itemId)) entries.push({ at: n.at as number, who: "agent", actor: n.actor as string, text: n.text as string, ref: n.ref as string | null });
      for (const m of messages) {
        const text = this.withMarkers(m);
        entries.push({ at: m.at as number, who: m.role as string, actor: m.actor as string,
          text: m.status === "context_waiting" ? `［判断待ちだった発言］${text}` : text, ref: m.ref as string | null });
      }
      entries.sort((a, b) => a.at - b.at);
      let total = 0;
      const kept: typeof entries = [];
      for (let i = entries.length - 1; i >= 0; i--) {
        total += entries[i].text.length;
        if (total > CHAT_TRANSCRIPT_CHARS && kept.length) break;
        kept.unshift(entries[i]);
      }
      const truncated = kept.length < entries.length;
      if (truncated && num(r.context_confirmed) === 0) {
        this.sql.exec("UPDATE chat_messages SET status='context_waiting',taken_by=NULL,taken_at=NULL WHERE seq=?", seq);
        // Return, rather than throw, so the wait is committed with the refusal.
        return { ok: false, error: { code: "CHAT_CONFIRMATION_REQUIRED", detail: "Earlier conversation was omitted. The owner must confirm a new turn." } };
      }
      this.sql.exec("UPDATE chat_messages SET status='taken',taken_by=?,taken_at=? WHERE seq=?", actor, Date.now(), seq);
      const chatPath = `/chat#${encodeURIComponent(itemId)}`;
      const chatUrl = (this.chatOrigin ?? "") + chatPath;
      const resultRefs = [...new Set(entries.slice().reverse().flatMap(({ ref }) => ref ? [ref] : []))].slice(0, CHAT_RESULT_LINKS);
      // Existing workers already consume transcript entries, including when a
      // wrapper does not yet read the structured context fields.
      if (truncated || resultRefs.length) {
        const notice = [
          truncated ? "古いやり取りは一部省略されています。持ち主は今回の指示を確認して送り直しました。必要な承認が今回の指示に無ければ、実行せず確認を求めてください。" : "",
          `元の会話: ${chatUrl}`,
          resultRefs.length ? `最近の成果リンク（参照用）: ${JSON.stringify(resultRefs)}` : "",
        ].filter(Boolean).join("\n");
        kept.unshift({ at: 0, who: "system", actor: "iris", text: notice, ref: null });
      }
      return {
        ok: true,
        turn: {
          item_id: itemId, seq, text: this.withMarkers(turn),
          attachments: ((turn.attachments ?? []) as Record<string, unknown>[])
            .map((a) => ({ id: a.id, name: a.name, bytes: a.bytes, chars: a.chars, mime: a.mime ?? null })),
        },
        item: { item_id: item.item_id, project: item.project, title: item.title, source_ref: item.source_ref },
        handoff: handoff === null ? null : { request_id: handoff.request_id, title: handoff.title, accepted_by: handoff.accepted_by },
        transcript: kept, transcript_truncated: truncated, chat_url: chatUrl, result_refs: resultRefs,
      };
    });
  }
  /** The `board_chat_reply` tool: answer the turn this worker took. */
  chatReply(actor: string, input: unknown): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["item_id", "seq", "text", "ref", "failed"]);
    const itemId = requiredStr(obj, "item_id");
    if (!nonNegativeInteger(obj.seq)) throw invalid("seq must be the turn's number");
    const seq = obj.seq as number;
    const text = requiredStr(obj, "text");
    if (!validLine(text, CHAT_TEXT_MAX, true)) throw invalid(`text must be 1 to ${CHAT_TEXT_MAX} characters`);
    const ref = optionalStr(obj, "ref");
    if (ref !== null && !validHttpsUrl(ref)) throw invalid("ref must be an https URL");
    if (has(obj, "failed") && typeof obj.failed !== "boolean") throw invalid("failed must be true or false");
    const failed = obj.failed === true;
    return this.tx(() => {
      const rows = this.sql.exec("SELECT role,status,taken_by FROM chat_messages WHERE seq=? AND item_id=?", seq, itemId).toArray() as Row[];
      if (!rows.length || rows[0].role !== "owner") throw new BoardError("NOT_FOUND", "No such turn");
      if (rows[0].status !== "taken" || rows[0].taken_by !== actor) throw new BoardError("HANDOFF_CONFLICT", "This worker has not taken this turn");
      this.sql.exec("UPDATE chat_messages SET status=? WHERE seq=?", failed ? "failed" : "answered", seq);
      this.sql.exec(
        "INSERT INTO chat_messages(item_id,at,actor,role,text,ref) VALUES(?,?,?,'agent',?,?)",
        itemId, Date.now(), actor, text, ref,
      );
      return { ok: true, changed: true, seq };
    });
  }

  /**
   * The router's answer for a request without a destination: sets it, unless the
   * request was taken, taken back or given a destination by the owner meanwhile.
   */
  routeHandoff(actor: string, itemId: string, request: string, to: string, text: string, toSetBy: string = actor): Record<string, unknown> {
    if (!(HANDOFF_TARGETS as readonly string[]).includes(to)) throw invalid("unknown destination");
    return this.tx(() => {
      const handoff = this.loadHandoff(itemId);
      if (handoff === null || handoff.state !== "requested" || handoff.request_id !== request || handoff.to !== null)
        return { ok: true, changed: false, handoff };
      this.sql.exec("UPDATE board_items SET handoff_to=?,handoff_to_by=? WHERE item_id=?", to, toSetBy, itemId);
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
    const generation = r[prefix + "handoff_generation"] ?? null;
    const heartbeatAt = r[prefix + "handoff_heartbeat_at"] ?? null;
    const leaseUntil = r[prefix + "handoff_lease_until"] ?? null;
    const view: HandoffView = {
      state: str(state), request_id: strOrNull(r[prefix + "handoff_request"] ?? null),
      accepted_by: strOrNull(r[prefix + "handoff_actor"] ?? null),
      generation: generation === null ? null : num(generation),
      lease_until: leaseUntil === null ? null : num(leaseUntil),
    };
    return {
      state: view.state, request_id: view.request_id,
      requested_at: at === null ? null : num(at),
      accepted_by: view.accepted_by,
      accepted_at: acceptedAt === null ? null : num(acceptedAt),
      to: strOrNull(r[prefix + "handoff_to"] ?? null),
      requested_by: strOrNull(r[prefix + "handoff_by"] ?? null),
      to_set_by: strOrNull(r[prefix + "handoff_to_by"] ?? null),
      title: strOrNull(r[prefix + "handoff_title"] ?? null),
      generation: view.generation,
      heartbeat_at: heartbeatAt === null ? null : num(heartbeatAt),
      phase: r[prefix + "handoff_phase"] ?? null,
      phase_at: r[prefix + "handoff_phase_at"] ?? null,
      lease_until: view.lease_until,
      lease_expired: leaseExpired(view, Date.now()),
      legacy_run: isLegacyRun(view),
      versions: parseVersions(strOrNull(r[prefix + "handoff_versions"] ?? null)),
      result: resultOf(r, prefix),
    };
  }
  private loadHandoff(id: string): Record<string, unknown> | null {
    const rows = this.sql.exec(
      `SELECT ${HANDOFF_COLUMNS.join(",")} FROM board_items WHERE item_id=?`, id,
    ).toArray() as Row[];
    return rows.length ? this.handoffOf(rows[0]) : null;
  }
  /** The typed view of one item's handoff for the resume.ts decisions. */
  private handoffView(id: string): HandoffView | null {
    const h = this.loadHandoff(id);
    if (h === null) return null;
    return {
      state: h.state as string, request_id: h.request_id as string | null,
      accepted_by: h.accepted_by as string | null,
      generation: h.generation as number | null, lease_until: h.lease_until as number | null,
    };
  }
  /** The last generation ever used on this item (kept after a handoff ends). */
  private loadGeneration(id: string): number | null {
    const rows = this.sql.exec("SELECT handoff_generation FROM board_items WHERE item_id=?", id).toArray() as Row[];
    if (!rows.length) return null;
    const g = rows[0].handoff_generation ?? null;
    return g === null ? null : num(g);
  }
  /** Clears a handoff back to the pile. The generation stays, on purpose. */
  private clearHandoff(itemId: string): void {
    this.sql.exec(
      "UPDATE board_items SET handoff_state=NULL,handoff_request=NULL,handoff_at=NULL,handoff_actor=NULL,handoff_accepted_at=NULL,handoff_to=NULL,handoff_by=NULL,handoff_to_by=NULL,handoff_title=NULL,handoff_heartbeat_at=NULL,handoff_lease_until=NULL,handoff_versions=NULL,handoff_result_ref=NULL,handoff_result_commit=NULL,handoff_phase=NULL,handoff_phase_at=NULL WHERE item_id=?",
      itemId,
    );
  }

  /** The actors registered status-only for a project, or null when the project is not registered. */
  private statusOnlyFor(project: string | null): Set<string> | null {
    if (project === null) return null;
    return this.statusOnlyMap.get(project) ?? null;
  }
  private loadItem(id: string): Item | null {
    const rows = this.sql.exec(`SELECT ${ITEM_COLUMNS.join(",")} FROM board_items WHERE item_id=?`, id).toArray();
    return rows.length ? rowItem(rows[0] as Row) : null;
  }
  /** Reads the kept count (board_counts): one row, where COUNT(*) read the
   * whole table on every list and every write (issue #38). */
  private count(table: "board_items" | "board_events"): number {
    return num((this.sql.exec("SELECT n FROM board_counts WHERE name=?", table).one() as Row).n);
  }

  /** Runs `fn` in one transaction; a thrown error rolls everything back. */
  private tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  /** The optional fence a plain write carries (see checkGenericWrite). The
   * two fields come together or not at all. */
  private parseFence(obj: Record<string, unknown>): GenericFence {
    if (!has(obj, "request_id") && !has(obj, "generation")) return null;
    if (!has(obj, "request_id") || !has(obj, "generation"))
      throw invalid("request_id and generation must be sent together (the fence of the run writing this)");
    const request = requiredStr(obj, "request_id");
    if (!nonNegativeInteger(obj.generation) || (obj.generation as number) < 1)
      throw invalid("generation must be the positive integer the accept returned (handoff.generation)");
    return { request_id: request, generation: obj.generation as number };
  }
  /** Refuses a plain write that a stale run could hide behind (resume.ts
   * checkGenericWrite decides; only the run writer's own plain writes to an
   * item it is running are fenced). Runs inside the write's transaction. */
  private guardGenericWrite(actor: string, itemId: string, fence: GenericFence): void {
    const view = this.handoffView(itemId);
    if (view === null) return;
    const verdict = checkGenericWrite(view, actor, fence);
    if (!verdict.ok) throw new BoardError(verdict.code, verdict.detail);
  }

  /** Creates or updates one item. `actor` comes from the writer's key.
   * `internal` marks the store's own follow-up writes (the accept flipping
   * the item to in progress), which are part of a fenced operation already
   * and must not be fenced a second time. */
  upsertItem(actor: string, input: unknown, internal = false): { ok: boolean; changed: boolean; item: Item } {
    const obj = asObject(input);
    onlyKeys(obj, [
      "item_id", "project", "kind", "title", "source_ref", "parent_id", "state",
      "waiting_reason", "planned_start", "planned_end", "expected_revision",
      "request_id", "generation",
    ]);
    const fence = this.parseFence(obj);
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
      if (!internal && existing !== null) this.guardGenericWrite(actor, itemId, fence);
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
    onlyKeys(obj, ["item_id", "kind", "text", "ref", "request_id", "generation"]);
    const fence = this.parseFence(obj);
    const itemId = requiredStr(obj, "item_id");
    const kind = requiredStr(obj, "kind");
    const text = requiredStr(obj, "text");
    const reference = optionalStr(obj, "ref");
    if (!(WRITER_EVENT_KINDS as readonly string[]).includes(kind))
      throw invalid("kind must be session_start, session_end or note (state_change is recorded by the board)");
    if (!validLine(text, 2000, true)) throw invalid("text must be 1 to 2000 characters");
    if (reference !== null && !validHttpsUrl(reference)) throw invalid("ref must be an https URL of 500 characters at most");
    return this.tx(() => {
      const target = this.loadItem(itemId);
      if (target === null) throw new BoardError("NOT_FOUND", "No such item");
      if (this.statusOnlyFor(target.project)?.has(actor)
        && (kind !== "note" || reference !== null || !(STATUS_ONLY_PROGRESS as readonly string[]).includes(text)))
        throw new BoardError("FORBIDDEN", "This work reports status only: a note of 状態：着手, 状態：作業中 or 状態：要確認, without a link");
      this.guardGenericWrite(actor, itemId, fence);
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
  acceptHandoff(actor: string, input: unknown, restricted = false): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["item_id", "request_id", "versions"]);
    const itemId = requiredStr(obj, "item_id");
    const request = requiredStr(obj, "request_id");
    // What the taker runs with, e.g. "picker=1a2b3c4,rules=5d6e7f8" (#46 Q8): recorded, never acted on.
    const versionsText = optionalStr(obj, "versions");
    const versions = versionsText === null ? null : parseVersions(versionsText);
    if (versionsText !== null && versions === null)
      throw invalid("versions must be up to 8 name=commit pairs separated by commas (name ^[a-z][a-z0-9_-]{0,31}$, commit 7 to 40 hex)");
    const now = Date.now();
    let again = false;
    this.tx(() => {
      const target = this.loadItem(itemId);
      const handoff = this.loadHandoff(itemId);
      if (restricted && (target === null || handoff === null || handoff.request_id !== request || (handoff.to !== actor && handoff.accepted_by !== actor)))
        throw new BoardError("NOT_FOUND", "No such request");
      if (target === null) throw new BoardError("NOT_FOUND", "No such item");
      // Idempotent retry: the same writer asking again for the request it
      // already took (its first answer may have been lost on the wire) gets
      // the same handoff back, not a conflict and never a second run.
      if (handoff !== null && handoff.state === "accepted" && handoff.request_id === request && handoff.accepted_by === actor) {
        if (restricted && (handoff.to !== actor || typeof handoff.lease_until !== "number" || handoff.lease_until <= now))
          throw new BoardError("HANDOFF_CONFLICT", "This request is no longer active for this writer");
        again = true;
        // A run taken before generations existed has none on record: give
        // it one now, and a lease, so from here on it is fenced and timed
        // like any other run. The retrying writer learns both from this
        // very answer, so nothing is stranded by the upgrade.
        if (handoff.generation === null) {
          this.sql.exec(
            "UPDATE board_items SET handoff_generation=?,handoff_heartbeat_at=?,handoff_lease_until=? WHERE item_id=?",
            nextGeneration(this.loadGeneration(itemId)), now, now + this.leaseMs, itemId,
          );
        }
        return;
      }
      if (handoff === null || handoff.state !== "requested" || handoff.request_id !== request)
        throw new BoardError("HANDOFF_CONFLICT", "This request is not open: it was taken, taken back, or the id is another one");
      this.refuseWhilePaused();
      if (this.projectIsLocal(target.project) && !isLocalTarget(actor))
        throw new BoardError("FORBIDDEN", `Project ${target.project} is 手元だけ: only the owner's PC (local-*) takes its work, not ${actor}`);
      // A request with a destination is only for that writer, so another one cannot pick it up by mistake.
      const to = handoff.to as string | null;
      if (restricted && to !== actor)
        throw new BoardError("NOT_FOUND", "No such request");
      if (to !== null && (UNTAKEN_TARGETS.has(to) || to !== actor))
        throw new BoardError("FORBIDDEN", UNTAKEN_TARGETS.has(to)
          ? `This request is on ${to}: nobody takes it until the owner routes it to someone`
          : `This request is for ${to}, not for ${actor}`);
      // A project registered status-only runs only as its registered taker,
      // taken explicitly: anybody else would report freely, and a request
      // without that destination waits to be routed rather than change hands.
      const registered = this.statusOnlyFor(target.project);
      if (registered !== null && (!registered.has(actor) || to !== actor))
        throw new BoardError("FORBIDDEN", `Project ${target.project} reports status only: only its registered taker may run it, taken as its named destination`);
      // COALESCE: a request made before generations existed has none yet;
      // the accept is where its run begins, so it gets the first one here.
      this.sql.exec(
        "UPDATE board_items SET handoff_state='accepted',handoff_actor=?,handoff_accepted_at=?,handoff_heartbeat_at=?,handoff_lease_until=?,handoff_generation=COALESCE(handoff_generation,?),handoff_versions=? WHERE item_id=?",
        actor, now, now, now + this.leaseMs, nextGeneration(this.loadGeneration(itemId)),
        versions === null ? null : Object.entries(versions).map(([k, v]) => `${k}=${v}`).join(","), itemId,
      );
      const withVersions = versions === null ? "" : ` (versions: ${Object.entries(versions).map(([k, v]) => `${k} ${v}`).join(", ")})`;
      this.insertEvent(itemId, now, actor, "note", `accepted ${request}${withVersions}`, null, "accepted");
    });
    if (again) {
      const item = this.loadItem(itemId);
      return { ok: true, changed: false, item: restricted && item ? withoutParent(item) : item, handoff: this.loadHandoff(itemId) };
    }
    // The request is this writer's now; the state follows as an internal
    // write (the accept itself is the fenced operation; see upsertItem).
    const item = this.loadItem(itemId);
    const written = item !== null && item.state === "planned" ? this.upsertItem(actor, { item_id: itemId, state: "in_progress" }, true) : { item };
    return { ok: true, changed: true, item: restricted && written.item ? withoutParent(written.item) : written.item, handoff: this.loadHandoff(itemId) };
  }

  /** The fencing fields every run-scoped tool sends, checked by resume.ts. */
  private fenced(obj: Record<string, unknown>): { itemId: string; request: string; generation: number } {
    const itemId = requiredStr(obj, "item_id");
    const request = requiredStr(obj, "request_id");
    if (!has(obj, "generation") || !nonNegativeInteger(obj.generation) || (obj.generation as number) < 1)
      throw invalid("generation must be the positive integer the accept returned (handoff.generation)");
    return { itemId, request, generation: obj.generation as number };
  }
  private checkRun(itemId: string, actor: string, request: string, generation: number, requireLiveLease = false): HandoffView {
    const item = this.loadItem(itemId);
    const handoff = this.loadHandoff(itemId);
    const view = this.handoffView(itemId) ?? { state: null, request_id: null, accepted_by: null, generation: null, lease_until: null };
    if (requireLiveLease && (item === null || handoff === null || view.request_id !== request || view.accepted_by !== actor || handoff.to !== actor))
      throw new BoardError("NOT_FOUND", "No such active request");
    if (item === null) throw new BoardError("NOT_FOUND", "No such item");
    const verdict = checkFence(view, actor, request, generation);
    if (!verdict.ok) throw new BoardError(verdict.code, verdict.detail);
    if (requireLiveLease && (view.lease_until === null || view.lease_until <= Date.now()))
      throw new BoardError("STALE_GENERATION", "This run's lease expired; stop and wait for the owner to recover it");
    return view;
  }

  /**
   * The `board_heartbeat_handoff` tool: the run that took a request says it
   * is still working, and its lease is extended. No event is written (a
   * heartbeat every few minutes would fill the board); the times are on the
   * handoff itself. A stale generation is refused, so a replaced run learns
   * here, at the latest, that it must stop writing.
   */
  heartbeatHandoff(actor: string, input: unknown, restricted = false): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["item_id", "request_id", "generation"]);
    const { itemId, request, generation } = this.fenced(obj);
    const now = Date.now();
    return this.tx(() => {
      this.checkRun(itemId, actor, request, generation, restricted);
      this.sql.exec("UPDATE board_items SET handoff_heartbeat_at=?,handoff_lease_until=? WHERE item_id=?", now, now + this.leaseMs, itemId);
      return { ok: true, changed: true, handoff: this.loadHandoff(itemId), ...this.stopSignal() };
    });
  }

  /**
   * The `board_progress_handoff` tool: an event written as the current run.
   * Same fields as board_add_event, plus the fence. This is the write a cloud
   * worker uses for progress and results, so a late write from an old run is
   * refused instead of landing on work somebody else has taken over.
   */
  progressHandoff(actor: string, input: unknown, restricted = false): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["item_id", "request_id", "generation", "kind", "text", "ref"]);
    const { itemId, request, generation } = this.fenced(obj);
    const kind = requiredStr(obj, "kind");
    const text = requiredStr(obj, "text");
    const reference = optionalStr(obj, "ref");
    if (!(WRITER_EVENT_KINDS as readonly string[]).includes(kind))
      throw invalid("kind must be session_start, session_end or note (state_change is recorded by the board)");
    if (!validLine(text, 2000, true)) throw invalid("text must be 1 to 2000 characters");
    if (reference !== null && !validHttpsUrl(reference)) throw invalid("ref must be an https URL of 500 characters at most");
    return this.tx(() => {
      this.checkRun(itemId, actor, request, generation, restricted);
      if (this.statusOnlyFor(this.loadItem(itemId)?.project ?? null)?.has(actor)
        && (kind !== "note" || reference !== null || !(STATUS_ONLY_PROGRESS as readonly string[]).includes(text)))
        throw new BoardError("FORBIDDEN", "This work reports status only: a note of 状態：着手, 状態：作業中 or 状態：要確認, without a link");
      const at = Date.now();
      const seq = this.insertEvent(itemId, at, actor, kind, text, reference);
      const phase = kind === "note" && reference === null ? PHASE_NOTE.exec(text)?.[1] : null;
      if (phase) this.sql.exec("UPDATE board_items SET handoff_phase=?,handoff_phase_at=? WHERE item_id=? AND handoff_phase IS NOT ?", phase, at, itemId, phase);
      this.sql.exec("UPDATE board_items SET handoff_heartbeat_at=?,handoff_lease_until=? WHERE item_id=?", at, at + this.leaseMs, itemId);
      return { ok: true, event: { seq, item_id: itemId, at, actor, kind, text, ref: reference }, handoff: this.loadHandoff(itemId), ...this.stopSignal() };
    });
  }

  /**
   * The `board_complete_handoff` tool: the current run finishes the work.
   * The handoff stays on the item as `completed` (who ran it, which
   * generation, when) for the record; the work itself is done (or stopped,
   * when the run reports it could not finish). After completion the item can
   * be handed over again only as new work on the pile — it is no longer
   * planned, so in practice a person re-piles it first.
   */
  completeHandoff(actor: string, input: unknown, restricted = false): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["item_id", "request_id", "generation", "outcome", "text", "ref", "commit"]);
    const { itemId, request, generation } = this.fenced(obj);
    const outcome = requiredStr(obj, "outcome");
    if (outcome !== "done" && outcome !== "stopped") throw invalid("outcome must be done or stopped");
    const text = optionalStr(obj, "text");
    if (text !== null && !validLine(text, 2000, true)) throw invalid("text must be 1 to 2000 characters");
    // The result's link (a PR, a commit page) and commit: the card's 結果 (#46 段 2).
    const ref = optionalStr(obj, "ref");
    if (ref !== null && !validHttpsUrl(ref)) throw invalid("ref must be an https URL of 500 characters at most");
    const commit = optionalStr(obj, "commit");
    if (commit !== null && !COMMIT.test(commit)) throw invalid("commit must be 7 to 40 lowercase hex characters");
    const now = Date.now();
    this.tx(() => {
      this.checkRun(itemId, actor, request, generation, restricted);
      if (this.statusOnlyFor(this.loadItem(itemId)?.project ?? null)?.has(actor)
        && (ref !== null || commit !== null || (text !== null && !(STATUS_ONLY_COMPLETION as readonly string[]).includes(text))))
        throw new BoardError("FORBIDDEN", "This work reports status only: 状態：完了 or 状態：要確認, without a link or a commit");
      this.sql.exec(
        "UPDATE board_items SET handoff_state='completed',handoff_lease_until=NULL,handoff_result_ref=?,handoff_result_commit=? WHERE item_id=?",
        ref, commit, itemId,
      );
      const base = text ?? `completed ${request} (${outcome})`;
      this.insertEvent(itemId, now, actor, "note", commit !== null && !base.includes(commit) ? truncateLine(`${base} (commit ${commit})`) : base, ref);
    });
    const item = this.loadItem(itemId);
    const written = item !== null && item.state !== outcome ? this.upsertItem(actor, { item_id: itemId, state: outcome }) : { item };
    return { ok: true, changed: true, item: restricted && written.item ? withoutParent(written.item) : written.item, handoff: this.loadHandoff(itemId) };
  }

  /** Marks an accepted run `unknown`. Shared by the tool and the page. */
  private markUnknown(actor: string, itemId: string, request: string, now: number): void {
    if (this.loadItem(itemId) === null) throw new BoardError("NOT_FOUND", "No such item");
    const view = this.handoffView(itemId) ?? { state: null, request_id: null, accepted_by: null, generation: null, lease_until: null };
    if (view.request_id !== request)
      throw new BoardError("HANDOFF_CONFLICT", "This request is not the current one");
    const verdict = canMarkUnknown(view, now);
    if (!verdict.ok) throw new BoardError(verdict.code, verdict.detail);
    this.sql.exec("UPDATE board_items SET handoff_state='unknown' WHERE item_id=?", itemId);
    this.insertEvent(itemId, now, actor, "note", `marked unknown ${request}: the run's lease expired and its outcome is unconfirmed; nothing restarts it automatically`, null);
  }

  /**
   * The `board_mark_handoff_unknown` tool: a writer (for the owner) records
   * that an accepted run's outcome is unknown — its lease expired and it has
   * not reported. Nothing is restarted or re-queued by this; the work waits
   * in `unknown` until a person releases it (stopped confirmed) or resumes
   * the same run (still working confirmed).
   */
  markUnknownForTool(actor: string, input: unknown): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["item_id", "request_id"]);
    const itemId = requiredStr(obj, "item_id");
    const request = requiredStr(obj, "request_id");
    return this.tx(() => {
      this.markUnknown(actor, itemId, request, Date.now());
      return { ok: true, changed: true, item: this.loadItem(itemId), handoff: this.loadHandoff(itemId) };
    });
  }

  /** Releases `unknown` work back to the pile. Shared by the tool and the page. */
  private releaseUnknown(actor: string, itemId: string, request: string, now: number): void {
    if (this.loadItem(itemId) === null) throw new BoardError("NOT_FOUND", "No such item");
    const view = this.handoffView(itemId) ?? { state: null, request_id: null, accepted_by: null, generation: null, lease_until: null };
    if (view.request_id !== request)
      throw new BoardError("HANDOFF_CONFLICT", "This request is not the current one");
    const verdict = canReleaseUnknown(view);
    if (!verdict.ok) throw new BoardError(verdict.code, verdict.detail);
    this.clearHandoff(itemId);
    this.insertEvent(itemId, now, actor, "note", `released ${request}: the old run was confirmed stopped, so the work is back on the pile`, null);
  }

  /** Resumes an `unknown` run as the same run. Shared by the tool and the page. */
  private resumeUnknown(actor: string, itemId: string, request: string, now: number, byOwner: boolean): void {
    if (this.loadItem(itemId) === null) throw new BoardError("NOT_FOUND", "No such item");
    const view = this.handoffView(itemId) ?? { state: null, request_id: null, accepted_by: null, generation: null, lease_until: null };
    if (view.request_id !== request)
      throw new BoardError("HANDOFF_CONFLICT", "This request is not the current one");
    const verdict = canResumeUnknown(view);
    if (!verdict.ok) throw new BoardError(verdict.code, verdict.detail);
    if (!byOwner && view.accepted_by !== actor)
      throw new BoardError("FORBIDDEN", `This run was taken by ${view.accepted_by ?? "another writer"}: only that writer, or the owner from the page, can resume it`);
    // A run taken before generations existed has none: resuming is where it
    // rejoins the fenced world, so it gets the next generation here and the
    // caller learns it from the answer. Its plain writes were the only ones
    // it could make until now; from here on it is fenced like any run.
    this.sql.exec(
      "UPDATE board_items SET handoff_state='accepted',handoff_heartbeat_at=?,handoff_lease_until=?,handoff_generation=COALESCE(handoff_generation,?) WHERE item_id=?",
      now, now + this.leaseMs, nextGeneration(this.loadGeneration(itemId)), itemId,
    );
    this.insertEvent(itemId, now, actor, "note", `resumed ${request}: the same run was confirmed still working`, null);
  }

  /**
   * The `board_release_handoff` tool, two safe ways back to the pile:
   *   - the run itself gives the work back (state accepted, fenced by its
   *     request and generation): it is the one actor that knows it stopped;
   *   - work in `unknown`, with `stopped_confirmed: true`: the caller states
   *     a person confirmed the old run has stopped and its outcome was
   *     checked. Without that confirmation the release is refused — an
   *     unconfirmed run is never re-queued by a bare call.
   */
  releaseHandoff(actor: string, input: unknown): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["item_id", "request_id", "generation", "stopped_confirmed"]);
    const itemId = requiredStr(obj, "item_id");
    const request = requiredStr(obj, "request_id");
    const now = Date.now();
    let backToPile = false;
    this.tx(() => {
      const view = this.handoffView(itemId);
      if (view === null) {
        if (this.loadItem(itemId) === null) throw new BoardError("NOT_FOUND", "No such item");
        throw new BoardError("HANDOFF_CONFLICT", "This work is not handed over");
      }
      if (view.state === "accepted") {
        const { generation } = this.fenced(obj);
        const verdict = checkFence(view, actor, request, generation);
        if (!verdict.ok) throw new BoardError(verdict.code, verdict.detail);
        this.clearHandoff(itemId);
        this.insertEvent(itemId, now, actor, "note", `released ${request} by the run itself: the work is back on the pile`, null);
        backToPile = true;
      } else if (view.state === "unknown") {
        if (obj.stopped_confirmed !== true)
          throw invalid("stopped_confirmed: true is required: a person must confirm the old run has stopped and its outcome was checked");
        this.releaseUnknown(actor, itemId, request, now);
        backToPile = true;
      } else {
        throw new BoardError("HANDOFF_CONFLICT", "Only a run in progress, or work marked unknown, can be released");
      }
    });
    if (backToPile) {
      const item = this.loadItem(itemId);
      if (item !== null && item.state === "in_progress") this.upsertItem(actor, { item_id: itemId, state: "planned" });
    }
    return { ok: true, changed: true, item: this.loadItem(itemId), handoff: this.loadHandoff(itemId) };
  }

  /** The `board_resume_handoff` tool: the run that went unknown is confirmed
   * still working (by itself, reappearing) and continues as the same run. */
  resumeHandoff(actor: string, input: unknown): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["item_id", "request_id"]);
    const itemId = requiredStr(obj, "item_id");
    const request = requiredStr(obj, "request_id");
    return this.tx(() => {
      this.resumeUnknown(actor, itemId, request, Date.now(), false);
      return { ok: true, changed: true, item: this.loadItem(itemId), handoff: this.loadHandoff(itemId) };
    });
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
    const prior = this.loadHandoff(item.item_id);
    if (prior !== null && prior.state !== "completed") throw new BoardError("HANDOFF_CONFLICT", "This work is handed over already");
    this.checkScope(item.project, to);
    const request = newId(day, "REQ-");
    const now = Date.now();
    this.sql.exec(
      "UPDATE board_items SET handoff_state='requested',handoff_request=?,handoff_at=?,handoff_actor=NULL,handoff_accepted_at=NULL,handoff_to=?,handoff_by=?,handoff_to_by=?,handoff_title=?,handoff_generation=?,handoff_heartbeat_at=NULL,handoff_lease_until=NULL,handoff_versions=NULL,handoff_result_ref=NULL,handoff_result_commit=NULL,handoff_phase=NULL,handoff_phase_at=NULL WHERE item_id=?",
      request, now, to, actor, to === null ? null : actor, item.title, nextGeneration(this.loadGeneration(item.item_id)), item.item_id,
    );
    this.insertEvent(item.item_id, now, actor, "note", handedText(request, to), null, "requested");
  }

  /** Withdraws a request that nobody has taken yet, so the work is back on the pile. Runs inside a transaction. */
  private withdraw(actor: string, itemId: string, handoff: Record<string, unknown> | null, now: number): void {
    if (handoff === null || handoff.state !== "requested")
      throw new BoardError("HANDOFF_CONFLICT", "Only a request that nobody has taken yet can be taken back");
    this.clearHandoff(itemId);
    this.insertEvent(itemId, now, actor, "note", `taken back ${String(handoff.request_id)}`, null);
  }

  /** Changes the destination of an open request; false when it already had that one. Runs inside a transaction. */
  private reroute(actor: string, itemId: string, handoff: Record<string, unknown> | null, to: string | null, now: number): boolean {
    if (handoff === null || handoff.state !== "requested")
      throw new BoardError("HANDOFF_CONFLICT", "Only a request that nobody has taken yet can be routed");
    if (handoff.to === to) return false;
    const item = this.loadItem(itemId);
    if (item !== null) this.checkScope(item.project, to);
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

  /**
   * The `board_request_status` tool: where one request really is, read off the
   * item's handoff, the dispatcher's newest row and the item's linked events
   * (lifecycle.ts). Read-only: it writes nothing and starts nothing, so asking
   * for progress can never run the work twice.
   */
  requestStatus(input: unknown): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["item_id"]);
    const itemId = requiredStr(obj, "item_id");
    const item = this.loadItem(itemId);
    if (item === null) throw new BoardError("NOT_FOUND", "No such item");
    const handoff = this.loadHandoff(itemId) as LifecycleInput["handoff"];
    let dispatch: LifecycleInput["dispatch"] = null;
    if (handoff !== null && handoff.request_id !== null) {
      const rows = this.sql.exec(
        "SELECT at,status,session_id FROM dispatch_log WHERE request_id=? ORDER BY seq DESC", handoff.request_id,
      ).toArray() as Row[];
      if (rows.length)
        dispatch = {
          status: rows[0].status === null ? "started" : str(rows[0].status), at: num(rows[0].at),
          session_id: strOrNull(rows[0].session_id ?? null), attempts: rows.length,
        };
    }
    const refs = (this.sql.exec(
      "SELECT at,actor,ref FROM board_events WHERE item_id=? AND ref IS NOT NULL ORDER BY seq DESC LIMIT 10", itemId,
    ).toArray() as Row[]).map((r) => ({ at: num(r.at), actor: str(r.actor), ref: str(r.ref) }));
    const lifecycle = deriveLifecycle(
      { item: { item_id: item.item_id, state: item.state, updated_at: item.updated_at, updated_by: item.updated_by }, handoff, dispatch, refs },
      Date.now(),
    );
    return { ok: true, item_id: itemId, request_id: handoff?.request_id ?? null, lifecycle };
  }

  /**
   * The `board_my_work` tool (#46 段 2, the read the patrols need before more
   * of them are added, Q10): only what concerns the calling writer — work
   * handed to it that waits to be taken, its own runs (accepted or unknown),
   * and how many conversation turns wait for it — plus whether the owner
   * stopped everything. Uses the handoff_state index instead of reading
   * every item and its latest event as board_list does.
   */
  myWork(actor: string, input: unknown, restricted = false): Record<string, unknown> {
    const obj = asObject(input);
    onlyKeys(obj, ["project"]);
    const project = optionalStr(obj, "project");
    const pause = this.pauseState();
    const rows = this.sql.exec(
      `SELECT ${ITEM_COLUMNS.join(",")},${HANDOFF_COLUMNS.join(",")} FROM board_items
       WHERE handoff_state IN ('requested','accepted','unknown')
         AND ((handoff_state='requested' AND handoff_to=?) OR (handoff_state<>'requested' AND handoff_actor=?))
         AND (? IS NULL OR handoff_to=?)
         AND (? IS NULL OR project=?)
       ORDER BY handoff_at, item_id LIMIT 200`,
      actor, actor, restricted ? actor : null, actor, project, project,
    ).toArray() as Row[];
    const items = rows.map((r) => {
      const item = rowItem(r);
      return { ...(restricted ? withoutParent(item) : item), handoff: this.handoffOf(r) };
    });
    const turns = isChatTarget(actor) && !pause.paused
      ? num((this.sql.exec(
        "SELECT COUNT(*) AS n FROM chat_messages WHERE role='owner' AND status='waiting' AND to_target=?", actor,
      ).one() as Row).n)
      : 0;
    if (restricted) return { ok: true, paused: pause.paused, items };
    return { ok: true, paused: pause.paused, items, chat_turns: turns, scopes: this.projectScopes() };
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
  pageData(devinReady = false, since: string | null = null): Record<string, unknown> {
    const now = Date.now();
    const { epoch, version } = this.sql.exec("SELECT epoch,version FROM page_revision WHERE id=1").one();
    const revision = `${epoch}.${version}`;
    const route = this.routeOrder();
    const live = { revision, history_epoch: epoch, generated_at: now, can_write: true,
      route: this.routeView(route, devinReady, now), paused: this.pauseState(), scopes: route.scopes };
    if (since === revision) return { ok: true, unchanged: true, ...live };
    const data = this.list(null, 0, PAGE_EVENT_LIMIT, true);
    // A run reports its result as a note and then closes the item, so the
    // item's last event is the state change and the result is just before
    // it. For such items the page also gets the newest event that is not a
    // state change (last_note), to show the result on the card. Writers'
    // board_list is unchanged.
    const pageItems = data.items as (Record<string, unknown> & { item_id: string; last_event: { kind: string } | null })[];
    const needingPreviousEvent = pageItems.filter(item => item.last_event?.kind === "state_change").map(item => item.item_id);
    const notes = new Map<string, Record<string, unknown>>();
    // Look backwards through the (item_id, seq) index only for cards that
    // display a previous event. One bound array also works on large boards.
    for (const r of this.sql.exec(
      `SELECT e.seq,e.item_id,e.at,e.actor,e.kind,e.text,e.ref
       FROM json_each(?) AS wanted
       JOIN board_events e ON e.seq=(
         SELECT seq FROM board_events WHERE item_id=wanted.value AND kind<>'state_change'
         ORDER BY seq DESC LIMIT 1
       )`, JSON.stringify(needingPreviousEvent),
    ).toArray() as Row[]) {
      notes.set(str(r.item_id), { seq: num(r.seq), at: num(r.at), actor: str(r.actor), kind: str(r.kind), text: str(r.text), ref: strOrNull(r.ref) });
    }
    const chats = this.chatSummary();
    const items = pageItems.map((item) => {
      const note = notes.get(item.item_id);
      const withNote = note ? { ...item, last_note: note } : item;
      const chat = chats.get(item.item_id);
      return chat ? { ...withNote, chat } : withNote;
    });
    return { ...data, items, ...live };
  }

  /** A bounded slice of the append-only history up to the page's observed
   * head. Never send free-form note text, actors or refs into the timeline. */
  activity(after: number, through: number): Record<string, unknown> {
    const { epoch } = this.sql.exec("SELECT epoch FROM page_revision WHERE id=1").one();
    const rows = this.sql.exec(
      `SELECT seq,item_id,at,kind,milestone,
        CASE WHEN kind='state_change' THEN substr(text,1,48) END AS transition
       FROM board_events WHERE seq>? AND seq<=? ORDER BY seq LIMIT 500`, after, through,
    ).toArray() as Row[];
    const events = rows.map(r => {
      const change = /^(planned|in_progress|waiting|done|stopped) -> (planned|in_progress|waiting|done|stopped)(?: |$)/.exec(String(r.transition));
      return { seq: r.seq, item_id: r.item_id, at: r.at, kind: r.milestone ?? r.kind,
        ...(change ? { from: change[1], to: change[2] } : {}) };
    });
    return { ok: true, history_epoch: epoch, events };
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
   *   {op:"mark_unknown"|"release"|"resume", item_id, request_id}   the
   *     owner's recovery for a run whose outcome is unknown (see above).
   *   {op:"hand", item_id, day?, to?}   ask for a piece of work on the pile to
   *     be done: it gets a request id and waits for one writer to take it
   *     (`acceptHandoff`); `to` is its destination (HANDOFF_TARGETS, absent or
   *     null = the board chooses). {op:"route", item_id, to} changes the
   *     destination of a request that nobody has taken yet (a request on
   *     `hold` gets one this way). {op:"take_back", item_id} withdraws a
   *     request that nobody has taken yet.
   *   {op:"order", order:[...]}   the order "おまかせ" goes down: distinct
   *     destinations from route.ts ORDERABLE, first first. Left out = not used.
   *   {op:"continue", item_id, day?, to?}   hand over the continuation of a
   *     session that stopped (item_id is its `session/<number>` item): a new
   *     piece of work "<item_id> の続き" under it, handed over at once. One
   *     open continuation per session.
   * Titles, states and plans stay with the writers that own them.
   */
  ownerWrite(actor: string, input: unknown, newId: (day: string | null, prefix?: string) => string): Record<string, unknown> {
    const obj = asObject(input);
    const op = requiredStr(obj, "op");
    // The owner's recovery path from the page, for a run whose outcome is
    // unknown: {op:"mark_unknown", item_id, request_id} quarantines an
    // accepted run whose lease expired; then {op:"release", item_id,
    // request_id} (the owner confirming the old run has stopped) puts the
    // work back on the pile, or {op:"resume", item_id, request_id} (the
    // owner confirming it is still working) resumes the same run. Release
    // also returns the item to planned, as the writer-side release does.
    if (op === "mark_unknown" || op === "release" || op === "resume") {
      onlyKeys(obj, ["op", "item_id", "request_id"]);
      const itemId = requiredStr(obj, "item_id");
      const request = requiredStr(obj, "request_id");
      const now = Date.now();
      let backToPile = false;
      const result = this.tx(() => {
        const item = this.loadItem(itemId);
        if (item === null) throw new BoardError("NOT_FOUND", "No such item");
        if (op === "mark_unknown") this.markUnknown(actor, itemId, request, now);
        else if (op === "resume") this.resumeUnknown(actor, itemId, request, now, true);
        else { this.releaseUnknown(actor, itemId, request, now); backToPile = true; }
        return { ok: true, changed: true, item, handoff: this.loadHandoff(itemId) };
      });
      if (backToPile) {
        const item = this.loadItem(itemId);
        if (item !== null && item.state === "in_progress") this.upsertItem(actor, { item_id: itemId, state: "planned" });
        result.item = this.loadItem(itemId);
      }
      return result;
    }
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
    if (op === "chat_send") return this.chatSend(actor, obj);
    if (op === "pause") {
      // {op:"pause", paused:true|false}: 全部止める / 再開 (see pauseState).
      onlyKeys(obj, ["op", "paused"]);
      if (typeof obj.paused !== "boolean") throw invalid("paused must be true or false");
      const before = this.pauseState().paused;
      if (before === obj.paused) return { ok: true, changed: false, paused: this.pauseState() };
      this.putSetting("paused", obj.paused, actor);
      return { ok: true, changed: true, paused: this.pauseState() };
    }
    if (op === "scope") {
      // {op:"scope", project, scope:"local"|"any"}: 手元だけ / どこでもよい (see projectScopes).
      // Marking a project 手元だけ sends its open requests that point outside
      // the range back to the board's choice, which then stays within it.
      onlyKeys(obj, ["op", "project", "scope"]);
      const project = requiredStr(obj, "project");
      const scope = requiredStr(obj, "scope");
      if (scope !== "local" && scope !== "any") throw invalid("scope must be local or any");
      return this.tx(() => {
        const known = num((this.sql.exec("SELECT COUNT(*) AS n FROM board_items WHERE project=?", project).one() as Row).n);
        if (known === 0) throw new BoardError("NOT_FOUND", "No such project");
        const scopes: Record<string, string> = { ...this.projectScopes() };
        if ((scopes[project] === "local") === (scope === "local")) return { ok: true, changed: false, scopes };
        if (scope === "local") scopes[project] = "local";
        else delete scopes[project];
        this.putSetting("project_scopes", scopes, actor);
        let rerouted = 0;
        if (scope === "local") {
          const now = Date.now();
          for (const r of this.sql.exec(
            "SELECT item_id,handoff_request,handoff_to FROM board_items WHERE project=? AND handoff_state='requested' AND handoff_to IS NOT NULL", project,
          ).toArray() as Row[]) {
            const to = str(r.handoff_to);
            if (UNTAKEN_TARGETS.has(to) || isLocalTarget(to)) continue;
            this.sql.exec("UPDATE board_items SET handoff_to=NULL,handoff_to_by=NULL WHERE item_id=?", str(r.item_id));
            this.insertEvent(str(r.item_id), now, actor, "note",
              `routed ${String(r.handoff_request)} to the board's choice: project ${project} became 手元だけ, and ${to} is outside it`, null);
            rerouted += 1;
          }
        }
        return { ok: true, changed: true, scopes: this.projectScopes(), rerouted };
      });
    }
    if (op === "order") {
      onlyKeys(obj, ["op", "order"]);
      const order = parseOrder(obj.order);
      if (order === null) throw invalid(`order must list distinct destinations from ${ORDERABLE.join(", ")}`);
      this.sql.exec(
        `INSERT INTO board_settings(key,value,updated_at,updated_by) VALUES('route_order',?,?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
        JSON.stringify(order), Date.now(), actor,
      );
      return { ok: true, changed: true, route: this.routeOrder() };
    }
    if (op === "continue") {
      // {op:"continue", item_id, day?, to?}: a session on the owner's PC
      // stopped; hand its continuation to an AI. The board puts a piece of
      // work titled "<session item> の続き" under the session's item and
      // hands it over at once, exactly as "add" then "hand" would. Takers
      // read the session item from the title (picker/src/takeover.mjs); the
      // session's own item stays the session's (its writer keeps writing it).
      onlyKeys(obj, ["op", "item_id", "day", "to"]);
      const itemId = requiredStr(obj, "item_id");
      const day = optionalStr(obj, "day");
      const to = handoffTarget(obj);
      const session = this.loadItem(itemId);
      if (session === null) throw new BoardError("NOT_FOUND", "No such item");
      if (session.kind !== "task" || !SESSION_ITEM.test(itemId))
        throw new BoardError("FORBIDDEN", "Only the item of a session (session/<number>) can be continued");
      const open = num((this.sql.exec(
        "SELECT COUNT(*) AS n FROM board_items WHERE parent_id=? AND handoff_state IN ('requested','accepted','unknown')", itemId,
      ).one() as Row).n);
      if (open > 0) throw new BoardError("HANDOFF_CONFLICT", "A continuation of this session is handed over already");
      const created = this.upsertItem(actor, {
        item_id: newId(day), project: session.project, kind: "task", title: `${itemId} の続き`, state: "planned",
        parent_id: itemId, expected_revision: 0,
      });
      const workId = (created.item as Item).item_id;
      return this.tx(() => {
        const work = this.loadItem(workId);
        if (work === null) throw new BoardError("NOT_FOUND", "No such item");
        this.handOver(actor, work, day, to, newId);
        return { ok: true, changed: true, item: this.loadItem(workId), handoff: this.loadHandoff(workId) };
      });
    }
    if (op === "add") {
      onlyKeys(obj, ["op", "project", "title", "parent_id", "day"]);
      const project = requiredStr(obj, "project");
      const title = requiredStr(obj, "title");
      const parentId = optionalStr(obj, "parent_id");
      // A project is made by a writer; a typing slip here must not start a new one.
      // The one exception is CHAT_PROJECT, where a chat with no project goes (chat page).
      const known = num((this.sql.exec("SELECT COUNT(*) AS n FROM board_items WHERE project=?", project).one() as Row).n);
      if (known === 0 && project !== CHAT_PROJECT) throw new BoardError("NOT_FOUND", "No such project");
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
    throw invalid("op must be add, attach, move, hand, continue, route, take_back, order, chat_send, pause, scope, mark_unknown, release or resume");
  }

  /** All items of the project (or of every project), each with its latest
   * event, and the events after `sinceSeq`: oldest first, or the newest ones
   * first when `newestFirst` is set. */
  list(project: string | null, sinceSeq: number, eventLimit: number, newestFirst: boolean): Record<string, unknown> {
    const itemCols = ITEM_COLUMNS.map((c) => `i.${c} AS i_${c}`).join(",");
    const handoffCols = HANDOFF_COLUMNS.map((c) => `i.${c} AS i_${c}`).join(",");
    const itemRows = this.sql.exec(
      `SELECT ${itemCols},i.pile_rank AS i_pile_rank,${handoffCols},e.seq AS e_seq,e.at AS e_at,e.actor AS e_actor,e.kind AS e_kind,e.text AS e_text,e.ref AS e_ref
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

  private insertEvent(itemId: string, at: number, actor: string, kind: string, text: string, ref: string | null, milestone: "requested" | "accepted" | null = null): number {
    if (this.count("board_events") >= this.limits.events)
      throw new BoardError("BOARD_EVENT_LIMIT", `The board holds ${this.limits.events} events already; nothing was added`);
    const row = this.sql.exec(
      "INSERT INTO board_events(item_id,at,actor,kind,text,ref,milestone) VALUES(?,?,?,?,?,?,?) RETURNING seq",
      itemId, at, actor, kind, text, ref, milestone,
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
