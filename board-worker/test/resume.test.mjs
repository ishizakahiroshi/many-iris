// The safe-resumption decisions with no board and no wrangler: the lease,
// the fencing generation, and the unknown quarantine (src/resume.ts).
// store.ts keeps the state and asks these questions; the end-to-end flow
// through the Worker is in test/board.test.mjs.
//
//   node test/resume.test.mjs
import {
  HANDOFF_LEASE_MS, canMarkUnknown, canReleaseUnknown, canResumeUnknown,
  checkFence, checkGenericWrite, isLegacyRun, leaseExpired, nextGeneration,
} from "../src/resume.ts";

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
}

const NOW = 1_800_000_000_000;
const run = (over = {}) => ({
  state: "accepted", request_id: "REQ-20261116-aaaaaaaa", accepted_by: "muse",
  generation: 3, lease_until: NOW + HANDOFF_LEASE_MS, ...over,
});

// --- the lease: expiry is information, never an action
check("a run inside its lease is not expired", leaseExpired(run(), NOW) === false);
check("a run past its lease is expired", leaseExpired(run({ lease_until: NOW - 1 }), NOW) === true);
check("exactly at the lease end is not expired yet", leaseExpired(run({ lease_until: NOW }), NOW) === false);
check("a requested handoff has no lease to expire", leaseExpired(run({ state: "requested", lease_until: null }), NOW) === false);
check("an unknown handoff does not expire further", leaseExpired(run({ state: "unknown", lease_until: NOW - 1 }), NOW) === false);
check("a lease is half an hour", HANDOFF_LEASE_MS === 30 * 60 * 1000);

// --- generations only grow
check("the first generation is 1", nextGeneration(null) === 1 && nextGeneration(0) === 1);
check("the next generation is one more", nextGeneration(3) === 4);

// --- the fence on a run's writes
check("the current run may write", checkFence(run(), "muse", "REQ-20261116-aaaaaaaa", 3).ok === true);
check("an old generation is refused as stale", (() => { const v = checkFence(run(), "muse", "REQ-20261116-aaaaaaaa", 2); return !v.ok && v.code === "STALE_GENERATION"; })());
check("a future generation is refused as stale too", checkFence(run(), "muse", "REQ-20261116-aaaaaaaa", 4).code === "STALE_GENERATION");
check("another writer is refused", checkFence(run(), "alpha", "REQ-20261116-aaaaaaaa", 3).code === "FORBIDDEN");
check("another request is a conflict", checkFence(run(), "muse", "REQ-20261116-bbbbbbbb", 3).code === "HANDOFF_CONFLICT");
check("a completed run may not write again", checkFence(run({ state: "completed" }), "muse", "REQ-20261116-aaaaaaaa", 3).code === "HANDOFF_CONFLICT");
check("an unknown run may not write until resumed", checkFence(run({ state: "unknown" }), "muse", "REQ-20261116-aaaaaaaa", 3).code === "HANDOFF_CONFLICT");
check("work that was never taken has no run to write as", checkFence(run({ state: "requested" }), "muse", "REQ-20261116-aaaaaaaa", 3).code === "HANDOFF_CONFLICT");

// --- unknown: only an expired accepted run, and nothing follows automatically
check("an expired accepted run can be marked unknown", canMarkUnknown(run({ lease_until: NOW - 1 }), NOW).ok === true);
check("a run still in its lease cannot be marked unknown", canMarkUnknown(run(), NOW).code === "HANDOFF_CONFLICT");
check("a requested handoff cannot be marked unknown", canMarkUnknown(run({ state: "requested", lease_until: null }), NOW).code === "HANDOFF_CONFLICT");
check("unknown work can be released (after the stopped check)", canReleaseUnknown(run({ state: "unknown" })).ok === true);
check("accepted work cannot be released through the unknown path", canReleaseUnknown(run()).code === "HANDOFF_CONFLICT");
check("requested work cannot be released through the unknown path", canReleaseUnknown(run({ state: "requested" })).code === "HANDOFF_CONFLICT");
check("unknown work can be resumed as the same run", canResumeUnknown(run({ state: "unknown" })).ok === true);
check("accepted work needs no resume", canResumeUnknown(run()).code === "HANDOFF_CONFLICT");

// --- the plain tools' boundary: only the run writer's own writes are fenced
check("another writer's plain write is not fenced", checkGenericWrite(run(), "alpha", null).ok === true);
check("the owner page's actor is not fenced", checkGenericWrite(run(), "page:owner", null).ok === true);
check("the run writer's plain write needs its fence", (() => { const v = checkGenericWrite(run(), "muse", null); return !v.ok && v.code === "FENCE_REQUIRED"; })());
check("the run writer's plain write with the current fence passes",
  checkGenericWrite(run(), "muse", { request_id: "REQ-20261116-aaaaaaaa", generation: 3 }).ok === true);
check("the run writer's plain write with an old generation is stale",
  checkGenericWrite(run(), "muse", { request_id: "REQ-20261116-aaaaaaaa", generation: 2 }).code === "STALE_GENERATION");
check("the run writer's plain write under another request is a conflict",
  checkGenericWrite(run(), "muse", { request_id: "REQ-20261116-bbbbbbbb", generation: 3 }).code === "HANDOFF_CONFLICT");
check("a requested item fences nobody's plain writes",
  checkGenericWrite(run({ state: "requested", accepted_by: null, lease_until: null }), "muse", null).ok === true);
check("a completed item fences nobody's plain writes", checkGenericWrite(run({ state: "completed" }), "muse", null).ok === true);
check("an unknown run's plain writes are refused until it is resumed",
  checkGenericWrite(run({ state: "unknown" }), "muse", { request_id: "REQ-20261116-aaaaaaaa", generation: 3 }).code === "HANDOFF_CONFLICT");
check("another writer still writes plainly on unknown work", checkGenericWrite(run({ state: "unknown" }), "alpha", null).ok === true);

// --- runs taken before generations and leases existed (migration)
check("a run with no generation is a legacy run", isLegacyRun(run({ generation: null, lease_until: null })) === true);
check("an unknown run with no generation is a legacy run", isLegacyRun(run({ state: "unknown", generation: null })) === true);
check("a run with a generation is not legacy", isLegacyRun(run()) === false);
check("work never taken is not a legacy run", isLegacyRun(run({ state: "requested", accepted_by: null, generation: null, lease_until: null })) === false);
check("a legacy run can be marked unknown: no lease was ever recorded", canMarkUnknown(run({ generation: null, lease_until: null }), NOW).ok === true);
check("an accepted run with no lease on record can be marked unknown", canMarkUnknown(run({ lease_until: null }), NOW).ok === true);
check("a legacy run has no generation a fence could match",
  checkFence(run({ generation: null, lease_until: null }), "muse", "REQ-20261116-aaaaaaaa", 1).code === "STALE_GENERATION");
check("a legacy run's plain writes stay allowed: it has no fence to send",
  checkGenericWrite(run({ generation: null, lease_until: null }), "muse", null).ok === true);

console.log(`passed ${passed}, failed ${failures.length}`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
