// Many Iris board on Cloudflare Workers.
//
//   GET  /board        read-only page (people, through Cloudflare Access)
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
import boardHtml from "../../iris/web/board.html";
import { accessUser, type AccessResult } from "./access";
import { authenticate } from "./keys";
import { handle } from "./mcp";
import { SCOPE, authorize } from "./oauth";
import { validActor } from "./rules";
import { DEFAULT_LIMITS, Store, guarded, type Limits } from "./store";

export interface Env {
  BOARD: DurableObjectNamespace<BoardStore>;
  /** OAuth clients, grants and tokens (the library's storage). */
  OAUTH_KV: KVNamespace;
  /** Injected by the OAuth library into the handlers it calls. */
  OAUTH_PROVIDER: OAuthHelpers;
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
}

const MCP_PATH = "/board/mcp";

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
        case "board_accept_handoff":
          return this.store.acceptHandoff(actor, args);
        default:
          return { ok: false, error: { code: "FORBIDDEN", detail: "Operation unavailable" } };
      }
    });
  }
  async page(): Promise<Record<string, unknown>> {
    return guarded(() => this.store.pageData());
  }
  /** A write by the signed-in owner from the page (see Store.ownerWrite). */
  async ownerWrite(args: unknown): Promise<Record<string, unknown>> {
    return guarded(() => this.store.ownerWrite(OWNER_ACTOR, args, newBacklogId));
  }
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
    case "BOARD_ITEM_LIMIT":
    case "BOARD_EVENT_LIMIT":
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
    if (url.pathname !== MCP_PATH) return failure(404, "NOT_FOUND", "Not found");
    if (request.method !== "POST") return failure(405, "METHOD", "Use POST");
    if (foreignOrigin(request, url)) return failure(403, "ORIGIN", "Requests from other sites are refused");
    const actor = (ctx as ExecutionContext & { props?: { actor?: unknown } }).props?.actor;
    if (typeof actor !== "string" || !validActor(actor)) return failure(401, "AUTH", "A valid key is required");
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const stub = boardStub(env);
    const result = await handle(body.value, (tool, args) => stub.run(tool, actor, args));
    if (result === null) return respond(202, null, "text/plain");
    return json(result.status, result.body);
  },
};

/** Everything that is not the protected resource or the library's own OAuth endpoints. */
const siteHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    if (path === "/api/board" && method === "GET") {
      const who = await accessUser(request, env);
      if (!who.ok) return accessFailure(who);
      const data = await boardStub(env).page();
      return data.ok === false ? failure(503, "STORAGE", "Board unavailable") : json(200, data);
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
} satisfies ExportedHandler<Env>;
