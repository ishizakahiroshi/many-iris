// The picker: one pass looks at the board, takes at most one piece of
// work that is addressed to this writer, runs it through the configured
// executor, and reports the run with the fenced handoff tools
// (board_heartbeat_handoff / board_progress_handoff /
// board_complete_handoff) that PR #4 added to board-worker.
//
// This side exists because the board's other destinations had no taker
// in this repository: the board's own cron dispatcher only starts
// Devin sessions, and many-ai-cli's local_taker only runs while its
// Hub is up on the owner's PC, only for `local-claude`, and reports
// with the plain (unfenced) writes. This picker is the standalone
// counterpart: it runs anywhere Node runs (a VPS cron job is enough;
// no PC has to stay on), for whichever writer its key belongs to, and
// it never writes run state with the plain tools.
//
// Safety rules, all deliberate:
// - Only work addressed to this writer is taken (handoff.to === the
//   configured writer name). Unrouted work is the board dispatcher's
//   business, not the picker's.
// - By default only work the board's owner handed over from the page
//   counts (requested_by and to_set_by are both `page:owner`): a
//   writer key alone can put a title on the board, and a run may reach
//   local files through a command executor, so writer-handed work is
//   not run unattended unless the operator opts out of the gate.
// - The title a run works on is the snapshot the handover kept
//   (handoff.title), treated as data — the name of the work — never
//   as fresh instructions.
// - While a run goes, a heartbeat extends its lease. A fence refusal
//   (STALE_GENERATION / FORBIDDEN / HANDOFF_CONFLICT) or a lost board
//   connection aborts the run: this run has been replaced or can no
//   longer prove it is the current one, so it must not finish writing.
//   Nothing is retried automatically and nothing is completed blind;
//   if the board cannot be told the outcome, the lease lapses and the
//   board's unknown-state quarantine is the human recovery path.
// - One run per pass, and a daily cap, bound what an unattended
//   picker can do before a person looks.

import { BoardRefusal, BoardUnreachable } from "./board-client.mjs";
import { takeoverRef } from "./takeover.mjs";

/** The board page's writer name: the only hander trusted by default. */
export const OWNER_ACTOR = "page:owner";

const TEXT_MAX = 2000;

export function truncate(text, max = TEXT_MAX) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * May this picker take this item? Returns the run's identity
 * ({ itemId, project, requestId, title }) or null. Pure: unit tests
 * measure this directly against board_list-shaped items.
 */
export function eligible(item, config) {
  if (item === null || typeof item !== "object") return null;
  const handoff = item.handoff;
  if (handoff === null || typeof handoff !== "object") return null;
  if (item.kind !== "task") return null;
  if (handoff.state !== "requested") return null;
  if (typeof item.item_id !== "string" || item.item_id.length === 0) return null;
  if (typeof handoff.request_id !== "string" || handoff.request_id.length === 0) return null;
  // Addressed to somebody else, or to nobody yet: not this picker's.
  if (handoff.to !== config.writer) return null;
  if (config.ownerOnly) {
    if (handoff.requested_by !== OWNER_ACTOR || handoff.to_set_by !== OWNER_ACTOR) return null;
  }
  const title = typeof handoff.title === "string" ? handoff.title.trim() : "";
  if (title.length === 0) return null;
  return { itemId: item.item_id, project: item.project ?? null, requestId: handoff.request_id, title };
}

/**
 * For work that continues a session (see takeover.mjs): the session
 * item's identity as the board has it — { itemId, project, createdAt,
 * title } — or { itemId, missing: true } when the board has no such
 * item or could not be read. Null for ordinary work. The executor
 * decides what to do with a missing one (it should stop and say so).
 */
export async function lookUpTakeover(client, job, listed = []) {
  const ref = takeoverRef(job);
  if (ref === null) return null;
  let found = listed.find((i) => i?.item_id === ref) ?? null;
  if (found === null) {
    try {
      found = (await client.listItems()).find((i) => i?.item_id === ref) ?? null;
    } catch (error) {
      if (!(error instanceof BoardUnreachable)) throw error;
    }
  }
  if (found === null || !Number.isFinite(found.created_at)) return { itemId: ref, missing: true };
  return { itemId: ref, project: found.project ?? null, createdAt: found.created_at, title: truncate(found.title ?? "", 200) };
}

/** Fence refusals: the board has moved on; this run stops, no retry. */
export function isFenceRefusal(error) {
  return error instanceof BoardRefusal
    && (error.code === "STALE_GENERATION" || error.code === "FORBIDDEN" || error.code === "HANDOFF_CONFLICT");
}

/**
 * One pass. `deps` carries everything with side effects so tests can
 * drive the whole pass against a fake board:
 *   client   – BoardClient-shaped ({ call, listItems })
 *   executor – { run(job, { signal, progress }) -> { outcome, text } }
 *   state    – { runsToday(), recordRun() } daily-cap bookkeeping
 *   log      – (message) => void, never given the key or item bodies
 *   timers   – { setInterval, clearInterval } (heartbeat scheduling)
 *
 * Returns an outcome object; expected board conditions are outcomes,
 * not exceptions.
 */
export async function runPass({ client, config, executor, state, log = () => {}, timers = globalThis }) {
  if (state.runsToday() >= config.maxRunsPerDay) {
    log(`daily cap reached (${config.maxRunsPerDay}); not looking`);
    return { kind: "capped" };
  }

  const projects = config.projects.length > 0 ? config.projects : [null];
  let chosen = null;
  let listed = [];
  for (const project of projects) {
    let items;
    try {
      items = await client.listItems(project ?? undefined);
    } catch (error) {
      if (error instanceof BoardUnreachable) {
        log("the board could not be read; ending this pass without taking anything");
        return { kind: "unreachable" };
      }
      throw error;
    }
    chosen = items.map((item) => eligible(item, config)).find((run) => run !== null) ?? null;
    if (chosen !== null) {
      listed = items;
      break;
    }
  }
  if (chosen === null) return { kind: "nothing" };

  // Take it. A refusal here means somebody else won, it was taken
  // back, or it was routed elsewhere between listing and accepting:
  // an ordinary race, reported and never retried in this pass.
  let accepted;
  try {
    accepted = await client.call("board_accept_handoff", { item_id: chosen.itemId, request_id: chosen.requestId });
  } catch (error) {
    if (error instanceof BoardRefusal) {
      log(`accept refused for ${chosen.itemId}: ${error.code}`);
      return { kind: "accept-refused", itemId: chosen.itemId, code: error.code };
    }
    if (error instanceof BoardUnreachable) {
      // The accept may or may not have landed. The board's accept is
      // idempotent for the same writer and request, but this picker
      // does not chase it: if it landed, the lease lapses into the
      // board's unknown quarantine for a person to settle.
      log(`accept for ${chosen.itemId} may not have reached the board; not chasing it`);
      return { kind: "unreachable", itemId: chosen.itemId };
    }
    throw error;
  }
  const generation = accepted?.handoff?.generation;
  if (!Number.isSafeInteger(generation) || generation < 1) {
    // Without the generation no fenced write is possible. This is the
    // pre-PR#4 board (or a legacy answer): stop before doing any work
    // rather than fall back to the plain writes. The accept itself
    // gave the run a lease; it lapses into the unknown quarantine.
    log(`accept for ${chosen.itemId} returned no generation; not running unfenced`);
    return { kind: "no-generation", itemId: chosen.itemId };
  }
  state.recordRun();
  const fence = { item_id: chosen.itemId, request_id: chosen.requestId, generation };
  log(`took ${chosen.itemId} (generation ${generation})`);

  const abort = new AbortController();
  let stopReason = null; // "fenced-out" | "unreachable"
  const heartbeat = async () => {
    try {
      await client.call("board_heartbeat_handoff", fence);
    } catch (error) {
      if (isFenceRefusal(error)) stopReason = "fenced-out";
      else if (error instanceof BoardUnreachable) stopReason = "unreachable";
      else throw error;
      abort.abort();
    }
  };
  const timer = timers.setInterval(() => { void heartbeat(); }, config.heartbeatMs);
  const progress = async (text) => {
    await client.call("board_progress_handoff", { ...fence, kind: "note", text: truncate(text) });
  };

  let result;
  try {
    await progress(`開始（picker、${config.writer}。任された仕事 ${chosen.requestId} を受けた）`);
    const job = { itemId: chosen.itemId, project: chosen.project, requestId: chosen.requestId, title: chosen.title };
    const takeover = await lookUpTakeover(client, job, listed);
    if (takeover !== null) job.takeover = takeover;
    result = await executor.run(job, { signal: abort.signal, progress });
  } catch (error) {
    result = { outcome: "stopped", text: `executor failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    timers.clearInterval(timer);
  }

  if (stopReason !== null) {
    // Replaced, or the board went away mid-run: the run was aborted
    // and its outcome must not be written over whatever the board
    // holds now. No completion is attempted.
    log(`run of ${chosen.itemId} stopped (${stopReason}); leaving the outcome unwritten`);
    return { kind: stopReason, itemId: chosen.itemId };
  }

  // Before finishing, prove the fence once more: a heartbeat that is
  // refused (or unanswered) means this run may no longer complete.
  try {
    await client.call("board_heartbeat_handoff", fence);
  } catch (error) {
    if (isFenceRefusal(error)) return { kind: "fenced-out", itemId: chosen.itemId };
    if (error instanceof BoardUnreachable) return { kind: "unreachable", itemId: chosen.itemId };
    throw error;
  }

  const outcome = result?.outcome === "done" ? "done" : "stopped";
  try {
    await client.call("board_complete_handoff", { ...fence, outcome, text: truncate(result?.text ?? "") || undefined });
  } catch (error) {
    if (isFenceRefusal(error)) {
      log(`completion of ${chosen.itemId} refused: ${error.code}`);
      return { kind: "fenced-out", itemId: chosen.itemId };
    }
    if (error instanceof BoardUnreachable) {
      // The completion may or may not have landed; the lease and the
      // unknown quarantine, not a retry, are the recovery path.
      log(`completion of ${chosen.itemId} may not have reached the board; not retrying`);
      return { kind: "unreachable", itemId: chosen.itemId };
    }
    throw error;
  }
  log(`run of ${chosen.itemId} completed (${outcome})`);
  return { kind: "ran", itemId: chosen.itemId, finished: outcome === "done" };
}

/** The longest answer the board keeps in a conversation (board-worker store.ts CHAT_TEXT_MAX). */
export const CHAT_REPLY_MAX = 20000;

/**
 * Reads the executor's answer for a conversation turn. A worker that knows
 * conversations prints one last line of JSON {"reply": "...", "ref": "https://..."};
 * anything else is taken as the plain answer text.
 */
export function chatAnswer(result) {
  let reply = String(result?.text ?? "");
  let ref = null;
  try {
    const parsed = JSON.parse(reply);
    if (parsed && typeof parsed.reply === "string") {
      reply = parsed.reply;
      if (typeof parsed.ref === "string" && parsed.ref.startsWith("https://")) ref = parsed.ref;
    }
  } catch { /* plain text */ }
  reply = reply.trim();
  if (reply.length > CHAT_REPLY_MAX) reply = `${reply.slice(0, CHAT_REPLY_MAX - 1)}…`;
  return { reply: reply || "（返事が空でした）", ref, failed: result?.outcome !== "done" };
}

/**
 * One conversation pass ("話す"): answer the oldest turn the owner sent to
 * this writer, if there is one. The board only ever has owner turns from
 * the signed-in owner's page, so no owner gate is needed here. Turns do not
 * count toward the daily cap (owner decision 2026-11-21: no cap for
 * conversations; each turn needs the owner to send one). A board without
 * conversations (an older version) reads as nothing to do.
 */
export async function runChatPass({ client, executor, log = () => {} }) {
  let pending;
  try {
    pending = await client.call("board_chat_pending", {});
  } catch (error) {
    if (error instanceof BoardUnreachable || error instanceof BoardRefusal) return { kind: "nothing" };
    throw error;
  }
  const turn = Array.isArray(pending?.turns) ? pending.turns[0] : undefined;
  if (!turn || typeof turn.item_id !== "string" || !Number.isSafeInteger(turn.seq)) return { kind: "nothing" };
  let taken;
  try {
    taken = await client.call("board_chat_take", { item_id: turn.item_id, seq: turn.seq });
  } catch (error) {
    if (error instanceof BoardRefusal) {
      log(`chat turn ${turn.seq} on ${turn.item_id} refused: ${error.code}`);
      return { kind: "chat-refused", itemId: turn.item_id, code: error.code };
    }
    if (error instanceof BoardUnreachable) return { kind: "unreachable", itemId: turn.item_id };
    throw error;
  }
  log(`took chat turn ${turn.seq} on ${turn.item_id}`);
  const job = {
    kind: "chat",
    itemId: turn.item_id,
    project: taken?.item?.project ?? null,
    requestId: taken?.handoff?.request_id ?? null,
    title: truncate(taken?.handoff?.title ?? taken?.item?.title ?? "", 200),
    turn: { seq: turn.seq, text: String(taken?.turn?.text ?? "") },
    transcript: Array.isArray(taken?.transcript) ? taken.transcript : [],
  };
  let result;
  try {
    result = await executor.run(job, { progress: async () => {} });
  } catch (error) {
    result = { outcome: "stopped", text: `[失敗] executor failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const answer = chatAnswer(result);
  const args = { item_id: turn.item_id, seq: turn.seq, text: answer.reply };
  if (answer.ref) args.ref = answer.ref;
  if (answer.failed) args.failed = true;
  try {
    await client.call("board_chat_reply", args);
  } catch (error) {
    if (error instanceof BoardRefusal) {
      log(`answer to chat turn ${turn.seq} refused: ${error.code}`);
      return { kind: "chat-refused", itemId: turn.item_id, code: error.code };
    }
    if (error instanceof BoardUnreachable) {
      // The turn stays taken; after a while this writer may take it again.
      log(`answer to chat turn ${turn.seq} may not have reached the board`);
      return { kind: "unreachable", itemId: turn.item_id };
    }
    throw error;
  }
  log(`answered chat turn ${turn.seq} on ${turn.item_id} (${answer.failed ? "failed" : "done"})`);
  return { kind: "chatted", itemId: turn.item_id, finished: !answer.failed };
}
