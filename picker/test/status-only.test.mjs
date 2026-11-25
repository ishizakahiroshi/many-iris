// Unit tests for the picker's status-only reporting (#50), against the same
// kind of fake board as picker.test.mjs. What they pin down:
//   - a registered job's reports carry only the fixed status words — markers
//     planted in the interim report, the completion text, the result link and
//     the exception message never reach a board call (acceptance 1);
//   - a covered job whose registration names another writer or board is
//     held, not run and not reported (acceptance 4);
//   - the picker's status words are exactly the ones the board accepts
//     (board-worker/src/status-only.ts, read as text the way
//     board-worker's readme.test.mjs reads mcp.ts).
// The receiving side's refusals are covered against the real board in
// status-only-e2e.test.mjs.
//
//   node test/status-only.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardRefusal } from "../src/board-client.mjs";
import { RecordExecutor } from "../src/executors.mjs";
import { configFromEnv } from "../src/main.mjs";
import { runPass, statusOnlyFor, STATUS_ATTENTION, STATUS_DONE, STATUS_STARTED, STATUS_WORKING } from "../src/picker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const statusOnlySrc = readFileSync(join(here, "..", "..", "board-worker", "src", "status-only.ts"), "utf8");
const wordList = (name) => {
  const m = new RegExp(`${name} = \\[([^\\]]+)\\]`).exec(statusOnlySrc);
  return m === null ? [] : [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};
const STATUS_ONLY_PROGRESS = wordList("STATUS_ONLY_PROGRESS");
const STATUS_ONLY_COMPLETION = wordList("STATUS_ONLY_COMPLETION");

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
}

const boardUrl = "https://board.example.invalid/board/mcp";

function item(overrides = {}, handoffOverrides = {}) {
  return {
    item_id: "task1",
    project: "quiet",
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

/** The same fake board as picker.test.mjs: the real one's fence semantics for the tools the picker uses. */
class FakeBoard {
  constructor(items, actor = "muse") {
    this.items = items;
    this.actor = actor;
    this.calls = [];
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
    const it = this.items.find((i) => i.item_id === args.item_id);
    switch (tool) {
      case "board_accept_handoff": {
        if (!it || !it.handoff) throw new BoardRefusal("NOT_FOUND", "No such item");
        const h = it.handoff;
        if (h.state !== "requested" || h.request_id !== args.request_id) throw new BoardRefusal("HANDOFF_CONFLICT", "not open");
        if (h.to !== null && h.to !== this.actor) throw new BoardRefusal("FORBIDDEN", "for another writer");
        h.state = "accepted";
        h.accepted_by = this.actor;
        h.generation = (h.generation ?? 0) + 1;
        return { ok: true, changed: true, handoff: structuredClone(h) };
      }
      case "board_heartbeat_handoff":
        this.fenceOf(args);
        return { ok: true };
      case "board_progress_handoff":
        this.fenceOf(args);
        return { ok: true };
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

const freshState = () => {
  const s = { runs: 0 };
  return { runsToday: () => s.runs, recordRun: () => { s.runs += 1; } };
};

const restrictedCfg = {
  writer: "muse",
  boardUrl,
  projects: [],
  ownerOnly: true,
  heartbeatMs: 10,
  maxRunsPerDay: 6,
  statusOnly: [{ project: "quiet", writer: "muse", board: `${boardUrl}/` }],
};

// --- the configuration -----------------------------------------------
{
  const env = { PICKER_BOARD_URL: boardUrl, PICKER_KEY_FILE: "k", PICKER_WRITER: "muse" };
  check("no PICKER_STATUS_ONLY means no registrations", configFromEnv(env).statusOnly.length === 0);
  const parsed = configFromEnv({ ...env, PICKER_STATUS_ONLY: JSON.stringify([{ project: "quiet", writer: "muse", board: `${boardUrl}/` }]) });
  check("a valid entry parses and the board url is normalized",
    parsed.statusOnly.length === 1 && parsed.statusOnly[0].board === boardUrl, JSON.stringify(parsed.statusOnly));
  for (const [name, raw] of [
    ["not JSON", "{broken"],
    ["not an array", '{"project":"quiet","writer":"muse","board":"b"}'],
    ["a missing field", '[{"project":"quiet","writer":"muse"}]'],
    ["an extra field", `[{"project":"quiet","writer":"muse","board":"${boardUrl}","extra":1}]`],
    ["a bad writer name", `[{"project":"quiet","writer":"No_Good","board":"${boardUrl}"}]`],
    ["a non-https board", '[{"project":"quiet","writer":"muse","board":"http://198.51.100.7/board/mcp"}]'],
    ["a duplicate project", `[{"project":"quiet","writer":"muse","board":"${boardUrl}"},{"project":"quiet","writer":"muse","board":"${boardUrl}"}]`],
    ["too many entries", `[${Array.from({ length: 65 }, (_, i) => `{"project":"p${i}","writer":"muse","board":"${boardUrl}"}`).join(",")}]`],
  ]) {
    let threw = false;
    try { configFromEnv({ ...env, PICKER_STATUS_ONLY: raw }); } catch { threw = true; }
    check(`malformed PICKER_STATUS_ONLY (${name}) is refused`, threw);
  }
}

// --- statusOnlyFor ------------------------------------------------------
check("a registered job of this picker is restricted", statusOnlyFor("quiet", restrictedCfg) === "restricted");
check("an unregistered project reports normally", statusOnlyFor("open", restrictedCfg) === null);
check("a registration for another writer holds",
  statusOnlyFor("quiet", { ...restrictedCfg, statusOnly: [{ project: "quiet", writer: "grokbot", board: boardUrl }] }) === "held");
check("a registration for another board holds",
  statusOnlyFor("quiet", { ...restrictedCfg, statusOnly: [{ project: "quiet", writer: "muse", board: "https://other.example.invalid/board/mcp" }] }) === "held");
check("no registrations at all means ordinary reporting", statusOnlyFor("quiet", { writer: "muse" }) === null);

// --- the shared words are the ones the board accepts --------------------
check("the picker's progress words are the board's",
  [STATUS_STARTED, STATUS_WORKING, STATUS_ATTENTION].every((s) => STATUS_ONLY_PROGRESS.includes(s)),
  JSON.stringify(STATUS_ONLY_PROGRESS));
check("the picker's completion words are the board's",
  [STATUS_DONE, STATUS_ATTENTION].every((s) => STATUS_ONLY_COMPLETION.includes(s)),
  JSON.stringify(STATUS_ONLY_COMPLETION));

// --- a restricted run leaks none of the four markers (acceptance 1) -----
{
  const board = new FakeBoard([item()]);
  const executor = {
    async run(job, { progress }) {
      await progress("MARKER-INTERIM-7f3a9b: detail of the run in progress");
      return { outcome: "done", text: '{"summary":"MARKER-DONE-2c8e4f","ref":"https://example.com/result/MARKER-REF-6d1b3a","commit":"9e5f2d4a1b3c"}' };
    },
  };
  const outcome = await runPass({ client: board, config: restrictedCfg, executor, state: freshState() });
  check("a restricted run finishes", outcome.kind === "ran" && outcome.finished === true, JSON.stringify(outcome));
  check("no marker reached any board call", !JSON.stringify(board.calls).includes("MARKER"));
  const notes = board.callsOf("board_progress_handoff").map((c) => c.args.text);
  check("progress carried only the status words, starting with 着手",
    notes.length > 0 && notes.every((t) => STATUS_ONLY_PROGRESS.includes(t)) && notes[0] === "状態：着手", JSON.stringify(notes));
  const done = board.callsOf("board_complete_handoff")[0];
  check("completion is the done status without a link or a commit",
    done?.args.text === "状態：完了" && !("ref" in done.args) && !("commit" in done.args), JSON.stringify(done?.args));
}

// --- the exception path reports only 要確認 -------------------------------
{
  const board = new FakeBoard([item()]);
  const executor = { async run() { throw new Error("MARKER-ERROR-5b7d2c exploded"); } };
  const outcome = await runPass({ client: board, config: restrictedCfg, executor, state: freshState() });
  const done = board.callsOf("board_complete_handoff")[0];
  check("an exception ends as the attention status, with no marker",
    outcome.finished === false && done?.args.outcome === "stopped" && done?.args.text === "状態：要確認"
    && !JSON.stringify(board.calls).includes("MARKER"), JSON.stringify(done?.args));
}

// --- worker milestones become status words, deduplicated -----------------
{
  const board = new FakeBoard([item()]);
  const executor = {
    async run(job, { progress }) {
      await progress("工程：調査中");
      await progress("工程：回答待ち");
      await progress("工程：実装中");
      return { outcome: "done", text: "done" };
    },
  };
  await runPass({ client: board, config: restrictedCfg, executor, state: freshState() });
  const notes = board.callsOf("board_progress_handoff").map((c) => c.args.text);
  check("milestones become status words and repeats collapse",
    notes.join("/") === "状態：着手/状態：作業中/状態：要確認/状態：作業中", JSON.stringify(notes));
}

// --- a mismatched registration holds the job (acceptance 4) --------------
{
  const heldCfg = { ...restrictedCfg, statusOnly: [{ project: "quiet", writer: "grokbot", board: boardUrl }] };
  const board = new FakeBoard([item()]);
  const executor = new RecordExecutor();
  const outcome = await runPass({ client: board, config: heldCfg, executor, state: freshState() });
  check("a job registered for another writer is held", outcome.kind === "held" && outcome.itemIds.includes("task1"), JSON.stringify(outcome));
  check("nothing was accepted and nothing ran", board.callsOf("board_accept_handoff").length === 0 && executor.jobs.length === 0);
}
{
  const heldCfg = { ...restrictedCfg, statusOnly: [{ project: "quiet", writer: "muse", board: "https://other.example.invalid/board/mcp" }] };
  const board = new FakeBoard([item()]);
  const outcome = await runPass({ client: board, config: heldCfg, executor: new RecordExecutor(), state: freshState() });
  check("a job registered for another board is held", outcome.kind === "held", JSON.stringify(outcome));
  check("the board was never asked to accept", board.callsOf("board_accept_handoff").length === 0);
}
{
  const heldCfg = { ...restrictedCfg, statusOnly: [{ project: "quiet", writer: "grokbot", board: boardUrl }] };
  const board = new FakeBoard([
    item(),
    item({ item_id: "open1", project: "open" }, { request_id: "REQ-2" }),
  ]);
  const executor = new RecordExecutor();
  const outcome = await runPass({ client: board, config: heldCfg, executor, state: freshState() });
  check("a held job does not stop ordinary work behind it", outcome.kind === "ran" && executor.jobs.length === 1 && executor.jobs[0].itemId === "open1", JSON.stringify(outcome));
  const done = board.callsOf("board_complete_handoff")[0];
  check("the ordinary job still reports freely", done?.args.text !== "状態：完了" && done?.args.text !== "状態：要確認", JSON.stringify(done?.args));
}

console.log(`status-only.test: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
