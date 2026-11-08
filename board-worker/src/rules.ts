// The board's rules: the same contract as the Rust board (iris/src/board.rs).
// Kinds, states, field limits and error codes must stay identical, so that a
// writer (many-ai-cli, Muse, ChatGPT) can talk to either one.

export const MAX_ITEMS = 5000;
export const MAX_EVENTS = 50000;
/** Depth of the deepest item, counting a root as 1. */
export const MAX_DEPTH = 6;
export const KINDS = ["project", "plan", "context", "issue", "pr", "task"] as const;
export const STATES = ["planned", "in_progress", "waiting", "done", "stopped"] as const;
/** Kinds a writer may add. `state_change` is recorded by the board itself. */
export const WRITER_EVENT_KINDS = ["session_start", "session_end", "note"] as const;
/** Events returned by one `board_list` call. */
export const LIST_EVENT_LIMIT = 500;
/** Recent events shown on the page. */
export const PAGE_EVENT_LIMIT = 100;
export const MAX_KEYS = 64;

export class BoardError extends Error {
  constructor(
    public code: string,
    public detail: string,
  ) {
    super(detail);
  }
}
export const invalid = (detail: string) => new BoardError("INVALID", detail);

const charLen = (s: string) => [...s].length;

/** Control characters, line/paragraph separators, and invisible direction or
 * joiner characters that can make text look different from what it is. */
export function hasForbiddenChar(s: string, allowLayout: boolean): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const control = c <= 0x1f || (c >= 0x7f && c <= 0x9f);
    if (control && !(allowLayout && (ch === "\n" || ch === "\r" || ch === "\t"))) return true;
    if (
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x2028 && c <= 0x202e) ||
      (c >= 0x2060 && c <= 0x2064) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0xfeff
    )
      return true;
  }
  return false;
}

/** 1..=max characters, not blank, no hidden control characters. */
export function validLine(s: string, max: number, allowLayout: boolean): boolean {
  const n = charLen(s);
  return n >= 1 && n <= max && s.trim() !== "" && !hasForbiddenChar(s, allowLayout);
}
export const validItemId = (s: string) => /^[A-Za-z0-9._:/-]{1,128}$/.test(s);
export const validActor = (s: string) => /^[a-z0-9-]{1,32}$/.test(s);

function daysInMonth(year: number, month: number): number {
  if ([1, 3, 5, 7, 8, 10, 12].includes(month)) return 31;
  if ([4, 6, 9, 11].includes(month)) return 30;
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return 0;
}
/** `YYYY-MM-DD`, a real calendar date. */
export function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}
const noDotDot = (path: string) => !path.split("/").some((seg) => seg === "..");

/** `https://host[:port][/path]` with an ASCII host, no user info, no spaces. */
export function validHttpsUrl(s: string): boolean {
  if (charLen(s) > 500 || hasForbiddenChar(s, false) || /\s/u.test(s)) return false;
  if (!s.startsWith("https://")) return false;
  const rest = s.slice("https://".length);
  if (rest.includes("\\")) return false;
  const found = rest.search(/[/?#]/);
  const end = found === -1 ? rest.length : found;
  const authority = rest.slice(0, end);
  const tail = rest.slice(end);
  return (
    authority.length > 0 &&
    /^[A-Za-z0-9.\-:[\]]+$/.test(authority) &&
    /[A-Za-z0-9]/.test(authority) &&
    noDotDot(tail.split(/[?#]/)[0] ?? "")
  );
}

/** A repository-relative path such as `docs/local/plan_x.md`, or an https URL.
 * Absolute paths, drive letters, `file:` and `..` are refused. */
export function validSourceRef(s: string): boolean {
  if (s.length === 0 || charLen(s) > 500) return false;
  if (s.startsWith("https://")) return validHttpsUrl(s);
  return !(
    hasForbiddenChar(s, false) ||
    /\s/u.test(s) ||
    s.startsWith("/") ||
    s.startsWith("~") ||
    s.includes("\\") ||
    s.includes(":") ||
    s.split("/").some((seg) => seg === "" || seg === ".." || seg === ".")
  );
}

export interface Item {
  item_id: string;
  project: string;
  kind: string;
  title: string;
  source_ref: string | null;
  parent_id: string | null;
  state: string;
  waiting_reason: string | null;
  planned_start: string | null;
  planned_end: string | null;
  created_at: number;
  updated_at: number;
  updated_by: string;
  revision: number;
}
export const ITEM_COLUMNS = [
  "item_id", "project", "kind", "title", "source_ref", "parent_id", "state", "waiting_reason",
  "planned_start", "planned_end", "created_at", "updated_at", "updated_by", "revision",
] as const;

/** The fields a writer controls (not the bookkeeping ones). */
export function sameContent(a: Item, b: Item): boolean {
  return (
    a.project === b.project &&
    a.kind === b.kind &&
    a.title === b.title &&
    a.source_ref === b.source_ref &&
    a.parent_id === b.parent_id &&
    a.state === b.state &&
    a.waiting_reason === b.waiting_reason &&
    a.planned_start === b.planned_start &&
    a.planned_end === b.planned_end
  );
}

export function validateItem(item: Item): void {
  if (!validItemId(item.item_id)) throw invalid("item_id must match ^[A-Za-z0-9._:/-]{1,128}$");
  if (!validLine(item.project, 80, false)) throw invalid("project must be 1 to 80 characters");
  if (!(KINDS as readonly string[]).includes(item.kind)) throw invalid("kind is not one of the allowed values");
  if (!validLine(item.title, 200, false)) throw invalid("title must be 1 to 200 characters");
  if (item.source_ref !== null && !validSourceRef(item.source_ref))
    throw invalid("source_ref must be a repository-relative path or an https URL (500 characters at most)");
  if (!(STATES as readonly string[]).includes(item.state)) throw invalid("state is not one of the allowed values");
  const waiting = item.state === "waiting";
  if (waiting && !(item.waiting_reason !== null && validLine(item.waiting_reason, 200, false)))
    throw invalid("waiting_reason (1 to 200 characters) is required when state is waiting");
  if (!waiting && item.waiting_reason !== null)
    throw invalid("waiting_reason is only allowed when state is waiting");
  for (const date of [item.planned_start, item.planned_end]) {
    if (date !== null && !validDate(date)) throw invalid("planned dates must be real YYYY-MM-DD dates");
  }
  if (item.planned_start !== null && item.planned_end !== null && item.planned_end < item.planned_start)
    throw invalid("planned_end must not be before planned_start");
}

export type Args = Record<string, unknown>;
export const has = (obj: Args, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

/** A field a writer may leave alone, set, or clear (JSON `null`). */
export type Patch = { kind: "absent" } | { kind: "clear" } | { kind: "set"; value: string };
export function clearable(obj: Args, key: string): Patch {
  if (!has(obj, key)) return { kind: "absent" };
  const v = obj[key];
  if (v === null) return { kind: "clear" };
  if (typeof v === "string" && v.length > 0) return { kind: "set", value: v };
  throw invalid(`${key} must be a non-empty string, or null to clear it`);
}
export function optionalStr(obj: Args, key: string): string | null {
  if (!has(obj, key)) return null;
  const v = obj[key];
  if (typeof v === "string") return v;
  throw invalid(`${key} must be a string`);
}
export function requiredStr(obj: Args, key: string): string {
  const v = optionalStr(obj, key);
  if (v === null) throw invalid(`${key} is required`);
  return v;
}
export function applyPatch(current: string | null, patch: Patch): string | null {
  if (patch.kind === "clear") return null;
  if (patch.kind === "set") return patch.value;
  return current;
}
export function onlyKeys(obj: Args, allowed: readonly string[]): void {
  if (Object.keys(obj).some((k) => !allowed.includes(k))) throw invalid("Unknown field");
}
export function nonNegativeInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
export function asObject(input: unknown): Args {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw invalid("Arguments must be an object");
  return input as Args;
}
