// End-to-end test of status-only reporting (#50) against two real board
// Workers (`wrangler dev`, local Durable Object storage), in the same
// shape as picker-e2e.test.mjs. Keys are made up for this run only; the
// temp folders are removed at the end.
//
// Two boards, A and B, each register the "quiet" project status-only for
// its own taker (BOARD_STATUS_ONLY): A for muse, B for grokbot. Each
// picker carries its half of the registration in its config
// (PICKER_STATUS_ONLY). What this test proves over the wire:
//
//   acceptance 1 – a restricted run's interim report, result summary,
//     result link and thrown exception never reach a sent MCP call or the
//     board's saved events; the fixed status words do;
//   acceptance 3 – one item number ("shared-1") handed over on both
//     boards: each board's own key cannot read or write the other board,
//     each registered taker runs it exactly once, a second pass finds
//     nothing, and an unregistered project on the same board keeps its
//     ordinary reporting (the result link is kept);
//   acceptance 4 – a registration that names another writer or another
//     board holds the job (it is not run and nothing is reported), and a
//     picker without the registration is fenced out by the board before
//     the executor starts.
//
// Acceptance 2 (the receiving side's refusals) is measured in
// board-worker/test/board.test.mjs against the same registration.
//
//   node test/status-only-e2e.test.mjs
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardClient, BoardRefusal } from "../src/board-client.mjs";
import { runPass } from "../src/picker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const boardRoot = join(here, "..", "..", "board-worker");
const temp = join(tmpdir(), `iris-status-only-e2e-${Date.now()}`);

const key = () => randomBytes(32).toString("hex");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const K = { alpha: key(), muse: key(), vps: key(), beta: key(), grokbot: key() };

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
}
const code = async (promise) => {
  try { await promise; return "OK"; }
  catch (error) { return error instanceof BoardRefusal ? error.code : `threw ${error}`; }
};

const boards = [];
function makeBoard(name, port, writerEntries, statusOnlyActor) {
  const dir = join(temp, name);
  const base = `http://127.0.0.1:${port}`;
  const writers = { schema_version: 1, writers: writerEntries };
  const statusOnly = { schema_version: 1, status_only: [{ project: "quiet", actor: statusOnlyActor }] };
  const board = { name, dir, port, base, child: null, statusOnly, env: () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "test.env"),
      `BOARD_WRITERS='${JSON.stringify(writers)}'\nBOARD_STATUS_ONLY='${JSON.stringify(board.statusOnly)}'\nACCESS_TEAM_DOMAIN=http://127.0.0.1:9\nACCESS_AUD=${randomBytes(32).toString("hex")}\nBOARD_OWNERS=owner@example.com\nBOARD_LEASE_MS=60000\nBOARD_PUBLIC_ORIGIN=${base}\n`);
  } };
  boards.push(board);
  return board;
}

const wranglerJs = join(boardRoot, "node_modules", "wrangler", "bin", "wrangler.js");
async function start(board) {
  board.env();
  board.child = spawn(process.execPath, [wranglerJs, "dev", "--local", "--ip", "127.0.0.1", "--port", String(board.port),
    "--local-upstream", `127.0.0.1:${board.port}`, "--upstream-protocol", "http",
    "--persist-to", join(board.dir, "state"), "--env-file", join(board.dir, "test.env"), "--show-interactive-dev-session=false"],
    { cwd: boardRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } });
  let log = "";
  board.child.stdout.on("data", (d) => (log += d));
  board.child.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${board.base}/healthz`);
      if (r.ok) return;
    } catch {}
    if (board.child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev (${board.name}) did not start:\n${log.slice(-3000)}`);
}
function stop(board) {
  if (board.child === null || board.child.exitCode !== null) return;
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/pid", String(board.child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  } else board.child.kill("SIGTERM");
  board.child = null;
}

/** A BoardClient plus the list of JSON-RPC bodies it sent — the proof of
 * what did and did not reach the board. */
function tapping(url, keyValue) {
  const sent = [];
  const fetchImpl = (u, init) => { sent.push(JSON.parse(init.body)); return fetch(u, init); };
  return { client: new BoardClient({ url, key: keyValue, fetchImpl }), sent };
}
const calls = (sent, name) => sent.filter((r) => r.method === "tools/call" && r.params?.name === name);

/** A RecordExecutor that can also report interim text and end in a given
 * result (or an exception): the executor is the boundary the status words
 * are filtered at, so the markers start here. */
class ScriptedExecutor {
  constructor({ progress = [], result = { outcome: "done", text: "done" } } = {}) {
    this.jobs = [];
    this.reports = progress;
    this.result = result;
  }
  async run(job, { signal, progress: report } = {}) {
    this.jobs.push(job);
    if (signal?.aborted) return { outcome: "stopped", text: "aborted before the run started" };
    for (const text of this.reports) await report(text);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

const freshState = () => {
  const s = { runs: 0 };
  return { runsToday: () => s.runs, recordRun: () => { s.runs += 1; } };
};
const eventsFor = (listed, itemId) => (listed.events ?? []).filter((e) => e.item_id === itemId).map((e) => e.text ?? "");

const portA = 19000 + Math.floor(Math.random() * 400);
const portB = 20000 + Math.floor(Math.random() * 400);
const boardA = makeBoard("a", portA, [
  { actor: "alpha", token_sha256: sha(K.alpha), enabled: true },
  { actor: "muse", token_sha256: sha(K.muse), enabled: true },
  { actor: "vps-claude", token_sha256: sha(K.vps), enabled: true },
], "muse");
const boardB = makeBoard("b", portB, [
  { actor: "beta", token_sha256: sha(K.beta), enabled: true },
  { actor: "grokbot", token_sha256: sha(K.grokbot), enabled: true },
], "grokbot");

if (!existsSync(wranglerJs)) throw new Error("Run npm install in board-worker first");

try {
  await start(boardA);
  await start(boardB);
  const urlA = `${boardA.base}/board/mcp`;
  const urlB = `${boardB.base}/board/mcp`;
  const alpha = new BoardClient({ url: urlA, key: K.alpha });
  const beta = new BoardClient({ url: urlB, key: K.beta });
  const muse = tapping(urlA, K.muse);
  const grokbot = tapping(urlB, K.grokbot);

  const pickerA = { writer: "muse", boardUrl: urlA, projects: [], ownerOnly: false, heartbeatMs: 150, maxRunsPerDay: 20,
    statusOnly: [{ project: "quiet", writer: "muse", board: urlA }] };
  const pickerB = { writer: "grokbot", boardUrl: urlB, projects: [], ownerOnly: false, heartbeatMs: 150, maxRunsPerDay: 20,
    statusOnly: [{ project: "quiet", writer: "grokbot", board: urlB }] };

  const hand = async (seeder, itemId, project, to, title = `work ${itemId}`) => {
    await seeder.call("board_upsert_item", { item_id: itemId, project, kind: "task", title, state: "planned" });
    const h = await seeder.call("board_request_handoff", { item_id: itemId, to });
    if (h?.handoff?.state !== "requested") throw new Error(`handoff for ${itemId} did not land: ${JSON.stringify(h)}`);
  };
  const listed = (client) => client.call("board_list", { since_seq: 0 });
  const itemOf = (list, itemId) => (list.items ?? []).find((i) => i.item_id === itemId);

  // --- seed ---------------------------------------------------------------
  await hand(alpha, "qdone", "quiet", "muse");
  await hand(alpha, "qfail", "quiet", "muse");
  await hand(alpha, "shared-1", "quiet", "muse");
  await hand(alpha, "quiet-mis", "quiet", "vps-claude");
  await hand(beta, "shared-1", "quiet", "grokbot");

  // --- acceptance 1: markers never leave the executor ---------------------
  const runA = await runPass({ client: muse.client, config: pickerA, state: freshState(),
    executor: new ScriptedExecutor({
      progress: ["MARKER-PROG-4be8c2 detail https://example.com/x"],
      result: { outcome: "done", text: JSON.stringify({ summary: "MARKER-SUM-9f1a3d done", ref: "https://example.com/pr/9", commit: "9f1a3d2" }) },
    }) });
  check("the restricted run finished its job", runA.kind === "ran" && runA.itemId === "qdone" && runA.finished === true, JSON.stringify(runA));
  const sentA = JSON.stringify(muse.sent);
  check("no marker reached a sent MCP call", !sentA.includes("MARKER-") && !sentA.includes("example.com"), sentA.slice(0, 400));
  const listA = await listed(alpha);
  const qdoneEvents = eventsFor(listA, "qdone");
  check("no marker is saved on the board either", qdoneEvents.every((t) => !t.includes("MARKER-")), JSON.stringify(qdoneEvents));
  check("the run reported its states: 着手, 作業中, 完了",
    qdoneEvents.includes("状態：着手") && qdoneEvents.includes("状態：作業中") && qdoneEvents.includes("状態：完了"), JSON.stringify(qdoneEvents));
  const qdone = itemOf(listA, "qdone");
  check("the completed card carries no result link or commit", qdone?.state === "done" && qdone?.handoff?.state === "completed" && qdone?.handoff?.result === null, JSON.stringify(qdone?.handoff));

  const failA = await runPass({ client: muse.client, config: pickerA, state: freshState(),
    executor: new ScriptedExecutor({ result: new Error("MARKER-FAIL-7c2f91 the worker broke") }) });
  check("a broken restricted run still reports, as 要確認", failA.kind === "ran" && failA.itemId === "qfail" && failA.finished === false, JSON.stringify(failA));
  const qfailEvents = eventsFor(await listed(alpha), "qfail");
  check("the exception text never reached the board", qfailEvents.every((t) => !t.includes("MARKER-")), JSON.stringify(qfailEvents));
  check("the failure is a 要確認 state", qfailEvents.includes("状態：着手") && qfailEvents.includes("状態：要確認"), JSON.stringify(qfailEvents));
  check("the picker never sends progress the board would refuse",
    calls(muse.sent, "board_progress_handoff").every((r) => /^状態：(着手|作業中|要確認)$/.test(r.params.arguments.text)),
    JSON.stringify(calls(muse.sent, "board_progress_handoff").map((r) => r.params.arguments.text)));

  // --- acceptance 3: two boards, one item number, separate keys -----------
  const wrongKey = async (base, badKey, write = false) => (await fetch(`${base}/board/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${badKey}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: write
      ? { name: "board_upsert_item", arguments: { item_id: "shared-1", title: "fixture change" } }
      : { name: "board_list", arguments: {} } }),
  })).status;
  check("each board refuses reads using the other board's key",
    await wrongKey(boardB.base, K.muse) === 401 && await wrongKey(boardA.base, K.grokbot) === 401);
  check("each board refuses writes using the other board's key",
    await wrongKey(boardB.base, K.muse, true) === 401 && await wrongKey(boardA.base, K.grokbot, true) === 401);

  const runSharedA = await runPass({ client: muse.client, config: pickerA, state: freshState(),
    executor: new ScriptedExecutor({ result: { outcome: "done", text: JSON.stringify({ summary: "SHARED-A-11aa22", ref: "https://example.com/a/1" }) } }) });
  const runSharedB = await runPass({ client: grokbot.client, config: pickerB, state: freshState(),
    executor: new ScriptedExecutor({ result: { outcome: "done", text: JSON.stringify({ summary: "SHARED-B-33cc44", ref: "https://example.com/b/1" }) } }) });
  check("each board's own restricted run of shared-1 finished once",
    runSharedA.kind === "ran" && runSharedA.finished === true && runSharedB.kind === "ran" && runSharedB.finished === true,
    JSON.stringify({ a: runSharedA, b: runSharedB }));
  const listA3 = await listed(alpha);
  const listB3 = await listed(beta);
  const sharedA = itemOf(listA3, "shared-1");
  const sharedB = itemOf(listB3, "shared-1");
  check("shared-1 is done on both boards, run by its own taker",
    sharedA?.state === "done" && sharedA?.handoff?.accepted_by === "muse" && sharedB?.state === "done" && sharedB?.handoff?.accepted_by === "grokbot",
    JSON.stringify({ a: sharedA?.handoff, b: sharedB?.handoff }));
  check("neither board saw the other run's summary",
    eventsFor(listA3, "shared-1").every((t) => !t.includes("SHARED-")) && eventsFor(listB3, "shared-1").every((t) => !t.includes("SHARED-")));
  check("a second pass on each board finds nothing",
    (await runPass({ client: muse.client, config: pickerA, state: freshState(), executor: new ScriptedExecutor() })).kind === "nothing"
      && (await runPass({ client: grokbot.client, config: pickerB, state: freshState(), executor: new ScriptedExecutor() })).kind === "nothing");

  // An unregistered project on the same board keeps ordinary reporting.
  await hand(beta, "open-1", "open", "grokbot");
  const runOpen = await runPass({ client: grokbot.client, config: pickerB, state: freshState(),
    executor: new ScriptedExecutor({ result: { outcome: "done", text: JSON.stringify({ summary: "NORMAL-TEXT-55ee66 finished", ref: "https://example.com/open/result" }) } }) });
  const open1 = itemOf(await listed(beta), "open-1");
  check("the ordinary-reporting job keeps its result link",
    runOpen.kind === "ran" && open1?.handoff?.result?.ref === "https://example.com/open/result", JSON.stringify(open1?.handoff?.result));
  check("the ordinary-reporting job's summary reaches the board",
    eventsFor(await listed(beta), "open-1").some((t) => t.includes("NORMAL-TEXT-55ee66")));

  // --- acceptance 4: missing or mismatched registration --------------------
  const vps = new BoardClient({ url: urlA, key: K.vps });
  check("the registered taker cannot run work addressed to somebody else",
    await code(muse.client.call("board_accept_handoff", { item_id: "quiet-mis", request_id: (await alpha.call("board_request_status", { item_id: "quiet-mis" })).request_id })) === "FORBIDDEN");
  check("the named-but-unregistered taker cannot run it either",
    await code(vps.call("board_accept_handoff", { item_id: "quiet-mis", request_id: (await alpha.call("board_request_status", { item_id: "quiet-mis" })).request_id })) === "FORBIDDEN");
  check("the mismatched job stays parked as requested",
    itemOf(await listed(alpha), "quiet-mis")?.handoff?.state === "requested");

  await hand(alpha, "quiet-held", "quiet", "muse");
  const sentBefore = muse.sent.length;
  const heldWriter = await runPass({ client: muse.client, state: freshState(), executor: new ScriptedExecutor(),
    config: { ...pickerA, statusOnly: [{ project: "quiet", writer: "grokbot", board: urlA }] } });
  check("a registration for another writer holds the job", heldWriter.kind === "held" && heldWriter.itemIds.includes("quiet-held"), JSON.stringify(heldWriter));
  const heldBoard = await runPass({ client: muse.client, state: freshState(), executor: new ScriptedExecutor(),
    config: { ...pickerA, statusOnly: [{ project: "quiet", writer: "muse", board: "https://status-only-e2e.invalid/board/mcp" }] } });
  check("a registration for another board holds the job too", heldBoard.kind === "held", JSON.stringify(heldBoard));
  check("a held job is never even taken: no accept was sent",
    calls(muse.sent.slice(sentBefore), "board_accept_handoff").length === 0);
  check("the held job stays requested and unrun",
    itemOf(await listed(alpha), "quiet-held")?.handoff?.state === "requested");

  // Check both ends before acceptance or transmission of any free-text report.
  const beforeBare = muse.sent.length;
  const bareExecutor = new ScriptedExecutor();
  const bare = await runPass({ client: muse.client, state: freshState(), executor: bareExecutor,
    config: { ...pickerA, statusOnly: [] } });
  check("missing picker registration leaves the job pending without a run or report",
    bare.kind === "held" && bareExecutor.jobs.length === 0 &&
    ["board_accept_handoff", "board_progress_handoff", "board_complete_handoff"].every(t => calls(muse.sent.slice(beforeBare), t).length === 0) &&
    itemOf(await listed(alpha), "quiet-held")?.handoff?.state === "requested", JSON.stringify(bare));
  await hand(beta, "missing-board-registration", "new-project", "grokbot");
  const missingBoard = await runPass({ client: grokbot.client, state: freshState(), executor: bareExecutor,
    config: { ...pickerB, statusOnly: [{ project: "new-project", writer: "grokbot", board: urlB }] } });
  check("missing board registration leaves the job pending", missingBoard.kind === "held" && bareExecutor.jobs.length === 0 &&
    itemOf(await listed(beta), "missing-board-registration")?.handoff?.state === "requested");
  check("its ordinary report never landed",
    eventsFor(await listed(alpha), "quiet-held").every((t) => !t.includes("開始") && !t.startsWith("状態：")));
  stop(boardA);
  boardA.statusOnly = { schema_version: 1, status_only: [] };
  await start(boardA);
  const restored = itemOf(await listed(alpha), "quiet-held");
  check("removing the policy after a restart keeps the restriction",
    restored?.handoff?.report_mode === "status_only" &&
    await code(muse.client.call("board_accept_handoff", { item_id: "quiet-held",
      request_id: restored.handoff.request_id, report_mode: "status_only" })) === "FORBIDDEN");

} finally {
  for (const board of boards) stop(board);
  // Windows keeps the state directory locked for a moment after wrangler dev
  // is killed (same wait as board-worker/test/board.test.mjs).
  await new Promise((r) => setTimeout(r, 1000));
  if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
}

console.log(`status-only-e2e.test: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
