// The safe-resumption decisions with no board and no wrangler: the lease,
// the fencing generation, and the unknown quarantine (src/resume.ts).
// store.ts keeps the state and asks these questions; the end-to-end flow
// through the Worker is in test/board.test.mjs.
//
//   node test/resume.test.mjs
import {
  HANDOFF_LEASE_MS, canMarkUnknown, canReleaseUnknown, canResumeUnknown,
  checkFence, leaseExpired, nextGeneration,
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

console.log(`passed ${passed}, failed ${failures.length}`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
