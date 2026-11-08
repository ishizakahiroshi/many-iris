// Many Iris board on Cloudflare Workers.
//
//   GET  /board        read-only page (people, through Cloudflare Access)
//   GET  /api/board    page data (people, through Cloudflare Access)
//   POST /board/mcp    MCP for writers (writer key as a Bearer token; Access lets this path through)
//   GET  /healthz      "ok"
//
// Scripts and styles come from ./public (static assets, no secrets in them).
import { DurableObject } from "cloudflare:workers";
import boardHtml from "../../iris/web/board.html";
import { accessUser, type AccessResult } from "./access";
import { authenticate, bearer, type AuthResult } from "./keys";
import { handle } from "./mcp";
import { DEFAULT_LIMITS, Store, guarded, type Limits } from "./store";

export interface Env {
  BOARD: DurableObjectNamespace<BoardStore>;
  /** JSON: {"schema_version":1,"writers":[{"actor","token_sha256","enabled"}]} */
  BOARD_WRITERS?: string;
  /** Cloudflare Access settings for the people who read the page (see access.ts). */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  BOARD_OWNERS?: string;
  /** Test-only overrides of the item and event limits. */
  BOARD_LIMIT_ITEMS?: string;
  BOARD_LIMIT_EVENTS?: string;
}

const MAX_BODY = 65536;

function limitsFrom(env: Env): Limits {
  const pick = (raw: string | undefined, fallback: number) => {
    const n = Number(raw);
    return raw !== undefined && Number.isSafeInteger(n) && n > 0 ? n : fallback;
  };
  return { items: pick(env.BOARD_LIMIT_ITEMS, DEFAULT_LIMITS.items), events: pick(env.BOARD_LIMIT_EVENTS, DEFAULT_LIMITS.events) };
}

export class BoardStore extends DurableObject<Env> {
  private store: Store;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage, limitsFrom(env));
    ctx.blockConcurrencyWhile(async () => this.store.init());
  }
  async run(tool: string, actor: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return guarded(() => {
      switch (tool) {
        case "board_upsert_item":
          return this.store.upsertItem(actor, args);
        case "board_add_event":
          return this.store.addEvent(actor, args);
        case "board_list":
          return this.store.listForTool(args);
        default:
          return { ok: false, error: { code: "FORBIDDEN", detail: "Operation unavailable" } };
      }
    });
  }
  async page(): Promise<Record<string, unknown>> {
    return guarded(() => this.store.pageData());
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
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

function authFailure(result: Exclude<AuthResult, { ok: true }>): Response {
  switch (result.reason) {
    case "unavailable":
      return failure(503, "KEYS_UNAVAILABLE", "The key list is not set up");
    case "disabled":
      return failure(403, "KEY_DISABLED", "This key is switched off");
    default:
      return failure(401, "AUTH", "A valid key is required");
  }
}

function boardStub(env: Env) {
  return env.BOARD.get(env.BOARD.idFromName("board"));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/healthz" && method === "GET") return respond(200, "ok", "text/plain; charset=utf-8");
    if (path === "/" && method === "GET") return respond(302, null, "text/plain", { location: "/board" });

    if (path === "/board" && method === "GET") {
      const who = await accessUser(request, env);
      if (!who.ok) return accessFailure(who);
      return html(boardHtml.replace("__IRIS_UI_TOKEN__", ""));
    }

    if (path === "/api/board" && method === "GET") {
      const who = await accessUser(request, env);
      if (!who.ok) return accessFailure(who);
      const data = await boardStub(env).page();
      return data.ok === false ? failure(503, "STORAGE", "Board unavailable") : json(200, data);
    }

    if (path === "/board/mcp") {
      if (method !== "POST") return failure(405, "METHOD", "Use POST");
      if (foreignOrigin(request, url)) return failure(403, "ORIGIN", "Requests from other sites are refused");
      const who = await authenticate(env.BOARD_WRITERS, bearer(request));
      if (!who.ok) return authFailure(who);
      const body = await readBody(request);
      if (body instanceof Response) return body;
      const stub = boardStub(env);
      const result = await handle(body.value, (tool, args) => stub.run(tool, who.actor, args));
      if (result === null) return respond(202, null, "text/plain");
      return json(result.status, result.body);
    }

    return failure(404, "NOT_FOUND", "Not found");
  },
} satisfies ExportedHandler<Env>;
