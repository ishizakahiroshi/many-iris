// The request lifecycle read-out with no board and no wrangler
// (src/lifecycle.ts). store.ts gathers the rows; this checks the judgement:
// saved != handed over != taken != running != done, what is never guessed,
// and that nothing here can start or re-queue work.
//
//   node test/lifecycle.test.mjs
import { REQUEST_STALL_MS, STAGES, deriveLifecycle } from "../src/lifecycle.ts";
import { HANDOFF_LEASE_MS } from "../src/resume.ts";
import { POLL_GRACE_MS, pollIntervals, pollView } from "../src/poll.ts";

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
}

const NOW = 1_800_000_000_000;
const item = (over = {}) => ({ item_id: "workshop/task-1", state: "planned", updated_at: NOW - 1000, updated_by: "chatgpt", ...over });
const handoff = (over = {}) => ({
  state: "requested", request_id: "REQ-20261120-aaaaaaaa", requested_at: NOW - 60_000, accepted_by: null,
  accepted_at: null, to: "muse", generation: 1, heartbeat_at: null, lease_until: null, ...over,
});
const accepted = (over = {}) => handoff({
  state: "accepted", accepted_by: "muse", accepted_at: NOW - 600_000, heartbeat_at: NOW - 600_000,
  lease_until: NOW - 600_000 + HANDOFF_LEASE_MS, ...over,
});
const derive = (over = {}) => deriveLifecycle({ item: item(), handoff: null, dispatch: null, refs: [], ...over }, NOW);

// --- polling estimates use a separately observed queue read
{
  const interval = pollIntervals('{"example-picker":600}').get("example-picker");
  const empty = pollView("example-picker", null, interval, NOW);
  const manual = pollView("manual", NOW, undefined, NOW + 1_000_000);
  const scheduled = pollView("example-picker", NOW, interval, NOW + 600_000 + POLL_GRACE_MS);
  check("no initial patrol means no estimated date", empty.last_poll_at === null && empty.next_poll_at === null && !empty.overdue);
  check("activity is known but schedule can be unknown", manual.last_poll_at === NOW && manual.next_poll_source === null && manual.next_poll_at === null && !manual.overdue);
  check("configured estimate allows the grace window", scheduled.next_poll_at === NOW + 600_000 && scheduled.next_poll_source === "configured_interval_estimate" && !scheduled.overdue);
  check("an unobserved patrol beyond the grace window is overdue", pollView("example-picker", NOW, interval, NOW + 600_000 + POLL_GRACE_MS + 1).overdue);
  check("invalid config cannot synthesize a schedule", pollIntervals('{"example-picker":600,"bad":0}').size === 0);
}

// --- saved is not handed over (the case this was written for)
{
  const l = derive();
  check("a saved-only item is not_handed_over", l.stage === "not_handed_over");
  check("saved-only says no writer took it", l.accepted_by === null && l.times.accepted_at === null);
  check("saved-only says saving proves nothing about delivery", l.unconfirmed.length > 0);
  check("a planned item with no handoff needs attention", l.needs_attention === true);
  check("a done item with no handoff does not", derive({ item: item({ state: "done" }) }).needs_attention === false);
}

// --- asked, nobody took it
{
  const l = derive({ handoff: handoff() });
  check("a fresh request is requested, not accepted", l.stage === "requested" && l.accepted_by === null);
  check("a fresh request is not stalled", l.stalled === false && l.needs_attention === false);
  check("a fresh request says delivery is unconfirmed", l.unconfirmed.some((t) => t.includes("確認できません")));
  check("a writer with no dispatcher is said to be unreachable from the board", l.unconfirmed.some((t) => t.includes("muse")));
  const old = derive({ handoff: handoff({ requested_at: NOW - REQUEST_STALL_MS - 1 }) });
  check("an old untaken request is stalled and needs attention", old.stalled === true && old.needs_attention === true);
  check("stalled lists ways forward but runs none", old.options.length > 0);
  check("exactly at the stall limit is not stalled yet", derive({ handoff: handoff({ requested_at: NOW - REQUEST_STALL_MS }) }).stalled === false);
}
check("owner / hold parks it", ["owner", "hold"].every((to) => derive({ handoff: handoff({ to }) }).stage === "held"));
check("no destination yet is still requested", derive({ handoff: handoff({ to: null }) }).stage === "requested");

// --- the dispatcher's rows (devin)
{
  const d = (status, extra = {}) => derive({ handoff: handoff({ to: "devin" }), dispatch: { status, at: NOW - 30_000, session_id: "s1", attempts: 1, ...extra } });
  check("a lost start answer is dispatch_unknown, needs a person", (() => { const l = d("unknown"); return l.stage === "dispatch_unknown" && l.needs_attention; })());
  check("dispatch_unknown warns about running twice", d("unknown").options.some((t) => t.includes("二重実行")));
  check("a started session is still only requested until it accepts", d("started").stage === "requested");
  check("a started session still says the accept is missing", d("started").unconfirmed.some((t) => t.includes("受付")));
  check("a refused start needs attention", d("refused").needs_attention === true);
  check("a claim in flight is not reported as started", d("claimed").unconfirmed.some((t) => t.includes("途中")));
}

// --- taken: accepted vs running vs silent
{
  const a = derive({ item: item({ state: "in_progress" }), handoff: accepted() });
  check("taken with no report since is accepted, not running", a.stage === "accepted");
  check("accepted says start is unconfirmed", a.unconfirmed.some((t) => t.includes("着手")));
  check("accepted records who and when", a.accepted_by === "muse" && a.times.accepted_at === NOW - 600_000);
  const r = derive({ item: item({ state: "in_progress" }), handoff: accepted({ heartbeat_at: NOW - 60_000, lease_until: NOW - 60_000 + HANDOFF_LEASE_MS }) });
  check("a report after taking it is running", r.stage === "running" && r.needs_attention === false);
  const s = derive({ item: item({ state: "in_progress" }), handoff: accepted({ heartbeat_at: NOW - HANDOFF_LEASE_MS - 5000, lease_until: NOW - 5000 }) });
  check("a lapsed lease is silent, needs attention", s.stage === "silent" && s.needs_attention === true);
  check("silent never claims the run stopped", s.unconfirmed.some((t) => t.includes("断定できません")));
  check("silent is information: it offers marking unknown, never a restart", s.options.some((t) => t.includes("board_mark_handoff_unknown")));
}

// --- unknown, completed
{
  const u = derive({ handoff: accepted({ state: "unknown" }) });
  check("unknown stays unknown and needs a person", u.stage === "unknown" && u.needs_attention === true);
  const done = derive({ item: item({ state: "done" }), handoff: accepted({ state: "completed", lease_until: null }) });
  check("completed with done is completed/done", done.stage === "completed" && done.outcome === "done" && done.needs_attention === false);
  check("completed does not claim the person accepted it", done.summary.includes("人の受け入れ確認は別"));
  const stopped = derive({ item: item({ state: "stopped" }), handoff: accepted({ state: "completed", lease_until: null }) });
  check("completed with stopped is not reported as done", stopped.outcome === "stopped" && stopped.needs_attention === true && !stopped.summary.includes("完了として"));
}

// --- the unknown value is flagged, result links pass through
check("an unknown handoff state is flagged, not guessed", (() => { const l = derive({ handoff: handoff({ state: "weird" }) }); return l.needs_attention && l.unconfirmed.length > 0; })());
{
  const refs = [{ at: NOW - 10, actor: "muse", ref: "https://github.com/example/repo/pull/1" }];
  check("result links are carried as given", derive({ handoff: accepted(), refs }).result_refs[0].ref === refs[0].ref);
}

// --- every stage is reachable and listed
{
  const seen = new Set([
    derive().stage, derive({ handoff: handoff() }).stage, derive({ handoff: handoff({ to: "hold" }) }).stage,
    derive({ handoff: handoff({ to: "devin" }), dispatch: { status: "unknown", at: NOW, session_id: null, attempts: 1 } }).stage,
    derive({ handoff: accepted() }).stage,
    derive({ handoff: accepted({ heartbeat_at: NOW - 1 }) }).stage,
    derive({ handoff: accepted({ lease_until: NOW - 1 }) }).stage,
    derive({ handoff: accepted({ state: "unknown" }) }).stage,
    derive({ handoff: accepted({ state: "completed" }) }).stage,
  ]);
  check("every stage is produced and in STAGES", STAGES.every((s) => seen.has(s)) && [...seen].every((s) => STAGES.includes(s)), [...seen].join(","));
}

if (failures.length) {
  console.error(`FAILED ${failures.length} (passed ${passed}):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`lifecycle.test.mjs: ${passed} checks passed`);
