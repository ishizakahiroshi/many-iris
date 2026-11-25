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
//   The operator may name a few more trusted handers
//   (PICKER_TRUSTED_REQUESTERS, e.g. the owner's own local AI writers);
//   both who handed the work over and who chose this destination must
//   then be the owner or one of them. Every other writer stays out.
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

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardRefusal, BoardUnreachable } from "./board-client.mjs";
import { takeoverRef } from "./takeover.mjs";

/** The board page's writer name: the only hander trusted by default. */
export const OWNER_ACTOR = "page:owner";

/** The status words a status-only run may report (#50): the same words the
 * board's registration enforces on the receiving side (board-worker
 * status-only.ts). */
export const STATUS_STARTED = "状態：着手";
export const STATUS_WORKING = "状態：作業中";
export const STATUS_ATTENTION = "状態：要確認";
export const STATUS_DONE = "状態：完了";
const STATUS_WORDS = new Set([STATUS_STARTED, STATUS_WORKING, STATUS_ATTENTION]);

const TEXT_MAX = 2000;

export function truncate(text, max = TEXT_MAX) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Is this job's reporting restricted to the fixed status words? (#50)
 *   "restricted" – the job's project is registered and this picker (its
 *     writer and board) is the registered taker: its reports carry only the
 *     job's identity and the status words.
 *   "held" – the project is registered but for another writer or board:
 *     the job waits. It must not run here, and never with ordinary
 *     reporting — the restriction is not something a request can switch off.
 *   null – not registered: ordinary reporting.
 */
export function statusOnlyFor(project, config) {
  const entries = Array.isArray(config.statusOnly) ? config.statusOnly : [];
  const entry = entries.find((e) => e.project === project);
  if (!entry) return null;
  const board = (u) => String(u ?? "").replace(/\/+$/, "");
  return entry.writer === config.writer && board(entry.board) === board(config.boardUrl) ? "restricted" : "held";
}

/**
 * May this picker take this item? Returns the run's identity
 * ({ itemId, project, requestId, title }) or null. Pure: unit tests
 * measure this directly against board_list-shaped items.
 */
function addressedRequest(item, config) {
  if (item === null || typeof item !== "object") return null;
  const handoff = item.handoff;
  if (handoff === null || typeof handoff !== "object") return null;
  if (item.kind !== "task") return null;
  if (handoff.state !== "requested") return null;
  if (typeof item.item_id !== "string" || item.item_id.length === 0) return null;
  if (typeof handoff.request_id !== "string" || handoff.request_id.length === 0) return null;
  // Addressed to somebody else, or to nobody yet: not this picker's.
  if (handoff.to !== config.writer) return null;
  const title = typeof handoff.title === "string" ? handoff.title.trim() : "";
  if (title.length === 0) return null;
  return { itemId: item.item_id, project: item.project ?? null, requestId: handoff.request_id, title };
}

function requesterAllowed(handoff, config) {
  if (!config.ownerOnly) return true;
  const trusted = new Set([OWNER_ACTOR, ...(config.trustedRequesters ?? [])]);
  return trusted.has(handoff.requested_by) && trusted.has(handoff.to_set_by);
}

export function eligible(item, config) {
  const job = addressedRequest(item, config);
  return job && requesterAllowed(item.handoff, config) ? job : null;
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

/** A commit id as the board takes it (7 to 40 lowercase hex). */
const COMMIT = /^[0-9a-f]{7,40}$/;
/** The first pull request link in a text, if any. */
const PR_LINK = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

/**
 * The result to put in the card's 結果 (#46 段 2): { text, ref, commit }.
 * A worker that knows this prints one last line of JSON
 * {"summary": "...", "ref": "https://...", "commit": "<hex>"}; otherwise the
 * text is kept as it is and the first pull request link in it becomes ref.
 */
export function runResult(result) {
  let text = String(result?.text ?? "");
  let ref = null;
  let commit = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (typeof parsed.summary === "string") text = parsed.summary;
      if (typeof parsed.ref === "string" && parsed.ref.startsWith("https://") && parsed.ref.length <= 500) ref = parsed.ref;
      if (typeof parsed.commit === "string" && COMMIT.test(parsed.commit)) commit = parsed.commit;
    }
  } catch { /* plain text */ }
  if (ref === null) ref = PR_LINK.exec(text)?.[0] ?? null;
  return { text, ref, commit };
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
  const held = [];
  for (const project of projects) {
    let items;
    try {
      // Only what is addressed to this writer (board_my_work); an older board falls back to the full list.
      const mine = typeof client.listMine === "function" ? await client.listMine(project ?? undefined) : { paused: false, items: await client.listItems(project ?? undefined) };
      if (mine.paused) {
        log("the owner stopped everything on the board; not taking anything");
        return { kind: "paused" };
      }
      items = mine.items;
    } catch (error) {
      if (error instanceof BoardUnreachable) {
        log("the board could not be read; ending this pass without taking anything");
        return { kind: "unreachable" };
      }
      throw error;
    }
    for (const item of items) {
      const run = addressedRequest(item, config);
      if (run === null) continue;
      if (!requesterAllowed(item.handoff, config)) {
        if (item.handoff.requester_declined_at == null && item.handoff.to_set_by) {
          try {
            await client.call("board_report_requester_declined", {
              item_id: run.itemId, request_id: run.requestId, to_set_by: item.handoff.to_set_by,
            });
          } catch (error) {
            // Older or unavailable board: preserve the refusal and continue to other work.
            if (!(error instanceof BoardRefusal || error instanceof BoardUnreachable)) throw error;
            log("could not record the picker admission decision");
          }
        }
        continue;
      }
      // A status-only registration that names another writer or board holds
      // the job here: it stays requested and is never run with ordinary
      // reporting (the board refuses the accept the same way).
      const registration = statusOnlyFor(run.project, config);
      if (registration === "held" || (item.handoff.report_mode ?? null) !== (registration === "restricted" ? "status_only" : null)) {
        held.push(run.itemId);
        continue;
      }
      chosen = run;
      break;
    }
    if (chosen !== null) {
      listed = items;
      break;
    }
  }
  if (chosen === null) {
    if (held.length > 0) {
      log(`held ${held.join(", ")}: the status-only registration names a different writer or board`);
      return { kind: "held", itemIds: held };
    }
    return { kind: "nothing" };
  }
  if (held.length > 0) log(`held ${held.join(", ")}: the status-only registration names a different writer or board`);
  const restricted = statusOnlyFor(chosen.project, config) === "restricted";

  // Take it. A refusal here means somebody else won, it was taken
  // back, or it was routed elsewhere between listing and accepting:
  // an ordinary race, reported and never retried in this pass.
  let accepted;
  try {
    const acceptArgs = { item_id: chosen.itemId, request_id: chosen.requestId };
    if (restricted) acceptArgs.report_mode = "status_only";
    else if (typeof config.versions === "string" && config.versions.length > 0) acceptArgs.versions = config.versions;
    accepted = await client.call("board_accept_handoff", acceptArgs);
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
  let stopReason = null; // "fenced-out" | "unreachable" | "paused"
  // 全部止める: the board's answer to a heartbeat or a progress write says stop.
  const heedStop = (answer) => {
    if (answer?.stop === true && stopReason === null) {
      stopReason = "paused";
      abort.abort();
    }
  };
  const reportToBoard = async (tool, args) => {
    try {
      heedStop(await client.call(tool, args));
    } catch (error) {
      if (isFenceRefusal(error)) stopReason ??= "fenced-out";
      else if (error instanceof BoardUnreachable) stopReason ??= "unreachable";
      else throw error;
      abort.abort();
    }
  };
  const heartbeat = () => reportToBoard("board_heartbeat_handoff", fence);
  const timer = timers.setInterval(() => { void heartbeat(); }, config.heartbeatMs);
  let lastStatus = null;
  const progress = async (text) => {
    let note = truncate(text);
    if (restricted) {
      // Status-only (#50): only the fixed words go out. Whatever else the
      // worker reported — free text, links, error details — becomes the
      // nearest state before any board call is made.
      const status = text === "工程：回答待ち" ? STATUS_ATTENTION
        : STATUS_WORDS.has(text) ? text : STATUS_WORKING;
      if (status === lastStatus) return;
      lastStatus = status;
      note = status;
    }
    await reportToBoard("board_progress_handoff", { ...fence, kind: "note", text: note });
  };

  let result;
  try {
    await progress(restricted ? STATUS_STARTED : `開始（picker、${config.writer}。任された仕事 ${chosen.requestId} を受けた）`);
    if (!abort.signal.aborted) {
      const job = { itemId: chosen.itemId, project: chosen.project, requestId: chosen.requestId, title: chosen.title };
      const takeover = await lookUpTakeover(client, job, listed);
      if (takeover !== null) job.takeover = takeover;
      result = await executor.run(job, { signal: abort.signal, progress });
    }
  } catch (error) {
    result = { outcome: "stopped", text: `executor failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    timers.clearInterval(timer);
  }

  if (stopReason === "paused") {
    // The owner stopped everything: this run is still the current one, so it
    // gives the work back to the pile itself (fenced), and the owner hands it
    // over again after resuming. If the board cannot be told, the lease
    // lapses into the unknown quarantine as with any other lost run.
    try {
      await client.call("board_release_handoff", fence);
      log(`run of ${chosen.itemId} stopped: the owner stopped everything; the work is back on the pile`);
    } catch (error) {
      if (!(error instanceof BoardRefusal) && !(error instanceof BoardUnreachable)) throw error;
      log(`run of ${chosen.itemId} stopped for 全部止める, but giving it back failed (${error instanceof BoardRefusal ? error.code : "unreachable"})`);
    }
    return { kind: "paused", itemId: chosen.itemId };
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
  const completion = { ...fence, outcome };
  if (restricted) {
    // Status-only (#50): the result's own text, link and commit stay on the
    // terminal; the board learns only the state it ended in.
    completion.text = outcome === "done" ? STATUS_DONE : STATUS_ATTENTION;
  } else {
    const found = runResult(result);
    completion.text = truncate(found.text) || undefined;
    if (found.ref !== null) completion.ref = found.ref;
    if (found.commit !== null) completion.commit = found.commit;
  }
  try {
    await client.call("board_complete_handoff", completion);
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
/** A file name that is safe in one folder: no path, no control or reserved characters. */
export function safeFileName(name, index) {
  // eslint-disable-next-line no-control-regex
  const clean = String(name ?? "").replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_").replace(/^[.\s]+/, "").slice(0, 80);
  return `${index + 1}-${clean || "file"}`;
}

/**
 * The turn's attachments as files the executor can read: each is fetched
 * from the board into dir (created here; the caller removes it). Returns
 * [{ name, mime, path, bytes }] and, for one that could not be fetched,
 * [{ name, error }] so the worker can say so instead of guessing.
 */
export async function fetchAttachments(client, attachments, dir) {
  const out = [];
  if (!Array.isArray(attachments) || attachments.length === 0) return out;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [index, a] of attachments.entries()) {
    const name = String(a?.name ?? "file");
    try {
      const got = await client.readAttachment(String(a?.id ?? ""));
      const path = join(dir, safeFileName(got.name || name, index));
      // "wx": a file or link already at this path is refused, never written through.
      writeFileSync(path, got.bytes, { flag: "wx", mode: 0o600 });
      out.push({ name: got.name || name, mime: got.mime, path, bytes: got.bytes.length });
    } catch (error) {
      out.push({ name, error: error instanceof BoardRefusal ? error.code : "could not be fetched" });
    }
  }
  return out;
}

/**
 * A private folder for one turn's attachments under base, or null when base
 * is not safe to use. base keeps a stable name (the worker wrappers allow
 * reading whichever folder the paths sit in), but it usually lives in a shared
 * /tmp: it must be a real folder owned by this user, not a link or a folder
 * someone else made first, and it is narrowed to 0700. Each turn then gets an
 * unpredictable 0700 subfolder from mkdtemp, so nothing can be planted in it.
 */
export function privateTurnDir(base, prefix) {
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const st = lstatSync(base);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
    chmodSync(base, 0o700);
    return mkdtempSync(join(base, `${prefix}-`));
  } catch {
    return null;
  }
}

export async function runChatPass({ client, executor, log = () => {}, attachDir = null, config = {} }) {
  let pending;
  try {
    pending = await client.call("board_chat_pending", {});
  } catch (error) {
    if (error instanceof BoardUnreachable || error instanceof BoardRefusal) return { kind: "nothing" };
    throw error;
  }
  const turn = Array.isArray(pending?.turns) ? pending.turns.find(t => !statusOnlyFor(t.project, config)) : undefined;
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
    transcriptTruncated: taken?.transcript_truncated === true,
    chatUrl: taken?.chat_url ?? null,
    resultRefs: Array.isArray(taken?.result_refs) ? taken.result_refs : [],
  };
  // The owner's files on this turn: fetched here (this picker holds the board key, the
  // worker does not) and handed over as paths. Removed when the run ends.
  const sent = Array.isArray(taken?.turn?.attachments) ? taken.turn.attachments : [];
  const wantFiles = Boolean(attachDir && sent.length && typeof client.readAttachment === "function");
  let turnDir = null;
  let result;
  try {
    if (wantFiles) {
      turnDir = privateTurnDir(attachDir, `${turn.item_id.replace(/[^A-Za-z0-9_-]/g, "_")}-${turn.seq}`);
      if (turnDir) {
        job.attachments = await fetchAttachments(client, sent, turnDir);
        log(`fetched ${job.attachments.filter((a) => a.path).length} of ${sent.length} attachment(s) for chat turn ${turn.seq}`);
      } else {
        job.attachments = sent.map((a) => ({ name: String(a?.name ?? "file"), error: "attachment folder is not safe" }));
        log(`attachment folder ${attachDir} is a link, not a folder, or not this user's; chat turn ${turn.seq} gets no files`);
      }
    }
    result = await executor.run(job, { progress: async () => {} });
  } catch (error) {
    result = { outcome: "stopped", text: `[失敗] executor failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (turnDir) rmSync(turnDir, { recursive: true, force: true });
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
