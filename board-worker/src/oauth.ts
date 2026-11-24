// OAuth sign-in for MCP clients that cannot send a writer key (ChatGPT).
//
// The library (@cloudflare/workers-oauth-provider) owns discovery, client
// registration (CIMD and DCR), the token endpoint, PKCE and token storage. This
// file owns /authorize: the person must be signed in through Cloudflare Access
// as a board owner, and then approves the client on a consent page. The grant
// carries the writer name and a private confirmation namespace unique to this consent.
import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { accessUser, type AccessResult } from "./access";
import { validActor } from "./rules";

/** The one scope: write to and read the board through /board/mcp. */
export const SCOPE = "board";

export interface AuthorizeEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  BOARD_OWNERS?: string;
}

const CHATGPT_DOMAINS = ["chatgpt.com", "openai.com"];

/**
 * The actor the board records for writes made with this client's tokens. A
 * client whose metadata document is served from ChatGPT's domains is
 * "chatgpt"; any other client is "oauth-" plus its verified domain label, or
 * its self-asserted name for a registered client. The "oauth-" prefix keeps
 * those apart from the writer-key actors.
 */
export function actorFor(details: Pick<ConsentDescription, "clientDomain" | "clientName">): string {
  const domain = details.clientDomain?.toLowerCase();
  if (domain && CHATGPT_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return "chatgpt";
  const source = domain ? domain.replace(/^www\./, "").split(".")[0] : details.clientName.toLowerCase();
  const label = source.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 26);
  const actor = label ? `oauth-${label}` : "oauth-app";
  return validActor(actor) ? actor : "oauth-app";
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    },
  });
}

function accessRefusal(result: Exclude<AccessResult, { ok: true }>): Response {
  switch (result.reason) {
    case "unavailable":
      return plain(503, "Sign-in is not set up");
    case "missing":
      return plain(401, "Sign in through Cloudflare Access");
    default:
      return plain(403, "This account may not approve apps for the board");
  }
}

function consentPage(details: ConsentDescription, handle: string, actor: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `<p>発行元: <strong>${escape(details.clientDomain)}</strong></p>`
    : `<p>この app は自分で名乗っているだけで、名前は確かめられていません。</p>`;
  const loopback = details.redirectIsLoopback
    ? `<p><strong>この PC の上の app へ鍵を渡します。</strong>自分でいま接続を始めたときだけ許可してください。</p>`
    : "";
  return `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Many Iris 看板への接続の許可</title>
<h1>${name} に許可する接続を選んでください</h1>
${origin}
<p>鍵の送り先: <strong>${escape(details.redirectHost)}</strong></p>
${loopback}
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<p>dots 専用の接続では、dots 宛ての仕事を受け取り、その結果と確認依頼を返せます。</p>
<p><button name="decision" value="approve-dots">dots の担当として許可する</button></p>
<p>通常の接続では、看板全体を読み書きできます。操作は「${escape(actor)}」として記録されます。</p>
<p><button name="decision" value="approve">看板全体への接続を許可する</button> <button name="decision" value="deny">許可しない</button></p>
</form>
</html>`;
}

/** The consent page's own policy: no scripts, and the form posts only here and to the client's redirect. */
function consentHeaders(base: Headers, redirectUri: string): Headers {
  const headers = new Headers(base);
  let target = "";
  try {
    target = new URL(redirectUri).origin;
  } catch {
    target = "";
  }
  const formAction = target && target !== "null" ? `'self' ${target}` : "'self'";
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "content-security-policy",
    `default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action ${formAction}`,
  );
  return headers;
}

function redirect(location: string, headers: Headers = new Headers()): Response {
  const out = new Headers(headers);
  out.set("location", location);
  out.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers: out });
}

/** GET shows the consent page; POST approves or declines it. Both need a board owner signed in through Access. */
export async function authorize(request: Request, env: AuthorizeEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return plain(405, "Use GET or POST");
  const who = await accessUser(request, env);
  if (!who.ok) return accessRefusal(who);
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return new Response(consentPage(details, consent.handle, actorFor(details)), {
        status: 200,
        headers: consentHeaders(consent.headers, details.redirectUri),
      });
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > 4096) return plain(413, "Request body is too large");
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    const decision = form.get("decision");
    if (decision !== "approve" && decision !== "approve-dots") {
      const denied = await oauth.denyConsent(request, handle);
      return redirect(denied.redirectTo, denied.headers);
    }
    const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
    const details = await oauth.describeConsent(approved.request);
    // Only this owner's explicit consent can select the worker role. Client
    // names and request parameters cannot assign a handoff identity.
    const restricted = decision === "approve-dots";
    const actor = restricted ? "dots" : actorFor(details);
    const ownerId = encodeURIComponent(who.email);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      // Reconnecting one role replaces its previous grant for this client
      // without revoking the owner's other connection to the same resource.
      userId: restricted ? "dots@" + ownerId : ownerId,
      metadata: { actor },
      scope: [SCOPE],
      props: { actor, policy: restricted ? "restricted" : "trusted", confirmationSource: "grant:" + crypto.randomUUID() },
    });
    return redirect(redirectTo, approved.headers);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return redirect(error.redirectTo);
    if (error instanceof AuthorizationError) return plain(400, error.description);
    if (error instanceof CimdFetchError) return plain(400, "This app could not be verified");
    throw error;
  }
}
