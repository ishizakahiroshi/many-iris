// The router and the dispatcher with stand-ins for the board, Workers AI and
// Devin (no wrangler). Node loads the .ts files directly (type stripping).
//
//   node test/route.test.mjs
import { decideRoute, estimateNeurons, routeAllowed, routeRequest, utcDay, ROUTE_DAILY_NEURON_CAP } from "../src/route.ts";
import { runDispatcher, DISPATCH_MAX_PER_DAY } from "../src/dispatch.ts";

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
function fakeBoard(items, { neurons = 0, dispatched = 0 } = {}) {
  const log = { routed: [], usage: [], dispatched: [], events: [] };
  let used = neurons;
  const board = {
    async pendingHandoffs() { return { ok: true, items: items.map((i) => ({ ...i })) }; },
    async dispatchState() { return { ok: true, at: null, count: 0, total_since: dispatched + log.dispatched.length }; },
    async recordDispatch(request) { log.dispatched.push(request); return { ok: true }; },
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

console.log(`passed ${passed}, failed ${failures.length}`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
