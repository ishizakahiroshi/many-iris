// The router and the dispatcher with stand-ins for the board, Workers AI and
// Devin (no wrangler). Node loads the .ts files directly (type stripping).
//
//   node test/route.test.mjs
import { decideRoute, estimateNeurons, routeAllowed, routeRequest, utcDay, ROUTE_DAILY_NEURON_CAP } from "../src/route.ts";
import { runDispatcher, spawnDevinSession, DISPATCH_MAX_PER_DAY, DISPATCH_MAX_PER_REQUEST } from "../src/dispatch.ts";

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
}

// --- pure parts
check("a confident answer is taken", decideRoute({ answers: { to: { choice: "devin", probabilities: { devin: 0.8 }, confidence: 0.3 } } }).to === "devin");
check("an answer below the floor goes to hold", decideRoute({ answers: { to: { choice: "devin", probabilities: { devin: 0.4 }, confidence: 0.3 } } }).to === "hold");
check("an unknown destination goes to hold", decideRoute({ answers: { to: { choice: "someone", probabilities: { someone: 0.9 }, confidence: 0.3 } } }).to === "hold");
check("a missing answer goes to hold", decideRoute({}).to === "hold" && decideRoute(null).to === "hold");
check("a probability outside 0..1 goes to hold", decideRoute({ answers: { to: { choice: "devin", probabilities: { devin: 1.5 }, confidence: 0.3 } } }).to === "hold");
check("the decision says the probability and the confidence", decideRoute({ answers: { to: { choice: "owner", probabilities: { owner: 0.83 }, confidence: 0.3 } } }).text === "routed to owner (probability 0.83, confidence 0.30)");
for (const nobody of ["muse", "grokbot", "vps-claude", "local-claude"])
  check(`the router does not send work to ${nobody}, which nobody picks up yet`, decideRoute({ answers: { to: { choice: nobody, probabilities: { [nobody]: 0.92 }, confidence: 0.83 } } }).to === "hold");
check("Clef's low confidence alone does not send work to hold", decideRoute({ answers: { to: { choice: "devin", probabilities: { devin: 0.59 }, confidence: 0.28 } } }).to === "devin");
check("a choice that is not more likely than the rest goes to hold", decideRoute({ answers: { to: { choice: "hold", probabilities: { hold: 0.39 }, confidence: 0.09 } } }).to === "hold");
const fromUsage = estimateNeurons({ usage: { input_tokens: 1000 } }, 99999);
check("neurons come from the reported tokens", fromUsage.fromUsage === true && Math.abs(fromUsage.neurons - 3.455) < 1e-9, JSON.stringify(fromUsage));
const fromChars = estimateNeurons(null, 1000);
check("without a token count, the characters sent are counted", fromChars.fromUsage === false && Math.abs(fromChars.neurons - 3.455) < 1e-9);
check("the guard opens below the cap and closes at it", routeAllowed(ROUTE_DAILY_NEURON_CAP - 1) && !routeAllowed(ROUTE_DAILY_NEURON_CAP));
check("the day is the UTC day", utcDay(Date.UTC(2026, 10, 14, 23, 59)) === "2026-11-14" && utcDay(Date.UTC(2026, 10, 15, 0, 0)) === "2026-11-15");
const req = routeRequest({ project: "demo", title: "a\n  title\twith   space ".repeat(30), source_ref: "https://example.com/x" });
check("the title is one short line of data", req.model === "clef-flash" && req.state.title.length === 200 && !/\s{2}|\n/.test(req.state.title) &&
  req.state.reference === "https://example.com/x" && Object.keys(req.questions.to.criteria).join(",") === "devin,owner,hold");

// --- the dispatcher with stand-ins
// The fake's dispatch rows follow the real store's claim rules (store.ts
// claimDispatch): a claim is written before the start, an unknown outcome
// blocks the request until a person resolves it, and a confirmed start
// dedupes. claimDispatch's body runs without awaiting, like the real one's
// single transaction, so two ticks racing in these tests interleave the
// same way they would against the Durable Object.
function fakeBoard(items, { neurons = 0, dispatched = 0 } = {}) {
  const log = { routed: [], usage: [], dispatched: [], events: [], claims: [] };
  let used = neurons;
  const rows = [];
  for (let i = 0; i < dispatched; i++) rows.push({ request: "REQ-seed", at: Date.now(), status: "started", id: rows.length + 1 });
  const stateOf = (request, since) => {
    const mine = rows.filter((r) => r.request === request);
    const startedRows = mine.filter((r) => r.status === "started");
    return {
      ok: true,
      at: startedRows.length ? Math.max(...startedRows.map((r) => r.at)) : null,
      count: mine.length,
      total_since: rows.filter((r) => r.at >= since).length,
      blocked: mine.some((r) => r.status === "claimed" || r.status === "unknown"),
    };
  };
  const board = {
    async pendingHandoffs() { return { ok: true, items: items.map((i) => ({ ...i })) }; },
    async dispatchState(request, since) { return stateOf(request, since); },
    async claimDispatch(request, at, lim) {
      const mine = rows.filter((r) => r.request === request);
      if (mine.some((r) => r.status === "claimed" || r.status === "unknown")) return { ok: true, claimed: false, reason: "blocked" };
      if (mine.length >= lim.maxPerRequest) return { ok: true, claimed: false, reason: "per_request_cap" };
      const startedRows = mine.filter((r) => r.status === "started");
      if (startedRows.length && at - Math.max(...startedRows.map((r) => r.at)) < lim.dedupeMs) return { ok: true, claimed: false, reason: "dedupe" };
      if (rows.filter((r) => r.at >= lim.daySince).length >= lim.maxPerDay) return { ok: true, claimed: false, reason: "day_cap" };
      const row = { request, at, status: "claimed", id: rows.length + 1 };
      rows.push(row);
      log.claims.push(request);
      return { ok: true, claimed: true, claim_id: row.id };
    },
    async confirmDispatch(claimId) {
      const row = rows.find((r) => r.id === claimId);
      if (row?.status === "claimed") { row.status = "started"; log.dispatched.push(row.request); return { ok: true, changed: true }; }
      return { ok: true, changed: false };
    },
    async markDispatchUnknown(claimId) {
      const row = rows.find((r) => r.id === claimId);
      if (row?.status === "claimed") { row.status = "unknown"; return { ok: true, changed: true }; }
      return { ok: true, changed: false };
    },
    async refuseDispatch(claimId) {
      const row = rows.find((r) => r.id === claimId);
      if (row?.status === "claimed") { row.status = "refused"; return { ok: true, changed: true }; }
      return { ok: true, changed: false };
    },
    async resolveDispatch(request, resolution) {
      const row = rows.find((r) => r.request === request && r.status === "unknown");
      if (!row) return { ok: false };
      row.status = resolution === "retry" ? "resolved" : "started";
      return { ok: true, changed: true };
    },
    async run(tool, actor, args) { log.events.push(args.text); return { ok: true }; },
    async routeUsage(day) { return { ok: true, day, neurons: used }; },
    async recordRouteUse(day, n, fromUsage) { used += n; log.usage.push({ day, n, fromUsage }); return { ok: true }; },
    async routeHandoff(actor, itemId, request, to, text) { log.routed.push({ itemId, to, text }); return { ok: true, changed: true }; },
  };
  return { board, log };
}
const item = (id, to = null) => ({ item_id: id, project: "demo", title: `work ${id}`, source_ref: null, request_id: `REQ-${id}`, requested_at: 1, to });
const ai = (answer) => {
  const calls = [];
  return { calls, run: async (model, input) => { calls.push({ model, input }); if (answer instanceof Error) throw answer; return answer; } };
};
let devinStarts = 0;
const startDevin = async () => { devinStarts++; return { session_id: `s${devinStarts}`, url: "https://app.devin.ai/sessions/x" }; };

{
  const { board, log } = fakeBoard([item("m", "muse")]);
  const a = ai({ answers: { to: { choice: "devin", probabilities: { devin: 0.9 }, confidence: 0.3 } }, usage: { input_tokens: 500 } });
  devinStarts = 0;
  await runDispatcher({ board, ai: a, startDevin });
  check("work for muse wakes neither Clef nor Devin", a.calls.length === 0 && devinStarts === 0 && log.dispatched.length === 0 && log.usage.length === 0, JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("a")]);
  const a = ai({ answers: { to: { choice: "devin", probabilities: { devin: 0.8 }, confidence: 0.3 } }, usage: { input_tokens: 500 } });
  devinStarts = 0;
  await runDispatcher({ board, ai: a, startDevin });
  check("a confident devin answer routes and starts Devin in the same tick",
    log.routed[0]?.to === "devin" && log.routed[0]?.text === "routed to devin (probability 0.80, confidence 0.30)" && devinStarts === 1 && log.dispatched[0] === "REQ-a", JSON.stringify(log));
  check("the call is counted from its tokens", log.usage.length === 1 && log.usage[0].fromUsage === true && a.calls[0].model === "@cf/cloudflare/clef-flash");
}
{
  const { board, log } = fakeBoard([item("b")]);
  devinStarts = 0;
  await runDispatcher({ board, ai: ai({ answers: { to: { choice: "devin", probabilities: { devin: 0.4 }, confidence: 0.3 } }, usage: { input_tokens: 500 } }), startDevin });
  check("an unsure answer goes to hold and Devin stays asleep", log.routed[0]?.to === "hold" && devinStarts === 0, JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("c")], { neurons: ROUTE_DAILY_NEURON_CAP });
  const a = ai({ answers: { to: { choice: "devin", probabilities: { devin: 0.9 }, confidence: 0.3 } } });
  devinStarts = 0;
  await runDispatcher({ board, ai: a, startDevin });
  check("at the day's cap, Clef is not called and the work goes to hold with the reason",
    a.calls.length === 0 && log.routed[0]?.to === "hold" && log.routed[0]?.text.includes("used up") && devinStarts === 0, JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("d")]);
  devinStarts = 0;
  await runDispatcher({ board, ai: ai(new Error("down")), startDevin });
  check("a failed call goes to hold, is still counted, and Devin stays asleep",
    log.routed[0]?.to === "hold" && log.routed[0]?.text === "routed to hold: the router call failed" && log.usage[0]?.fromUsage === false && devinStarts === 0, JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("e")]);
  await runDispatcher({ board, ai: null, startDevin });
  check("without the AI binding the work goes to hold", log.routed[0]?.to === "hold" && log.routed[0]?.text.includes("not set up"));
}
{
  const { board, log } = fakeBoard([item("f", "devin"), item("g", "devin"), item("h", "devin")], { dispatched: DISPATCH_MAX_PER_DAY - 1 });
  devinStarts = 0;
  await runDispatcher({ board, ai: ai({}), startDevin });
  check("the day's cap on Devin starts holds", devinStarts === 1 && log.dispatched.length === 1, JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("i")]);
  devinStarts = 0;
  await runDispatcher({ board, ai: ai({ answers: { to: { choice: "devin", probabilities: { devin: 0.9 }, confidence: 0.3 } } }), startDevin: null });
  check("without a Devin key the work is still routed", log.routed[0]?.to === "devin" && devinStarts === 0);
}

// --- the claim before the start: races, lost answers, a person's settlement
{
  const { board, log } = fakeBoard([item("race", "devin")]);
  let starts = 0;
  const slowStart = async () => { starts++; await new Promise((r) => setTimeout(r, 50)); return { session_id: `sr${starts}` }; };
  await Promise.all([
    runDispatcher({ board, ai: null, startDevin: slowStart }),
    runDispatcher({ board, ai: null, startDevin: slowStart }),
  ]);
  check("two ticks racing claim once and start Devin once", starts === 1 && log.claims.length === 1 && log.dispatched.length === 1, JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("lost", "devin")]);
  let starts = 0;
  const lostStart = async () => { starts++; throw new Error("the answer was lost"); };
  await runDispatcher({ board, ai: null, startDevin: lostStart });
  check("a lost start was claimed once and tried once", starts === 1 && log.claims.length === 1 && log.dispatched.length === 0, JSON.stringify(log));
  check("the lost start is left unknown and blocks the dispatcher", (await board.dispatchState("REQ-lost", 0)).blocked === true);
  check("the board was told the outcome is unknown", log.events.some((t) => t.includes("REQ-lost") && t.includes("unknown")), JSON.stringify(log.events));
  await runDispatcher({ board, ai: null, startDevin: lostStart });
  check("an unknown start is never retried on its own", starts === 1, `starts=${starts}`);
  const settled = await board.resolveDispatch("REQ-lost", "retry");
  check("a person settles the unknown start as not running", settled.ok === true && (await board.dispatchState("REQ-lost", 0)).blocked === false);
  let okStarts = 0;
  await runDispatcher({ board, ai: null, startDevin: async () => { okStarts++; return { session_id: "s-ok" }; } });
  check("after the settlement the dispatcher may start it again", okStarts === 1 && log.dispatched[0] === "REQ-lost", JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("found", "devin")]);
  let starts = 0;
  await runDispatcher({ board, ai: null, startDevin: async () => { starts++; return null; } });
  check("a start that answers nothing is unknown too, not a silent retry", starts === 1 && (await board.dispatchState("REQ-found", 0)).blocked === true);
  const settled = await board.resolveDispatch("REQ-found", "started");
  let more = 0;
  await runDispatcher({ board, ai: null, startDevin: async () => { more++; return { session_id: "s-more" }; } });
  check("settled as started, the session is left to take the work itself", settled.ok === true && more === 0 && log.dispatched.length === 0, JSON.stringify(log));
}
{
  // Devin answered and said no (a 4xx, e.g. a revoked key): no session was
  // started, so nothing is unknown and no person has to settle it. The
  // attempt still counts, so a key that stays wrong stops at the per-request cap.
  const { board, log } = fakeBoard([item("refused", "devin")]);
  let starts = 0;
  const refusing = async () => { starts++; return { refused: 401 }; };
  await runDispatcher({ board, ai: null, startDevin: refusing });
  check("a refused start is not unknown and does not wait for a person", starts === 1 && (await board.dispatchState("REQ-refused", 0)).blocked === false, JSON.stringify(log));
  check("the board is told the start was refused, with the status", log.events.some((t) => t.includes("REQ-refused") && t.includes("refused (HTTP 401)") && !t.includes("unknown")), JSON.stringify(log.events));
  for (let i = 0; i < DISPATCH_MAX_PER_REQUEST + 2; i++) await runDispatcher({ board, ai: null, startDevin: refusing });
  check("refused starts stop at the per-request cap", starts === DISPATCH_MAX_PER_REQUEST && log.dispatched.length === 0, `starts=${starts}`);
}

// --- what a Devin answer means (spawnDevinSession), with a stand-in fetch
{
  const answer = (status, body) => async () => new Response(body, { status, headers: { "content-type": "application/json" } });
  const started = await spawnDevinSession(answer(200, JSON.stringify({ session_id: "devin-1", url: "https://app.devin.ai/sessions/1" })), "https://devin.test/sessions", "k", "p");
  check("a 2xx answer with a session is a start", started?.session_id === "devin-1" && started?.url === "https://app.devin.ai/sessions/1", JSON.stringify(started));
  for (const status of [400, 401, 403, 429]) {
    const refused = await spawnDevinSession(answer(status, "{}"), "https://devin.test/sessions", "k", "p");
    check(`a ${status} answer is a refusal, not an unknown start`, refused?.refused === status, JSON.stringify(refused));
  }
  for (const status of [500, 502, 504]) {
    const unknown = await spawnDevinSession(answer(status, "{}"), "https://devin.test/sessions", "k", "p");
    check(`a ${status} answer is unknown (the start may have happened)`, unknown === null, JSON.stringify(unknown));
  }
  const lost = await spawnDevinSession(async () => { throw new Error("connection reset"); }, "https://devin.test/sessions", "k", "p");
  check("a lost answer is unknown", lost === null);
  const garbled = await spawnDevinSession(answer(200, "not json"), "https://devin.test/sessions", "k", "p");
  check("a 2xx answer that cannot be read is unknown", garbled === null, JSON.stringify(garbled));
  let sent = null;
  await spawnDevinSession(async (url, init) => { sent = { url, init }; return new Response("{}", { status: 200 }); }, "https://devin.test/sessions", "key-1", "the prompt");
  check("the start posts the prompt with the key", sent?.url === "https://devin.test/sessions" && sent.init.method === "POST" &&
    sent.init.headers.authorization === "Bearer key-1" && JSON.parse(sent.init.body).prompt === "the prompt", JSON.stringify(sent?.init?.headers));
}

console.log(`passed ${passed}, failed ${failures.length}`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
