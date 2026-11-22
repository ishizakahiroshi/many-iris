// End-to-end test of the board's WebSocket watch under `wrangler dev`
// (local workerd, local Durable Object storage). A picker-style client
// holds a GET+Upgrade on /board/mcp with a writer key and is woken when
// work addressed to it appears — and not when someone else's does.
//
//   node test/watch.test.mjs
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempBase = process.env.BOARD_TEST_TEMP ?? tmpdir();
const temp = join(tempBase, `iris-board-watch-test-${Date.now()}`);
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}`;

const key = () => randomBytes(32).toString("hex");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const K = { alpha: key(), beta: key(), stranger: key(), vps: key() };
const writers = { schema_version: 1, writers: [
  { actor: "alpha", token_sha256: sha(K.alpha), enabled: true },
  { actor: "beta", token_sha256: sha(K.beta), enabled: false },
  { actor: "vps-claude", token_sha256: sha(K.vps), enabled: true },
] };

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
}

function wranglerJs() {
  const local = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(local)) throw new Error("Run pnpm install in board-worker first");
  return local;
}

let child = null;
async function start() {
  child = spawn(process.execPath, [wranglerJs(), "dev", "--local", "--ip", "127.0.0.1", "--port", String(port),
    "--local-upstream", `127.0.0.1:${port}`, "--upstream-protocol", "http",
    "--persist-to", join(temp, "state"), "--env-file", join(temp, "test.env"), "--show-interactive-dev-session=false"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } });
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

let rpcId = 0;
async function call(token, tool, args) {
  const r = await fetch(`${base}/board/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const body = await r.json();
  return body.error ? { rpcError: body.error } : body.result.structuredContent;
}

/** A websocket watch like the picker's: resolves on open, rejects on failure. */
function watch(token, path = "/board/mcp") {
  return new Promise((resolve, reject) => {
    const messages = [];
    const ws = new WebSocket(`${wsBase}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("watch open timed out")); }, 10000);
    ws.onopen = () => { clearTimeout(timer); resolve({ ws, messages }); };
    ws.onmessage = (e) => messages.push(e.data);
    ws.onerror = () => { clearTimeout(timer); reject(new Error("watch refused")); };
  });
}
/** A raw upgrade request (fetch refuses upgrade headers): for auth failures
 * the answer is a plain HTTP status line, so reading it is enough. */
function upgradeStatus(token, path = "/board/mcp") {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("upgrade probe timed out")); }, 10000);
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const line = buf.split("\r\n", 1)[0];
      const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(line);
      if (m !== null) { clearTimeout(timer); socket.destroy(); resolve(Number(m[1])); }
    });
    socket.on("error", (e) => { clearTimeout(timer); reject(e); });
    socket.on("connect", () => socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n` +
      (token === null ? "" : `Authorization: Bearer ${token}\r\n`) + "\r\n",
    ));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(temp, { recursive: true });
  writeFileSync(join(temp, "test.env"),
    `BOARD_WRITERS='${JSON.stringify(writers)}'\nBOARD_PUBLIC_ORIGIN=${base}\n`);
  await start();

  // --- the watch path honours the same key checks as the tool calls
  check("watch without a key is refused", (await upgradeStatus(null)) === 401);
  check("watch with a switched-off key is refused", (await upgradeStatus(K.beta)) === 403);
  check("watch with an unknown key is refused", (await upgradeStatus(K.stranger)) === 401);
  check("watch on /board/mcp/watch is refused without a key", (await upgradeStatus(null, "/board/mcp/watch")) === 401);

  // --- a real upgrade for a good key
  const w1 = await watch(K.vps);
  check("watch opens for a writer key", w1.ws.readyState === WebSocket.OPEN);

  // A handoff to someone else does not wake this watcher.
  let out = await call(K.alpha, "board_upsert_item", { item_id: "task-muse", project: "demo", kind: "task", title: "For muse", state: "planned" });
  check("item for muse is made", out.ok === true, JSON.stringify(out).slice(0, 200));
  out = await call(K.alpha, "board_request_handoff", { item_id: "task-muse", to: "muse" });
  check("handoff to muse is requested", out.ok === true, JSON.stringify(out).slice(0, 200));
  await wait(400);
  check("another writer's work does not wake", w1.messages.length === 0, w1.messages.join("|"));

  // A handoff addressed to the watcher wakes it.
  out = await call(K.alpha, "board_upsert_item", { item_id: "task-vps", project: "demo", kind: "task", title: "For vps", state: "planned" });
  out = await call(K.alpha, "board_request_handoff", { item_id: "task-vps", to: "vps-claude" });
  check("handoff to vps-claude is requested", out.ok === true, JSON.stringify(out).slice(0, 200));
  const req1 = out.handoff?.request_id ?? "";
  const deadline = Date.now() + 5000;
  while (w1.messages.length === 0 && Date.now() < deadline) await wait(50);
  check("own work wakes the watcher", w1.messages.some((m) => m.includes('"wake"')), w1.messages.join("|"));

  // While the same work stays pending, more board calls do not re-wake
  // (a picker's own pass must not loop on work it cannot take).
  const countAfterWake = w1.messages.length;
  await call(K.vps, "board_list", {});
  await call(K.alpha, "board_add_event", { item_id: "task-vps", kind: "note", text: "still pending" });
  await wait(300);
  check("no re-wake while the same work is pending", w1.messages.length === countAfterWake, w1.messages.join("|"));

  // Another request to the same watcher inside the same pending stretch is
  // still one stretch: the connection gets exactly one wake, not a second.
  out = await call(K.alpha, "board_upsert_item", { item_id: "task-vps-more", project: "demo", kind: "task", title: "More for vps", state: "planned" });
  check("a second item for vps-claude is made", out.ok === true, JSON.stringify(out).slice(0, 200));
  out = await call(K.alpha, "board_request_handoff", { item_id: "task-vps-more", to: "vps-claude" });
  check("a second request to vps-claude is made", out.ok === true, JSON.stringify(out).slice(0, 200));
  const req2 = out.handoff?.request_id ?? "";
  await wait(300);
  check("one pending stretch sends wake only once", w1.messages.length === 1, w1.messages.join("|"));

  // Take both back and request again: the new request wakes it again.
  out = await call(K.alpha, "board_take_back_handoff", { item_id: "task-vps", request_id: req1 });
  check("take back works", out.ok === true, JSON.stringify(out).slice(0, 200));
  out = await call(K.alpha, "board_take_back_handoff", { item_id: "task-vps-more", request_id: req2 });
  check("second take back works", out.ok === true, JSON.stringify(out).slice(0, 200));
  out = await call(K.alpha, "board_request_handoff", { item_id: "task-vps", to: "vps-claude" });
  check("re-requested", out.ok === true, JSON.stringify(out).slice(0, 200));
  const deadline2 = Date.now() + 5000;
  while (w1.messages.length === countAfterWake && Date.now() < deadline2) await wait(50);
  check("new request wakes the watcher again", w1.messages.length > countAfterWake, w1.messages.join("|"));
  w1.ws.close();

  // The alternate path upgrades too.
  const w2 = await watch(K.vps, "/board/mcp/watch");
  check("watch on /board/mcp/watch opens", w2.ws.readyState === WebSocket.OPEN);
  w2.ws.close();

  // --- reconnect works (the socket's attachment, not the DO's memory,
  //     carries the actor across reconnects)
  const w3 = await watch(K.vps);
  check("reconnected watch opens", w3.ws.readyState === WebSocket.OPEN);
  w3.ws.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
}

try {
  await main();
} finally {
  stop();
  // workerd lets go of its files a moment after it is stopped (Windows refuses
  // to remove them before), so wait and retry instead of leaving the folder.
  await new Promise((r) => setTimeout(r, 1000));
  try { rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { console.log(`could not remove ${temp}: ${e.code ?? e}`); }
}
process.exit(failures.length === 0 ? 0 : 1);
