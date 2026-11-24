// End-to-end test of the picker against the real board Worker
// (`wrangler dev`, local Durable Object storage), in the same shape
// as board-worker's own board.test.mjs. Keys are made up for this
// run only; the temp folder is removed at the end.
//
// The handoff in this test is writer-handed (requested_by is the
// requesting writer), so the picker runs with the owner gate off;
// the gate itself is measured in picker.test.mjs. What this test
// proves against the real board: the fenced round trip (accept ->
// heartbeat -> progress -> complete) works over the wire, work for
// another writer is left alone, and a second pass finds nothing.
//
//   node test/picker-e2e.test.mjs
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardClient, BoardUnreachable } from "../src/board-client.mjs";
import { CommandExecutor, RecordExecutor } from "../src/executors.mjs";
import { runPass } from "../src/picker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const boardRoot = join(here, "..", "..", "board-worker");
const temp = join(tmpdir(), `iris-picker-e2e-${Date.now()}`);
const port = 19000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;

const key = () => randomBytes(32).toString("hex");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const K = { alpha: key(), picker: key(), restricted: key() };
const writers = {
  schema_version: 1,
  writers: [
    { actor: "alpha", token_sha256: sha(K.alpha), enabled: true },
    { actor: "muse", token_sha256: sha(K.picker), enabled: true },
    { actor: "grokbot", token_sha256: sha(K.restricted), enabled: true, policy: "restricted" },
  ],
};

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
}

let child = null;
async function start() {
  const wranglerJs = join(boardRoot, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(wranglerJs)) throw new Error("Run npm install in board-worker first");
  mkdirSync(temp, { recursive: true });
  writeFileSync(join(temp, "test.env"),
    `BOARD_WRITERS='${JSON.stringify(writers)}'\nACCESS_TEAM_DOMAIN=http://127.0.0.1:9\nACCESS_AUD=${randomBytes(32).toString("hex")}\nBOARD_OWNERS=owner@example.com\nBOARD_LEASE_MS=60000\nBOARD_PUBLIC_ORIGIN=${base}\n`);
  child = spawn(process.execPath, [wranglerJs, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port),
    "--local-upstream", `127.0.0.1:${port}`, "--upstream-protocol", "http",
    "--persist-to", join(temp, "state"), "--env-file", join(temp, "test.env"), "--show-interactive-dev-session=false"],
    { cwd: boardRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not start:\n${log.slice(-3000)}`);
}
function stop() {
  if (child === null || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  } else child.kill("SIGTERM");
  child = null;
}

const freshState = () => {
  const s = { runs: 0 };
  return { runsToday: () => s.runs, recordRun: () => { s.runs += 1; } };
};

try {
  await start();
  const alpha = new BoardClient({ url: `${base}/board/mcp`, key: K.alpha });
  const pickerClient = new BoardClient({ url: `${base}/board/mcp`, key: K.picker });
  const config = { writer: "muse", projects: [], ownerOnly: false, heartbeatMs: 200, maxRunsPerDay: 6 };

  // Work handed to the picker, and work handed to somebody else.
  await alpha.call("board_upsert_item", { item_id: "job1", project: "demo", kind: "task", title: "Write the summary", state: "planned" });
  const handed = await alpha.call("board_request_handoff", { item_id: "job1", to: "muse" });
  check("the handoff was issued", handed?.handoff?.state === "requested" && typeof handed.handoff.request_id === "string", JSON.stringify(handed?.handoff));
  await alpha.call("board_upsert_item", { item_id: "job2", project: "demo", kind: "task", title: "Not for the picker", state: "planned" });
  await alpha.call("board_request_handoff", { item_id: "job2", to: "devin" });

  const executor = new RecordExecutor();
  const outcome = await runPass({ client: pickerClient, config, executor, state: freshState() });
  check("the pass ran the picker's job", outcome.kind === "ran" && outcome.finished === true, JSON.stringify(outcome));
  check("the executor received the handed-over title", executor.jobs.length === 1 && executor.jobs[0].title === "Write the summary");

  const items = await pickerClient.listItems();
  const job1 = items.find((i) => i.item_id === "job1");
  const job2 = items.find((i) => i.item_id === "job2");
  check("job1 is done on the board", job1?.state === "done", JSON.stringify(job1?.state));
  check("job1's handoff is completed with a generation", job1?.handoff?.state === "completed" && job1?.handoff?.generation === 1, JSON.stringify(job1?.handoff));
  check("job2 was left exactly as it was", job2?.state === "planned" && job2?.handoff?.state === "requested", JSON.stringify(job2?.handoff));

  const second = await runPass({ client: pickerClient, config, executor: new RecordExecutor(), state: freshState() });
  check("a second pass finds nothing to take", second.kind === "nothing", JSON.stringify(second));

  // The record of the run is on the board as events.
  const withEvents = await pickerClient.call("board_list", { since_seq: 0 });
  const texts = (withEvents.events ?? []).filter((e) => e.item_id === "job1").map((e) => e.text ?? "");
  check("the run's start and record are events on job1",
    texts.some((t) => t.includes("開始")) && texts.some((t) => t.includes("記録のみ")),
    JSON.stringify(texts));

  await alpha.call("board_upsert_item", { item_id: "phase-job", project: "demo", kind: "task", title: "Check fixtures", state: "planned" });
  await alpha.call("board_request_handoff", { item_id: "phase-job", to: "muse" });
  const fixture = `
    const { writeSync } = require('node:fs');
    console.error('awaiting_input');
    writeSync(3, 'investig');
    writeSync(3, 'ating\\n' + 'x'.repeat(128) + 'testing\\n' + 'testing\\ntesting\\n');
    console.log('fixture result');
  `;
  const command = new CommandExecutor({ command: process.execPath, args: ["-e", fixture] });
  const phaseRun = await runPass({ client: pickerClient, config, executor: command, state: freshState() });
  check("a real command with milestones still completes", phaseRun.finished === true);
  const phaseBoard = await alpha.call("board_list", { since_seq: 0 });
  const phaseNotes = phaseBoard.events.filter(e => e.item_id === "phase-job" && e.text.startsWith("工程："));
  check("only explicit changes are published, in order, before completion",
    phaseNotes.map(e => e.text).join("/") === "工程：作業コマンド起動/工程：調査中/工程：テスト中", JSON.stringify(phaseNotes));
  const latest = phaseBoard.items.find(i => i.item_id === "phase-job").handoff;
  check("the stored phase has its own report time", latest.phase === "テスト中" && latest.phase_at === phaseNotes.at(-1)?.at);

  const restrictedClient = new BoardClient({ url: `${base}/board/mcp`, key: K.restricted });
  const restrictedMine = await restrictedClient.listMine();
  check("restricted picker discovery uses the restricted credential successfully", restrictedMine.items.length === 0);
  const fallbackCalls = [];
  const oldBoardFallback = new BoardClient({ url: `${base}/board/mcp`, key: K.restricted, fetchImpl: async (url, init) => {
    const request = JSON.parse(init.body);
    const tool = request.params.name;
    fallbackCalls.push(tool);
    if (tool === "board_my_work") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Unknown or invalid tool" } }), { status: 200 });
    }
    return fetch(url, init);
  } });
  let fallbackRefused = false;
  try { await oldBoardFallback.listMine(); } catch (error) { fallbackRefused = error instanceof BoardUnreachable; }
  check("legacy picker fallback is denied by the actual restricted Worker", fallbackRefused && fallbackCalls.join(",") === "board_my_work,board_list");
} finally {
  stop();
  // Windows keeps the state directory locked for a moment after wrangler dev is killed
  // (same wait as board-worker/test/board.test.mjs).
  await new Promise((r) => setTimeout(r, 1000));
  if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
}

console.log(`picker-e2e.test: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
