// The owner's order and the dispatcher with stand-ins for the board and
// Devin (no wrangler). Node loads the .ts files directly (type stripping).
//
//   node test/route.test.mjs
import { ALIVE_MS, DEFAULT_ORDER, HANDOFF_TARGETS, ORDERABLE, chooseByOrder, isAlive, parseOrder } from "../src/route.ts";
import { runDispatcher, spawnDevinSession, DISPATCH_MAX_PER_DAY, DISPATCH_MAX_PER_REQUEST } from "../src/dispatch.ts";

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
}

// --- pure parts: the destinations, the order and who is alive
check("destinations are a tool and the place it runs", ["devin", "vps-claude", "local-claude", "vps-devin", "local-devin"].every((t) => HANDOFF_TARGETS.includes(t)));
check("owner and hold cannot be in the order", !ORDERABLE.includes("owner") && !ORDERABLE.includes("hold") && ORDERABLE.length === HANDOFF_TARGETS.length - 2);
check("the default order is the server, the PC, then Devin", DEFAULT_ORDER.join(",") === "vps-claude,local-claude,devin");
check("an order is distinct destinations in order", parseOrder(["devin", "vps-claude"])?.join(",") === "devin,vps-claude");
check("an empty order is allowed (everything goes to hold)", parseOrder([])?.length === 0);
for (const bad of [null, "devin", ["devin", "devin"], ["owner"], ["hold"], ["someone"], [1], new Array(ORDERABLE.length + 1).fill("devin")])
  check(`a bad order is refused: ${JSON.stringify(bad)?.slice(0, 40)}`, parseOrder(bad) === null);
const now = 1_000_000_000;
check("a taker seen lately is alive", isAlive("vps-claude", { "vps-claude": now - 60_000 }, now, false));
check("a taker seen exactly the limit ago is still alive", isAlive("vps-claude", { "vps-claude": now - ALIVE_MS }, now, false));
check("a taker not seen for longer than the limit is not", !isAlive("vps-claude", { "vps-claude": now - ALIVE_MS - 1 }, now, false));
check("a taker never seen is not", !isAlive("local-claude", {}, now, true));
check("Devin in the cloud is alive when the board can start it", isAlive("devin", {}, now, true) && !isAlive("devin", { devin: now }, now, false));
const first = chooseByOrder(["vps-claude", "local-claude", "devin"], (t) => t !== "vps-claude");
check("the first alive destination in the order gets the work, and the event says which number and who was passed over",
  first.to === "local-claude" && first.rank === 2 && first.text === "routed to local-claude: number 2 in the owner's order (vps-claude not picking up)", JSON.stringify(first));
check("the first one alive is taken without a note", chooseByOrder(["devin"], () => true).text === "routed to devin: number 1 in the owner's order");
const none = chooseByOrder(["vps-claude", "devin"], () => false);
check("when nobody is alive the work goes to hold, naming them", none.to === "hold" && none.rank === null && none.text === "routed to hold: nobody in the owner's order is picking up (vps-claude, devin)", JSON.stringify(none));
check("an empty order sends the work to hold", chooseByOrder([], () => true).to === "hold");
check("owner and hold in a stored order are passed over", chooseByOrder(["owner", "hold", "devin"], () => true).to === "devin");

// --- the dispatcher with stand-ins
// The fake's dispatch rows follow the real store's claim rules (store.ts
// claimDispatch): a claim is written before the start, an unknown outcome
// blocks the request until a person resolves it, and a confirmed start
// dedupes. claimDispatch's body runs without awaiting, like the real one's
// single transaction, so two ticks racing in these tests interleave the
// same way they would against the Durable Object.
function fakeBoard(items, { dispatched = 0, order = ["vps-claude", "local-claude", "devin"], seen = {}, orderOk = true } = {}) {
  const log = { routed: [], dispatched: [], events: [], claims: [], orderReads: 0 };
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
    async routeOrder() { log.orderReads++; return orderOk ? { ok: true, order, seen } : { ok: false }; },
    async routeHandoff(actor, itemId, request, to, text, toSetBy) { log.routed.push({ itemId, to, text, toSetBy, actor }); return { ok: true, changed: true }; },
  };
  return { board, log };
}
const item = (id, to = null, requestedBy = "page:owner") => ({ item_id: id, project: "demo", title: `work ${id}`, source_ref: null, request_id: `REQ-${id}`, requested_at: 1, to, requested_by: requestedBy });
const fresh = () => Date.now() - 30_000;
let devinStarts = 0;
const startDevin = async () => { devinStarts++; return { session_id: `s${devinStarts}`, url: "https://app.devin.ai/sessions/x" }; };

{
  const { board, log } = fakeBoard([item("m", "muse")]);
  devinStarts = 0;
  await runDispatcher({ board, startDevin });
  check("work for muse reads no order and wakes no Devin", log.orderReads === 0 && devinStarts === 0 && log.routed.length === 0, JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("a")], { seen: { "vps-claude": fresh() } });
  devinStarts = 0;
  await runDispatcher({ board, startDevin });
  check("the owner's work goes to the first in the order that is picking up, as the owner's choice",
    log.routed[0]?.to === "vps-claude" && log.routed[0]?.toSetBy === "page:owner" && log.routed[0]?.actor === "dispatcher" && devinStarts === 0, JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("b")]);
  devinStarts = 0;
  await runDispatcher({ board, startDevin });
  check("with the server and the PC away, the order reaches Devin, which starts in the same pass",
    log.routed[0]?.to === "devin" && log.routed[0]?.text.includes("number 3") && devinStarts === 1 && log.dispatched[0] === "REQ-b", JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("c")]);
  devinStarts = 0;
  await runDispatcher({ board, startDevin: null });
  check("without a Devin key and nobody picking up, the work goes to hold, set by the dispatcher",
    log.routed[0]?.to === "hold" && log.routed[0]?.toSetBy === "dispatcher" && devinStarts === 0, JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("w", null, "alpha")], { seen: { "vps-claude": fresh() } });
  await runDispatcher({ board, startDevin });
  check("work a writer handed over is placed by the order but names the dispatcher, so the owner-only takers leave it",
    log.routed[0]?.to === "vps-claude" && log.routed[0]?.toSetBy === "dispatcher", JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("u")], { orderOk: false });
  devinStarts = 0;
  await runDispatcher({ board, startDevin });
  check("an order that cannot be read sends the work to hold", log.routed[0]?.to === "hold" && devinStarts === 0, JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("p1"), item("p2")], { order: ["local-claude"], seen: { "local-claude": fresh() } });
  await runDispatcher({ board, startDevin });
  check("the order is read once per pass", log.orderReads === 1 && log.routed.length === 2 && log.routed.every((r) => r.to === "local-claude"), JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("f", "devin"), item("g", "devin"), item("h", "devin")], { dispatched: DISPATCH_MAX_PER_DAY - 1 });
  devinStarts = 0;
  await runDispatcher({ board, startDevin });
  check("the day's cap on Devin starts holds", devinStarts === 1 && log.dispatched.length === 1, JSON.stringify(log));
}

// --- the claim before the start: races, lost answers, a person's settlement
{
  const { board, log } = fakeBoard([item("race", "devin")]);
  let starts = 0;
  const slowStart = async () => { starts++; await new Promise((r) => setTimeout(r, 50)); return { session_id: `sr${starts}` }; };
  await Promise.all([
    runDispatcher({ board, startDevin: slowStart }),
    runDispatcher({ board, startDevin: slowStart }),
  ]);
  check("two ticks racing claim once and start Devin once", starts === 1 && log.claims.length === 1 && log.dispatched.length === 1, JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("lost", "devin")]);
  let starts = 0;
  const lostStart = async () => { starts++; throw new Error("the answer was lost"); };
  await runDispatcher({ board, startDevin: lostStart });
  check("a lost start was claimed once and tried once", starts === 1 && log.claims.length === 1 && log.dispatched.length === 0, JSON.stringify(log));
  check("the lost start is left unknown and blocks the dispatcher", (await board.dispatchState("REQ-lost", 0)).blocked === true);
  check("the board was told the outcome is unknown", log.events.some((t) => t.includes("REQ-lost") && t.includes("unknown")), JSON.stringify(log.events));
  await runDispatcher({ board, startDevin: lostStart });
  check("an unknown start is never retried on its own", starts === 1, `starts=${starts}`);
  const settled = await board.resolveDispatch("REQ-lost", "retry");
  check("a person settles the unknown start as not running", settled.ok === true && (await board.dispatchState("REQ-lost", 0)).blocked === false);
  let okStarts = 0;
  await runDispatcher({ board, startDevin: async () => { okStarts++; return { session_id: "s-ok" }; } });
  check("after the settlement the dispatcher may start it again", okStarts === 1 && log.dispatched[0] === "REQ-lost", JSON.stringify(log));
}
{
  const { board, log } = fakeBoard([item("found", "devin")]);
  let starts = 0;
  await runDispatcher({ board, startDevin: async () => { starts++; return null; } });
  check("a start that answers nothing is unknown too, not a silent retry", starts === 1 && (await board.dispatchState("REQ-found", 0)).blocked === true);
  const settled = await board.resolveDispatch("REQ-found", "started");
  let more = 0;
  await runDispatcher({ board, startDevin: async () => { more++; return { session_id: "s-more" }; } });
  check("settled as started, the session is left to take the work itself", settled.ok === true && more === 0 && log.dispatched.length === 0, JSON.stringify(log));
}
{
  // Devin answered and said no (a 4xx, e.g. a revoked key): no session was
  // started, so nothing is unknown and no person has to settle it. The
  // attempt still counts, so a key that stays wrong stops at the per-request cap.
  const { board, log } = fakeBoard([item("refused", "devin")]);
  let starts = 0;
  const refusing = async () => { starts++; return { refused: 401 }; };
  await runDispatcher({ board, startDevin: refusing });
  check("a refused start is not unknown and does not wait for a person", starts === 1 && (await board.dispatchState("REQ-refused", 0)).blocked === false, JSON.stringify(log));
  check("the board is told the start was refused, with the status", log.events.some((t) => t.includes("REQ-refused") && t.includes("refused (HTTP 401)") && !t.includes("unknown")), JSON.stringify(log.events));
  for (let i = 0; i < DISPATCH_MAX_PER_REQUEST + 2; i++) await runDispatcher({ board, startDevin: refusing });
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
