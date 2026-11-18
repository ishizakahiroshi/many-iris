// End-to-end test of the scheduled dispatcher against a stand-in Devin API
// (a local HTTP server whose answers this test controls), under
// `wrangler dev` with a real Durable Object. It covers what the stand-in
// tests in route.test.mjs cannot: the claim is written on the real board
// BEFORE the session starts, two scheduled ticks racing each other start
// one session, a lost start answer is never retried on its own and waits
// for board_resolve_dispatch, and work taken back while its session is
// still starting is refused to that session at accept time.
//
//   node test/dispatch.test.mjs
import { spawn, execFileSync } from "node:child_process";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempBase = process.env.BOARD_TEST_TEMP ?? tmpdir();
const temp = join(tempBase, `iris-board-dispatch-test-${Date.now()}`);
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

const key = () => randomBytes(32).toString("hex");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const K = { alpha: key(), devin: key() };
const writers = { schema_version: 1, writers: [
  { actor: "alpha", token_sha256: sha(K.alpha), enabled: true },
  { actor: "devin", token_sha256: sha(K.devin), enabled: true },
] };

// A stand-in for Cloudflare Access (same shape as test/board.test.mjs).
const certsPort = 19000 + Math.floor(Math.random() * 1000);
const team = `http://127.0.0.1:${certsPort}`;
const AUD = randomBytes(32).toString("hex");
const OWNER = "owner@example.com";
const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid-1";
const certsServer = createServer((req, res) => {
  if (req.url !== "/cdn-cgi/access/certs") { res.writeHead(404).end(); return; }
  const jwk = signing.publicKey.export({ format: "jwk" });
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }));
});
const b64u = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function jwt(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: team, aud: [AUD], email: OWNER, iat: now, nbf: now, exp: now + 600, sub: "u1", type: "app", ...claims };
  const head = `${b64u({ alg: "RS256", kid: KID, typ: "JWT" })}.${b64u(body)}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(signing.privateKey).toString("base64url")}`;
}
const jar = { "cf-access-jwt-assertion": jwt() };

// The Devin stand-in: records every start, and answers as this test says.
const devinPort = 17000 + Math.floor(Math.random() * 1000);
let devinMode = "ok";
let devinDelayMs = 0;
const devinPosts = [];
const devinServer = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const requestId = /request_id: (REQ-[0-9A-Za-z-]+)/.exec(body)?.[1] ?? "?";
  devinPosts.push({ request_id: requestId, at: Date.now() });
  if (devinDelayMs) await new Promise((r) => setTimeout(r, devinDelayMs));
  if (devinMode === "fail") { res.writeHead(500).end("no"); return; }
  res.writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ session_id: `sess-${devinPosts.length}`, url: "https://app.devin.ai/sessions/x" }));
});
const postsFor = (request) => devinPosts.filter((p) => p.request_id === request).length;

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(name, cond, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(250);
  }
  return cond();
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
    "--persist-to", join(temp, "state"), "--env-file", join(temp, "test.env"), "--show-interactive-dev-session=false", "--test-scheduled"],
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
    await sleep(500);
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
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const body = await r.json();
  if (body.error) return { rpcError: body.error };
  return body.result.structuredContent;
}
const code = (res) => res?.error?.code ?? res?.rpcError?.code ?? "OK";
const tick = () => fetch(`${base}/__scheduled?cron=*/10+*+*+*+*`);
const eventsOf = async (id) => (await call(K.alpha, "board_list", {})).events.filter((e) => e.item_id === id);
const handoffOf = async (id) => (await call(K.alpha, "board_list", { since_seq: 999999 })).items.find((i) => i.item_id === id)?.handoff;
const ownerPost = (body) => fetch(`${base}/api/board/item`, {
  method: "POST", headers: { "content-type": "application/json", origin: base, ...jar }, body: JSON.stringify(body),
});
const ownerCode = async (body) => { const a = await ownerPost(body); return `${a.status} ${(await a.json()).code ?? "OK"}`; };

async function main() {
  mkdirSync(temp, { recursive: true });
  writeFileSync(join(temp, "test.env"),
    `BOARD_WRITERS='${JSON.stringify(writers)}'\nACCESS_TEAM_DOMAIN=${team}\nACCESS_AUD=${AUD}\nBOARD_OWNERS=${OWNER}\nBOARD_PUBLIC_ORIGIN=${base}\nDEVIN_API_KEY=test-devin-key\nDEVIN_SESSIONS_URL=http://127.0.0.1:${devinPort}/sessions\n`);
  await new Promise((r) => certsServer.listen(certsPort, "127.0.0.1", r));
  await new Promise((r) => devinServer.listen(devinPort, "127.0.0.1", r));
  await start();

  await call(K.alpha, "board_upsert_item", { item_id: "dp", project: "demo", kind: "project", title: "Demo", state: "in_progress" });
  const pile = async (id) => {
    await call(K.alpha, "board_upsert_item", { item_id: id, project: "demo", kind: "task", title: `work ${id}`, state: "planned" });
    const hand = await call(K.alpha, "board_request_handoff", { item_id: id, to: "devin" });
    return hand.handoff?.request_id ?? "";
  };

  // --- a claimed start, confirmed by its answer
  const req1 = await pile("dt1");
  check("work is handed to devin", req1.startsWith("REQ-"), req1);
  await tick();
  check("the dispatcher starts one session", await waitFor("post", () => postsFor(req1) === 1), `posts=${postsFor(req1)}`);
  check("the start is recorded on the board", await waitFor("event", async () =>
    (await eventsOf("dt1")).some((e) => e.actor === "dispatcher" && e.text.startsWith(`dispatched ${req1} to devin session`))));
  await tick();
  await sleep(1500);
  check("a started request is not started twice", postsFor(req1) === 1, `posts=${postsFor(req1)}`);

  // --- two ticks racing: the atomic claim lets only one of them start it
  const req2 = await pile("dt2");
  devinDelayMs = 900;
  await Promise.all([tick(), tick()]);
  await waitFor("post", () => postsFor(req2) >= 1);
  await sleep(2500);
  devinDelayMs = 0;
  check("two racing ticks start one session", postsFor(req2) === 1, `posts=${postsFor(req2)}`);

  // --- the start's answer is lost: unknown, never retried, settled by a person
  const req3 = await pile("dt3");
  devinMode = "fail";
  await tick();
  check("the failing start was tried once", await waitFor("post", () => postsFor(req3) === 1), `posts=${postsFor(req3)}`);
  check("the board is told the outcome is unknown", await waitFor("event", async () =>
    (await eventsOf("dt3")).some((e) => e.actor === "dispatcher" && e.text.includes(`dispatch of ${req3}`) && e.text.includes("unknown"))));
  await tick();
  await sleep(1500);
  check("an unknown start is never retried on its own", postsFor(req3) === 1, `posts=${postsFor(req3)}`);
  check("settling a dispatch that is not unknown is refused",
    code(await call(K.alpha, "board_resolve_dispatch", { request_id: req1, resolution: "retry" })) === "HANDOFF_CONFLICT");
  const settled = await call(K.alpha, "board_resolve_dispatch", { request_id: req3, resolution: "retry" });
  check("a person settles the unknown start as not running", settled.ok === true && settled.changed === true, JSON.stringify(settled));
  devinMode = "ok";
  await tick();
  check("after the settlement the dispatcher starts it again", await waitFor("post", () => postsFor(req3) === 2), `posts=${postsFor(req3)}`);

  // --- settled as started: the session takes the work itself
  const req4 = await pile("dt4");
  devinMode = "fail";
  await tick();
  check("the second failing start was tried once", await waitFor("post", () => postsFor(req4) === 1), `posts=${postsFor(req4)}`);
  await waitFor("event", async () => (await eventsOf("dt4")).some((e) => e.text.includes("unknown")));
  const settledStarted = await call(K.alpha, "board_resolve_dispatch", { request_id: req4, resolution: "started", session_id: "sess-manual" });
  check("a person settles the unknown start as running", settledStarted.ok === true, JSON.stringify(settledStarted));
  check("the settlement is recorded on the item", (await eventsOf("dt4")).some((e) => e.text.includes("sess-manual")), "");
  check("settling it twice is refused", code(await call(K.alpha, "board_resolve_dispatch", { request_id: req4, resolution: "retry" })) === "HANDOFF_CONFLICT");
  devinMode = "ok";
  await tick();
  await sleep(1500);
  check("a session settled as started is not started again", postsFor(req4) === 1, `posts=${postsFor(req4)}`);

  // --- taken back while its session is still starting
  const req5 = await pile("dt5");
  devinDelayMs = 1200;
  const racing = tick();
  check("the start begins", await waitFor("post", () => postsFor(req5) === 1, 10000), `posts=${postsFor(req5)}`);
  check("the owner takes the work back while it is starting", (await ownerCode({ op: "take_back", item_id: "dt5" })) === "200 OK");
  await racing;
  await sleep(2500);
  devinDelayMs = 0;
  check("the work stays taken back", (await handoffOf("dt5")) === null);
  check("the started session is refused the work at accept time",
    code(await call(K.devin, "board_accept_handoff", { item_id: "dt5", request_id: req5 })) === "HANDOFF_CONFLICT");
  check("the session did start once (it cannot be unstarted)", postsFor(req5) === 1, `posts=${postsFor(req5)}`);
}

let crashed = null;
try {
  await main();
} catch (e) {
  crashed = e;
} finally {
  stop();
  certsServer.close();
  devinServer.close();
  await sleep(1000);
  if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
}
if (crashed) {
  console.error(`CRASHED: ${crashed.stack ?? crashed}`);
  console.error(`before the crash: passed ${passed}, failed ${failures.length}`);
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(2);
}
console.log(`passed ${passed}, failed ${failures.length}`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
