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
const K = { alpha: key(), beta: key(), stranger: key(), muse: key(), vps: key(), local: key(), restricted: key(), restrictedRevoked: key() };
const writers = { schema_version: 1, writers: [
  { actor: "alpha", token_sha256: sha(K.alpha), enabled: true },
  { actor: "beta", token_sha256: sha(K.beta), enabled: false },
  { actor: "muse", token_sha256: sha(K.muse), enabled: true },
  { actor: "vps-claude", token_sha256: sha(K.vps), enabled: true },
  { actor: "local-claude", token_sha256: sha(K.local), enabled: true },
  { actor: "grokbot", token_sha256: sha(K.restricted), enabled: true, policy: "restricted" },
  { actor: "vps-devin", token_sha256: sha(K.restrictedRevoked), enabled: false, policy: "restricted" },
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
  // --local-upstream keeps request.url on this test's own origin (not the production route),
  // which is the origin the OAuth resource and issuer are configured with.
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

function writeTestEnv() {
  writeFileSync(join(temp, "test.env"),
    `BOARD_WRITERS='${JSON.stringify(writers)}'\nACCESS_TEAM_DOMAIN=${team}\nACCESS_AUD=${AUD}\nBOARD_OWNERS=other@example.com, ${OWNER.toUpperCase()}\nBOARD_LIMIT_ITEMS=27\nBOARD_LEASE_MS=2000\nBOARD_PUBLIC_ORIGIN=${base}\n`);
}
async function main() {
  mkdirSync(temp, { recursive: true });
  writeTestEnv();
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
  check("a revoked restricted credential is refused", (await mcpRaw(K.restrictedRevoked, { jsonrpc: "2.0", id: 1, method: "ping", params: {} })).status === 403);
  check("MCP with an unknown key is refused", (await mcpRaw(K.stranger, { jsonrpc: "2.0", id: 1, method: "ping", params: {} })).status === 401);
  check("MCP from a browser on another site is refused",
    (await mcpRaw(K.alpha, { jsonrpc: "2.0", id: 1, method: "ping", params: {} }, { origin: "https://evil.example" })).status === 403);
  check("MCP GET is refused", (await fetch(`${base}/board/mcp`, { headers: { authorization: `Bearer ${K.alpha}` } })).status === 405);
  check("MCP needs JSON content", (await mcpRaw(K.alpha, "{}", { "content-type": "text/plain" })).status === 415);
  check("MCP body over 128 KB is refused", (await mcpRaw(K.alpha, JSON.stringify({ pad: "x".repeat(140000) }))).status === 413);
  check("broken JSON is refused", (await mcpRaw(K.alpha, "{")).status === 400);
  let res = await rpc(K.alpha, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  check("initialize answers", res.status === 200 && res.body.result.protocolVersion === "2025-06-18" && res.body.result.serverInfo.name === "many-iris-board");
  check("notification gets 202", (await mcpRaw(K.alpha, { jsonrpc: "2.0", method: "notifications/initialized" })).status === 202);
  res = await rpc(K.alpha, "tools/list");
  check("twenty tools", res.body.result?.tools?.map((t) => t.name).join(",") === "board_upsert_item,board_add_event,board_list,board_my_work,board_request_status,board_request_handoff,board_accept_handoff,board_route_handoff,board_take_back_handoff,board_heartbeat_handoff,board_progress_handoff,board_complete_handoff,board_mark_handoff_unknown,board_release_handoff,board_resume_handoff,board_chat_pending,board_chat_take,board_chat_attachment,board_chat_reply,board_resolve_dispatch",
    `${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  check("unknown method is 404", (await rpc(K.alpha, "resources/list")).status === 404);
  check("unsupported per-request version is refused",
    (await rpc(K.alpha, "ping", { _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01" } })).status === 400);
  check("unknown tool", code(await call(K.alpha, "board_delete", {})) === -32602);
  res = await rpc(K.restricted, "tools/list");
  check("restricted discovery exposes only own-work and run reporting",
    res.body.result?.tools?.map((t) => t.name).join(",") === "board_my_work,board_accept_handoff,board_heartbeat_handoff,board_progress_handoff,board_complete_handoff");
  check("restricted call cannot reach legacy attachment reads", code(await call(K.restricted, "board_chat_attachment", { attachment_id: "0".repeat(32) })) === -32602);
  check("restricted call cannot reach board_list", code(await call(K.restricted, "board_list", {})) === -32602);
  check("restricted call cannot reach request status", code(await call(K.restricted, "board_request_status", { item_id: "synthetic-b" })) === -32602);

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
  // Work is often recorded first and tied to its plan afterwards.
  await call(K.alpha, "board_upsert_item", { item_id: "late1", project: "demo", kind: "task", title: "late", state: "planned" });
  out = await call(K.alpha, "board_upsert_item", { item_id: "late1", parent_id: "p1" });
  check("an existing item can be put under a parent later", out.ok === true && out.item.parent_id === "p1" && out.item.title === "late");
  out = await call(K.alpha, "board_upsert_item", { item_id: "late1", parent_id: "c1" });
  check("an existing item can be moved to another parent", out.ok === true && out.item.parent_id === "c1");

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

  // --- OAuth for clients that cannot send a writer key (ChatGPT)
  const resource = `${base}/board/mcp`;
  r = await mcpRaw(null, { jsonrpc: "2.0", id: 1, method: "ping", params: {} });
  const challenge = r.headers.get("www-authenticate") ?? "";
  check("MCP without a token points to the resource metadata",
    r.status === 401 && challenge.includes(`resource_metadata="${base}/.well-known/oauth-protected-resource/board/mcp"`), challenge);
  r = await fetch(`${base}/.well-known/oauth-protected-resource/board/mcp`);
  const prm = await r.json();
  check("resource metadata names the resource and the issuer",
    r.status === 200 && prm.resource === resource && prm.authorization_servers?.[0] === base, JSON.stringify(prm));
  r = await fetch(`${base}/.well-known/oauth-authorization-server`);
  const asm = await r.json();
  check("server metadata lists the endpoints",
    r.status === 200 && asm.issuer === base && asm.authorization_endpoint === `${base}/authorize` &&
    asm.token_endpoint === `${base}/oauth/token` && asm.registration_endpoint === `${base}/oauth/register`, JSON.stringify(asm));
  check("server metadata requires S256 and sends iss",
    JSON.stringify(asm.code_challenge_methods_supported) === '["S256"]' && asm.authorization_response_iss_parameter_supported === true);

  const redirectUri = "https://client.example.com/cb";
  r = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    client_name: "Test <App>", redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  const client = await r.json();
  check("a client registers", r.status === 201 && typeof client.client_id === "string", `${r.status} ${JSON.stringify(client)}`);

  const verifier = randomBytes(32).toString("base64url");
  const pkce = createHash("sha256").update(verifier).digest("base64url");
  const authorizeUrl = (state) => `${base}/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id,
    redirect_uri: redirectUri, code_challenge: pkce, code_challenge_method: "S256", state, scope: "board", resource })}`;
  check("consent without Access is refused", (await fetch(authorizeUrl("s1"))).status === 401);
  check("consent for another email is refused",
    (await fetch(authorizeUrl("s1"), { headers: asOwner(jwt({ email: "someone@example.com" })) })).status === 403);

  const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  async function consent(state) {
    const res = await fetch(authorizeUrl(state), { headers: asOwner() });
    const text = await res.text();
    return { res, text, handle: /name="handle" value="([^"]+)"/.exec(text)?.[1] ?? "", cookie: cookiesOf(res) };
  }
  const answer = (c, decision, headers = asOwner()) => fetch(`${base}/authorize`, { method: "POST", redirect: "manual",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded", cookie: c.cookie },
    body: new URLSearchParams({ handle: c.handle, decision }) });

  let page1 = await consent("s1");
  const csp = page1.res.headers.get("content-security-policy") ?? "";
  check("consent page for the owner", page1.res.status === 200 && page1.handle.length > 0 && page1.text.includes("client.example.com"));
  check("consent page escapes the client's name", page1.text.includes("Test &#60;App&#62;") && !page1.text.includes("Test <App>"));
  check("consent page names the actor", page1.text.includes("oauth-test-app"));
  check("consent page has no scripts and posts only here and to the client",
    csp.includes("default-src 'none'") && csp.includes("form-action 'self' https://client.example.com") && csp.includes("frame-ancestors 'none'"), csp);
  check("approval without Access is refused", (await answer(page1, "approve", {})).status === 401);

  r = await answer(page1, "approve");
  const back = new URL(r.headers.get("location") ?? "about:blank");
  check("approval returns a code to the client",
    r.status === 302 && back.origin + back.pathname === redirectUri && back.searchParams.get("state") === "s1" &&
    back.searchParams.get("iss") === base && (back.searchParams.get("code") ?? "").length > 0, String(back));
  check("the consent form works once", (await answer(page1, "approve")).status === 400);

  const tokenRequest = (params) => fetch(`${base}/oauth/token`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const grant = { grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: redirectUri,
    client_id: client.client_id, resource };
  check("a code without its PKCE verifier gets no token", (await tokenRequest(grant)).status === 400);
  page1 = await consent("s2");
  r = await answer(page1, "approve");
  const code2 = new URL(r.headers.get("location") ?? "about:blank").searchParams.get("code");
  r = await tokenRequest({ ...grant, code: code2, code_verifier: verifier });
  const tokens = await r.json();
  check("the code and its verifier get a token",
    r.status === 200 && typeof tokens.access_token === "string" && typeof tokens.refresh_token === "string", `${r.status} ${JSON.stringify(tokens)}`);
  r = await mcpRaw(tokens.access_token, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call",
    params: { name: "board_add_event", arguments: { item_id: "p1", kind: "note", text: "from an OAuth client" } } });
  const written = await r.text();
  out = (() => { try { return JSON.parse(written).result?.structuredContent ?? {}; } catch { return {}; } })();
  check("an OAuth token writes as its client's actor", out.ok === true && out.event?.actor === "oauth-test-app",
    `${r.status} ${r.headers.get("www-authenticate") ?? ""} ${written.slice(0, 300)}`);
  check("an OAuth token cannot read the page data",
    (await status({ authorization: `Bearer ${tokens.access_token}` })) === 401);
  check("a broken token is refused at MCP",
    (await mcpRaw(`${tokens.access_token}x`, { jsonrpc: "2.0", id: 1, method: "ping", params: {} })).status === 401);
  check("the code works once", (await tokenRequest({ ...grant, code: code2, code_verifier: verifier })).status === 400);
  check("a replayed code revokes the tokens it gave",
    (await mcpRaw(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "ping", params: {} })).status === 401);

  page1 = await consent("s3");
  r = await answer(page1, "deny");
  const denied = new URL(r.headers.get("location") ?? "about:blank");
  check("declining returns access_denied", r.status === 302 && denied.searchParams.get("error") === "access_denied" &&
    denied.searchParams.get("state") === "s3", String(denied));
  check("an unknown client gets no consent page",
    (await fetch(authorizeUrl("s4").replace(encodeURIComponent(client.client_id), "unknown-client"), { headers: asOwner() })).status === 400);

  // --- the owner's own writes from the page
  const ownerPost = (body, headers = { ...jar, origin: base }, type = "application/json") =>
    fetch(`${base}/api/board/item`, { method: "POST", headers: { "content-type": type, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const ownerCode = async (body, headers) => { const a = await ownerPost(body, headers); return `${a.status} ${(await a.json()).code ?? "OK"}`; };
  page = await (await fetch(`${base}/api/board`, { headers: jar })).json();
  check("the page data says the owner may write", page.can_write === true);
  const addBody = { op: "add", project: "demo", title: "積んだ仕事" };
  check("an owner write without Access is refused", (await ownerPost(addBody, { origin: base })).status === 401);
  check("a writer key cannot use the owner's write", (await ownerPost(addBody, { origin: base, authorization: `Bearer ${K.alpha}` })).status === 401);
  check("another email cannot write", (await ownerPost(addBody, { ...asOwner(jwt({ email: "someone@example.com" })), origin: base })).status === 403);
  check("an owner write from another site is refused", (await ownerCode(addBody, { ...jar, origin: "https://evil.example" })) === "403 ORIGIN");
  check("an owner write without an Origin is refused", (await ownerCode(addBody, { ...jar })) === "403 ORIGIN");
  check("an owner write needs JSON content", (await ownerPost(JSON.stringify(addBody), { ...jar, origin: base }, "text/plain")).status === 415);
  check("an owner write cannot be read with GET", (await fetch(`${base}/api/board/item`, { headers: jar })).status === 404);
  check("an unknown operation is refused", (await ownerCode({ op: "delete", item_id: "p1" })) === "400 INVALID");
  check("the owner cannot choose the kind or the state", (await ownerCode({ ...addBody, kind: "plan" })) === "400 INVALID" &&
    (await ownerCode({ ...addBody, state: "done" })) === "400 INVALID");
  check("the owner cannot start a project by a typing slip", (await ownerCode({ ...addBody, project: "demoo" })) === "404 NOT_FOUND");
  check("a blank title is refused", (await ownerCode({ ...addBody, title: "   " })) === "400 INVALID");
  check("a missing parent is refused", (await ownerCode({ ...addBody, parent_id: "nope" })) === "404 PARENT_NOT_FOUND");
  const itemsBefore = (await call(K.alpha, "board_list", {})).counts.items;
  r = await ownerPost({ ...addBody, parent_id: "c1" });
  out = await r.json();
  const piled = out.item ?? {};
  check("the owner piles up a piece of work", r.status === 200 && out.ok === true && piled.kind === "task" && piled.state === "planned" &&
    piled.parent_id === "c1" && piled.updated_by === "page:owner" && /^backlog\/\d{8}-[0-9a-f]{8}$/.test(piled.item_id ?? ""), JSON.stringify(out));
  const dayOf = (shift) => new Date(Date.now() + shift * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
  check("without a day from the page, the id carries the board's day", piled.item_id?.startsWith(`backlog/${dayOf(0)}-`));
  check("refused owner writes left nothing", (await call(K.alpha, "board_list", {})).counts.items === itemsBefore + 1);
  check("attach needs the revision", (await ownerCode({ op: "attach", item_id: piled.item_id, parent_id: "p1" })) === "400 INVALID");
  check("attach needs a parent or null", (await ownerCode({ op: "attach", item_id: piled.item_id, expected_revision: 1 })) === "400 INVALID");
  check("a stale revision is refused", (await ownerCode({ op: "attach", item_id: piled.item_id, parent_id: "p1", expected_revision: 7 })) === "409 REVISION_CONFLICT");
  r = await ownerPost({ op: "attach", item_id: piled.item_id, parent_id: "p1", expected_revision: 1 });
  out = await r.json();
  check("the owner moves work under another item", r.status === 200 && out.item?.parent_id === "p1" && out.item?.revision === 2 && out.item?.title === "積んだ仕事");
  r = await ownerPost({ op: "attach", item_id: piled.item_id, parent_id: null, expected_revision: 2 });
  out = await r.json();
  check("the owner takes work out from under its parent", r.status === 200 && out.item?.parent_id === null);
  check("the owner cannot move a plan", (await ownerCode({ op: "attach", item_id: "c1", parent_id: null, expected_revision: 1 })) === "403 FORBIDDEN");
  check("the owner cannot make a cycle", (await ownerCode({ op: "attach", item_id: "d3", parent_id: "d6", expected_revision: 1 })) === "400 CYCLE");
  check("the owner cannot move work across projects", (await ownerCode({ op: "attach", item_id: piled.item_id, parent_id: "o1", expected_revision: 3 })) === "400 PROJECT_MISMATCH");
  check("an unknown item is not found", (await ownerCode({ op: "attach", item_id: "nope", parent_id: null, expected_revision: 1 })) === "404 NOT_FOUND");
  // The pile under c1 is d3 then late1 (the order they were made in).
  const pileOrder = async () => (await (await fetch(`${base}/api/board`, { headers: jar })).json()).items
    .filter((i) => i.parent_id === "c1" && i.kind === "task" && i.state === "planned").map((i) => i.item_id).join(",");
  check("the pile starts in the order it was made", (await pileOrder()) === "d3,late1", await pileOrder());
  const lateBefore = (await call(K.alpha, "board_list", {})).items.find((i) => i.item_id === "late1");
  r = await ownerPost({ op: "move", item_id: "late1", direction: "up" });
  out = await r.json();
  check("the owner moves work up the pile", r.status === 200 && out.changed === true && out.order?.join(",") === "late1,d3" && (await pileOrder()) === "late1,d3", JSON.stringify(out));
  r = await ownerPost({ op: "move", item_id: "late1", direction: "up" });
  out = await r.json();
  check("the top of the pile stays where it is", r.status === 200 && out.changed === false && (await pileOrder()) === "late1,d3");
  const lateAfter = (await call(K.alpha, "board_list", {})).items.find((i) => i.item_id === "late1");
  check("the order does not touch the writer's fields", lateAfter.revision === lateBefore.revision && lateAfter.updated_by === "alpha" && lateAfter.rank === 1);
  check("only work on the pile can be reordered", (await ownerCode({ op: "move", item_id: "c1", direction: "up" })) === "403 FORBIDDEN");
  check("a direction other than up or down is refused", (await ownerCode({ op: "move", item_id: "late1", direction: "top" })) === "400 INVALID");
  check("moving an unknown item is not found", (await ownerCode({ op: "move", item_id: "nope", direction: "up" })) === "404 NOT_FOUND");
  check("a writer cannot set the order", code(await call(K.alpha, "board_upsert_item", { item_id: "late1", rank: 5 })) === -32602);
  r = await ownerPost({ ...addBody, title: "tomorrow here", day: dayOf(1) });
  out = await r.json();
  check("the id carries the page's day when it is a day next to the board's", r.status === 200 && out.item?.item_id?.startsWith(`backlog/${dayOf(1)}-`), JSON.stringify(out));
  r = await ownerPost({ ...addBody, title: "far away", day: "19990101" });
  out = await r.json();
  check("a day that no time zone can have falls back to the board's day", r.status === 200 && out.item?.item_id?.startsWith(`backlog/${dayOf(0)}-`), JSON.stringify(out));
  check("a day that is not a string is refused", (await ownerCode({ ...addBody, day: 20261112 })) === "400 INVALID");
  // --- handing a piece of work on the pile to an AI
  const handoffOf = async (id) => (await call(K.alpha, "board_list", { since_seq: 999999 })).items.find((i) => i.item_id === id)?.handoff;
  check("work that was not handed over says so", (await handoffOf(piled.item_id)) === null);
  check("only work on the pile can be handed over", (await ownerCode({ op: "hand", item_id: "c1" })) === "403 FORBIDDEN");
  check("handing over an unknown item is not found", (await ownerCode({ op: "hand", item_id: "nope" })) === "404 NOT_FOUND");
  check("nothing to take back before it is handed over", (await ownerCode({ op: "take_back", item_id: piled.item_id })) === "409 HANDOFF_CONFLICT");
  r = await ownerPost({ op: "hand", item_id: piled.item_id });
  out = await r.json();
  const firstRequest = out.handoff?.request_id ?? "";
  check("the owner hands work over", r.status === 200 && out.handoff?.state === "requested" && new RegExp(`^REQ-${dayOf(0)}-[0-9a-f]{8}$`).test(firstRequest) &&
    out.handoff?.accepted_by === null, JSON.stringify(out));
  check("the same work cannot be handed over twice", (await ownerCode({ op: "hand", item_id: piled.item_id })) === "409 HANDOFF_CONFLICT");
  check("a writer sees the request", (await handoffOf(piled.item_id))?.request_id === firstRequest);
  // Handing over from the page starts a dispatcher pass at once (no cron tick is asked for here).
  let routedAtOnce = null;
  for (let i = 0; i < 60 && (routedAtOnce?.to ?? null) === null; i++) {
    routedAtOnce = await handoffOf(piled.item_id);
    if ((routedAtOnce?.to ?? null) === null) await new Promise((r) => setTimeout(r, 500));
  }
  check("work the owner hands over without a destination is routed right away, without a cron tick",
    routedAtOnce?.to === "hold" && routedAtOnce?.to_set_by === "dispatcher" && routedAtOnce?.request_id === firstRequest, JSON.stringify(routedAtOnce));
  check("the owner takes the request back", (await ownerCode({ op: "take_back", item_id: piled.item_id })) === "200 OK" && (await handoffOf(piled.item_id)) === null);
  check("a request that was taken back cannot be accepted", code(await call(K.alpha, "board_accept_handoff", { item_id: piled.item_id, request_id: firstRequest })) === "HANDOFF_CONFLICT");
  // Handed over by a writer this time: the pass after the page's hand would send it to hold before alpha takes it.
  out = await call(K.alpha, "board_request_handoff", { item_id: piled.item_id });
  const request = out.handoff?.request_id ?? "";
  check("a new request gets a new id", request !== "" && request !== firstRequest);
  check("accepting needs the id of the open request", code(await call(K.alpha, "board_accept_handoff", { item_id: piled.item_id, request_id: firstRequest })) === "HANDOFF_CONFLICT");
  check("accepting an unknown item is not found", code(await call(K.alpha, "board_accept_handoff", { item_id: "nope", request_id: request })) === "NOT_FOUND");
  check("no key, no accepting", (await mcpRaw(null, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "board_accept_handoff", arguments: { item_id: piled.item_id, request_id: request } } })).status === 401);
  const accepted = await call(K.alpha, "board_accept_handoff", { item_id: piled.item_id, request_id: request });
  check("a writer accepts the request", accepted.handoff?.state === "accepted" && accepted.handoff?.accepted_by === "alpha" &&
    accepted.item?.state === "in_progress" && accepted.item?.updated_by === "alpha", JSON.stringify(accepted));
  check("a writer cannot write the hand-off fields directly", code(await call(K.alpha, "board_upsert_item", { item_id: piled.item_id, handoff: { state: "requested" } })) === -32602 &&
    code(await call(K.alpha, "board_upsert_item", { item_id: piled.item_id, handoff_state: null })) === -32602);

  // --- board_request_status: saved, handed over, taken and running are kept apart, and asking writes nothing
  await call(K.alpha, "board_upsert_item", { item_id: "status1", project: "demo", kind: "task", title: "status case", state: "planned" });
  let st = await call(K.alpha, "board_request_status", { item_id: "status1" });
  check("a saved-only item reports not_handed_over, with no request and no taker", st.lifecycle?.stage === "not_handed_over" && st.request_id === null && st.lifecycle?.accepted_by === null, JSON.stringify(st));
  check("asking for the status of an unknown item is not found", code(await call(K.alpha, "board_request_status", { item_id: "nope" })) === "NOT_FOUND");
  check("status takes no other argument", code(await call(K.alpha, "board_request_status", { item_id: "status1", extra: 1 })) === -32602);
  check("no key, no status", (await mcpRaw(null, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "board_request_status", arguments: { item_id: "status1" } } })).status === 401);
  const handed = await call(K.alpha, "board_request_handoff", { item_id: "status1", to: "muse" });
  st = await call(K.alpha, "board_request_status", { item_id: "status1" });
  check("a handed-over item reports requested, not accepted", st.lifecycle?.stage === "requested" && st.request_id === handed.handoff?.request_id && st.lifecycle?.accepted_by === null, JSON.stringify(st));
  const eventsAfterAsk = (await call(K.alpha, "board_list", { project: "demo" })).events?.length;
  await call(K.alpha, "board_request_status", { item_id: "status1" });
  await call(K.alpha, "board_request_status", { item_id: "status1" });
  check("asking for the status writes nothing", (await call(K.alpha, "board_list", { project: "demo" })).events?.length === eventsAfterAsk && (await call(K.alpha, "board_request_status", { item_id: "status1" })).lifecycle?.stage === "requested");
  const statusRun = await call(K.muse, "board_accept_handoff", { item_id: "status1", request_id: handed.handoff.request_id });
  st = await call(K.alpha, "board_request_status", { item_id: "status1" });
  check("a taken item reports accepted, with who and when, and no sign of work yet", st.lifecycle?.stage === "accepted" && st.lifecycle?.accepted_by === "muse" && typeof st.lifecycle?.times?.accepted_at === "number", JSON.stringify(st));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await call(K.muse, "board_progress_handoff", { item_id: "status1", request_id: handed.handoff.request_id, generation: statusRun.handoff.generation, kind: "note", text: "working", ref: "https://github.com/example/repo/issues/1" });
  st = await call(K.alpha, "board_request_status", { item_id: "status1" });
  check("a report after taking it makes it running, and its result link is carried", st.lifecycle?.stage === "running" && st.lifecycle?.result_refs?.[0]?.ref === "https://github.com/example/repo/issues/1", JSON.stringify(st));
  await call(K.muse, "board_complete_handoff", { item_id: "status1", request_id: handed.handoff.request_id, generation: statusRun.handoff.generation, outcome: "done" });
  st = await call(K.alpha, "board_request_status", { item_id: "status1" });
  check("a closed run reports completed/done", st.lifecycle?.stage === "completed" && st.lifecycle?.outcome === "done", JSON.stringify(st));

  // --- a writer hands work over without the page (board_request_handoff)
  await call(K.alpha, "board_upsert_item", { item_id: "pile2", project: "demo", kind: "task", title: "writer-handed work", state: "planned" });
  check("requesting a hand-off on unknown work is not found", code(await call(K.alpha, "board_request_handoff", { item_id: "nope" })) === "NOT_FOUND");
  check("only work on the pile can be handed over by a writer", code(await call(K.alpha, "board_request_handoff", { item_id: piled.item_id })) === "FORBIDDEN");
  const writerHand = await call(K.alpha, "board_request_handoff", { item_id: "pile2" });
  const writerRequest = writerHand.handoff?.request_id ?? "";
  check("a writer hands work over", writerHand.handoff?.state === "requested" && new RegExp(`^REQ-${dayOf(0)}-[0-9a-f]{8}$`).test(writerRequest) &&
    writerHand.handoff?.accepted_by === null, JSON.stringify(writerHand));
  check("the same work cannot be handed over twice by a writer", code(await call(K.alpha, "board_request_handoff", { item_id: "pile2" })) === "HANDOFF_CONFLICT");
  check("the owner can still take back a writer's request", (await ownerCode({ op: "take_back", item_id: "pile2" })) === "200 OK" && (await handoffOf("pile2")) === null);
  const writerHand2 = await call(K.alpha, "board_request_handoff", { item_id: "pile2" });
  const writerRequest2 = writerHand2.handoff?.request_id ?? "";
  check("a re-request gets a new id", writerRequest2 !== "" && writerRequest2 !== writerRequest);
  const writerAccepted = await call(K.muse, "board_accept_handoff", { item_id: "pile2", request_id: writerRequest2 });
  check("a writer accepts the unaddressed request", writerAccepted.handoff?.state === "accepted" && writerAccepted.item?.state === "in_progress", JSON.stringify(writerAccepted));
  check("a request without a destination says so", writerAccepted.handoff?.to === null, JSON.stringify(writerAccepted.handoff));

  // --- the destination of a request (handoff.to)
  await call(K.alpha, "board_upsert_item", { item_id: "pile3", project: "demo", kind: "task", title: "work for one writer", state: "planned" });
  const badTo = code(await call(K.alpha, "board_request_handoff", { item_id: "pile3", to: "someone" }));
  check("a destination outside the list is refused", badTo === "INVALID", String(badTo));
  check("the page refuses a destination outside the list", (await ownerCode({ op: "hand", item_id: "pile3", to: "someone" })) === "400 INVALID");
  r = await ownerPost({ op: "hand", item_id: "pile3", to: "hold" });
  out = await r.json();
  check("the owner hands work over with a destination", r.status === 200 && out.handoff?.to === "hold" && (await handoffOf("pile3"))?.to === "hold", JSON.stringify(out));
  const ownerHanded = await handoffOf("pile3");
  check("a request records who asked, who set the destination and the title then", ownerHanded?.requested_by === "page:owner" && ownerHanded?.to_set_by === "page:owner" && ownerHanded?.title === "work for one writer", JSON.stringify(ownerHanded));
  check("taking a request back clears its destination", (await ownerCode({ op: "take_back", item_id: "pile3" })) === "200 OK" && (await handoffOf("pile3")) === null);
  const toMuse = await call(K.alpha, "board_request_handoff", { item_id: "pile3", to: "muse" });
  const museRequest = toMuse.handoff?.request_id ?? "";
  check("a writer hands work to a destination", toMuse.handoff?.to === "muse" && (await handoffOf("pile3"))?.to === "muse", JSON.stringify(toMuse));
  const writerHanded = await handoffOf("pile3");
  check("a request handed by a writer names the writer", writerHanded?.requested_by === "alpha" && writerHanded?.to_set_by === "alpha", JSON.stringify(writerHanded));
  check("a request for muse cannot be taken by another writer", code(await call(K.alpha, "board_accept_handoff", { item_id: "pile3", request_id: museRequest })) === "FORBIDDEN");
  check("the owner routes the request to hold", (await ownerCode({ op: "route", item_id: "pile3", to: "hold" })) === "200 OK" && (await handoffOf("pile3"))?.to === "hold");
  check("nobody takes a request on hold", code(await call(K.muse, "board_accept_handoff", { item_id: "pile3", request_id: museRequest })) === "FORBIDDEN" &&
    code(await call(K.alpha, "board_accept_handoff", { item_id: "pile3", request_id: museRequest })) === "FORBIDDEN");
  check("routing needs a destination", (await ownerCode({ op: "route", item_id: "pile3" })) === "400 INVALID");
  check("a writer cannot route to a destination outside the list", code(await call(K.alpha, "board_route_handoff", { item_id: "pile3", to: "someone" })) === "INVALID");
  check("a writer must name the destination", code(await call(K.alpha, "board_route_handoff", { item_id: "pile3" })) === -32602);
  const writerRouted = await call(K.muse, "board_route_handoff", { item_id: "pile3", to: "devin" });
  check("a writer routes a request on hold", writerRouted.changed === true && writerRouted.handoff?.to === "devin" && (await handoffOf("pile3"))?.to === "devin", JSON.stringify(writerRouted));
  const afterWriterRoute = await handoffOf("pile3");
  check("routing by a writer records who set the destination", afterWriterRoute?.to_set_by === "muse" && afterWriterRoute?.requested_by === "alpha", JSON.stringify(afterWriterRoute));
  check("routing by a writer names the writer", (await call(K.alpha, "board_list", {})).events.some((e) => e.item_id === "pile3" && e.actor === "muse" && e.text === `routed ${museRequest} to devin`));
  check("routing to the same destination changes nothing", (await call(K.alpha, "board_route_handoff", { item_id: "pile3", to: "devin" })).changed === false);
  r = await ownerPost({ op: "route", item_id: "pile3", to: "muse" });
  out = await r.json();
  check("the owner routes a request on hold to a writer", r.status === 200 && out.changed === true && out.handoff?.to === "muse" && out.handoff?.request_id === museRequest, JSON.stringify(out));
  check("routing by the owner records the owner as the one who set the destination", out.handoff?.to_set_by === "page:owner");
  await call(K.alpha, "board_upsert_item", { item_id: "pile3", title: "work for one writer, renamed" });
  const renamed = await handoffOf("pile3");
  check("the request keeps the title it was handed over with", renamed?.title === "work for one writer", JSON.stringify(renamed));
  const page3 = (await (await fetch(`${base}/api/board`, { headers: jar })).json()).items.find((i) => i.item_id === "pile3");
  check("the page data carries the destination", page3?.handoff?.to === "muse");
  const routedEvent = (await call(K.alpha, "board_list", {})).events.some((e) => e.item_id === "pile3" && e.text === `routed ${museRequest} to muse`);
  check("routing leaves an event", routedEvent);
  const museTook = await call(K.muse, "board_accept_handoff", { item_id: "pile3", request_id: museRequest });
  check("the writer of the destination takes the request", museTook.handoff?.state === "accepted" && museTook.handoff?.accepted_by === "muse", JSON.stringify(museTook));
  check("an accepted request cannot be routed", (await ownerCode({ op: "route", item_id: "pile3", to: "devin" })) === "409 HANDOFF_CONFLICT");
  check("an accepted request cannot be routed by a writer", code(await call(K.alpha, "board_route_handoff", { item_id: "pile3", to: "devin" })) === "HANDOFF_CONFLICT");
  check("an accepted request cannot be taken back by a writer", code(await call(K.alpha, "board_take_back_handoff", { item_id: "pile3" })) === "HANDOFF_CONFLICT");

  // --- the cron gives a destination to work handed over without one (the
  // owner's order; nobody in it is picking up yet, and the test has no Devin
  // key, so it is hold). Nobody is started.
  await call(K.alpha, "board_upsert_item", { item_id: "pile4", project: "demo", kind: "task", title: "write the release notes", state: "planned" });
  await call(K.alpha, "board_request_handoff", { item_id: "pile4" });
  check("a writer must name the item to take back", code(await call(K.alpha, "board_take_back_handoff", {})) === -32602);
  check("a take back naming another request is refused", code(await call(K.muse, "board_take_back_handoff", { item_id: "pile4", request_id: "REQ-19990101-ffffffff" })) === "HANDOFF_CONFLICT");
  const withdrawn = await call(K.muse, "board_take_back_handoff", { item_id: "pile4" });
  check("a writer takes back a request nobody has taken", withdrawn.changed === true && (await handoffOf("pile4")) === null, JSON.stringify(withdrawn));
  check("taking back by a writer names the writer", (await call(K.alpha, "board_list", {})).events.some((e) => e.item_id === "pile4" && e.actor === "muse" && e.text.startsWith("taken back REQ-")));
  check("a request already taken back cannot be taken back again", code(await call(K.alpha, "board_take_back_handoff", { item_id: "pile4" })) === "HANDOFF_CONFLICT");
  await call(K.alpha, "board_request_handoff", { item_id: "pile4" });
  check("the cron can be started in the test", (await fetch(`${base}/__scheduled?cron=*/10+*+*+*+*`)).ok);
  let routedTo = null;
  for (let i = 0; i < 60 && routedTo === null; i++) {
    routedTo = (await handoffOf("pile4"))?.to ?? null;
    if (routedTo === null) await new Promise((r) => setTimeout(r, 500));
  }
  const routedNote = (await call(K.alpha, "board_list", {})).events.find((e) => e.item_id === "pile4" && e.actor === "dispatcher");
  check("the cron gives the work a destination and says why", routedTo !== null && routedNote?.text?.startsWith(`routed to ${routedTo}`), `${routedTo} / ${routedNote?.text}`);
  console.log(`(router in this run: ${routedNote?.text ?? "no event"})`);
  check("the cron leaves work with a destination alone", (await handoffOf("pile3"))?.to === "muse");

  const acceptedAgain = await call(K.alpha, "board_accept_handoff", { item_id: piled.item_id, request_id: request });
  check("accepting again as the same writer answers the same handoff, not a second run",
    acceptedAgain.ok === true && acceptedAgain.changed === false && acceptedAgain.handoff?.state === "accepted" && Number.isInteger(acceptedAgain.handoff?.generation), JSON.stringify(acceptedAgain));
  check("the same request cannot be accepted by another writer", code(await call(K.muse, "board_accept_handoff", { item_id: piled.item_id, request_id: request })) === "HANDOFF_CONFLICT");
  check("an accepted request cannot be taken back", (await ownerCode({ op: "take_back", item_id: piled.item_id })) === "409 HANDOFF_CONFLICT");
  check("the page data carries the hand-off", (await (await fetch(`${base}/api/board`, { headers: jar })).json()).items
    .find((i) => i.item_id === piled.item_id)?.handoff?.state === "accepted");
  const piledGen = acceptedAgain.handoff?.generation;
  check("the run's own plain write now needs its fence", code(await call(K.alpha, "board_upsert_item", { item_id: piled.item_id, state: "in_progress" })) === "FENCE_REQUIRED");
  check("the run still writes plainly with its fence", (await call(K.alpha, "board_upsert_item", { item_id: piled.item_id, state: "in_progress", request_id: request, generation: piledGen })).item?.updated_by === "alpha");
  check("another writer still writes after the owner", (await call(K.muse, "board_add_event", { item_id: piled.item_id, kind: "note", text: "a note from another writer" })).event?.actor === "muse");

  // --- safe resumption: lease, fencing, unknown, release and resume (pile4)
  await call(K.alpha, "board_take_back_handoff", { item_id: "pile4" });
  const reHand = await call(K.alpha, "board_request_handoff", { item_id: "pile4", to: "muse" });
  const reRequest = reHand.handoff?.request_id ?? "";
  const gen1 = reHand.handoff?.generation;
  check("a new request gets the next generation", Number.isInteger(gen1) && gen1 >= 1, JSON.stringify(reHand.handoff));
  const took = await call(K.muse, "board_accept_handoff", { item_id: "pile4", request_id: reRequest });
  check("accepting starts a lease", took.handoff?.state === "accepted" && took.handoff?.generation === gen1 &&
    typeof took.handoff?.lease_until === "number" && took.handoff.lease_until > Date.now() && took.handoff?.lease_expired === false, JSON.stringify(took.handoff));
  check("a heartbeat needs the current generation", code(await call(K.muse, "board_heartbeat_handoff", { item_id: "pile4", request_id: reRequest, generation: gen1 + 9 })) === "STALE_GENERATION");
  check("a heartbeat from the run extends the lease", (await call(K.muse, "board_heartbeat_handoff", { item_id: "pile4", request_id: reRequest, generation: gen1 })).ok === true);
  check("progress from another writer is refused", code(await call(K.alpha, "board_progress_handoff", { item_id: "pile4", request_id: reRequest, generation: gen1, kind: "note", text: "not my run" })) === "FORBIDDEN");
  check("progress from the run is written", (await call(K.muse, "board_progress_handoff", { item_id: "pile4", request_id: reRequest, generation: gen1, kind: "note", text: "halfway" })).event?.text === "halfway");
  check("the run's plain event without its fence is refused", code(await call(K.muse, "board_add_event", { item_id: "pile4", kind: "note", text: "plain, no fence" })) === "FENCE_REQUIRED");
  check("the run's plain update without its fence is refused", code(await call(K.muse, "board_upsert_item", { item_id: "pile4", title: "plain rename" })) === "FENCE_REQUIRED");
  check("the run's plain event with a wrong generation is stale", code(await call(K.muse, "board_add_event", { item_id: "pile4", kind: "note", text: "plain, wrong fence", request_id: reRequest, generation: gen1 + 9 })) === "STALE_GENERATION");
  check("the run's plain event with its fence is written", (await call(K.muse, "board_add_event", { item_id: "pile4", kind: "note", text: "plain, fenced", request_id: reRequest, generation: gen1 })).event?.text === "plain, fenced");
  check("another writer's plain event needs no fence", (await call(K.alpha, "board_add_event", { item_id: "pile4", kind: "note", text: "from another writer" })).event?.actor === "alpha");
  check("a run in its lease cannot be marked unknown", code(await call(K.alpha, "board_mark_handoff_unknown", { item_id: "pile4", request_id: reRequest })) === "HANDOFF_CONFLICT");
  await new Promise((r) => setTimeout(r, 2300));
  check("the board shows the lease has expired, and changes nothing by itself",
    (await handoffOf("pile4"))?.lease_expired === true && (await handoffOf("pile4"))?.state === "accepted");
  check("an expired run can be marked unknown", (await call(K.alpha, "board_mark_handoff_unknown", { item_id: "pile4", request_id: reRequest })).handoff?.state === "unknown");
  check("an unknown run cannot write progress", code(await call(K.muse, "board_progress_handoff", { item_id: "pile4", request_id: reRequest, generation: gen1, kind: "note", text: "still here?" })) === "HANDOFF_CONFLICT");
  check("an unknown run's plain writes are refused too", code(await call(K.muse, "board_add_event", { item_id: "pile4", kind: "note", text: "plain while unknown", request_id: reRequest, generation: gen1 })) === "HANDOFF_CONFLICT");
  // pendingHandoffs selects exactly the items whose handoff.state is
  // "requested"; that state is what is measured here.
  check("unknown work is not pending for the dispatcher", (await handoffOf("pile4"))?.state === "unknown");
  check("release without the stopped confirmation is refused", code(await call(K.alpha, "board_release_handoff", { item_id: "pile4", request_id: reRequest })) === "INVALID");
  check("another writer cannot resume somebody else's run", code(await call(K.alpha, "board_resume_handoff", { item_id: "pile4", request_id: reRequest })) === "FORBIDDEN");
  check("the run itself resumes as the same run", (await call(K.muse, "board_resume_handoff", { item_id: "pile4", request_id: reRequest })).handoff?.state === "accepted" &&
    (await handoffOf("pile4"))?.generation === gen1);
  await new Promise((r) => setTimeout(r, 2300));
  await call(K.alpha, "board_mark_handoff_unknown", { item_id: "pile4", request_id: reRequest });
  const released = await call(K.alpha, "board_release_handoff", { item_id: "pile4", request_id: reRequest, stopped_confirmed: true });
  check("confirmed release puts the work back on the pile", released.handoff === null && released.item?.state === "planned", JSON.stringify(released));
  const hand2 = await call(K.alpha, "board_request_handoff", { item_id: "pile4", to: "muse" });
  const request2 = hand2.handoff?.request_id ?? "";
  check("the next request's generation is higher", hand2.handoff?.generation === gen1 + 1, JSON.stringify(hand2.handoff));
  await call(K.muse, "board_accept_handoff", { item_id: "pile4", request_id: request2 });
  check("a write with the old generation is stale", code(await call(K.muse, "board_progress_handoff", { item_id: "pile4", request_id: request2, generation: gen1, kind: "note", text: "old run" })) === "STALE_GENERATION");
  check("a plain write with the old generation is stale too", code(await call(K.muse, "board_add_event", { item_id: "pile4", kind: "note", text: "old run, plain", request_id: request2, generation: gen1 })) === "STALE_GENERATION");
  check("a plain write from the old run without a fence is refused", code(await call(K.muse, "board_add_event", { item_id: "pile4", kind: "note", text: "old run, no fence" })) === "FENCE_REQUIRED");
  const completed = await call(K.muse, "board_complete_handoff", { item_id: "pile4", request_id: request2, generation: gen1 + 1, outcome: "done", text: "finished" });
  check("the current run completes the work", completed.item?.state === "done" && completed.handoff?.state === "completed", JSON.stringify(completed));
  const pageAfterDone = (await (await fetch(`${base}/api/board`, { headers: jar })).json()).items.find((i) => i.item_id === "pile4");
  check("the page shows a closed run's result: the newest note before the state change",
    pageAfterDone?.last_event?.kind === "state_change" && pageAfterDone?.last_note?.kind === "note" && pageAfterDone.last_note.text.includes("finished"), JSON.stringify({ last: pageAfterDone?.last_event, note: pageAfterDone?.last_note }));
  check("writers' board_list has no last_note", !("last_note" in ((await call(K.alpha, "board_list", {})).items.find((i) => i.item_id === "pile4") ?? {})));
  check("a completed run cannot write again", code(await call(K.muse, "board_progress_handoff", { item_id: "pile4", request_id: request2, generation: gen1 + 1, kind: "note", text: "late" })) === "HANDOFF_CONFLICT");
  check("settling a dispatch that is not unknown is refused", code(await call(K.alpha, "board_resolve_dispatch", { request_id: request2, resolution: "retry" })) === "HANDOFF_CONFLICT");
  check("settling a dispatch needs a known resolution", code(await call(K.alpha, "board_resolve_dispatch", { request_id: request2, resolution: "maybe" })) === "INVALID");

  // --- the owner's recovery from the page (pile3, taken by muse, lease long expired)
  check("the owner marks an expired run unknown from the page", (await ownerCode({ op: "mark_unknown", item_id: "pile3", request_id: museRequest })) === "200 OK" &&
    (await handoffOf("pile3"))?.state === "unknown");
  check("the owner releases it back to the pile from the page", (await ownerCode({ op: "release", item_id: "pile3", request_id: museRequest })) === "200 OK" &&
    (await handoffOf("pile3")) === null);

  // --- continuing a session that stopped (op continue)
  const sessionMade = code(await call(K.alpha, "board_upsert_item", { item_id: "session/77", project: "demo", kind: "task", title: "11-19 claude: stopped work", state: "in_progress" }));
  check("a writer makes a session's item", sessionMade === "OK", String(sessionMade));
  r = await ownerPost({ op: "continue", item_id: "session/77", day: dayOf(0), to: "vps-claude" });
  out = await r.json();
  check("the owner hands over the continuation of a session", r.status === 200 && out.item?.title === "session/77 の続き" && out.item?.parent_id === "session/77" &&
    out.item?.project === "demo" && out.item?.kind === "task" && out.handoff?.state === "requested" && out.handoff?.to === "vps-claude", JSON.stringify(out));
  const continuation = out.item?.item_id ?? "";
  const continued = await handoffOf(continuation);
  check("the continuation counts as handed over by the owner (a picker's owner-only gate lets it through)",
    continued?.requested_by === "page:owner" && continued?.to_set_by === "page:owner" && continued?.title === "session/77 の続き", JSON.stringify(continued));
  const sessionAfter = (await call(K.alpha, "board_list", {})).items.find((i) => i.item_id === "session/77");
  check("the session's own item is left as its writer had it", sessionAfter?.state === "in_progress" && sessionAfter?.handoff === null && sessionAfter?.updated_by === "alpha", JSON.stringify(sessionAfter));
  check("one open continuation per session", (await ownerCode({ op: "continue", item_id: "session/77", to: "vps-claude" })) === "409 HANDOFF_CONFLICT");
  check("only a session's item can be continued", (await ownerCode({ op: "continue", item_id: "pile3", to: "vps-claude" })) === "403 FORBIDDEN");
  check("continuing an unknown item is not found", (await ownerCode({ op: "continue", item_id: "session/78" })) === "404 NOT_FOUND");
  check("the continuation's destination must be on the list", (await ownerCode({ op: "continue", item_id: "session/77", to: "someone" })) === "400 INVALID");
  check("taking the continuation back allows another one", (await ownerCode({ op: "take_back", item_id: continuation })) === "200 OK" &&
    (await ownerCode({ op: "continue", item_id: "session/77", to: "vps-claude" })) === "200 OK");

  // --- the owner's order for "おまかせ" (op order) and who is picking up
  const routeOf = async () => (await (await fetch(`${base}/api/board`, { headers: jar })).json()).route;
  let route = await routeOf();
  check("the page shows the default order until the owner sets one", route?.order?.join(",") === "vps-claude,local-claude,devin" && route?.set_by_owner === false, JSON.stringify(route));
  check("the page lists every destination that can be in the order, with tool and place apart",
    ["devin", "vps-claude", "local-claude", "vps-devin", "local-devin", "muse", "grokbot"].every((t) => route?.targets?.some((x) => x.target === t)) &&
    !route?.targets?.some((x) => x.target === "owner" || x.target === "hold"), JSON.stringify(route?.targets));
  check("without a Devin key, Devin in the cloud is not picking up", route?.targets?.find((x) => x.target === "devin")?.alive === false);
  for (const bad of [{ op: "order" }, { op: "order", order: ["owner"] }, { op: "order", order: ["devin", "devin"] }, { op: "order", order: ["someone"] }, { op: "order", order: "devin" }, { op: "order", order: [], extra: 1 }])
    check(`a bad order is refused: ${JSON.stringify(bad.order)}`, (await ownerCode(bad)) === "400 INVALID");
  check("the owner sets the order", (await ownerCode({ op: "order", order: ["vps-claude", "devin"] })) === "200 OK");
  route = await routeOf();
  check("the page shows the owner's order", route?.order?.join(",") === "vps-claude,devin" && route?.set_by_owner === true && typeof route?.updated_at === "number", JSON.stringify(route));
  check("a taker that never came is not picking up", route?.targets?.find((x) => x.target === "vps-claude")?.alive === false);
  await call(K.vps, "board_list", { since_seq: 999999 });
  route = await routeOf();
  check("a taker that came to the board is picking up", route?.targets?.find((x) => x.target === "vps-claude")?.alive === true && typeof route?.targets?.find((x) => x.target === "vps-claude")?.seen_at === "number", JSON.stringify(route?.targets));
  r = await ownerPost({ op: "add", project: "demo", title: "work for the order", day: dayOf(0) });
  const orderWork = (await r.json()).item?.item_id ?? "";
  r = await ownerPost({ op: "hand", item_id: orderWork, day: dayOf(0) });
  const orderRequest = (await r.json()).handoff?.request_id ?? "";
  let ordered = null;
  for (let i = 0; i < 60 && (ordered?.to ?? null) === null; i++) {
    ordered = await handoffOf(orderWork);
    if ((ordered?.to ?? null) === null) await new Promise((r) => setTimeout(r, 500));
  }
  check("おまかせ goes to the first in the owner's order that is picking up, as the owner's choice",
    ordered?.to === "vps-claude" && ordered?.to_set_by === "page:owner" && ordered?.requested_by === "page:owner", JSON.stringify(ordered));
  check("the event says it came from the order", (await call(K.alpha, "board_list", {})).events.some((e) => e.item_id === orderWork && e.actor === "dispatcher" && e.text === "routed to vps-claude: number 1 in the owner's order"));
  const vpsTook = await call(K.vps, "board_accept_handoff", { item_id: orderWork, request_id: orderRequest });
  check("the taker of that destination takes it", vpsTook.handoff?.state === "accepted" && vpsTook.handoff?.accepted_by === "vps-claude", JSON.stringify(vpsTook));
  check("the owner empties the order", (await ownerCode({ op: "order", order: [] })) === "200 OK" && (await routeOf())?.order?.length === 0);
  r = await ownerPost({ op: "add", project: "demo", title: "work with an empty order", day: dayOf(0) });
  const emptyWork = (await r.json()).item?.item_id ?? "";
  await ownerPost({ op: "hand", item_id: emptyWork, day: dayOf(0) });
  let held = null;
  for (let i = 0; i < 60 && (held?.to ?? null) === null; i++) {
    held = await handoffOf(emptyWork);
    if ((held?.to ?? null) === null) await new Promise((r) => setTimeout(r, 500));
  }
  check("with an empty order, おまかせ goes to hold", held?.to === "hold" && held?.to_set_by === "dispatcher", JSON.stringify(held));
  check("a writer can name the new destinations", code(await call(K.alpha, "board_route_handoff", { item_id: emptyWork, to: "vps-devin" })) === "OK" && (await handoffOf(emptyWork))?.to === "vps-devin");

  // --- conversations with the server's workers ("話す")
  const chatOf = async (id) => { const res = await fetch(`${base}/api/board/chat?item_id=${encodeURIComponent(id)}`, { headers: jar }); return { status: res.status, body: await res.json() }; };
  check("a conversation needs Access", (await fetch(`${base}/api/board/chat?item_id=${encodeURIComponent(orderWork)}`)).status === 401);
  let chat = await chatOf(orderWork);
  check("an item without messages has an empty conversation, partner from the handoff", chat.status === 200 && chat.body.messages?.length === 0 && chat.body.open === null && chat.body.partner === "vps-claude", JSON.stringify(chat.body).slice(0, 300));
  check("a bad partner is refused", (await ownerCode({ op: "chat_send", item_id: orderWork, text: "hi", to: "devin" })) === "400 INVALID");
  check("an empty message is refused", (await ownerCode({ op: "chat_send", item_id: orderWork, text: "  " })) === "400 INVALID");
  check("a message over 20000 characters is refused", (await ownerCode({ op: "chat_send", item_id: orderWork, text: "あ".repeat(20001) })) === "400 INVALID");
  check("the owner sends a message", (await ownerCode({ op: "chat_send", item_id: orderWork, text: "もう少し短くして" })) === "200 OK");
  check("one open turn per item", (await ownerCode({ op: "chat_send", item_id: orderWork, text: "まだ?" })) === "409 HANDOFF_CONFLICT");
  chat = await chatOf(orderWork);
  const turnSeq = chat.body.open?.seq;
  check("the page sees the open turn", chat.body.messages?.length === 1 && chat.body.open?.status === "waiting" && chat.body.open?.to === "vps-claude" && typeof turnSeq === "number", JSON.stringify(chat.body.open));
  check("a writer that is not a server worker has no turns", (await call(K.alpha, "board_chat_pending", {})).turns?.length === 0);
  check("a writer that is not a server worker cannot take a turn", code(await call(K.alpha, "board_chat_take", { item_id: orderWork, seq: turnSeq })) === "FORBIDDEN");
  const pending = await call(K.vps, "board_chat_pending", {});
  check("the worker sees the turn waiting for it", pending.turns?.some((x) => x.item_id === orderWork && x.seq === turnSeq), JSON.stringify(pending));
  check("a reply before taking the turn is refused", code(await call(K.vps, "board_chat_reply", { item_id: orderWork, seq: turnSeq, text: "x" })) === "HANDOFF_CONFLICT");
  const taken = await call(K.vps, "board_chat_take", { item_id: orderWork, seq: turnSeq });
  check("the worker takes the turn and gets the conversation so far", taken.turn?.text === "もう少し短くして" && Array.isArray(taken.transcript) &&
    taken.transcript.at(-1)?.who === "owner" && taken.item?.item_id === orderWork && taken.handoff?.request_id === orderRequest, JSON.stringify(taken).slice(0, 400));
  check("taking the same turn again is the same take (a lost answer can be repeated)", (await call(K.vps, "board_chat_take", { item_id: orderWork, seq: turnSeq })).turn?.seq === turnSeq);
  check("a taken turn is not pending any more", !(await call(K.vps, "board_chat_pending", {})).turns?.some((x) => x.seq === turnSeq));
  check("a bad ref is refused", code(await call(K.vps, "board_chat_reply", { item_id: orderWork, seq: turnSeq, text: "ok", ref: "http://x" })) === "INVALID");
  const long = "い".repeat(20000);
  check("the worker answers, up to 20000 characters", (await call(K.vps, "board_chat_reply", { item_id: orderWork, seq: turnSeq, text: long, ref: "https://github.com/example/repo/pull/1" })).ok === true);
  check("an answered turn cannot be answered again", code(await call(K.vps, "board_chat_reply", { item_id: orderWork, seq: turnSeq, text: "again" })) === "HANDOFF_CONFLICT");
  chat = await chatOf(orderWork);
  check("the page shows the answer and no open turn", chat.body.open === null && chat.body.messages?.length === 2 && chat.body.messages[1].role === "agent" &&
    chat.body.messages[1].text.length === 20000 && chat.body.messages[1].ref === "https://github.com/example/repo/pull/1" && chat.body.messages[0].status === "answered", JSON.stringify(chat.body.messages?.map((m) => ({ ...m, text: m.text.length }))));
  const pageChat = (await (await fetch(`${base}/api/board`, { headers: jar })).json()).items.find((i) => i.item_id === orderWork);
  check("the card knows the conversation", pageChat?.chat?.messages === 2 && pageChat?.chat?.open === false, JSON.stringify(pageChat?.chat));
check("the chat list knows when it last moved", typeof pageChat?.chat?.last_at === "number" && pageChat.chat.last_at > 0, JSON.stringify(pageChat?.chat));
check("the chat page needs Access", (await fetch(`${base}/chat`)).status === 401);
check("a new chat with no project goes under the project chat", (await ownerCode({ op: "add", project: "chat", title: "ふつうの会話", day: "20261121" })) === "200 OK");
check("another unknown project is still refused", (await ownerCode({ op: "add", project: "no-such-project", title: "x" })) === "404 NOT_FOUND");
const chatPage = await fetch(`${base}/chat`, { headers: jar });
check("the chat page is served", chatPage.status === 200 && (await chatPage.text()).includes('src="/chat.js"'));
  check("the owner can switch partners", (await ownerCode({ op: "chat_send", item_id: orderWork, text: "Devin でも見て", to: "vps-devin" })) === "200 OK" &&
    (await chatOf(orderWork)).body.open?.to === "vps-devin");
  check("a worker cannot take a turn for the other worker", code(await call(K.vps, "board_chat_take", { item_id: orderWork, seq: (await chatOf(orderWork)).body.open.seq })) === "FORBIDDEN");
  check("a conversation of an unknown item is not found", (await chatOf("nope")).status === 404);

  // --- text attachments of a conversation (R2: local simulation under wrangler dev)
  r = await ownerPost({ op: "add", project: "demo", title: "添付の会話", day: dayOf(0) });
  const attWork = (await r.json()).item?.item_id ?? "";
  const upload = (item, name, body, headers = { ...jar, origin: base }, type = "text/plain; charset=utf-8") =>
    fetch(`${base}/api/board/attachment?item_id=${encodeURIComponent(item)}&name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": type, ...headers }, body });
  const bodyText = ["一行目", "二行目", "三行目", "四行目（先頭には入らない）", "ZZ-SENTINEL-BODY"].join("\n") + "\n" + "あ".repeat(30000);
  check("an upload needs Access", (await upload(attWork, "a.txt", "x", { origin: base })).status === 401);
  check("an upload needs this site's Origin", (await upload(attWork, "a.txt", "x", { ...jar })).status === 403);
  check("an upload with another Origin is refused", (await upload(attWork, "a.txt", "x", { ...jar, origin: "https://evil.example" })).status === 403);
  check("an upload must be text or an image", (await upload(attWork, "a.svg", "<svg/>", undefined, "image/svg+xml")).status === 415);
  check("an image whose bytes are not that type is refused", (await upload(attWork, "a.png", "x", undefined, "image/png")).status === 400);
  check("an empty upload is refused", (await upload(attWork, "a.txt", "")).status === 400);
  check("an upload that is not UTF-8 is refused", (await upload(attWork, "a.txt", new Uint8Array([0xff, 0xfe, 0x41, 0x80]))).status === 400);
  check("an upload with a NUL is refused", (await upload(attWork, "a.txt", "a\u0000b")).status === 400);
  check("an upload for an unknown item is refused", (await upload("nope", "a.txt", "x")).status === 404);
  check("an upload over 1 MB is refused", (await upload(attWork, "big.txt", "a".repeat(1048577))).status === 413);
  r = await upload(attWork, "../メモ/貼り付け.txt", bodyText);
  const up = await r.json();
  check("a text is stored; the name is kept without its path, the head is 3 lines",
    r.status === 200 && up.attachment?.name === "貼り付け.txt" && up.attachment?.chars === bodyText.length && up.attachment?.head === "一行目\n二行目\n三行目" && /^[a-f0-9]{32}$/.test(up.attachment?.id),
    JSON.stringify(up).slice(0, 300));
  const attId = up.attachment?.id ?? "";
  const attGet = (id, headers = jar) => fetch(`${base}/api/board/attachment?id=${id}`, { headers });
  check("reading an attachment needs Access", (await attGet(attId, {})).status === 401);
  const got = await attGet(attId);
  check("the owner reads the body back as plain text", got.status === 200 && (await got.text()) === bodyText && got.headers.get("content-type")?.startsWith("text/plain"));
  check("an unknown attachment id is not found", (await attGet("0".repeat(32))).status === 404);
  check("a bad attachment id is refused", (await attGet("zz")).status === 400);
  check("a message with an unknown attachment is refused and leaves no message",
    (await ownerCode({ op: "chat_send", item_id: attWork, text: "見て", attachments: ["1".repeat(32)] })) === "404 NOT_FOUND" && (await chatOf(attWork)).body.messages?.length === 0);
  check("a bad attachment list is refused", (await ownerCode({ op: "chat_send", item_id: attWork, text: "見て", attachments: ["x"] })) === "400 INVALID" &&
    (await ownerCode({ op: "chat_send", item_id: attWork, text: "見て", attachments: [attId, attId] })) === "400 INVALID");
  check("the owner sends an attachment with no typed text", (await ownerCode({ op: "chat_send", item_id: attWork, text: "", attachments: [attId] })) === "200 OK");
  chat = await chatOf(attWork);
  const attMsg = chat.body.messages?.[0];
  check("the page sees the card, not the body", attMsg?.text === "" && attMsg?.attachments?.length === 1 && attMsg.attachments[0].id === attId &&
    attMsg.attachments[0].expired === false && !JSON.stringify(chat.body).includes("ZZ-SENTINEL-BODY") && chat.body.attachment_limits?.max_bytes === 1048576, JSON.stringify(chat.body.attachment_limits));
  check("a sent attachment cannot be sent again", (await ownerCode({ op: "chat_send", item_id: attWork, text: "もう一度", attachments: [attId] })) === "409 HANDOFF_CONFLICT");
  check("a sent attachment cannot be taken back", (await fetch(`${base}/api/board/attachment?item_id=${encodeURIComponent(attWork)}&id=${attId}`, { method: "DELETE", headers: { ...jar, origin: base } })).status === 403);
  const attTurn = chat.body.open?.seq;
  const attTaken = await call(K.vps, "board_chat_take", { item_id: attWork, seq: attTurn });
  const transcriptText = JSON.stringify(attTaken.transcript);
  check("the worker's transcript has a marker (name, size, head, id), never the body",
    attTaken.ok === true && transcriptText.includes("貼り付け.txt") && transcriptText.includes(attId) && transcriptText.includes("一行目") &&
    !transcriptText.includes("ZZ-SENTINEL-BODY") && !JSON.stringify(attTaken.turn).includes("ZZ-SENTINEL-BODY") &&
    attTaken.turn.text.includes(attId) && attTaken.turn.attachments?.[0]?.id === attId && attTaken.turn.attachments[0].chars === bodyText.length,
    JSON.stringify(attTaken.turn).slice(0, 400));
  check("the transcript stays far smaller than the attachment", transcriptText.length < 2000, String(transcriptText.length));
  check("a writer that is not a server worker cannot read an attachment", code(await call(K.alpha, "board_chat_attachment", { attachment_id: attId })) === "FORBIDDEN");
  const part1 = await call(K.vps, "board_chat_attachment", { attachment_id: attId, offset: 0, limit: 10 });
  check("the restricted writer cannot read the other worker's stored attachment",
    code(await call(K.restricted, "board_chat_attachment", { attachment_id: attId })) === -32602);
  check("the worker reads a part by characters", part1.ok === true && part1.text === "一行目\n二行目\n三行目".slice(0, 10) && part1.returned === 10 && part1.next_offset === 10 && part1.total_chars === bodyText.length, JSON.stringify(part1).slice(0, 300));
  const sentinelAt = bodyText.indexOf("ZZ-SENTINEL-BODY");
  const part2 = await call(K.vps, "board_chat_attachment", { attachment_id: attId, offset: sentinelAt, limit: 16 });
  check("the worker reads a later part with an offset", part2.text === "ZZ-SENTINEL-BODY" && part2.next_offset === sentinelAt + 16, JSON.stringify(part2).slice(0, 200));
  const whole = await call(K.vps, "board_chat_attachment", { attachment_id: attId });
  check("a read returns at most 20000 characters and says where to go on", whole.returned === 20000 && whole.next_offset === 20000, JSON.stringify({ r: whole.returned, n: whole.next_offset }));
  const tail = await call(K.vps, "board_chat_attachment", { attachment_id: attId, offset: bodyText.length - 5, limit: 100 });
  check("the last part has no next_offset", tail.returned === 5 && tail.next_offset === null);
  check("limit 0 is refused", code(await call(K.vps, "board_chat_attachment", { attachment_id: attId, limit: 0 })) === "INVALID");
  check("an unknown attachment is not found for the worker", code(await call(K.vps, "board_chat_attachment", { attachment_id: "2".repeat(32) })) === "NOT_FOUND");
  check("the worker answers a turn that had an attachment", (await call(K.vps, "board_chat_reply", { item_id: attWork, seq: attTurn, text: "読みました" })).ok === true);

  // --- image attachments: stored as sent (type checked by the first bytes), given to the worker as MCP image content
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const pngOf = (size) => { const b = new Uint8Array(size); b.set(PNG_SIG); return b; };
  check("a PNG sent as JPEG is refused", (await upload(attWork, "s.jpg", pngOf(64), undefined, "image/jpeg")).status === 400);
  check("an image over 5 MB is refused", (await upload(attWork, "big.png", pngOf(5 * 1048576 + 1), undefined, "image/png")).status === 413);
  const shot = pngOf(300);
  r = await upload(attWork, "スクリーンショット.png", shot, undefined, "image/png");
  const imgUp = await r.json();
  const imgId = imgUp.attachment?.id ?? "";
  check("an image is stored with its type", r.status === 200 && imgUp.attachment?.mime === "image/png" && imgUp.attachment?.bytes === 300 && imgUp.attachment?.chars === 0, JSON.stringify(imgUp));
  check("the owner sends the image", (await ownerCode({ op: "chat_send", item_id: attWork, text: "これ見て", attachments: [imgId] })) === "200 OK");
  const imgGet = await attGet(imgId);
  check("the owner reads the image back as that type, sandboxed", imgGet.status === 200 && imgGet.headers.get("content-type") === "image/png" &&
    imgGet.headers.get("content-security-policy") === "sandbox" && (await imgGet.arrayBuffer()).byteLength === 300);
  chat = await chatOf(attWork);
  const imgMsg = chat.body.messages?.at(-1);
  check("the page sees the image's type", imgMsg?.attachments?.[0]?.mime === "image/png" && chat.body.attachment_limits?.image_max_bytes === 5242880);
  const imgPending = await call(K.vps, "board_chat_pending", {});
  const imgTurn = imgPending.turns?.find((t) => t.item_id === attWork)?.seq;
  const imgTaken = await call(K.vps, "board_chat_take", { item_id: attWork, seq: imgTurn });
  check("the worker's turn carries an image marker", imgTaken.ok === true && imgTaken.turn.text.includes("添付 画像") && imgTaken.turn.text.includes(imgId) && imgTaken.turn.attachments?.[0]?.mime === "image/png", imgTaken.turn?.text);
  const rawImg = await rpc(K.vps, "tools/call", { name: "board_chat_attachment", arguments: { attachment_id: imgId } });
  const parts = rawImg.body.result?.content ?? [];
  const imgPart = parts.find((c) => c.type === "image");
  check("the worker gets the image as MCP image content", rawImg.body.result?.isError === false && imgPart?.mimeType === "image/png" &&
    Buffer.from(imgPart.data, "base64").equals(Buffer.from(shot)) && parts[0]?.type === "text" && JSON.parse(parts[0].text).name === "スクリーンショット.png", JSON.stringify(parts.map((c) => c.type)));
  check("the worker answers the image turn", (await call(K.vps, "board_chat_reply", { item_id: attWork, seq: imgTurn, text: "画像を見ました" })).ok === true);

  // limits: one file 1 MB (an image 5 MB), five on a message, 20 MiB and 20 in a conversation; unsent ones can be taken back
  r = await ownerPost({ op: "add", project: "demo", title: "添付の上限", day: dayOf(0) });
  const capWork = (await r.json()).item?.item_id ?? "";
  const mb = "a".repeat(1048576);
  const ids = [];
  for (let n = 0; n < 5; n++) { const x = await (await upload(capWork, `m${n}.txt`, mb)).json(); ids.push(x.attachment?.id); }
  check("five files of exactly 1 MB are accepted", ids.every((x) => typeof x === "string"), JSON.stringify(ids));
  const fiveMb = pngOf(5 * 1048576);
  const bigImages = [];
  for (let n = 0; n < 3; n++) bigImages.push((await upload(capWork, `i${n}.png`, fiveMb, undefined, "image/png")).status);
  check("three 5 MB images fill the conversation to 20 MiB", bigImages.every((c) => c === 200), JSON.stringify(bigImages));
  check("one more byte is over the conversation's 20 MiB", (await upload(capWork, "m5.txt", "a")).status === 409);
  check("more than five on one message is refused", (await ownerCode({ op: "chat_send", item_id: capWork, text: "x", attachments: [...ids, "3".repeat(32)] })) === "400 INVALID");
  r = await fetch(`${base}/api/board/attachment?item_id=${encodeURIComponent(capWork)}&id=${ids[4]}`, { method: "DELETE", headers: { ...jar, origin: base } });
  check("an unsent attachment can be taken back", r.status === 200 && (await attGet(ids[4])).status === 404);
  check("taking one back frees room", (await upload(capWork, "again.txt", mb)).status === 200);
  r = await ownerPost({ op: "add", project: "demo", title: "未送信の上限", day: dayOf(0) });
  const unsentWork = (await r.json()).item?.item_id ?? "";
  let unsentCodes = [];
  for (let n = 0; n < 11; n++) unsentCodes.push((await upload(unsentWork, `u${n}.txt`, "x")).status);
  check("ten unsent attachments at most", unsentCodes.slice(0, 10).every((c) => c === 200) && unsentCodes[10] === 409, JSON.stringify(unsentCodes));

  // --- #46 段 2: 全部止める (op pause), board_my_work, versions, results, 手元だけ (op scope)
  await call(K.alpha, "board_upsert_item", { item_id: "stop1", project: "scoped", kind: "task", title: "work to stop", state: "planned" });
  await call(K.alpha, "board_upsert_item", { item_id: "stop2", project: "scoped", kind: "task", title: "work with a result", state: "planned" });
  check("the owner hands stop1 to vps-claude", (await ownerCode({ op: "hand", item_id: "stop1", to: "vps-claude" })) === "200 OK");
  let mine = await call(K.vps, "board_my_work", { project: "scoped" });
  check("board_my_work lists the caller's work", mine.ok === true && mine.paused === false && mine.items.map((i) => i.item_id).join(",") === "stop1" &&
    mine.items[0].handoff?.to === "vps-claude" && mine.items[0].kind === "task", JSON.stringify(mine).slice(0, 400));
  check("board_my_work leaves out work for others", (await call(K.alpha, "board_my_work", { project: "scoped" })).items.length === 0);
  const req1 = mine.items[0]?.handoff?.request_id;
  check("the owner stops everything", (await ownerCode({ op: "pause", paused: true })) === "200 OK");
  page = await (await fetch(`${base}/api/board`, { headers: jar })).json();
  check("the page data says everything is stopped", page.paused?.paused === true && page.paused?.by === "page:owner", JSON.stringify(page.paused));
  check("board_my_work says it is stopped", (await call(K.vps, "board_my_work", { project: "scoped" })).paused === true);
  check("an accept is refused while everything is stopped", code(await call(K.vps, "board_accept_handoff", { item_id: "stop1", request_id: req1 })) === "PAUSED");
  const pausedTurns = await call(K.vps, "board_chat_pending", {});
  check("no conversation turn is offered while everything is stopped", pausedTurns.turns.length === 0 && pausedTurns.paused === true);
  check("pause needs true or false", (await ownerCode({ op: "pause", paused: "yes" })) === "400 INVALID");
  check("the owner resumes", (await ownerCode({ op: "pause", paused: false })) === "200 OK");
  check("bad versions are refused", code(await call(K.vps, "board_accept_handoff", { item_id: "stop1", request_id: req1, versions: "Picker=xyz" })) === "INVALID");
  let acc = await call(K.vps, "board_accept_handoff", { item_id: "stop1", request_id: req1, versions: "picker=abc1234,rules=0123456789abcdef" });
  check("an accept records the versions it was given", acc.ok === true && acc.handoff?.versions?.picker === "abc1234" && acc.handoff?.versions?.rules === "0123456789abcdef", JSON.stringify(acc.handoff));
  const fence1 = { item_id: "stop1", request_id: req1, generation: acc.handoff?.generation };
  check("board_my_work lists the caller's own run", (await call(K.vps, "board_my_work", { project: "scoped" })).items[0]?.handoff?.state === "accepted");
  let hb = await call(K.vps, "board_heartbeat_handoff", fence1);
  check("a heartbeat says nothing about stopping while the board runs", hb.ok === true && hb.stop === undefined, JSON.stringify(hb).slice(0, 200));
  await ownerPost({ op: "pause", paused: true });
  hb = await call(K.vps, "board_heartbeat_handoff", fence1);
  check("a heartbeat tells the run to stop while everything is stopped", hb.ok === true && hb.stop === true && hb.stop_reason === "paused", JSON.stringify(hb).slice(0, 200));
  const prog = await call(K.vps, "board_progress_handoff", { ...fence1, kind: "note", text: "still here" });
  check("a progress write also tells the run to stop", prog.ok === true && prog.stop === true);
  const given = await call(K.vps, "board_release_handoff", fence1);
  check("the stopped run gives the work back to the pile", given.ok === true && given.item?.state === "planned" && given.handoff === null, JSON.stringify(given).slice(0, 300));
  await ownerPost({ op: "pause", paused: false });
  check("the owner hands stop2 to vps-claude", (await ownerCode({ op: "hand", item_id: "stop2", to: "vps-claude" })) === "200 OK");
  const req2 = (await handoffOf("stop2"))?.request_id;
  acc = await call(K.vps, "board_accept_handoff", { item_id: "stop2", request_id: req2 });
  const fence2 = { item_id: "stop2", request_id: req2, generation: acc.handoff?.generation };
  check("an accept without versions records none", acc.ok === true && acc.handoff?.versions === null);
  check("a bad result commit is refused", code(await call(K.vps, "board_complete_handoff", { ...fence2, outcome: "done", commit: "XYZ" })) === "INVALID");
  check("a result link must be https", code(await call(K.vps, "board_complete_handoff", { ...fence2, outcome: "done", ref: "http://example.com/x" })) === "INVALID");
  const finished = await call(K.vps, "board_complete_handoff", { ...fence2, outcome: "done", ref: "https://github.com/example/repo/pull/7", commit: "0a1b2c3d" });
  check("a completion keeps the result link and commit", finished.ok === true && finished.handoff?.result?.ref === "https://github.com/example/repo/pull/7" && finished.handoff?.result?.commit === "0a1b2c3d", JSON.stringify(finished.handoff));
  const resultStatus = await call(K.alpha, "board_request_status", { item_id: "stop2" });
  check("the result link is among the request's evidence", JSON.stringify(resultStatus).includes("https://github.com/example/repo/pull/7"));
  check("the owner hands stop1 to vps-claude again", (await ownerCode({ op: "hand", item_id: "stop1", to: "vps-claude" })) === "200 OK");
  check("a scope needs a known project", (await ownerCode({ op: "scope", project: "no-such-project", scope: "local" })) === "404 NOT_FOUND");
  check("a scope is local or any", (await ownerCode({ op: "scope", project: "scoped", scope: "cloud" })) === "400 INVALID");
  r = await ownerPost({ op: "scope", project: "scoped", scope: "local" });
  out = await r.json();
  check("marking a project 手元だけ sends its outside requests back to the board's choice", r.status === 200 && out.rerouted === 1 && out.scopes?.scoped === "local", JSON.stringify(out));
  page = await (await fetch(`${base}/api/board`, { headers: jar })).json();
  check("the page data lists the 手元だけ projects", page.scopes?.scoped === "local");
  check("a 手元だけ project refuses a destination outside the PC", (await ownerCode({ op: "route", item_id: "stop1", to: "vps-claude" })) === "403 FORBIDDEN");
  check("a writer cannot route 手元だけ work outside the PC either", code(await call(K.alpha, "board_route_handoff", { item_id: "stop1", to: "devin" })) === "FORBIDDEN");
  check("a 手元だけ project may still go on hold", (await ownerCode({ op: "route", item_id: "stop1", to: "hold" })) === "200 OK");
  // The board's choice for a 手元だけ project goes down the PC's part of the order only.
  await call(K.local, "board_my_work", {});
  await call(K.vps, "board_my_work", {});
  check("the owner sets an order with the server first", (await ownerCode({ op: "order", order: ["vps-claude", "local-claude"] })) === "200 OK");
  check("the owner sends stop1 to the board's choice", (await ownerCode({ op: "route", item_id: "stop1", to: null })) === "200 OK");
  let chosen = null;
  for (let n = 0; n < 20 && (chosen === null || chosen === undefined); n++) {
    await new Promise((res) => setTimeout(res, 250));
    chosen = (await handoffOf("stop1"))?.to;
  }
  check("the board's choice for 手元だけ work skips the server", chosen === "local-claude", String(chosen));
  const req3 = (await handoffOf("stop1"))?.request_id;
  check("the PC takes 手元だけ work", (await call(K.local, "board_accept_handoff", { item_id: "stop1", request_id: req3 })).ok === true);
  check("talking to the server about 手元だけ work is refused", (await ownerCode({ op: "chat_send", item_id: "stop2", text: "hello" })) === "403 FORBIDDEN");
  check("a project goes back to どこでもよい", (await ownerCode({ op: "scope", project: "scoped", scope: "any" })) === "200 OK");
  page = await (await fetch(`${base}/api/board`, { headers: jar })).json();
  check("the page data no longer lists it", page.scopes?.scoped === undefined);

  // --- restricted external actor: assigned request and fenced result only
  const localMine = await call(K.local, "board_my_work", { project: "scoped" });
  const localRun = localMine.items.find((item) => item.item_id === "stop1");
  const foreignFence = { item_id: "stop1", request_id: localRun.handoff.request_id, generation: localRun.handoff.generation };
  const hiddenForeign = await call(K.restricted, "board_accept_handoff", { item_id: "stop1", request_id: foreignFence.request_id });
  check("restricted credentials receive the same generic refusal for a foreign accepted request",
    code(hiddenForeign) === "NOT_FOUND" && !JSON.stringify(hiddenForeign).includes("local-claude") && !JSON.stringify(hiddenForeign).includes("stop1"));
  check("the assigned writer can stop its own prior run", (await call(K.local, "board_release_handoff", foreignFence)).ok === true);
  check("the owner assigns the synthetic request directly to grokbot", (await ownerCode({ op: "hand", item_id: "stop1", to: "grokbot" })) === "200 OK");
  const ownRequest = (await call(K.alpha, "board_request_status", { item_id: "stop1" })).request_id;
  const other = { item_id: "foreign-p0", project: "other-project-p0", title: "Other writer's private task" };
  check("the other writer has a simultaneous assignment",
    (await call(K.alpha, "board_upsert_item", { ...other, kind: "task", state: "planned" })).ok &&
    (await ownerCode({ op: "hand", item_id: other.item_id, to: "muse" })) === "200 OK");
  const otherRequest = (await call(K.alpha, "board_request_status", { item_id: other.item_id })).request_id;
  const ownWork = await call(K.restricted, "board_my_work", {});
  check("unfiltered discovery hides the other project, task and request",
    typeof otherRequest === "string" && [...Object.values(other), otherRequest].every(value => !JSON.stringify(ownWork).includes(value)));
  check("restricted my_work returns only its assignment and no global or parent metadata",
    ownWork.items?.length === 1 && ownWork.items[0]?.item_id === "stop1" && !("scopes" in ownWork) && !("chat_turns" in ownWork) && !("parent_id" in ownWork.items[0]));
  const ownAccepted = await call(K.restricted, "board_accept_handoff", { item_id: "stop1", request_id: ownRequest });
  const ownFence = { item_id: "stop1", request_id: ownRequest, generation: ownAccepted.handoff?.generation };
  check("restricted accept returns the own item without parent_id", ownAccepted.handoff?.accepted_by === "grokbot" && !("parent_id" in ownAccepted.item));
  await ownerPost({ op: "pause", paused: true });
  const ownerStopSignal = await call(K.restricted, "board_heartbeat_handoff", ownFence);
  check("owner stop reaches the restricted run", ownerStopSignal.stop === true && ownerStopSignal.stop_reason === "paused");
  await ownerPost({ op: "pause", paused: false });
  const staleOwnHeartbeat = await call(K.restricted, "board_heartbeat_handoff", { ...ownFence, generation: ownFence.generation + 1 });
  check("restricted heartbeat rejects a stale generation", code(staleOwnHeartbeat) === "STALE_GENERATION", JSON.stringify(staleOwnHeartbeat));
  const ownHeartbeat = await call(K.restricted, "board_heartbeat_handoff", ownFence);
  check("restricted heartbeat renews its own live lease", ownHeartbeat.ok === true, JSON.stringify(ownHeartbeat));
  const ownProgress = await call(K.restricted, "board_progress_handoff", { ...ownFence, kind: "note", text: "Synthetic restricted result" });
  check("restricted progress reports the authenticated actor", ownProgress.event?.actor === "grokbot", JSON.stringify(ownProgress));
  const ownCompleted = await call(K.restricted, "board_complete_handoff", { ...ownFence, outcome: "done" });
  check("restricted completion keeps parent_id out of the response", ownCompleted.handoff?.state === "completed" && !("parent_id" in ownCompleted.item), JSON.stringify(ownCompleted));
  await call(K.alpha, "board_upsert_item", { item_id: "stop1", state: "planned" });
  await ownerPost({ op: "hand", item_id: "stop1", to: "grokbot" });
  const expiringRequest = (await call(K.alpha, "board_request_status", { item_id: "stop1" })).request_id;
  const expiringAccept = await call(K.restricted, "board_accept_handoff", { item_id: "stop1", request_id: expiringRequest });
  const expiringFence = { item_id: "stop1", request_id: expiringRequest, generation: expiringAccept.handoff.generation };
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const expiredHeartbeat = await call(K.restricted, "board_heartbeat_handoff", expiringFence);
  check("an expired restricted lease cannot be renewed", code(expiredHeartbeat) === "STALE_GENERATION", JSON.stringify(expiredHeartbeat));
  check("the owner can quarantine and release the expired run", (await ownerCode({ op: "mark_unknown", item_id: "stop1", request_id: expiringRequest })) === "200 OK" &&
    (await ownerCode({ op: "release", item_id: "stop1", request_id: expiringRequest })) === "200 OK");

  // --- the item limit (27 in this run)
  let lastCode = "OK";
  for (let n = 0; n < 27 && lastCode === "OK"; n++) {
    lastCode = code(await call(K.alpha, "board_upsert_item", { item_id: `fill${n}`, project: "demo", kind: "task", title: `f${n}`, state: "planned" }));
  }
  check("item limit", lastCode === "BOARD_ITEM_LIMIT");
  list = await call(K.alpha, "board_list", {});
  check("item count stays at the limit", list.counts.items === 27, String(list.counts.items));
  // The counts are kept by triggers (issue #38), not counted per call: they must
  // still match the rows. Events are never deleted and seq is the rowid, so
  // the newest seq is the number of events.
  let newestSeq = 0;
  for (let part = list; ; ) {
    newestSeq = part.next_since_seq;
    if (!part.events_truncated) break;
    part = await call(K.alpha, "board_list", { since_seq: newestSeq });
  }
  check("kept counts match the rows", list.items.length === list.counts.items && newestSeq === list.counts.events,
    `${list.items.length}/${list.counts.items} items, seq ${newestSeq}/${list.counts.events} events`);

  // --- page data
  page = await (await fetch(`${base}/api/board`, { headers: jar })).json();
  check("page lists newest event first", page.events[0].seq > page.events[page.events.length - 1].seq);

  // --- survives a restart
  const before = list.counts;
  const hasLegacyAssignment = (work) => work.items?.some(i => i.item_id === "pile2" && i.handoff?.to === null);
  check("trusted writer sees its previously accepted unaddressed task", hasLegacyAssignment(await call(K.muse, "board_my_work", {})));
  stop();
  writers.writers.find(w => w.actor === "muse").policy = "restricted";
  writeTestEnv();
  await new Promise((r) => setTimeout(r, 1500));
  await start();
  const narrowed = await call(K.muse, "board_my_work", {});
  check("downgrading the writer hides previously accepted unaddressed tasks", narrowed.ok && !narrowed.items.some(item => item.item_id === "pile2"));
  list = await call(K.alpha, "board_list", {});
  check("data survives a restart", list.counts.items === before.items && list.counts.events === before.events,
    `${JSON.stringify(before)} -> ${JSON.stringify(list.counts)}`);
  const afterRestart = list.items.map((i) => i.item_id);
  check("the order of the pile survives a restart", afterRestart.indexOf("late1") < afterRestart.indexOf("d3"));
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
  console.error(`before the crash: passed ${passed}, failed ${failures.length}`);
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(2);
}
console.log(`passed ${passed}, failed ${failures.length}`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
