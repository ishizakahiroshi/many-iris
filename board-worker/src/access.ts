// People reach the page through Cloudflare Access (Google sign-in). Access
// adds a signed token (Cf-Access-Jwt-Assertion) to every request it lets
// through; the Worker checks it again so a gap in the Access settings does not
// open the board: RS256 signature against the team's published keys, issuer =
// the team domain, audience = this application's AUD tag, not expired, and the
// email is one of the owners.
//
// Settings (Worker secrets, never in the repository):
//   ACCESS_TEAM_DOMAIN  https://<team>.cloudflareaccess.com
//   ACCESS_AUD          Application Audience (AUD) tag of the Access application
//   BOARD_OWNERS        comma-separated emails allowed to read the page

export type AccessResult = { ok: true; email: string } | { ok: false; reason: "missing" | "unknown" | "unavailable" };

interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  BOARD_OWNERS?: string;
}

const HEADER = "cf-access-jwt-assertion";
const KEYS_TTL_MS = 60 * 60 * 1000;
const REFETCH_GAP_MS = 60 * 1000;
const CLOCK_SKEW_S = 60;

let cache: { team: string; at: number; keys: Map<string, CryptoKey> } | null = null;

function b64urlBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  try {
    const bin = atob(pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
function b64urlJson(s: string): Record<string, unknown> | null {
  const bytes = b64urlBytes(s);
  if (bytes === null) return null;
  try {
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function loadKeys(team: string): Promise<Map<string, CryptoKey> | null> {
  try {
    const r = await fetch(`${team}/cdn-cgi/access/certs`, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const body = (await r.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) return null;
    const keys = new Map<string, CryptoKey>();
    for (const k of body.keys as Record<string, unknown>[]) {
      if (k?.kty !== "RSA" || typeof k.kid !== "string" || typeof k.n !== "string" || typeof k.e !== "string") continue;
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(k.kid, key);
    }
    return keys.size ? keys : null;
  } catch {
    return null;
  }
}

async function keyFor(team: string, kid: string): Promise<CryptoKey | null | "unavailable"> {
  const now = Date.now();
  const fresh = cache !== null && cache.team === team && now - cache.at < KEYS_TTL_MS;
  if (fresh && cache!.keys.has(kid)) return cache!.keys.get(kid)!;
  // Unknown kid: Access may have rotated its keys. Refetch, but not on every request.
  if (fresh && now - cache!.at < REFETCH_GAP_MS) return null;
  const keys = await loadKeys(team);
  if (keys === null) return cache !== null && cache.team === team && cache.keys.has(kid) ? cache.keys.get(kid)! : "unavailable";
  cache = { team, at: now, keys };
  return keys.get(kid) ?? null;
}

function owners(raw: string | undefined): Set<string> | null {
  if (typeof raw !== "string") return null;
  const list = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length && list.every((e) => /^[^\s@,]+@[^\s@,]+$/.test(e)) ? new Set(list) : null;
}

export async function accessUser(request: Request, env: AccessEnv): Promise<AccessResult> {
  const team = (env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/\/+$/, "");
  const aud = (env.ACCESS_AUD ?? "").trim();
  const allowed = owners(env.BOARD_OWNERS);
  if (!/^https?:\/\/[^/\s]+$/.test(team) || !/^[0-9a-f]{16,128}$/i.test(aud) || allowed === null) return { ok: false, reason: "unavailable" };

  const token = request.headers.get(HEADER);
  if (token === null || token.length === 0 || token.length > 16384) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "unknown" };
  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);
  const signature = b64urlBytes(parts[2]);
  if (header === null || payload === null || signature === null) return { ok: false, reason: "unknown" };
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "unknown" };

  const key = await keyFor(team, header.kid);
  if (key === "unavailable") return { ok: false, reason: "unavailable" };
  if (key === null) return { ok: false, reason: "unknown" };
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed))) return { ok: false, reason: "unknown" };

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== team) return { ok: false, reason: "unknown" };
  if (!audiences.includes(aud)) return { ok: false, reason: "unknown" };
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < now) return { ok: false, reason: "unknown" };
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf - CLOCK_SKEW_S > now)) return { ok: false, reason: "unknown" };
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!allowed.has(email)) return { ok: false, reason: "unknown" };
  return { ok: true, email };
}
