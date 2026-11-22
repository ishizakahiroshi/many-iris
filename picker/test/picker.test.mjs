// Unit tests for the picker against a fake board that reproduces the
// real board's handoff rules (accept conflict, generation fencing,
// idempotent re-accept). The end-to-end behaviour against the real
// board Worker is covered by picker-e2e.test.mjs.
//
//   node test/picker.test.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardRefusal, BoardUnreachable } from "../src/board-client.mjs";
import { RecordExecutor } from "../src/executors.mjs";
import { acquireLock, configFromEnv } from "../src/main.mjs";
import { chatAnswer, eligible, fetchAttachments, privateTurnDir, runChatPass, runPass } from "../src/picker.mjs";

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
}

const baseConfig = {
  writer: "muse",
  projects: [],
  ownerOnly: true,
  heartbeatMs: 10,
  maxRunsPerDay: 6,
};

function item(overrides = {}, handoffOverrides = {}) {
  return {
    item_id: "task1",
    project: "demo",
    kind: "task",
    title: "Current title",
    state: "planned",
    handoff: {
      state: "requested",
      request_id: "REQ-1",
      to: "muse",
      requested_by: "page:owner",
      to_set_by: "page:owner",
      title: "Handed-over title",
      generation: null,
      lease_until: null,
      ...handoffOverrides,
    },
    ...overrides,
  };
}

/** A fake board with the real one's fence semantics for the tools the picker uses. */
class FakeBoard {
  constructor(items, actor = "muse") {
    this.items = items;
    this.actor = actor;
    this.calls = [];
    this.drop = new Map(); // tool -> number of BoardUnreachable to throw
    this.onHeartbeat = null; // hook after a successful heartbeat
    this.heartbeats = 0;
  }

  async listItems() {
    this.calls.push({ tool: "board_list" });
    return structuredClone(this.items);
  }

  fenceOf(args) {
    const it = this.items.find((i) => i.item_id === args.item_id);
    if (!it || !it.handoff) throw new BoardRefusal("NOT_FOUND", "No such item");
    const h = it.handoff;
    if (h.state !== "accepted" || h.request_id !== args.request_id) throw new BoardRefusal("HANDOFF_CONFLICT", "not the current run");
    if (h.accepted_by !== this.actor) throw new BoardRefusal("FORBIDDEN", "another writer took it");
    if (h.generation !== args.generation) throw new BoardRefusal("STALE_GENERATION", "a newer run replaced this one");
    return it;
  }

  async call(tool, args) {
    this.calls.push({ tool, args: structuredClone(args) });
    if ((this.drop.get(tool) ?? 0) > 0) {
      this.drop.set(tool, this.drop.get(tool) - 1);
      throw new BoardUnreachable(`fake drop of ${tool}`);
    }
    const it = this.items.find((i) => i.item_id === args.item_id);
    switch (tool) {
      case "board_accept_handoff": {
        if (!it || !it.handoff) throw new BoardRefusal("NOT_FOUND", "No such item");
        const h = it.handoff;
        if (h.state === "accepted" && h.request_id === args.request_id && h.accepted_by === this.actor) {
          return { ok: true, changed: false, handoff: structuredClone(h) };
        }
        if (h.state !== "requested" || h.request_id !== args.request_id) throw new BoardRefusal("HANDOFF_CONFLICT", "not open");
        if (h.to !== null && h.to !== this.actor) throw new BoardRefusal("FORBIDDEN", "for another writer");
        h.state = "accepted";
        h.accepted_by = this.actor;
        h.generation = (h.generation ?? 0) + 1;
        return { ok: true, changed: true, handoff: structuredClone(h) };
      }
      case "board_heartbeat_handoff": {
        this.fenceOf(args);
        this.heartbeats += 1;
        if (this.onHeartbeat) this.onHeartbeat(this.heartbeats);
        return { ok: true };
      }
      case "board_progress_handoff": {
        this.fenceOf(args);
        return { ok: true };
      }
      case "board_complete_handoff": {
        const target = this.fenceOf(args);
        target.handoff.state = "completed";
        target.state = args.outcome === "done" ? "done" : "stopped";
        return { ok: true };
      }
      default:
        throw new Error(`fake board does not know ${tool}`);
    }
  }

  callsOf(tool) {
    return this.calls.filter((c) => c.tool === tool);
  }
}

const state = (runs = 0) => ({ runs, runsToday() { return this.runs; }, recordRun() { this.runs += 1; } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- eligibility ---------------------------------------------------
{
  const cfg = baseConfig;
  check("owner-handed work for this writer is eligible",
    eligible(item(), cfg)?.requestId === "REQ-1");
  check("work for another writer is not eligible",
    eligible(item({}, { to: "devin" }), cfg) === null);
  check("unrouted work is not eligible",
    eligible(item({}, { to: null }), cfg) === null);
  check("writer-handed work is refused while the owner gate is on",
    eligible(item({}, { requested_by: "alpha" }), cfg) === null);
  check("work routed by a writer is refused while the owner gate is on",
    eligible(item({}, { to_set_by: "dispatcher" }), cfg) === null);
  check("writer-handed work is eligible when the operator opens the gate",
    eligible(item({}, { requested_by: "alpha", to_set_by: "alpha" }), { ...cfg, ownerOnly: false }) !== null);
  const trustedCfg = { ...cfg, trustedRequesters: ["local-claude"] };
  check("work handed over and routed by a trusted writer is eligible",
    eligible(item({}, { requested_by: "local-claude", to_set_by: "local-claude" }), trustedCfg) !== null);
  check("owner-handed work stays eligible when trusted writers are named",
    eligible(item(), trustedCfg) !== null);
  check("a trusted writer's request routed by the dispatcher is refused",
    eligible(item({}, { requested_by: "local-claude", to_set_by: "dispatcher" }), trustedCfg) === null);
  check("an untrusted writer's request is refused when trusted writers are named",
    eligible(item({}, { requested_by: "alpha", to_set_by: "alpha" }), trustedCfg) === null);
  check("an untrusted writer cannot route a trusted writer's request here",
    eligible(item({}, { requested_by: "local-claude", to_set_by: "alpha" }), trustedCfg) === null);
  check("a non-task is not eligible", eligible(item({ kind: "note" }), cfg) === null);
  check("an already-taken request is not eligible",
    eligible(item({}, { state: "accepted" }), cfg) === null);
  check("a request without its handed-over title is not eligible",
    eligible(item({}, { title: null }), cfg) === null);
  check("an item without a handoff is not eligible",
    eligible({ item_id: "x", kind: "task", handoff: null }, cfg) === null);
}

// --- one full round -------------------------------------------------
{
  const board = new FakeBoard([item()]);
  const executor = new RecordExecutor();
  const outcome = await runPass({ client: board, config: baseConfig, executor, state: state() });
  check("a full round runs and finishes", outcome.kind === "ran" && outcome.finished === true, JSON.stringify(outcome));
  check("the executor got the handed-over title, not the current one",
    executor.jobs.length === 1 && executor.jobs[0].title === "Handed-over title");
  const complete = board.callsOf("board_complete_handoff")[0];
  check("completion carries the fence the accept returned",
    complete?.args.request_id === "REQ-1" && complete?.args.generation === 1 && complete?.args.outcome === "done",
    JSON.stringify(complete?.args));
  check("progress was written with the same fence",
    board.callsOf("board_progress_handoff").every((c) => c.args.generation === 1 && c.args.request_id === "REQ-1"));
  check("the item ends completed on the board",
    board.items[0].handoff.state === "completed" && board.items[0].state === "done");
}

// --- unrelated work is left alone -----------------------------------
{
  const board = new FakeBoard([
    item({ item_id: "other1" }, { to: "devin", request_id: "REQ-2" }),
    item({ item_id: "other2" }, { state: "accepted", request_id: "REQ-3", accepted_by: "muse", generation: 4 }),
    { item_id: "plain", project: "demo", kind: "task", title: "No handoff", state: "planned", handoff: null },
  ]);
  const executor = new RecordExecutor();
  const outcome = await runPass({ client: board, config: baseConfig, executor, state: state() });
  check("nothing eligible means nothing taken", outcome.kind === "nothing", JSON.stringify(outcome));
  check("no accept was attempted for unrelated work", board.callsOf("board_accept_handoff").length === 0);
  check("the executor never ran", executor.jobs.length === 0);
}

// --- a second picker finds the work gone ----------------------------
{
  const board = new FakeBoard([item()]);
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowExecutor = { async run(job, { signal }) { await gate; return { outcome: "done", text: "done" }; } };
  const first = runPass({ client: board, config: baseConfig, executor: slowExecutor, state: state() });
  await wait(30); // the first picker has accepted and is running
  const second = await runPass({ client: board, config: baseConfig, executor: new RecordExecutor(), state: state() });
  check("a concurrent pass takes nothing while the first runs", second.kind === "nothing", JSON.stringify(second));
  release();
  const firstOutcome = await first;
  check("the first pass still completes its run", firstOutcome.kind === "ran" && firstOutcome.finished === true);
  check("exactly one completion landed", board.callsOf("board_complete_handoff").length === 1);
}

// --- accept race -----------------------------------------------------
{
  const board = new FakeBoard([item()]);
  board.call = async (tool, args) => {
    if (tool === "board_accept_handoff") throw new BoardRefusal("HANDOFF_CONFLICT", "taken meanwhile");
    return FakeBoard.prototype.call.call(board, tool, args);
  };
  const executor = new RecordExecutor();
  const outcome = await runPass({ client: board, config: baseConfig, executor, state: state() });
  check("a refused accept ends the pass without running", outcome.kind === "accept-refused" && executor.jobs.length === 0, JSON.stringify(outcome));
}

// --- replaced mid-run: heartbeat meets a newer generation ------------
{
  const board = new FakeBoard([item()]);
  board.onHeartbeat = (n) => {
    if (n === 1) board.items[0].handoff.generation = 99; // a newer run replaced this one
  };
  let aborted = false;
  const executor = {
    async run(job, { signal }) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 500);
        signal.addEventListener("abort", () => { aborted = true; clearTimeout(t); resolve(); }, { once: true });
      });
      return { outcome: "done", text: "must not be written" };
    },
  };
  const outcome = await runPass({ client: board, config: baseConfig, executor, state: state() });
  check("a stale generation aborts the run", aborted === true);
  check("the pass reports fenced-out", outcome.kind === "fenced-out", JSON.stringify(outcome));
  check("no completion was attempted after the fence broke", board.callsOf("board_complete_handoff").length === 0);
  check("the board still shows the newer run's state", board.items[0].handoff.state === "accepted" && board.items[0].handoff.generation === 99);
}

// --- board unreachable mid-run ---------------------------------------
{
  const board = new FakeBoard([item()]);
  board.drop.set("board_heartbeat_handoff", 50);
  let aborted = false;
  const executor = {
    async run(job, { signal }) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 500);
        signal.addEventListener("abort", () => { aborted = true; clearTimeout(t); resolve(); }, { once: true });
      });
      return { outcome: "done", text: "must not be written" };
    },
  };
  const outcome = await runPass({ client: board, config: baseConfig, executor, state: state() });
  check("losing the board aborts the run", aborted === true);
  check("the pass reports unreachable", outcome.kind === "unreachable", JSON.stringify(outcome));
  check("no completion was attempted while the board was gone", board.callsOf("board_complete_handoff").length === 0);
}

// --- a board without generations (pre-PR#4) --------------------------
{
  const board = new FakeBoard([item()]);
  const realCall = board.call.bind(board);
  board.call = async (tool, args) => {
    const out = await realCall(tool, args);
    if (tool === "board_accept_handoff") return { ok: true, changed: true, handoff: { state: "accepted", request_id: "REQ-1", generation: null } };
    return out;
  };
  const executor = new RecordExecutor();
  const outcome = await runPass({ client: board, config: baseConfig, executor, state: state() });
  check("an accept without a generation is not run unfenced", outcome.kind === "no-generation" && executor.jobs.length === 0, JSON.stringify(outcome));
}

// --- executor failure completes as stopped ----------------------------
{
  const board = new FakeBoard([item()]);
  const executor = { async run() { throw new Error("boom"); } };
  const outcome = await runPass({ client: board, config: baseConfig, executor, state: state() });
  check("an executor failure still finishes the handoff", outcome.kind === "ran" && outcome.finished === false, JSON.stringify(outcome));
  check("the completion says stopped", board.callsOf("board_complete_handoff")[0]?.args.outcome === "stopped");
}

// --- daily cap ---------------------------------------------------------
{
  const board = new FakeBoard([item()]);
  const outcome = await runPass({ client: board, config: baseConfig, executor: new RecordExecutor(), state: state(6) });
  check("the daily cap stops the pass before any board call", outcome.kind === "capped" && board.calls.length === 0, JSON.stringify(outcome));
}
{
  const env = { PICKER_BOARD_URL: "https://board.example.com/board/mcp", PICKER_KEY_FILE: "k", PICKER_WRITER: "muse" };
  check("PICKER_MAX_RUNS_PER_DAY=0 means no daily cap", configFromEnv({ ...env, PICKER_MAX_RUNS_PER_DAY: "0" }).maxRunsPerDay === Infinity);
  check("the daily cap stays 6 by default", configFromEnv(env).maxRunsPerDay === 6);
  let threw = false;
  try { configFromEnv({ ...env, PICKER_MAX_RUNS_PER_DAY: "-1" }); } catch { threw = true; }
  check("a negative daily cap is refused", threw);
  const board = new FakeBoard([item()]);
  const outcome = await runPass({ client: board, config: { ...baseConfig, maxRunsPerDay: Infinity }, executor: new RecordExecutor(), state: state(500) });
  check("with no daily cap, a pass still runs after many runs", outcome.kind === "ran", JSON.stringify(outcome));
}

// --- the entry point runs when started as a script ---------------------
// (On Windows the script path and import.meta.url differ in form; a plain
// string comparison made `node src/main.mjs` exit 0 without doing anything.)
{
  const main = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.mjs");
  const run = spawnSync(process.execPath, [main], { encoding: "utf8" });
  check("main.mjs without a mode prints the usage and exits 2", run.status === 2 && run.stderr.includes("usage:"), JSON.stringify({ status: run.status, stderr: run.stderr }));
}

// --- one pass at a time per state file ---------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "iris-picker-lock-"));
  const path = join(dir, "picker-state.json.lock");
  const first = acquireLock(path);
  check("the first pass gets the lock", typeof first === "function" && existsSync(path));
  check("a second pass while the first runs gets nothing", acquireLock(path) === null);
  first();
  check("releasing removes the lock", !existsSync(path));
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(path, `${dead}\n`);
  const taken = acquireLock(path);
  check("a lock left by a process that is gone is taken over", typeof taken === "function");
  taken?.();
  rmSync(dir, { recursive: true, force: true });
}

// --- takeover: the executor learns which session it continues --------
{
  const session = { item_id: "session/1933", project: "demo", kind: "task", title: "11-19 claude: stopped work", state: "in_progress", created_at: 1795000000000, handoff: null };
  const board = new FakeBoard([item({}, { title: "session/1933 の続き" }), session]);
  const executor = new RecordExecutor();
  const outcome = await runPass({ client: board, config: baseConfig, executor, state: state() });
  const takeover = executor.jobs[0]?.takeover;
  check("a takeover round still runs and finishes", outcome.kind === "ran" && outcome.finished === true, JSON.stringify(outcome));
  check("the executor gets the session item's creation time and project",
    takeover?.itemId === "session/1933" && takeover?.createdAt === 1795000000000 && takeover?.project === "demo" && takeover?.missing === undefined,
    JSON.stringify(takeover));
  check("the session item was found in the list already read (no second list)", board.callsOf("board_list").length === 1);
}
{
  const board = new FakeBoard([item({}, { title: "session/42 の続き" })]);
  const executor = new RecordExecutor();
  await runPass({ client: board, config: baseConfig, executor, state: state() });
  check("a session the board does not have is passed on as missing",
    executor.jobs[0]?.takeover?.itemId === "session/42" && executor.jobs[0]?.takeover?.missing === true,
    JSON.stringify(executor.jobs[0]?.takeover));
}
{
  const board = new FakeBoard([item()]);
  const executor = new RecordExecutor();
  await runPass({ client: board, config: baseConfig, executor, state: state() });
  check("ordinary work carries no takeover", executor.jobs[0] !== undefined && !("takeover" in executor.jobs[0]));
}

// --- conversations (runChatPass)
{
  class ChatBoard {
    constructor(turns, { pendingError = null } = {}) { this.turns = turns; this.calls = []; this.pendingError = pendingError; this.replies = []; }
    async call(tool, args) {
      this.calls.push({ tool, args });
      if (tool === "board_chat_pending") { if (this.pendingError) throw this.pendingError; return { ok: true, turns: this.turns }; }
      if (tool === "board_chat_take") {
        const t = this.turns.find((x) => x.seq === args.seq);
        if (!t || t.taken) throw new BoardRefusal("HANDOFF_CONFLICT", "not open");
        t.taken = true;
        return { ok: true, turn: { item_id: t.item_id, seq: t.seq, text: t.text, attachments: t.attachments ?? [] }, item: { item_id: t.item_id, project: "demo", title: "Item title" },
          handoff: { request_id: "REQ-9", title: "Handed title" }, transcript: [{ at: 1, who: "owner", actor: "page:owner", text: t.text }] };
      }
      if (tool === "board_chat_reply") { this.replies.push(args); return { ok: true }; }
      throw new Error(`unexpected ${tool}`);
    }
    async readAttachment(id) {
      if (id === "img") return { name: "shot.png", mime: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
      if (id === "txt") return { name: "../メモ.txt", mime: "text/plain", bytes: Buffer.from("中身", "utf8") };
      throw new BoardRefusal("NOT_FOUND", "gone");
    }
  }
  const executorOf = (result) => ({ jobs: [], async run(job) { this.jobs.push(job); if (result instanceof Error) throw result; return result; } });

  const empty = new ChatBoard([]);
  check("no turn: nothing to do", (await runChatPass({ client: empty, executor: executorOf({}) })).kind === "nothing");
  const old = new ChatBoard([], { pendingError: new BoardUnreachable("old board") });
  check("a board without conversations reads as nothing (the work pass still runs)", (await runChatPass({ client: old, executor: executorOf({}) })).kind === "nothing");

  const board = new ChatBoard([{ item_id: "task1", seq: 7, text: "もう少し短くして" }]);
  const ex = executorOf({ outcome: "done", text: JSON.stringify({ reply: "短くしました\n2 行目", ref: "https://github.com/example/repo/pull/3" }) });
  const out = await runChatPass({ client: board, executor: ex });
  check("a turn is taken, run as a chat job, and answered", out.kind === "chatted" && out.finished === true &&
    board.replies[0]?.text === "短くしました\n2 行目" && board.replies[0]?.ref === "https://github.com/example/repo/pull/3" && board.replies[0]?.seq === 7 && !("failed" in board.replies[0]), JSON.stringify(board.replies));
  const job = ex.jobs[0];
  check("the chat job carries the turn, the handed-over title, the request and the transcript",
    job?.kind === "chat" && job.turn.text === "もう少し短くして" && job.title === "Handed title" && job.requestId === "REQ-9" && job.transcript.length === 1, JSON.stringify(job));

  const failing = new ChatBoard([{ item_id: "task1", seq: 8, text: "x" }]);
  await runChatPass({ client: failing, executor: executorOf({ outcome: "stopped", text: "command exited with code 4: [失敗] だめだった" }) });
  check("a failed run answers the turn as failed, with the reason", failing.replies[0]?.failed === true && failing.replies[0]?.text.includes("だめだった"), JSON.stringify(failing.replies));

  const thrown = new ChatBoard([{ item_id: "task1", seq: 9, text: "x" }]);
  await runChatPass({ client: thrown, executor: executorOf(new Error("boom")) });
  check("an executor that throws still answers the turn as failed", thrown.replies[0]?.failed === true && thrown.replies[0]?.text.includes("boom"));

  const raced = new ChatBoard([{ item_id: "task1", seq: 10, text: "x", taken: true }]);
  const r = await runChatPass({ client: raced, executor: executorOf({ outcome: "done", text: "y" }) });
  check("a turn someone else took is left alone", r.kind === "chat-refused" && raced.replies.length === 0);

  // attachments: fetched into files for the executor, removed after the run
  const { existsSync, readFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const attachDir = mkdtempSync(join(tmpdir(), "picker-att-"));
  const withFiles = new ChatBoard([{ item_id: "task/1", seq: 11, text: "見て", attachments: [{ id: "img", name: "shot.png" }, { id: "txt", name: "メモ.txt" }, { id: "gone", name: "old.png" }] }]);
  let seen = null;
  const looking = { async run(job) { seen = job.attachments?.map((a) => ({ ...a, there: a.path ? existsSync(a.path) : false, body: a.path ? readFileSync(a.path) : null })); return { outcome: "done", text: "見ました" }; } };
  await runChatPass({ client: withFiles, executor: looking, attachDir });
  check("the turn's attachments reach the executor as files", seen?.length === 3 && seen[0].there && seen[0].mime === "image/png" && seen[0].body.length === 4 &&
    seen[1].there && seen[1].body.toString("utf8") === "中身" && seen[1].path.startsWith(attachDir) && !seen[1].path.includes("..") && seen[2].error === "NOT_FOUND" && !seen[2].path, JSON.stringify(seen?.map((a) => ({ ...a, body: undefined }))));
  check("the files are removed after the run", seen?.every((a) => !a.path || !existsSync(a.path)));
  check("the turn is still answered", withFiles.replies[0]?.text === "見ました");
  const noDir = new ChatBoard([{ item_id: "task1", seq: 12, text: "x", attachments: [{ id: "img", name: "shot.png" }] }]);
  const plain = executorOf({ outcome: "done", text: "y" });
  await runChatPass({ client: noDir, executor: plain });
  check("without an attachment folder the job carries no files", plain.jobs[0] && !("attachments" in plain.jobs[0]));

  // the attachment folder sits in a shared /tmp: nothing can be planted in it ahead of the run
  const { lstatSync, statSync, symlinkSync, readdirSync } = await import("node:fs");
  const { basename } = await import("node:path");
  const posix = typeof process.getuid === "function";
  const base = join(mkdtempSync(join(tmpdir(), "picker-base-")), "many-iris-attachments-test");
  let turnSeen = null;
  const peek = { async run(job) { const p = job.attachments?.find((a) => a.path)?.path; turnSeen = p ? { dir: dirname(p), dirMode: statSync(dirname(p)).mode & 0o777, fileMode: statSync(p).mode & 0o777 } : null; return { outcome: "done", text: "ok" }; } };
  await runChatPass({ client: new ChatBoard([{ item_id: "task/1", seq: 13, text: "x", attachments: [{ id: "img", name: "shot.png" }] }]), executor: peek, attachDir: base });
  check("each turn gets its own unpredictable folder under the base",
    turnSeen && dirname(turnSeen.dir) === base && /^task_1-13-[A-Za-z0-9]{6}$/.test(basename(turnSeen.dir)), JSON.stringify(turnSeen));
  if (posix) {
    check("the base, the turn folder and the files are this user's only",
      (statSync(base).mode & 0o777) === 0o700 && turnSeen?.dirMode === 0o700 && turnSeen?.fileMode === 0o600, JSON.stringify({ base: (statSync(base).mode & 0o777).toString(8), ...turnSeen }));
  }
  check("the turn folder is removed after the run", turnSeen && !existsSync(turnSeen.dir) && readdirSync(base).length === 0);

  const target = mkdtempSync(join(tmpdir(), "picker-target-"));
  const link = join(mkdtempSync(join(tmpdir(), "picker-link-")), "many-iris-attachments-test");
  let linked = true;
  try { symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir"); } catch { linked = false; }
  if (linked && lstatSync(link).isSymbolicLink()) {
    check("a base that is a link is refused", privateTurnDir(link, "t-1") === null && readdirSync(target).length === 0);
    const viaLink = executorOf({ outcome: "done", text: "y" });
    const refused = new ChatBoard([{ item_id: "task1", seq: 14, text: "x", attachments: [{ id: "img", name: "shot.png" }] }]);
    await runChatPass({ client: refused, executor: viaLink, attachDir: link });
    check("a refused base still answers, telling the worker the files could not be given",
      viaLink.jobs[0]?.attachments?.[0]?.error === "attachment folder is not safe" && !viaLink.jobs[0].attachments[0].path && readdirSync(target).length === 0 && refused.replies.length === 1);
  } else {
    console.log("skip: could not make a link here (the link case is covered on Linux CI)");
  }

  const planted = mkdtempSync(join(tmpdir(), "picker-planted-"));
  writeFileSync(join(planted, "1-shot.png"), "keep");
  const got = await fetchAttachments(new ChatBoard([]), [{ id: "img", name: "shot.png" }], planted);
  const { readFileSync: readKeep } = await import("node:fs");
  check("a file already at the path is not written over", got[0]?.error && !got[0].path && readKeep(join(planted, "1-shot.png"), "utf8") === "keep", JSON.stringify(got));
  // the link's folder first (removing it drops the link, not what it points at), then the rest
  for (const dir of [dirname(link), dirname(base), target, planted, attachDir]) rmSync(dir, { recursive: true, force: true });

  check("plain text is the answer as it is", chatAnswer({ outcome: "done", text: "plain" }).reply === "plain");
  check("an answer longer than the board keeps is cut", chatAnswer({ outcome: "done", text: JSON.stringify({ reply: "あ".repeat(25000) }) }).reply.length === 20000);
  check("an empty answer says so", chatAnswer({ outcome: "done", text: "" }).reply === "（返事が空でした）");
  check("a non-https ref is dropped", chatAnswer({ outcome: "done", text: JSON.stringify({ reply: "a", ref: "http://x" }) }).ref === null);
}
console.log(`picker.test: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
