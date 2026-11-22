// Many Iris board on Cloudflare Workers.
//
//   GET  /board        read-only page (people, through Cloudflare Access)
//   GET  /chat         the conversations with the server's AI workers (through Cloudflare Access)
//   GET  /api/board    page data (people, through Cloudflare Access)
//   POST /board/mcp    MCP for writers: a writer key, or an OAuth access token
//                      for this resource, as a Bearer token (Access lets this path through)
//   GET/POST /authorize  OAuth consent page (a board owner, through Cloudflare Access)
//   /.well-known/oauth-*, /oauth/token, /oauth/register
//                      OAuth discovery, tokens and client registration (the library;
//                      Access lets these through)
//   GET  /healthz      "ok"
//
// Scripts and styles come from ./public (static assets, no secrets in them).
import { DurableObject } from "cloudflare:workers";
import { ExternalTokenError, OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import boardHtml from "../web/board.html";
import chatHtml from "../web/chat.html";
import { accessUser, type AccessResult } from "./access";
import { ATTACHMENT_MAX_BYTES, IMAGE_MAX_BYTES, attachmentKey, cleanName, isImageType, parseText, sliceChars, sniffImage, toBase64 } from "./attachments";
import { DISPATCH_ACTOR, runDispatcher, spawnDevinSession, type DispatchDeps } from "./dispatch.ts";
import { authenticate } from "./keys";
import { handle } from "./mcp";
import { SCOPE, authorize } from "./oauth";
import { validActor, validItemId } from "./rules";
import { DEFAULT_LIMITS, Store, guarded, type Limits } from "./store";
import { HANDOFF_LEASE_MS } from "./resume";

export interface Env {
  BOARD: DurableObjectNamespace<BoardStore>;
  /** OAuth clients, grants and tokens (the library's storage). */
  OAUTH_KV: KVNamespace;
  /** Injected by the OAuth library into the handlers it calls. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Bodies of the conversations' text attachments (R2). Owner-only reads; the 30-day expiry is an R2 lifecycle rule. */
  ATTACHMENTS: R2Bucket;
  /** The public origin, e.g. https://iris.example.com: the OAuth issuer. */
  BOARD_PUBLIC_ORIGIN?: string;
  /** JSON: {"schema_version":1,"writers":[{"actor","token_sha256","enabled"}]} */
  BOARD_WRITERS?: string;
  /** Cloudflare Access settings for the people who read the page (see access.ts). */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  BOARD_OWNERS?: string;
  /** Test-only overrides of the item and event limits. */
  BOARD_LIMIT_ITEMS?: string;
  BOARD_LIMIT_EVENTS?: string;
  /** Test-only override of the handoff lease, in milliseconds. */
  BOARD_LEASE_MS?: string;
  /** Devin API key for the scheduled dispatcher (wrangler secret put DEVIN_API_KEY). */
  DEVIN_API_KEY?: string;
  /** Override of the sessions endpoint (defaults to https://api.devin.ai/v1/sessions).
   * A service-user key targets the org-scoped v3 endpoint instead:
   *   https://api.devin.ai/v3/organizations/<org>/sessions */
  DEVIN_SESSIONS_URL?: string;
}

const MCP_PATH = "/board/mcp";

// A conversation message may be 20,000 characters (store.ts CHAT_TEXT_MAX).
const MAX_BODY = 131072;

function limitsFrom(env: Env): Limits {
  const pick = (raw: string | undefined, fallback: number) => {
    const n = Number(raw);
    return raw !== undefined && Number.isSafeInteger(n) && n > 0 ? n : fallback;
  };
  return {
    items: pick(env.BOARD_LIMIT_ITEMS, DEFAULT_LIMITS.items),
    events: pick(env.BOARD_LIMIT_EVENTS, DEFAULT_LIMITS.events),
    leaseMs: pick(env.BOARD_LEASE_MS, HANDOFF_LEASE_MS),
  };
}

export class BoardStore extends DurableObject<Env> {
  private store: Store;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage, limitsFrom(env));
    ctx.blockConcurrencyWhile(async () => this.store.init());
  }
  async run(tool: string, actor: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Every call with a writer's key says that writer is running (the owner's
    // order passes over takers that stopped coming). A failure here must not
    // cost the call itself.
    if (actor !== DISPATCH_ACTOR) {
      try { this.store.noteSeen(actor, Date.now()); } catch { /* the call goes on */ }
    }
    if (tool === "board_chat_attachment") return this.readAttachmentTool(actor, args);
    const result = guarded(() => {
      switch (tool) {
        case "board_upsert_item":
          return this.store.upsertItem(actor, args);
        case "board_add_event":
          return this.store.addEvent(actor, args);
        case "board_list":
          return this.store.listForTool(args);
        case "board_my_work":
          return this.store.myWork(actor, args);
        case "board_request_status":
          return this.store.requestStatus(args);
        case "board_request_handoff":
          return this.store.requestHandoff(actor, args, newBacklogId);
        case "board_accept_handoff":
          return this.store.acceptHandoff(actor, args);
        case "board_route_handoff":
          return this.store.routeForTool(actor, args);
        case "board_take_back_handoff":
          return this.store.takeBackForTool(actor, args);
        case "board_heartbeat_handoff":
          return this.store.heartbeatHandoff(actor, args);
        case "board_progress_handoff":
          return this.store.progressHandoff(actor, args);
        case "board_complete_handoff":
          return this.store.completeHandoff(actor, args);
        case "board_mark_handoff_unknown":
          return this.store.markUnknownForTool(actor, args);
        case "board_release_handoff":
          return this.store.releaseHandoff(actor, args);
        case "board_resume_handoff":
          return this.store.resumeHandoff(actor, args);
        case "board_resolve_dispatch":
          return this.store.resolveDispatch(actor, args);
        case "board_chat_pending":
          return this.store.chatPending(actor);
        case "board_chat_take":
          return this.store.chatTake(actor, args);
        case "board_chat_reply":
          return this.store.chatReply(actor, args);
        default:
          return { ok: false, error: { code: "FORBIDDEN", detail: "Operation unavailable" } };
      }
    });
    // A call that created work (or one that did not) costs two indexed reads
    // when nobody is watching, so this runs after every tool answer.
    this.pokeWatchers();
    return result;
  }
  async page(): Promise<Record<string, unknown>> {
    return guarded(() => this.store.pageData(Boolean(this.env.DEVIN_API_KEY)));
  }
  /** One conversation for the page (see Store.chatView). */
  async chat(itemId: string): Promise<Record<string, unknown>> {
    return guarded(() => this.store.chatView(itemId));
  }
  /** The `board_chat_attachment` tool: a part of an attachment's text, by characters. The body is read from R2 here, never put in a transcript. */
  private async readAttachmentTool(actor: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let checked: ReturnType<Store["attachmentForWorker"]>;
    try {
      checked = this.store.attachmentForWorker(actor, args);
    } catch (e) {
      return guarded(() => { throw e; });
    }
    const object = await this.env.ATTACHMENTS.get(attachmentKey(checked.meta.id));
    if (object === null) return { ok: false, error: { code: "NOT_FOUND", detail: "The attachment's text is gone (expired)" } };
    if (isImageType(checked.meta.mime)) {
      const bytes = new Uint8Array(await object.arrayBuffer());
      return {
        ok: true, attachment_id: checked.meta.id, name: checked.meta.name, mime: checked.meta.mime, bytes: bytes.length,
        image: { data: toBase64(bytes), mimeType: checked.meta.mime },
      };
    }
    const part = sliceChars(await object.text(), checked.offset, checked.limit);
    return {
      ok: true, attachment_id: checked.meta.id, name: checked.meta.name, offset: checked.offset,
      returned: [...part.text].length, total_chars: part.total, next_offset: part.next, text: part.text,
    };
  }
  /** Reserve an attachment's record (see Store.attachmentAdd). */
  async attachmentAdd(itemId: string, id: string, name: string, bytes: number, chars: number, head: string, mime: string | null = null): Promise<Record<string, unknown>> {
    return guarded(() => this.store.attachmentAdd(itemId, id, name, bytes, chars, head, mime));
  }
  async attachmentDrop(itemId: string, id: string): Promise<Record<string, unknown>> {
    return guarded(() => this.store.attachmentDrop(itemId, id));
  }
  async attachmentMeta(id: string): Promise<Record<string, unknown>> {
    return guarded(() => ({ ok: true, ...this.store.attachmentMeta(id) }));
  }
  /** A write by the signed-in owner from the page (see Store.ownerWrite). */
  async ownerWrite(args: unknown): Promise<Record<string, unknown>> {
    const result = guarded(() => this.store.ownerWrite(OWNER_ACTOR, args, newBacklogId));
    this.pokeWatchers();
    return result;
  }
  /** The dispatcher's reads and marks (see the scheduled handler). */
  async pendingHandoffs(): Promise<Record<string, unknown>> {
    return guarded(() => this.store.pendingHandoffs());
  }
  async dispatchState(request: string, since: number): Promise<Record<string, unknown>> {
    return guarded(() => this.store.dispatchState(request, since));
  }
  async claimDispatch(
    request: string, at: number,
    limits: { dedupeMs: number; maxPerRequest: number; daySince: number; maxPerDay: number },
  ): Promise<Record<string, unknown>> {
    return guarded(() => this.store.claimDispatch(request, at, limits));
  }
  async confirmDispatch(claimId: number, sessionId: string | null): Promise<Record<string, unknown>> {
    return guarded(() => this.store.confirmDispatch(claimId, sessionId));
  }
  async markDispatchUnknown(claimId: number): Promise<Record<string, unknown>> {
    return guarded(() => this.store.markDispatchUnknown(claimId));
  }
  async refuseDispatch(claimId: number): Promise<Record<string, unknown>> {
    return guarded(() => this.store.refuseDispatch(claimId));
  }
  async routeOrder(): Promise<Record<string, unknown>> {
    return guarded(() => this.store.routeOrder());
  }
  async routeHandoff(actor: string, itemId: string, request: string, to: string, text: string, toSetBy: string): Promise<Record<string, unknown>> {
    const result = guarded(() => this.store.routeHandoff(actor, itemId, request, to, text, toSetBy));
    this.pokeWatchers();
    return result;
  }

  /* ---- WebSocket watch -------------------------------------------------
   * A picker holds one connection per writer and is woken when work that
   * concerns it appears; polling stays the fallback. Hibernation-safe: the
   * actor lives on the socket's attachment, not in memory. */

  private static MAX_WATCHERS = 32;

  private watchers(): { ws: WebSocket; actor: string; poked: boolean }[] {
    const out: { ws: WebSocket; actor: string; poked: boolean }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment() as { actor?: unknown; poked?: unknown } | null;
        if (typeof att?.actor === "string") out.push({ ws, actor: att.actor, poked: att.poked === true });
      } catch { /* an attachment that is not ours; skip it */ }
    }
    return out;
  }

  /** Wake every watcher whose actor has work waiting right now — once per
   * pending stretch, not per mutation: while the work stays pending (the
   * picker is stopped, at its day cap, or just slow) a pass's own board
   * calls must not re-wake it. The flag clears when nothing is pending for
   * the actor, so the next request wakes it again. */
  private pokeWatchers(): void {
    const watchers = this.watchers();
    if (!watchers.length) return;
    const targets = new Set(this.store.watchTargets());
    const message = JSON.stringify({ type: "wake", at: Date.now() });
    for (const w of watchers) {
      const wants = targets.has(w.actor);
      if (wants === w.poked) continue;
      if (wants) {
        try { w.ws.send(message); }
        catch { try { w.ws.close(1011, "send failed"); } catch { /* already gone */ } continue; }
      }
      try { w.ws.serializeAttachment({ actor: w.actor, poked: wants }); } catch { /* dying socket */ }
    }
  }

  /** The Durable Object's fetch handles the watch upgrade only; everything
   * else goes through the RPC methods above. The caller (mcpHandler) has
   * already authenticated the writer and passes its name in x-watch-actor. */
  async fetch(request: Request): Promise<Response> {
    const actor = request.headers.get("x-watch-actor");
    if (!actor || (request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      return new Response("watch expects a websocket upgrade", { status: 400 });
    }
    if (this.ctx.getWebSockets().length >= BoardStore.MAX_WATCHERS) {
      return new Response("too many watchers", { status: 503 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ actor });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") { try { ws.send("pong"); } catch { /* closed */ } }
  }
  async webSocketClose(ws: WebSocket): Promise<void> { try { ws.close(); } catch { /* already gone */ } }
  async webSocketError(ws: WebSocket): Promise<void> { try { ws.close(); } catch { /* already gone */ } }
}

/** The name the owner's own writes carry on the board. The colon keeps it apart
 * from every writer key and OAuth client: their names match ^[a-z0-9-]{1,32}$
 * (rules.ts validActor), so none of them can be this one. */
const OWNER_ACTOR = "page:owner";

/**
 * `backlog/<YYYYMMDD>-<8 hex>`: made by the board, so the page never names an
 * item. The day is the owner's calendar day as the page reports it, taken only
 * when it is the board's own (UTC) day or the day before or after it, which is
 * as far as any time zone can be; otherwise the UTC day.
 */
function newBacklogId(pageDay: string | null, prefix = "backlog/"): string {
  const utcDay = (shift: number) => new Date(Date.now() + shift * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
  const day = pageDay !== null && [utcDay(-1), utcDay(0), utcDay(1)].includes(pageDay) ? pageDay : utcDay(0);
  const random = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${day}-${random}`;
}

/** HTTP status of a refused owner write. */
function ownerWriteStatus(code: unknown): number {
  switch (code) {
    case "NOT_FOUND":
    case "PARENT_NOT_FOUND":
      return 404;
    case "FORBIDDEN":
      return 403;
    case "REVISION_CONFLICT":
    case "HANDOFF_CONFLICT":
    case "STALE_GENERATION":
    case "FENCE_REQUIRED":
    case "BOARD_ITEM_LIMIT":
    case "BOARD_EVENT_LIMIT":
    case "PAUSED":
      return 409;
    case "STORAGE":
      return 503;
    default:
      return 400;
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};
function respond(status: number, body: string | null, contentType: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": contentType, ...SECURITY_HEADERS, ...extra } });
}
const json = (status: number, value: unknown, extra: Record<string, string> = {}) =>
  respond(status, JSON.stringify(value), "application/json; charset=utf-8", extra);
const failure = (status: number, code: string, detail: string) => json(status, { ok: false, code, detail });
const html = (body: string) => respond(200, body, "text/html; charset=utf-8");

/** A browser request from another site is refused; tools that send no Origin are fine. */
function foreignOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== url.origin;
}

async function readBody(request: Request): Promise<{ value: unknown } | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) return failure(413, "TOO_LARGE", "Request body is too large");
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return failure(415, "CONTENT_TYPE", "Send application/json");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY) return failure(413, "TOO_LARGE", "Request body is too large");
  try {
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return failure(400, "INVALID_JSON", "Request body is not valid JSON");
  }
}

function accessFailure(result: Exclude<AccessResult, { ok: true }>): Response {
  switch (result.reason) {
    case "unavailable":
      return failure(503, "ACCESS_UNAVAILABLE", "Sign-in is not set up");
    case "missing":
      return failure(401, "AUTH", "Sign in through Cloudflare Access");
    default:
      return failure(403, "FORBIDDEN", "This account may not read the board");
  }
}

/** The HTTP answer for a refused call to the board. */
function refusal(result: Record<string, unknown>): Response {
  const error = (result.error ?? {}) as { code?: unknown; detail?: unknown };
  return failure(ownerWriteStatus(error.code), String(error.code ?? "STORAGE"), String(error.detail ?? "Board unavailable"));
}

function boardStub(env: Env) {
  return env.BOARD.get(env.BOARD.idFromName("board"));
}

/**
 * /board/mcp, reached only with a valid Bearer token for this resource: an OAuth
 * access token (props from the grant) or a writer key (props from
 * resolveExternalToken). The actor always comes from those props.
 */
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const watchPath = url.pathname === MCP_PATH || url.pathname === `${MCP_PATH}/watch`;
    if (!watchPath) return failure(404, "NOT_FOUND", "Not found");
    if (foreignOrigin(request, url)) return failure(403, "ORIGIN", "Requests from other sites are refused");
    const actor = (ctx as ExecutionContext & { props?: { actor?: unknown } }).props?.actor;
    if (typeof actor !== "string" || !validActor(actor)) return failure(401, "AUTH", "A valid key is required");

    // A picker watching for work: GET + Upgrade on the same protected path
    // (or /board/mcp/watch), so the same Bearer check and the same Access
    // bypass that let the tool calls through apply unchanged.
    if (request.method === "GET" && (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const headers = new Headers(request.headers);
      headers.set("x-watch-actor", actor);
      return boardStub(env).fetch(new Request(url.origin + url.pathname, { headers, method: "GET" }));
    }
    if (request.method !== "POST") return failure(405, "METHOD", "Use POST");
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const stub = boardStub(env);
    const result = await handle(body.value, (tool, args) => stub.run(tool, actor, args));
    if (result === null) return respond(202, null, "text/plain");
    return json(result.status, result.body);
  },
};

/** Everything that is not the protected resource or the library's own OAuth endpoints. */
const DEVIN_SESSIONS_URL = "https://api.devin.ai/v1/sessions";

/** What one dispatcher pass works with (the cron tick, and the pass right after the owner hands work over). */
function dispatcherDeps(env: Env): DispatchDeps {
  const devinKey = env.DEVIN_API_KEY;
  return {
    board: boardStub(env),
    startDevin: devinKey
      ? (prompt) => spawnDevinSession((url, init) => fetch(url, init), env.DEVIN_SESSIONS_URL ?? DEVIN_SESSIONS_URL, devinKey, prompt)
      : null,
  };
}

const siteHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/healthz" && method === "GET") return respond(200, "ok", "text/plain; charset=utf-8");
    if (path === "/" && method === "GET") return respond(302, null, "text/plain", { location: "/board" });
    if (path === "/authorize") return authorize(request, env);

    if (path === "/board" && method === "GET") {
      const who = await accessUser(request, env);
      if (!who.ok) return accessFailure(who);
      return html(boardHtml.replace("__IRIS_UI_TOKEN__", ""));
    }

    // The conversations as a chat page (the same data as the board, through Access).
    if (path === "/chat" && method === "GET") {
      const who = await accessUser(request, env);
      if (!who.ok) return accessFailure(who);
      return html(chatHtml);
    }

    if (path === "/api/board" && method === "GET") {
      const who = await accessUser(request, env);
      if (!who.ok) return accessFailure(who);
      const data = await boardStub(env).page();
      return data.ok === false ? failure(503, "STORAGE", "Board unavailable") : json(200, data);
    }

    if (path === "/api/board/chat" && method === "GET") {
      const who = await accessUser(request, env);
      if (!who.ok) return accessFailure(who);
      const itemId = url.searchParams.get("item_id") ?? "";
      if (!validItemId(itemId)) return failure(400, "INVALID", "item_id is required");
      const data = await boardStub(env).chat(itemId);
      if (data.ok === false) {
        const error = (data.error ?? {}) as { code?: unknown; detail?: unknown };
        return failure(ownerWriteStatus(error.code), String(error.code ?? "STORAGE"), String(error.detail ?? "Board unavailable"));
      }
      return json(200, data);
    }

    // Text attachments of a conversation: the owner uploads (a long paste or a
    // .txt/.md/.log), reads and takes back an unsent one. The body is kept in
    // R2; the board keeps the name, the sizes and the first lines.
    if (path === "/api/board/attachment") {
      const who = await accessUser(request, env);
      if (!who.ok) return accessFailure(who);
      if (method === "GET") {
        const id = url.searchParams.get("id") ?? "";
        const meta = await boardStub(env).attachmentMeta(id);
        if (meta.ok === false) return refusal(meta);
        const object = await env.ATTACHMENTS.get(attachmentKey(id));
        if (object === null) return failure(404, "NOT_FOUND", "The attachment's text is gone (expired)");
        // Shown as plain text or as the checked image type; the sandbox CSP keeps even a hostile file inert.
        const shownAs = isImageType(meta.mime) ? meta.mime : "text/plain; charset=utf-8";
        return new Response(object.body, { status: 200, headers: {
          "content-type": shownAs, ...SECURITY_HEADERS, "content-security-policy": "sandbox",
        } });
      }
      if (request.headers.get("origin") !== url.origin) return failure(403, "ORIGIN", "Requests from other sites are refused");
      const itemId = url.searchParams.get("item_id") ?? "";
      if (!validItemId(itemId)) return failure(400, "INVALID", "item_id is required");
      if (method === "DELETE") {
        const done = await boardStub(env).attachmentDrop(itemId, url.searchParams.get("id") ?? "");
        if (done.ok === false) return refusal(done);
        const id = url.searchParams.get("id") ?? "";
        try { await env.ATTACHMENTS.delete(attachmentKey(id)); } catch { /* the lifecycle rule removes it */ }
        return json(200, done);
      }
      if (method !== "POST") return failure(405, "METHOD", "POST, GET or DELETE");
      const declared = Number(request.headers.get("content-length") ?? "0");
      const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const name = cleanName(url.searchParams.get("name") ?? "");
      if (isImageType(type)) {
        // An image: its first bytes must say the same type it was sent as.
        if (declared > IMAGE_MAX_BYTES) return failure(413, "TOO_LARGE", "An image may be 5 MB");
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length > IMAGE_MAX_BYTES) return failure(413, "TOO_LARGE", "An image may be 5 MB");
        if (sniffImage(bytes) !== type) return failure(400, "INVALID", "The image is not the type it was sent as");
        const added = await boardStub(env).attachmentAdd(itemId, id, name, bytes.length, 0, "", type);
        if (added.ok === false) return refusal(added);
        try {
          await env.ATTACHMENTS.put(attachmentKey(id), bytes, { httpMetadata: { contentType: type } });
        } catch {
          await boardStub(env).attachmentDrop(itemId, id);
          return failure(503, "STORAGE", "The attachment could not be stored");
        }
        return json(200, added);
      }
      if (declared > ATTACHMENT_MAX_BYTES) return failure(413, "TOO_LARGE", "An attachment may be 1 MB");
      if (type !== "text/plain" && type !== "text/markdown") return failure(415, "CONTENT_TYPE", "Send text/plain or an image");
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > ATTACHMENT_MAX_BYTES) return failure(413, "TOO_LARGE", "An attachment may be 1 MB");
      const parsed = bytes.length > 0 ? parseText(bytes) : null;
      if (parsed === null) return failure(400, "INVALID", "An attachment is a non-empty UTF-8 text");
      const added = await boardStub(env).attachmentAdd(itemId, id, name, parsed.bytes, parsed.chars, parsed.head);
      if (added.ok === false) return refusal(added);
      try {
        await env.ATTACHMENTS.put(attachmentKey(id), bytes, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
      } catch {
        await boardStub(env).attachmentDrop(itemId, id);
        return failure(503, "STORAGE", "The attachment could not be stored");
      }
      return json(200, added);
    }

    // The owner's own writes from the page. Cloudflare Access proves who it is;
    // the Origin header must be this site's (a browser always sends it on a POST),
    // so another site cannot make the owner's browser write.
    if (path === "/api/board/item" && method === "POST") {
      const who = await accessUser(request, env);
      if (!who.ok) return accessFailure(who);
      if (request.headers.get("origin") !== url.origin) return failure(403, "ORIGIN", "Requests from other sites are refused");
      const body = await readBody(request);
      if (body instanceof Response) return body;
      const result = await boardStub(env).ownerWrite(body.value);
      if (result.ok === false) {
        const error = (result.error ?? {}) as { code?: unknown; detail?: unknown };
        return failure(ownerWriteStatus(error.code), String(error.code ?? "STORAGE"), String(error.detail ?? "Board unavailable"));
      }
      // Work handed over (or sent back to the board's choice) is looked at
      // right away instead of at the next cron tick: the same dispatcher
      // pass, after the answer is on its way. Its claims are atomic, so a
      // tick running at the same moment cannot start anything twice.
      const op = (body.value as { op?: unknown } | null)?.op;
      if (op === "hand" || op === "route" || op === "continue" || op === "order" || op === "pause" || op === "scope") ctx.waitUntil(runDispatcher(dispatcherDeps(env)));
      return json(200, result);
    }

    return failure(404, "NOT_FOUND", "Not found");
  },
};

/** The configured public origin, only in its canonical form (https, or http on a loopback host for tests). */
function publicOrigin(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.origin !== value || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  const known = providers.get(origin);
  if (known) return known;
  const resource = `${origin}${MCP_PATH}`;
  const provider = new OAuthProvider<Env>({
    apiRoute: MCP_PATH,
    apiHandler: mcpHandler,
    defaultHandler: siteHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: {
      resource,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "Many Iris board",
    },
    // Writer keys (many-ai-cli, Muse) keep working: they are this board's own keys,
    // checked against the hashes in BOARD_WRITERS, never forwarded anywhere.
    resolveExternalToken: async ({ token, env }) => {
      const who = await authenticate(env.BOARD_WRITERS, token);
      if (who.ok) return { props: { actor: who.actor }, audience: resource };
      if (who.reason === "disabled") {
        throw new ExternalTokenError("invalid_token", { description: "This key is switched off", statusCode: 403 });
      }
      if (who.reason === "unavailable") {
        throw new ExternalTokenError("temporarily_unavailable", { description: "The key list is not set up", statusCode: 503 });
      }
      return null;
    },
  });
  providers.set(origin, provider);
  return provider;
}


export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = publicOrigin(env.BOARD_PUBLIC_ORIGIN);
    if (origin === null) return failure(503, "CONFIG", "The board's public origin is not set up");
    return providerFor(origin).fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDispatcher(dispatcherDeps(env)));
  },
} satisfies ExportedHandler<Env>;
