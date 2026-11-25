// An operator-registered interval is an estimate, not a scheduler receipt.
export const POLL_GRACE_MS = 120_000;

export function pollIntervals(raw: string | undefined): Map<string, number> {
  const parsed = new Map<string, number>();
  if (raw === undefined) return parsed;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return parsed;
    const entries = Object.entries(data);
    if (entries.length > 64) return parsed;
    for (const [actor, seconds] of entries) {
      if (!/^[a-z0-9-]{1,32}$/.test(actor) || typeof seconds !== "number"
          || !Number.isInteger(seconds) || seconds < 60 || seconds > 86400) return new Map();
      parsed.set(actor, seconds * 1000);
    }
  } catch { return new Map(); }
  return parsed;
}

export function pollView(assignee: string, lastPollAt: number | null, intervalMs: number | undefined, now: number) {
  const nextPollAt = lastPollAt === null || intervalMs === undefined ? null : lastPollAt + intervalMs;
  return {
    assignee,
    last_poll_at: lastPollAt,
    next_poll_at: nextPollAt,
    next_poll_source: nextPollAt === null ? null : "configured_interval_estimate",
    overdue: nextPollAt !== null && now > nextPollAt + POLL_GRACE_MS,
  };
}
