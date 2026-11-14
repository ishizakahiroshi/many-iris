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
const K = { alpha: key(), beta: key(), stranger: key(), muse: key() };
const writers = { schema_version: 1, writers: [
  { actor: "alpha", token_sha256: sha(K.alpha), enabled: true },
  { actor: "beta", token_sha256: sha(K.beta), enabled: false },
  { actor: "muse", token_sha256: sha(K.muse), enabled: true },
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

async function main() {
  mkdirSync(temp, { recursive: true });
  writeFileSync(join(temp, "test.env"),
    `BOARD_WRITERS='${JSON.stringify(writers)}'\nACCESS_TEAM_DOMAIN=${team}\nACCESS_AUD=${AUD}\nBOARD_OWNERS=other@example.com, ${OWNER.toUpperCase()}\nBOARD_LIMIT_ITEMS=14\nBOARD_PUBLIC_ORIGIN=${base}\n`);
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
  check("seven tools", res.body.result?.tools?.map((t) => t.name).join(",") === "board_upsert_item,board_add_event,board_list,board_request_handoff,board_accept_handoff,board_route_handoff,board_take_back_handoff",
    `${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
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
  check("the owner takes the request back", (await ownerCode({ op: "take_back", item_id: piled.item_id })) === "200 OK" && (await handoffOf(piled.item_id)) === null);
  check("a request that was taken back cannot be accepted", code(await call(K.alpha, "board_accept_handoff", { item_id: piled.item_id, request_id: firstRequest })) === "HANDOFF_CONFLICT");
  out = await (await ownerPost({ op: "hand", item_id: piled.item_id })).json();
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
  const writerAccepted = await call(K.alpha, "board_accept_handoff", { item_id: "pile2", request_id: writerRequest2 });
  check("a writer accepts its own request", writerAccepted.handoff?.state === "accepted" && writerAccepted.item?.state === "in_progress", JSON.stringify(writerAccepted));
  check("a request without a destination says so", writerAccepted.handoff?.to === null, JSON.stringify(writerAccepted.handoff));

  // --- the destination of a request (handoff.to)
  await call(K.alpha, "board_upsert_item", { item_id: "pile3", project: "demo", kind: "task", title: "work for one writer", state: "planned" });
  const badTo = code(await call(K.alpha, "board_request_handoff", { item_id: "pile3", to: "someone" }));
  check("a destination outside the list is refused", badTo === "INVALID", String(badTo));
  check("the page refuses a destination outside the list", (await ownerCode({ op: "hand", item_id: "pile3", to: "someone" })) === "400 INVALID");
  r = await ownerPost({ op: "hand", item_id: "pile3", to: "hold" });
  out = await r.json();
  check("the owner hands work over with a destination", r.status === 200 && out.handoff?.to === "hold" && (await handoffOf("pile3"))?.to === "hold", JSON.stringify(out));
  check("taking a request back clears its destination", (await ownerCode({ op: "take_back", item_id: "pile3" })) === "200 OK" && (await handoffOf("pile3")) === null);
  const toMuse = await call(K.alpha, "board_request_handoff", { item_id: "pile3", to: "muse" });
  const museRequest = toMuse.handoff?.request_id ?? "";
  check("a writer hands work to a destination", toMuse.handoff?.to === "muse" && (await handoffOf("pile3"))?.to === "muse", JSON.stringify(toMuse));
  check("a request for muse cannot be taken by another writer", code(await call(K.alpha, "board_accept_handoff", { item_id: "pile3", request_id: museRequest })) === "FORBIDDEN");
  check("the owner routes the request to hold", (await ownerCode({ op: "route", item_id: "pile3", to: "hold" })) === "200 OK" && (await handoffOf("pile3"))?.to === "hold");
  check("nobody takes a request on hold", code(await call(K.muse, "board_accept_handoff", { item_id: "pile3", request_id: museRequest })) === "FORBIDDEN" &&
    code(await call(K.alpha, "board_accept_handoff", { item_id: "pile3", request_id: museRequest })) === "FORBIDDEN");
  check("routing needs a destination", (await ownerCode({ op: "route", item_id: "pile3" })) === "400 INVALID");
  check("a writer cannot route to a destination outside the list", code(await call(K.alpha, "board_route_handoff", { item_id: "pile3", to: "someone" })) === "INVALID");
  check("a writer must name the destination", code(await call(K.alpha, "board_route_handoff", { item_id: "pile3" })) === -32602);
  const writerRouted = await call(K.muse, "board_route_handoff", { item_id: "pile3", to: "devin" });
  check("a writer routes a request on hold", writerRouted.changed === true && writerRouted.handoff?.to === "devin" && (await handoffOf("pile3"))?.to === "devin", JSON.stringify(writerRouted));
  check("routing by a writer names the writer", (await call(K.alpha, "board_list", {})).events.some((e) => e.item_id === "pile3" && e.actor === "muse" && e.text === `routed ${museRequest} to devin`));
  check("routing to the same destination changes nothing", (await call(K.alpha, "board_route_handoff", { item_id: "pile3", to: "devin" })).changed === false);
  r = await ownerPost({ op: "route", item_id: "pile3", to: "muse" });
  out = await r.json();
  check("the owner routes a request on hold to a writer", r.status === 200 && out.changed === true && out.handoff?.to === "muse" && out.handoff?.request_id === museRequest, JSON.stringify(out));
  const page3 = (await (await fetch(`${base}/api/board`, { headers: jar })).json()).items.find((i) => i.item_id === "pile3");
  check("the page data carries the destination", page3?.handoff?.to === "muse");
  const routedEvent = (await call(K.alpha, "board_list", {})).events.some((e) => e.item_id === "pile3" && e.text === `routed ${museRequest} to muse`);
  check("routing leaves an event", routedEvent);
  const museTook = await call(K.muse, "board_accept_handoff", { item_id: "pile3", request_id: museRequest });
  check("the writer of the destination takes the request", museTook.handoff?.state === "accepted" && museTook.handoff?.accepted_by === "muse", JSON.stringify(museTook));
  check("an accepted request cannot be routed", (await ownerCode({ op: "route", item_id: "pile3", to: "devin" })) === "409 HANDOFF_CONFLICT");
  check("an accepted request cannot be routed by a writer", code(await call(K.alpha, "board_route_handoff", { item_id: "pile3", to: "devin" })) === "HANDOFF_CONFLICT");
  check("an accepted request cannot be taken back by a writer", code(await call(K.alpha, "board_take_back_handoff", { item_id: "pile3" })) === "HANDOFF_CONFLICT");

  // --- the cron gives a destination to work handed over without one (Clef, or hold
  // when the router cannot answer). The test has no Devin key, so nobody is started.
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

  check("the same request cannot be accepted twice", code(await call(K.alpha, "board_accept_handoff", { item_id: piled.item_id, request_id: request })) === "HANDOFF_CONFLICT");
  check("an accepted request cannot be taken back", (await ownerCode({ op: "take_back", item_id: piled.item_id })) === "409 HANDOFF_CONFLICT");
  check("the page data carries the hand-off", (await (await fetch(`${base}/api/board`, { headers: jar })).json()).items
    .find((i) => i.item_id === piled.item_id)?.handoff?.state === "accepted");
  check("a writer still writes after the owner", (await call(K.alpha, "board_upsert_item", { item_id: piled.item_id, state: "in_progress" })).item?.updated_by === "alpha");

  // --- the item limit (14 in this run)
  let lastCode = "OK";
  for (let n = 0; n < 14 && lastCode === "OK"; n++) {
    lastCode = code(await call(K.alpha, "board_upsert_item", { item_id: `fill${n}`, project: "demo", kind: "task", title: `f${n}`, state: "planned" }));
  }
  check("item limit", lastCode === "BOARD_ITEM_LIMIT");
  list = await call(K.alpha, "board_list", {});
  check("item count stays at the limit", list.counts.items === 14, String(list.counts.items));

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
