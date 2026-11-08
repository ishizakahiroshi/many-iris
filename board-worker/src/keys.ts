// Keys. Only the SHA-256 of a key is stored (in a Worker secret holding the
// same JSON as the Rust board's writers file). The actor always comes from the
// key, never from the request body.
import { MAX_KEYS, validActor } from "./rules";

interface KeyEntry {
  actor: string;
  hash: Uint8Array;
  enabled: boolean;
}
export type AuthResult =
  | { ok: true; actor: string }
  | { ok: false; reason: "missing" | "unknown" | "disabled" | "unavailable" };

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Parses `{"schema_version":1,"writers":[{"actor","token_sha256","enabled"}]}`.
 * Anything unexpected makes the whole list unusable (nobody is let in). */
export function parseKeys(raw: string | undefined): KeyEntry[] | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 65536) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some((k) => k !== "schema_version" && k !== "writers") || obj.schema_version !== 1) return null;
  if (!Array.isArray(obj.writers) || obj.writers.length > MAX_KEYS) return null;
  const entries: KeyEntry[] = [];
  const seen = new Set<string>();
  for (const entry of obj.writers) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    if (Object.keys(e).some((k) => !["actor", "token_sha256", "enabled"].includes(k))) return null;
    if (typeof e.actor !== "string" || !validActor(e.actor)) return null;
    if (typeof e.token_sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(e.token_sha256)) return null;
    if (typeof e.enabled !== "boolean") return null;
    const hash = e.token_sha256.toLowerCase();
    if (seen.has("a:" + e.actor) || seen.has("h:" + hash)) return null;
    seen.add("a:" + e.actor);
    seen.add("h:" + hash);
    entries.push({ actor: e.actor, hash: fromHex(hash), enabled: e.enabled });
  }
  return entries;
}

/** Resolves a presented key to its actor. Every entry is compared (no early
 * exit) and each comparison takes the same time. */
export async function authenticate(raw: string | undefined, token: string | null): Promise<AuthResult> {
  if (token === null || token.length === 0 || token.length > 512) return { ok: false, reason: "missing" };
  const entries = parseKeys(raw);
  if (entries === null) return { ok: false, reason: "unavailable" };
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  let found: KeyEntry | null = null;
  for (const entry of entries) {
    if (crypto.subtle.timingSafeEqual(entry.hash, digest)) found = entry;
  }
  if (found === null) return { ok: false, reason: "unknown" };
  if (!found.enabled) return { ok: false, reason: "disabled" };
  return { ok: true, actor: found.actor };
}

export function bearer(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (value === null || !value.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length);
  return token.length ? token : null;
}
