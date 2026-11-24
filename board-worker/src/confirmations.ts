import { asObject, BoardError, invalid, onlyKeys, requiredStr, validLine } from "./rules";

const DAY = 86_400_000;
const MAX_PER_SOURCE = 256;
const MAX_TOTAL = 4096;
type Row = {
  id: string; source: string; request_id: string; state: string; actor: string;
  project: string; agent: string; task: string; question: string; local_only: number; created_at: number;
};

const conflict = () => new BoardError("CONFIRMATION_CONFLICT", "This confirmation has changed");
const notFound = () => new BoardError("NOT_FOUND", "No such confirmation");
const paused = () => new BoardError("PAUSED", "The board is paused");
const answer = (request_id: string, state: string) => ({ ok: true, request_id, state });

/** A private inbox. Generic board reads, revisions and events never contain its questions. */
export class ConfirmationInbox {
  constructor(private storage: DurableObjectStorage) {}

  init(): void {
    const sql = this.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS confirmations(
      id TEXT PRIMARY KEY, source TEXT NOT NULL, request_id TEXT NOT NULL, actor TEXT NOT NULL,
      project TEXT NOT NULL, agent TEXT NOT NULL, task TEXT NOT NULL, question TEXT NOT NULL, local_only INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','approved','applied','expired','unknown')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(source,request_id))`);
    sql.exec("CREATE INDEX IF NOT EXISTS confirmations_age ON confirmations(state,updated_at)");
  }

  private prune(now: number): void {
    const sql = this.storage.sql;
    // If delivery was interrupted after the owner's decision, its effect may be unknown.
    sql.exec("UPDATE confirmations SET state='expired',updated_at=updated_at+? WHERE state='pending' AND updated_at<=?", DAY, now - DAY);
    sql.exec("UPDATE confirmations SET state='unknown',updated_at=updated_at+? WHERE state='approved' AND updated_at<=?", DAY, now - DAY);
    sql.exec("DELETE FROM confirmations WHERE state IN ('applied','expired','unknown') AND updated_at<=?", now - 7 * DAY);
  }

  forSource(tool: string, source: string, actor: string, args: Record<string, unknown>, isPaused: boolean): Record<string, unknown> {
    const request = requiredStr(args, "request_id");
    if (!/^[a-f0-9]{32}$/.test(request)) throw invalid("Expected a 32 digit lowercase hexadecimal request_id");
    const sql = this.storage.sql;
    const now = Date.now();
    return this.storage.transactionSync(() => {
      this.prune(now);
      const row = sql.exec<Row>("SELECT * FROM confirmations WHERE source=? AND request_id=?", source, request).toArray()[0];
      if (tool === "iris_request_confirmation") {
        onlyKeys(args, ["request_id", "project", "agent", "task", "question", "local_only"]);
        for (const [name, limit] of [["project", 80], ["agent", 80], ["task", 160], ["question", 1000]] as const) {
          if (!validLine(requiredStr(args, name), limit, name === "question")) throw invalid("Invalid " + name);
        }
        if (args.local_only !== undefined && typeof args.local_only !== "boolean") throw invalid("Expected a boolean local_only");
        const localOnly = args.local_only === true ? 1 : 0;
        if (row) {
          if (row.project !== args.project || row.agent !== args.agent || row.task !== args.task ||
              row.question !== args.question || row.local_only !== localOnly) throw conflict();
        } else {
          const used = sql.exec<{n: number}>("SELECT COUNT(*) AS n FROM confirmations WHERE source=?", source).one().n;
          const total = sql.exec<{n: number}>("SELECT COUNT(*) AS n FROM confirmations").one().n;
          if (used >= MAX_PER_SOURCE || total >= MAX_TOTAL) throw new BoardError("CONFIRMATION_LIMIT", "The inbox is full");
          sql.exec(`INSERT INTO confirmations(id,source,request_id,actor,project,agent,task,question,local_only,state,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`, crypto.randomUUID(), source, request, actor,
            args.project as string, args.agent as string, args.task as string, args.question as string, localOnly, now, now);
          return answer(request, "pending");
        }
      }
      if (!row) throw notFound();
      if (tool === "iris_close_confirmation") {
        onlyKeys(args, ["request_id", "outcome"]);
        const outcome = requiredStr(args, "outcome");
        if (!["applied", "expired", "unknown"].includes(outcome)) throw invalid("Invalid outcome");
        if (row.state !== outcome) {
          if ((row.state !== "pending" && row.state !== "approved") || (outcome === "applied" && row.state !== "approved")) throw conflict();
          sql.exec("UPDATE confirmations SET state=?,updated_at=? WHERE id=?", outcome, now, row.id);
        }
        return answer(request, outcome);
      }
      if (tool === "iris_confirmation_status") onlyKeys(args, ["request_id"]);
      if (isPaused && row.state === "approved") throw paused();
      return answer(request, row.state);
    });
  }

  list(): Record<string, unknown> {
    return this.storage.transactionSync(() => {
      const now = Date.now();
      this.prune(now);
      const rows = this.storage.sql.exec<Row>(`SELECT id,actor,project,agent,task,question,state,local_only,created_at
        FROM confirmations WHERE state IN ('pending','approved') OR (state='unknown' AND updated_at>?)
        ORDER BY created_at,id`, now - DAY).toArray();
      return { ok: true, items: rows.map(({ actor, created_at, local_only, ...fields }) =>
        ({ ...fields, source: actor, local_only: Boolean(local_only), created_at: new Date(created_at).toISOString() })) };
    });
  }

  approve(input: unknown, isPaused: boolean): Record<string, unknown> {
    const args = asObject(input);
    onlyKeys(args, ["op", "id"]);
    const id = requiredStr(args, "id");
    if (args.op !== "approve" || !/^[a-f0-9-]{36}$/.test(id)) throw invalid("Invalid approval");
    if (isPaused) throw paused();
    return this.storage.transactionSync(() => {
      const now = Date.now();
      this.prune(now);
      const row = this.storage.sql.exec<Row>("SELECT local_only,state FROM confirmations WHERE id=?", id).toArray()[0];
      if (!row) throw notFound();
      if (row.local_only) throw new BoardError("FORBIDDEN", "Answer this question at its source");
      if (row.state !== "pending" && row.state !== "approved") throw conflict();
      if (row.state === "pending")
        this.storage.sql.exec("UPDATE confirmations SET state='approved',updated_at=? WHERE id=?", now, id);
      return { ok: true, id, state: "approved" };
    });
  }
}
