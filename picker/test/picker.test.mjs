// Unit tests for the picker against a fake board that reproduces the
// real board's handoff rules (accept conflict, generation fencing,
// idempotent re-accept). The end-to-end behaviour against the real
// board Worker is covered by picker-e2e.test.mjs.
//
//   node test/picker.test.mjs
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardRefusal, BoardUnreachable } from "../src/board-client.mjs";
import { RecordExecutor } from "../src/executors.mjs";
import { eligible, runPass } from "../src/picker.mjs";

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

// --- the entry point runs when started as a script ---------------------
// (On Windows the script path and import.meta.url differ in form; a plain
// string comparison made `node src/main.mjs` exit 0 without doing anything.)
{
  const main = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.mjs");
  const run = spawnSync(process.execPath, [main], { encoding: "utf8" });
  check("main.mjs without a mode prints the usage and exits 2", run.status === 2 && run.stderr.includes("usage:"), JSON.stringify({ status: run.status, stderr: run.stderr }));
}

console.log(`picker.test: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
