// Safe resumption of handed-over work: the pure decisions behind the lease,
// the fencing generation and the "unknown" quarantine (store.ts keeps the
// state; this file only judges it, so test/resume.test.mjs can run it under
// Node with no board, like test/route.test.mjs does for the router).
//
// The shape of the danger: a cloud worker takes a request, then the line
// drops or the worker dies. Two things must never happen on their own:
//   - the same work starting twice while the first run may still be alive;
//   - a late write from an old run landing after the work was handed on.
// So an expired lease never re-queues anything by itself. It only makes the
// handoff *eligible* to be marked `unknown` by a person (or a writer acting
// for one); from `unknown` a person either confirms the old run is stopped
// and releases the work back to the pile, or confirms it is still working
// and resumes the same run. Every progress/completion write of a run carries
// its generation; a generation that is not the current one is refused. The
// plain write tools carry no generation, so `checkGenericWrite` below is
// the boundary for them: it fences the one writer a stale run can speak
// for — its own.

/** How long an accepted run may stay silent before its lease is expired. A
 * run keeps its lease by heartbeating; expiry alone changes nothing. */
export const HANDOFF_LEASE_MS = 30 * 60 * 1000;

/** The handoff states a run can be in (`null` on the item = not handed over). */
export const HANDOFF_STATES = ["requested", "accepted", "unknown", "completed"] as const;

export interface HandoffView {
  state: string | null;
  request_id: string | null;
  accepted_by: string | null;
  generation: number | null;
  lease_until: number | null;
}

/** True when an accepted run has been silent past its lease. `unknown` and
 * other states have no lease to expire. */
export function leaseExpired(h: HandoffView, now: number): boolean {
  return h.state === "accepted" && h.lease_until !== null && now > h.lease_until;
}

/** The generation the next request on this item gets: one more than the last
 * one ever used, so a token from any earlier run can never match again. */
export function nextGeneration(current: number | null): number {
  return (current ?? 0) + 1;
}

export type FenceVerdict =
  | { ok: true }
  | { ok: false; code: "HANDOFF_CONFLICT" | "STALE_GENERATION" | "FORBIDDEN" | "FENCE_REQUIRED"; detail: string };

/**
 * May `actor` write as the run (requestId, generation)? Only the writer that
 * accepted the request, while the handoff is still `accepted`, with the
 * request id that is on the item and the current generation. A mismatched
 * generation gets its own code, so a stale run can tell "I was replaced"
 * apart from "the work moved on".
 */
export function checkFence(
  h: HandoffView,
  actor: string,
  requestId: string,
  generation: number,
): FenceVerdict {
  if (h.state !== "accepted" || h.request_id !== requestId)
    return { ok: false, code: "HANDOFF_CONFLICT", detail: "This run is not the open one: it was completed, released, marked unknown, or the id is another one" };
  if (h.accepted_by !== actor)
    return { ok: false, code: "FORBIDDEN", detail: `This run was taken by ${h.accepted_by ?? "another writer"}, not by ${actor}` };
  if (h.generation !== generation)
    return { ok: false, code: "STALE_GENERATION", detail: `Generation ${generation} is stale: the current run is generation ${h.generation}. This write was refused so an old run cannot overwrite a newer one` };
  return { ok: true };
}

/** May the handoff be marked `unknown` at `now`? Only an accepted run whose
 * lease has expired: a run that is still heartbeating is not "unknown", it is
 * working, and a requested/completed handoff has nothing to lose track of.
 * A run with no lease on record at all (accepted before leases existed) can
 * also be marked: nothing proves it is alive, so its outcome is exactly as
 * unconfirmed as an expired run's — a person still has to look. */
export function canMarkUnknown(h: HandoffView, now: number): FenceVerdict {
  if (h.state !== "accepted")
    return { ok: false, code: "HANDOFF_CONFLICT", detail: "Only a run that was taken can be marked unknown" };
  if (h.lease_until === null) return { ok: true };
  if (!leaseExpired(h, now))
    return { ok: false, code: "HANDOFF_CONFLICT", detail: "The run's lease has not expired: it may still be working, so it is not unknown yet" };
  return { ok: true };
}

/** A run taken before generations existed: its handoff is `accepted` or
 * `unknown` but has no generation, so no fence can ever match it. Such a run
 * keeps writing through the plain tools (there is no token it could send);
 * it gains a generation when it is resumed from `unknown`, and any work
 * handed over or accepted now always has one. */
export function isLegacyRun(h: HandoffView): boolean {
  return (h.state === "accepted" || h.state === "unknown") && h.generation === null;
}

/** The fence a plain write (board_upsert_item / board_add_event) carries. */
export type GenericFence = { request_id: string; generation: number } | null;

/**
 * May `actor` write to this item through the plain tools, which carry no
 * fence of their own? The board's keys name writers, not runs, so the only
 * write a stale run can be fenced out of is one made under its own writer's
 * name: while a handoff is `accepted`, a plain write by the writer that
 * took it must carry the run's current fence (request_id + generation), or
 * use the fenced tools — otherwise a replaced run of the same writer could
 * keep writing over its successor through the old path. While the handoff
 * is `unknown`, that writer may not write plainly at all: the run is
 * quarantined until it is resumed. Every other writer (and the owner's
 * page, whose actor is not a writer) writes as before: their writes are
 * their own, under their own name, and the board has never fenced those.
 * A legacy run (no generation on record) cannot be asked for a fence it
 * never received, so its plain writes stay allowed until it is resumed or
 * the work is handed over again and a generation exists.
 */
export function checkGenericWrite(h: HandoffView, actor: string, fence: GenericFence): FenceVerdict {
  if (h.state !== "accepted" && h.state !== "unknown") return { ok: true };
  if (h.accepted_by === null || actor !== h.accepted_by) return { ok: true };
  if (h.state === "unknown")
    return { ok: false, code: "HANDOFF_CONFLICT", detail: "This run is marked unknown: its plain writes are refused until the run is resumed (board_resume_handoff) or the work is released" };
  if (h.generation === null) return { ok: true };
  if (fence === null)
    return { ok: false, code: "FENCE_REQUIRED", detail: `This item is being run as request ${h.request_id} generation ${h.generation}: a plain write by ${actor} must carry that request_id and generation, or use board_progress_handoff / board_complete_handoff. Other writers are not affected` };
  return checkFence(h, actor, fence.request_id, fence.generation);
}

/** May the work go back to the pile from `unknown`? Only from `unknown`
 * itself — that state is the proof a person looked at the run and stopped
 * treating its outcome as merely unconfirmed. Releasing straight from
 * `accepted` is refused here (the accepted writer's own fenced release is a
 * separate path in store.ts). */
export function canReleaseUnknown(h: HandoffView): FenceVerdict {
  if (h.state !== "unknown")
    return { ok: false, code: "HANDOFF_CONFLICT", detail: "Only work marked unknown can be released this way: mark it unknown first, then confirm the old run has stopped" };
  return { ok: true };
}

/** May an `unknown` handoff go back to `accepted` (the same run, confirmed
 * still working)? The generation does not change: it is the same run. */
export function canResumeUnknown(h: HandoffView): FenceVerdict {
  if (h.state !== "unknown")
    return { ok: false, code: "HANDOFF_CONFLICT", detail: "Only work marked unknown can be resumed" };
  return { ok: true };
}
