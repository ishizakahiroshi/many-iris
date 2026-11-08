// End-to-end test of the board Worker under `wrangler dev` (local workerd,
// local Durable Object storage). Keys are made up for this run only; the temp
// folder is removed at the end.
//
//   node test/board.test.mjs
import { spawn, execFileSync } from "node:child_process";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempBase = process.env.BOARD_TEST_TEMP ?? tmpdir();
const temp = join(tempBase, `iris-board-worker-test-${Date.now()}`);
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

const key = () => randomBytes(32).toString("hex");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const K = { alpha: key(), beta: key(), stranger: key() };
const writers = { schema_version: 1, writers: [
  { actor: "alpha", token_sha256: sha(K.alpha), enabled: true },
  { actor: "beta", token_sha256: sha(K.beta), enabled: false },
] };

// A stand-in for Cloudflare Access: a local server publishes the signing key the
// way <team>.cloudflareaccess.com/cdn-cgi/access/certs does, and the test signs
// tokens like the ones Access adds in Cf-Access-Jwt-Assertion.
const certsPort = 19000 + Math.floor(Math.random() * 1000);
const team = `http://127.0.0.1:${certsPort}`;
const AUD = randomBytes(32).toString("hex");
const OWNER = "owner@example.com";
const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
const forger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid-1";
const certsServer = createServer((req, res) => {
  if (req.url !== "/cdn-cgi/access/certs") { res.writeHead(404).end(); return; }
  const jwk = signing.publicKey.export({ format: "jwk" });
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }));
});
const b64u = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function jwt(claims = {}, { key = signing.privateKey, kid = KID, alg = "RS256" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: team, aud: [AUD], email: OWNER, iat: now, nbf: now, exp: now + 600, sub: "u1", type: "app", ...claims };
  const head = `${b64u({ alg, kid, typ: "JWT" })}.${b64u(body)}`;
  if (alg !== "RS256") return `${head}.`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(key).toString("base64url")}`;
}
const asOwner = (token = jwt()) => ({ "cf-access-jwt-assertion": token });

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
async function mcpRaw(token, body, headers = {}) {
  const h = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers };
  if (token !== null) h.authorization = `Bearer ${token}`;
  return fetch(`${base}/board/mcp`, { method: "POST", headers: h, body: typeof body === "string" ? body : JSON.stringify(body) });
}
async function rpc(token, method, params = {}) {
  const r = await mcpRaw(token, { jsonrpc: "2.0", id: ++rpcId, method, params });
  return { status: r.status, body: await r.json() };
}
async function call(token, tool, args) {
  const { body } = await rpc(token, "tools/call", { name: tool, arguments: args });
  if (body.error) return { rpcError: body.error };
  return body.result.structuredContent;
}
const code = (res) => res?.error?.code ?? res?.rpcError?.code ?? "OK";

async function main() {
  mkdirSync(temp, { recursive: true });
  writeFileSync(join(temp, "test.env"),
    `BOARD_WRITERS='${JSON.stringify(writers)}'\nACCESS_TEAM_DOMAIN=${team}\nACCESS_AUD=${AUD}\nBOARD_OWNERS=other@example.com, ${OWNER.toUpperCase()}\nBOARD_LIMIT_ITEMS=12\n`);
  await new Promise((r) => certsServer.listen(certsPort, "127.0.0.1", r));
  await start();

  // --- pages and Cloudflare Access
  const status = async (headers) => (await fetch(`${base}/api/board`, { headers })).status;
  let r = await fetch(`${base}/board`);
  check("board without Access is refused", r.status === 401);
  check("pages carry security headers", (r.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"));
  check("api without Access is refused", (await status({})) === 401);
  check("writer key cannot read the page data", (await status({ authorization: `Bearer ${K.alpha}` })) === 401);
  check("another email is refused", (await status(asOwner(jwt({ email: "someone@example.com" })))) === 403);
  check("another application (aud) is refused", (await status(asOwner(jwt({ aud: ["0".repeat(64)] })))) === 403);
  check("another team (iss) is refused", (await status(asOwner(jwt({ iss: "https://evil.cloudflareaccess.com" })))) === 403);
  check("an expired token is refused", (await status(asOwner(jwt({ exp: Math.floor(Date.now() / 1000) - 3600 })))) === 403);
  check("a token not yet valid is refused", (await status(asOwner(jwt({ nbf: Math.floor(Date.now() / 1000) + 3600 })))) === 403);
  check("a token signed by another key is refused", (await status(asOwner(jwt({}, { key: forger.privateKey })))) === 403);
  check("an unsigned token (alg none) is refused", (await status(asOwner(jwt({}, { alg: "none" })))) === 403);
  check("an unknown key id is refused", (await status(asOwner(jwt({}, { kid: "other-kid" })))) === 403);
  check("a broken token is refused", (await status(asOwner("a.b"))) === 403);
  r = await fetch(`${base}/board`, { headers: asOwner() });
  let text = await r.text();
  check("board for the owner shows the board", r.status === 200 && text.includes("board-projects") && !text.includes("__IRIS_UI_TOKEN__"));
  const jar = asOwner();
  r = await fetch(`${base}/api/board`, { headers: jar });
  let page = await r.json();
  check("empty board reads", r.status === 200 && page.ok === true && page.items.length === 0 && page.counts.items === 0);
  check("owner email matches without case", (await status(asOwner(jwt({ email: "Owner@Example.com" })))) === 200);
  check("the sign-in by key is gone", (await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: "{}" })).status === 404);  for (const f of ["/board.js", "/board.css", "/app.css"]) {
    check(`static ${f}`, (await fetch(`${base}${f}`)).status === 200);
  }
  check("unknown path is 404", (await fetch(`${base}/index.html`)).status === 404);

  // --- writer keys and the MCP handshake
  check("MCP without a key is refused", (await mcpRaw(null, { jsonrpc: "2.0", id: 1, method: "ping", params: {} })).status === 401);
  check("MCP with a switched-off key is refused", (await mcpRaw(K.beta, { jsonrpc: "2.0", id: 1, method: "ping", params: {} })).status === 403);
  check("MCP with an unknown key is refused", (await mcpRaw(K.stranger, { jsonrpc: "2.0", id: 1, method: "ping", params: {} })).status === 401);
  check("MCP from a browser on another site is refused",
    (await mcpRaw(K.alpha, { jsonrpc: "2.0", id: 1, method: "ping", params: {} }, { origin: "https://evil.example" })).status === 403);
  check("MCP GET is refused", (await fetch(`${base}/board/mcp`, { headers: { authorization: `Bearer ${K.alpha}` } })).status === 405);
  check("MCP needs JSON content", (await mcpRaw(K.alpha, "{}", { "content-type": "text/plain" })).status === 415);
  check("MCP body over 64 KB is refused", (await mcpRaw(K.alpha, JSON.stringify({ pad: "x".repeat(70000) }))).status === 413);
  check("broken JSON is refused", (await mcpRaw(K.alpha, "{")).status === 400);
  let res = await rpc(K.alpha, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  check("initialize answers", res.status === 200 && res.body.result.protocolVersion === "2025-06-18" && res.body.result.serverInfo.name === "many-iris-board");
  check("notification gets 202", (await mcpRaw(K.alpha, { jsonrpc: "2.0", method: "notifications/initialized" })).status === 202);
  res = await rpc(K.alpha, "tools/list");
  check("three tools", res.body.result.tools.map((t) => t.name).join(",") === "board_upsert_item,board_add_event,board_list");
  check("unknown method is 404", (await rpc(K.alpha, "resources/list")).status === 404);
  check("unsupported per-request version is refused",
    (await rpc(K.alpha, "ping", { _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01" } })).status === 400);
  check("unknown tool", code(await call(K.alpha, "board_delete", {})) === -32602);

  // --- items
  let out = await call(K.alpha, "board_upsert_item", { item_id: "p1", project: "demo", kind: "project", title: "Demo", state: "in_progress" });
  check("create a project", out.ok === true && out.changed === true && out.item.revision === 1 && out.item.updated_by === "alpha");
  out = await call(K.alpha, "board_upsert_item", { item_id: "p1", project: "demo", kind: "project", title: "Demo", state: "in_progress" });
  check("same content changes nothing", out.ok === true && out.changed === false && out.item.revision === 1);
  check("actor in the body is refused", code(await call(K.alpha, "board_upsert_item", { item_id: "p1", actor: "someone" })) === -32602);
  check("missing fields on create", code(await call(K.alpha, "board_upsert_item", { item_id: "new1", title: "x" })) === "INVALID");
  check("bad kind", code(await call(K.alpha, "board_upsert_item", { item_id: "x1", project: "demo", kind: "epic", title: "x", state: "planned" })) === "INVALID");
  check("hidden direction character in title",
    code(await call(K.alpha, "board_upsert_item", { item_id: "x2", project: "demo", kind: "task", title: "abc\u202Edef", state: "planned" })) === "INVALID");
  check("absolute source_ref", code(await call(K.alpha, "board_upsert_item", { item_id: "p1", source_ref: "C:/work/x.md" })) === "INVALID");
  check("parent traversal in source_ref", code(await call(K.alpha, "board_upsert_item", { item_id: "p1", source_ref: "docs/../x.md" })) === "INVALID");
  out = await call(K.alpha, "board_upsert_item", { item_id: "p1", source_ref: "docs/local/plan_demo.md" });
  check("relative source_ref", out.ok === true && out.item.source_ref === "docs/local/plan_demo.md" && out.item.revision === 2);
  check("invalid date", code(await call(K.alpha, "board_upsert_item", { item_id: "p1", planned_start: "2026-02-29" })) === "INVALID");
  check("end before start", code(await call(K.alpha, "board_upsert_item", { item_id: "p1", planned_start: "2026-11-10", planned_end: "2026-11-09" })) === "INVALID");
  check("revision conflict", code(await call(K.alpha, "board_upsert_item", { item_id: "p1", title: "Demo 2", expected_revision: 1 })) === "REVISION_CONFLICT");
  out = await call(K.alpha, "board_upsert_item", { item_id: "p1", title: "Demo 2", expected_revision: 2 });
  check("matching revision writes", out.ok === true && out.item.revision === 3);
  check("waiting needs a reason", code(await call(K.alpha, "board_upsert_item", { item_id: "p1", state: "waiting" })) === "INVALID");
  check("reason only while waiting", code(await call(K.alpha, "board_upsert_item", { item_id: "p1", waiting_reason: "x" })) === "INVALID");
  out = await call(K.alpha, "board_upsert_item", { item_id: "p1", state: "waiting", waiting_reason: "user answer" });
  check("waiting with a reason", out.ok === true && out.item.waiting_reason === "user answer");
  out = await call(K.alpha, "board_upsert_item", { item_id: "p1", state: "in_progress" });
  check("leaving waiting drops the reason", out.ok === true && out.item.waiting_reason === null);

  // --- tree rules
  out = await call(K.alpha, "board_upsert_item", { item_id: "c1", project: "demo", kind: "plan", title: "Plan", state: "planned", parent_id: "p1" });
  check("child under a parent", out.ok === true && out.item.parent_id === "p1");
  check("missing parent", code(await call(K.alpha, "board_upsert_item", { item_id: "c2", project: "demo", kind: "task", title: "t", state: "planned", parent_id: "nope" })) === "PARENT_NOT_FOUND");
  check("own parent", code(await call(K.alpha, "board_upsert_item", { item_id: "c1", parent_id: "c1" })) === "CYCLE");
  check("cycle", code(await call(K.alpha, "board_upsert_item", { item_id: "p1", parent_id: "c1" })) === "CYCLE");
  await call(K.alpha, "board_upsert_item", { item_id: "o1", project: "other", kind: "project", title: "Other", state: "planned" });
  check("parent in another project", code(await call(K.alpha, "board_upsert_item", { item_id: "c1", parent_id: "o1" })) === "PROJECT_MISMATCH");
  check("moving away from children", code(await call(K.alpha, "board_upsert_item", { item_id: "p1", project: "other" })) === "PROJECT_MISMATCH");
  let parent = "c1";
  for (const id of ["d3", "d4", "d5", "d6"]) {
    out = await call(K.alpha, "board_upsert_item", { item_id: id, project: "demo", kind: "task", title: id, state: "planned", parent_id: parent });
    parent = id;
  }
  check("six levels are allowed", out.ok === true);
  check("a seventh level is refused", code(await call(K.alpha, "board_upsert_item", { item_id: "d7", project: "demo", kind: "task", title: "d7", state: "planned", parent_id: "d6" })) === "DEPTH");
  check("a refused write leaves nothing", (await call(K.alpha, "board_list", { project: "demo" })).items.every((i) => i.item_id !== "d7"));

  // --- events
  out = await call(K.alpha, "board_add_event", { item_id: "c1", kind: "note", text: "line 1\nline 2", ref: "https://github.com/example/repo/pull/1" });
  check("note with a link", out.ok === true && out.event.actor === "alpha" && out.event.seq > 0);
  check("state_change cannot be written", code(await call(K.alpha, "board_add_event", { item_id: "c1", kind: "state_change", text: "x" })) === "INVALID");
  check("http link refused", code(await call(K.alpha, "board_add_event", { item_id: "c1", kind: "note", text: "x", ref: "http://example.com" })) === "INVALID");
  check("event on a missing item", code(await call(K.alpha, "board_add_event", { item_id: "nope", kind: "note", text: "x" })) === "NOT_FOUND");
  let list = await call(K.alpha, "board_list", {});
  const p1Events = list.events.filter((e) => e.item_id === "p1").map((e) => e.text);
  check("state changes are recorded by the board",
    p1Events.includes("in_progress -> waiting (user answer)") && p1Events.includes("waiting -> in_progress"), p1Events.join(" | "));
  check("items carry their latest event", list.items.find((i) => i.item_id === "c1").last_event.kind === "note");
  const since = list.next_since_seq;
  await call(K.alpha, "board_add_event", { item_id: "p1", kind: "session_start", text: "start" });
  list = await call(K.alpha, "board_list", { since_seq: since });
  check("since_seq returns only newer events", list.events.length === 1 && list.events[0].text === "start");
  list = await call(K.alpha, "board_list", { project: "other" });
  check("project filter", list.items.length === 1 && list.items[0].item_id === "o1");

  // --- the item limit (12 in this run)
  let lastCode = "OK";
  for (let n = 0; n < 12 && lastCode === "OK"; n++) {
    lastCode = code(await call(K.alpha, "board_upsert_item", { item_id: `fill${n}`, project: "demo", kind: "task", title: `f${n}`, state: "planned" }));
  }
  check("item limit", lastCode === "BOARD_ITEM_LIMIT");
  list = await call(K.alpha, "board_list", {});
  check("item count stays at the limit", list.counts.items === 12, String(list.counts.items));

  // --- page data
  page = await (await fetch(`${base}/api/board`, { headers: jar })).json();
  check("page lists newest event first", page.events[0].seq > page.events[page.events.length - 1].seq);

  // --- survives a restart
  const before = list.counts;
  stop();
  await new Promise((r) => setTimeout(r, 1500));
  await start();
  list = await call(K.alpha, "board_list", {});
  check("data survives a restart", list.counts.items === before.items && list.counts.events === before.events,
    `${JSON.stringify(before)} -> ${JSON.stringify(list.counts)}`);
}

let crashed = null;
try {
  await main();
} catch (e) {
  crashed = e;
} finally {
  stop();
  certsServer.close();
  await new Promise((r) => setTimeout(r, 1000));
  if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
}
if (crashed) {
  console.error(`CRASHED: ${crashed.stack ?? crashed}`);
  process.exit(2);
}
console.log(`passed ${passed}, failed ${failures.length}`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
