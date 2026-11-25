// The picker's entry point.
//
//   node src/main.mjs --once    one pass (for cron / a timer)
//   node src/main.mjs --loop    keep passing every PICKER_INTERVAL_SECS
//   node src/main.mjs --watch   stay resident: wake on a board notification,
//                               poll every PICKER_INTERVAL_SECS as fallback
//
// Configuration comes from the environment (see picker/README.md).
// The writer key is read from PICKER_KEY_FILE on every pass (a rotated
// key is picked up without a restart) and is never printed. Nothing
// here needs a PC to stay on: a VPS cron line running --once every
// few minutes is the intended deployment, and every pass is safe to
// repeat — the board, not this process, decides who took what.

import { closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardClient } from "./board-client.mjs";
import { CommandExecutor, RecordExecutor } from "./executors.mjs";
import { runChatPass, runPass } from "./picker.mjs";
import { watchBoard, watchUrl } from "./watch.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The commit a folder's git checkout is at, or null. */
export function headCommit(dir, run = execFileSync) {
  try {
    const out = String(run("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** "picker=<commit>[,name=<commit>...]" for board_accept_handoff, or null when nothing is known. */
export function versionsFromEnv(env, commitOf = headCommit) {
  const pairs = [];
  const own = commitOf(join(dirname(fileURLToPath(import.meta.url)), ".."));
  if (own !== null) pairs.push(`picker=${own}`);
  for (const entry of (env.PICKER_VERSION_DIRS ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
    const at = entry.indexOf("=");
    const name = at > 0 ? entry.slice(0, at) : "";
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name) || name === "picker" || pairs.some((p) => p.startsWith(`${name}=`))) {
      throw new Error("PICKER_VERSION_DIRS must be name=folder pairs (names ^[a-z][a-z0-9_-]{0,31}$, distinct, not picker)");
    }
    const commit = commitOf(entry.slice(at + 1));
    if (commit !== null) pairs.push(`${name}=${commit}`);
  }
  return pairs.length ? pairs.slice(0, 8).join(",") : null;
}

export function configFromEnv(env) {
  const required = (name) => {
    const value = env[name];
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required`);
    return value.trim();
  };
  const seconds = (name, fallback, min) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback * 1000;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a number of seconds >= ${min}`);
    return value * 1000;
  };
  const executorKind = env.PICKER_EXECUTOR ?? "record";
  if (executorKind !== "record" && executorKind !== "command") {
    throw new Error("PICKER_EXECUTOR must be 'record' or 'command'");
  }
  return {
    boardUrl: required("PICKER_BOARD_URL"),
    keyFile: required("PICKER_KEY_FILE"),
    writer: required("PICKER_WRITER"),
    projects: (env.PICKER_PROJECTS ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0),
    ownerOnly: env.PICKER_OWNER_ONLY !== "0",
    // Writers trusted like the owner page while the owner gate is on (the
    // owner's own local AI, say). Never this picker's own writer: it must
    // not be able to hand work to itself.
    trustedRequesters: (() => {
      const names = (env.PICKER_TRUSTED_REQUESTERS ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      const writer = (env.PICKER_WRITER ?? "").trim();
      if (names.includes(writer)) throw new Error("PICKER_TRUSTED_REQUESTERS must not include PICKER_WRITER itself");
      return names;
    })(),
    intervalMs: seconds("PICKER_INTERVAL_SECS", 300, 30),
    heartbeatMs: seconds("PICKER_HEARTBEAT_SECS", 300, 5),
    maxRunsPerDay: (() => {
      const value = Number(env.PICKER_MAX_RUNS_PER_DAY ?? "6");
      // 0 = no daily cap (owner decision 2026-11-21). STOP files still stop every pass.
      if (value === 0) return Infinity;
      if (!Number.isSafeInteger(value) || value < 1 || value > 50) throw new Error("PICKER_MAX_RUNS_PER_DAY must be 0 (no cap) or an integer from 1 to 50");
      return value;
    })(),
    // Status-only reporting (#50): a JSON array of
    // {"project","writer","board"} entries binds a project's reporting to one
    // taker and one board. A job in a registered project reports the fixed
    // status words only; one whose entry names another writer or board is
    // held, never run with ordinary reporting. Nothing in the work itself
    // can switch this on or off.
    statusOnly: (() => {
      const raw = env.PICKER_STATUS_ONLY;
      if (typeof raw !== "string" || raw.trim() === "") return [];
      const bad = () => { throw new Error('PICKER_STATUS_ONLY must be a JSON array of {"project","writer","board"} entries (project 1 to 80 characters, writer ^[a-z0-9-]{1,32}$, board the MCP endpoint https URL; at most 64, distinct projects)'); };
      let value;
      try { value = JSON.parse(raw); } catch { bad(); }
      if (!Array.isArray(value) || value.length > 64) bad();
      const entries = [];
      const seen = new Set();
      for (const e of value) {
        if (e === null || typeof e !== "object" || Array.isArray(e)) bad();
        if (Object.keys(e).some((k) => !["project", "writer", "board"].includes(k))) bad();
        if (typeof e.project !== "string" || e.project.length === 0 || e.project.length > 80) bad();
        if (typeof e.writer !== "string" || !/^[a-z0-9-]{1,32}$/.test(e.writer)) bad();
        if (typeof e.board !== "string") bad();
        const board = e.board.replace(/\/+$/, "");
        let endpoint;
        try { endpoint = new URL(board); } catch { bad(); }
        const loopback = endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname);
        if ((endpoint.protocol !== "https:" && !loopback) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) bad();
        if (seen.has(e.project)) bad();
        seen.add(e.project);
        entries.push({ project: e.project, writer: e.writer, board });
      }
      return entries;
    })(),
    stateFile: env.PICKER_STATE_FILE ?? "picker-state.json",
    // What this picker runs with, sent with every accept (#46 Q8), e.g.
    // "picker=<commit>,rules=<commit>": the picker's own commit, and the
    // folders named in PICKER_VERSION_DIRS ("rules=/path,skills=/path").
    versions: versionsFromEnv(env),
    // Where a conversation turn's attachments are put for the executor (one
    // folder per turn, removed after the run). The executor is told the paths.
    // /tmp is shared, so runChatPass uses this folder only if it is a real
    // folder of this user (narrowed to 0700) and gives each turn an
    // unpredictable private subfolder (privateTurnDir in picker.mjs).
    attachDir: env.PICKER_ATTACH_DIR || join(tmpdir(), `many-iris-attachments-${(env.PICKER_WRITER ?? "").replace(/[^A-Za-z0-9_-]/g, "_")}`),
    // Optional stop files (e.g. the run directory's STOP, and STOP-devin for
    // the devin picker): while any of them exists, a resident --watch picker
    // takes no passes. The shell wrappers check their own stop files for the
    // cron path; this is the same idea for the resident one.
    stopFiles: (env.PICKER_STOP_FILE ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0),
    executorKind,
    command: env.PICKER_COMMAND ?? "",
    commandArgs: env.PICKER_COMMAND_ARGS ? JSON.parse(env.PICKER_COMMAND_ARGS) : [],
    commandCwd: env.PICKER_COMMAND_CWD || undefined,
    commandTimeoutMs: seconds("PICKER_TIMEOUT_SECS", 1800, 10),
  };
}

/** Runs-per-day bookkeeping in a small JSON file (the taker's shape). */
export function fileState(path, now = () => Date.now()) {
  const read = () => {
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (data && typeof data.day === "string" && Number.isSafeInteger(data.runs)) return data;
    } catch {}
    return { day: "", runs: 0 };
  };
  const today = () => new Date(now()).toISOString().slice(0, 10);
  return {
    runsToday() {
      const data = read();
      return data.day === today() ? data.runs : 0;
    },
    recordRun() {
      const day = today();
      const data = read();
      const runs = data.day === day ? data.runs + 1 : 1;
      writeFileSync(path, `${JSON.stringify({ day, runs })}\n`);
    },
  };
}

/**
 * One picker per state file at a time. The board lets the same writer
 * accept the same request again with the same generation (so a lost
 * reply can be repeated), which means two passes started at the same
 * moment would both run the work. The lock file holds the pid of the
 * pass that owns it; a lock whose process is gone is taken over.
 * Returns a release function, or null when another pass is running.
 */
export function acquireLock(path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => { try { rmSync(path, { force: true }); } catch {} };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = NaN;
      try { owner = Number(readFileSync(path, "utf8").trim()); } catch {}
      if (Number.isSafeInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
          return null; // the owner is alive
        } catch (probe) {
          if (probe?.code === "EPERM") return null; // alive, another user
        }
      }
      try { rmSync(path, { force: true }); } catch {}
    }
  }
  return null;
}

export function makeExecutor(config) {
  if (config.executorKind === "command") {
    return new CommandExecutor({
      command: config.command,
      args: config.commandArgs,
      cwd: config.commandCwd,
      timeoutMs: config.commandTimeoutMs,
    });
  }
  return new RecordExecutor();
}

async function pass(config, executor) {
  // The key is read for every pass and handed straight to the client.
  const key = readFileSync(config.keyFile, "utf8").trim();
  const client = new BoardClient({ url: config.boardUrl, key });
  const log = (message) => console.log(`[picker ${new Date().toISOString()}] ${message}`);
  const release = acquireLock(`${config.stateFile}.lock`);
  if (release === null) {
    log("another pass of this picker is running; not looking");
    return { kind: "busy" };
  }
  try {
    // A conversation turn first: the owner is waiting on the other end.
    const chat = await runChatPass({ client, executor, log, attachDir: config.attachDir, config });
    if (chat.kind !== "nothing") return chat;
    return await runPass({ client, config, executor, state: fileState(config.stateFile), log });
  } finally {
    release();
  }
}

/**
 * The resident watch: a pass on start, on every board wake, and on every
 * interval tick (the poll stays the fallback when the socket is down or a
 * message is missed). Passes are serialized — a wake during a run queues
 * one more pass — and the per-pass lock still guards against a concurrent
 * cron --once or a second watcher for the same state file.
 */
export async function watchResident({ config, executor, passImpl = pass, watcherImpl = watchBoard, keyImpl = (path) => readFileSync(path, "utf8").trim(), log = (m) => console.log(`[picker ${new Date().toISOString()}] ${m}`) }) {
  const stopped = () => config.stopFiles.some((path) => existsSync(path));
  let running = false;
  let queued = false;
  const runPass = async (why) => {
    if (running) { queued = true; return; }
    running = true;
    try {
      do {
        queued = false;
        if (stopped()) log(`stop file present; skipping ${why} pass`);
        else {
          try {
            const outcome = await passImpl(config, executor);
            log(`${why} pass outcome: ${outcome.kind}`);
          } catch (error) {
            console.error(`[picker] ${why} pass failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } while (queued);
    } finally {
      running = false;
    }
  };

  const tick = () => { setTimeout(tick, config.intervalMs); void runPass("interval"); };
  setTimeout(tick, config.intervalMs);

  watcherImpl({
    url: watchUrl(config.boardUrl),
    key: keyImpl(config.keyFile),
    onWake: () => void runPass("wake"),
    onState: (state) => log(`watch ${state}`),
  });

  await runPass("startup");
}

async function main(argv) {
  const loop = argv.includes("--loop");
  const watch = argv.includes("--watch");
  if (!loop && !watch && !argv.includes("--once")) {
    console.error("usage: node src/main.mjs --once | --loop | --watch");
    return 2;
  }
  let config;
  try {
    config = configFromEnv(process.env);
  } catch (error) {
    console.error(`[picker] configuration error: ${error.message}`);
    return 2;
  }
  const executor = makeExecutor(config);
  if (!loop && !watch) {
    const outcome = await pass(config, executor);
    console.log(`[picker] pass outcome: ${outcome.kind}`);
    return 0;
  }
  if (watch) {
    if (typeof WebSocket === "undefined") {
      console.error("[picker] --watch needs Node.js 22 or later (the built-in WebSocket client)");
      return 2;
    }
    console.log(`[picker] watching as ${config.writer} (poll fallback every ${Math.round(config.intervalMs / 1000)}s)`);
    await watchResident({ config, executor });
    return 0;
  }
  console.log(`[picker] looping as ${config.writer} every ${Math.round(config.intervalMs / 1000)}s`);
  for (;;) {
    try {
      await pass(config, executor);
    } catch (error) {
      // A pass that throws (a board answer this client did not model)
      // must not kill the loop; the next pass starts from the board.
      console.error(`[picker] pass failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
  }
}

// Started as a script (not imported)? Compare real paths: the script path
// and import.meta.url differ in form on Windows and when the checkout is
// reached through a symlink or junction.
function startedAsScript() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedAsScript()) {
  process.exitCode = await main(process.argv.slice(2));
}

export { DAY_MS };
