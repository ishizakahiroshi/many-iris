// Choosing a destination for handed-over work that has none ("おまかせ"):
// the owner's order. The board goes down the owner's list and gives the work
// to the first destination that is picking up work right now; when none is,
// the work goes to `hold` and the owner decides (owner decisions 2026-11-21,
// B2 "order only", B4 "no owner in the order, hold last", B5 "alive = came to
// the board lately"). Everything here is plain functions without imports, so
// test/route.test.mjs can load this file directly with Node.

/**
 * Where a handed-over piece of work should go (the item's handoff.to): a tool
 * and the place it runs (owner decision 2026-11-21, B1). `devin` is Devin in
 * the cloud (the board starts its sessions), `vps-*` run on the always-on
 * server, `local-*` on the owner's PC. `owner` and `hold` are not writers.
 */
export const HANDOFF_TARGETS = [
  "devin", "vps-claude", "local-claude", "vps-devin", "local-devin", "muse", "grokbot", "owner", "hold",
] as const;
export type HandoffTarget = (typeof HANDOFF_TARGETS)[number];

/** The destinations the owner may put in the order (every writer; not owner, not hold). */
export const ORDERABLE = HANDOFF_TARGETS.filter((t) => t !== "owner" && t !== "hold");

/** The order until the owner sets one: the server first, then the PC, then Devin in the cloud. */
export const DEFAULT_ORDER: readonly string[] = ["vps-claude", "local-claude", "devin"];

/**
 * A taker that came to the board within this long counts as picking up work.
 * The server's taker comes every minute and the PC's every five, so a quarter
 * of an hour is three missed visits of the slower one.
 */
export const ALIVE_MS = 15 * 60 * 1000;

/** The name a destination set from the owner's order carries in handoff.to_set_by.
 * The order is the owner's own setting (only the signed-in owner can change it
 * from the page), so work the owner handed over keeps passing the takers'
 * "the owner chose this" gate; the event says it came from the order. */
export const OWNER_ACTOR = "page:owner";

/** Checks an order sent by the page: distinct destinations from ORDERABLE, in order. */
export function parseOrder(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > ORDERABLE.length) return null;
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string" || !(ORDERABLE as readonly string[]).includes(v) || seen.has(v)) return null;
    seen.add(v);
  }
  return [...seen];
}

/**
 * Whether a destination is picking up work now. Devin in the cloud does not
 * come to the board on its own: the board starts it, so it is ready whenever
 * the board has a Devin key. Every other destination is a taker that comes to
 * the board; it is alive when it came within ALIVE_MS.
 */
export function isAlive(target: string, seen: Record<string, number>, now: number, devinReady: boolean): boolean {
  if (target === "devin") return devinReady;
  const at = seen[target];
  return typeof at === "number" && now - at <= ALIVE_MS;
}

export interface RouteDecision {
  to: HandoffTarget;
  /** 1-based place in the order, or null for hold. */
  rank: number | null;
  /** One line for the board's event. */
  text: string;
}

/** Goes down the order and takes the first destination that is alive; hold when none is. */
export function chooseByOrder(order: readonly string[], alive: (target: string) => boolean): RouteDecision {
  const skipped: string[] = [];
  for (const [index, target] of order.entries()) {
    if (!(HANDOFF_TARGETS as readonly string[]).includes(target) || target === "owner" || target === "hold") continue;
    if (alive(target)) {
      const why = skipped.length ? ` (${skipped.join(", ")} not picking up)` : "";
      return { to: target as HandoffTarget, rank: index + 1, text: `routed to ${target}: number ${index + 1} in the owner's order${why}` };
    }
    skipped.push(target);
  }
  return {
    to: "hold", rank: null,
    text: order.length === 0
      ? "routed to hold: the owner's order is empty"
      : `routed to hold: nobody in the owner's order is picking up (${skipped.join(", ")})`,
  };
}

/** A board string cut to one short line (the same rule as the Devin prompt). */
export function plainLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}
