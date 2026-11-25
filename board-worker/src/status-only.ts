// Status-only reporting (#50): a job whose reporting is registered as
// status-only may tell the board nothing but who it is and which of the
// fixed status words it reached — no free text, no links, no commit. The
// registration lives in the Worker's environment (BOARD_STATUS_ONLY), next
// to the writer keys: it is operator configuration, so nothing in a request
// body can switch a job's reporting mode on or off.
//
// The picker carries the same registration on its side (PICKER_STATUS_ONLY:
// project + writer + board). This file is the board's half, and it stays
// free of imports so a plain Node test can load it (type stripping) and the
// picker's tests can compare the shared status words against it.

export interface StatusOnlyEntry {
  project: string;
  actor: string;
}

/** Every progress note a status-only run may write, exactly as sent. */
export const STATUS_ONLY_PROGRESS = ["状態：着手", "状態：作業中", "状態：要確認"] as const;
/** Every completion text a status-only run may close with (outcome stays done|stopped). */
export const STATUS_ONLY_COMPLETION = ["状態：完了", "状態：要確認"] as const;

const validActor = (s: string) => /^[a-z0-9-]{1,32}$/.test(s);

/**
 * Parses `{"schema_version":1,"status_only":[{"project","actor"}]}` — the
 * same strict shape as the writer key list: anything unexpected makes the
 * whole list unusable (null), so a half-written registration silently
 * narrows nothing.
 */
export function parseStatusOnly(raw: string | undefined): StatusOnlyEntry[] | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 65536) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some((k) => k !== "schema_version" && k !== "status_only") || obj.schema_version !== 1) return null;
  if (!Array.isArray(obj.status_only) || obj.status_only.length > 64) return null;
  const entries: StatusOnlyEntry[] = [];
  const seen = new Set<string>();
  for (const entry of obj.status_only) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    if (Object.keys(e).some((k) => k !== "project" && k !== "actor")) return null;
    if (typeof e.project !== "string" || e.project.length === 0 || e.project.length > 80) return null;
    if (typeof e.actor !== "string" || !validActor(e.actor)) return null;
    const key = `${e.project}\n${e.actor}`;
    if (seen.has(key)) return null;
    seen.add(key);
    entries.push({ project: e.project, actor: e.actor });
  }
  return entries;
}

/** project -> the actors registered status-only for it (empty map: nothing registered). */
export function statusOnlyActors(entries: StatusOnlyEntry[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of entries) {
    const actors = out.get(e.project) ?? new Set<string>();
    actors.add(e.actor);
    out.set(e.project, actors);
  }
  return out;
}
