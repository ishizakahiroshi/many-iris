// The picker's entry point.
//
//   node src/main.mjs --once   one pass (for cron / a timer)
//   node src/main.mjs --loop   keep passing every PICKER_INTERVAL_SECS
//
// Configuration comes from the environment (see picker/README.md).
// The writer key is read from PICKER_KEY_FILE on every pass (a rotated
// key is picked up without a restart) and is never printed. Nothing
// here needs a PC to stay on: a VPS cron line running --once every
// few minutes is the intended deployment, and every pass is safe to
// repeat — the board, not this process, decides who took what.

import { readFileSync, writeFileSync } from "node:fs";
import { BoardClient } from "./board-client.mjs";
import { CommandExecutor, RecordExecutor } from "./executors.mjs";
import { runPass } from "./picker.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

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
    intervalMs: seconds("PICKER_INTERVAL_SECS", 300, 30),
    heartbeatMs: seconds("PICKER_HEARTBEAT_SECS", 300, 5),
    maxRunsPerDay: (() => {
      const value = Number(env.PICKER_MAX_RUNS_PER_DAY ?? "6");
      if (!Number.isSafeInteger(value) || value < 1 || value > 50) throw new Error("PICKER_MAX_RUNS_PER_DAY must be an integer from 1 to 50");
      return value;
    })(),
    stateFile: env.PICKER_STATE_FILE ?? "picker-state.json",
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
  return runPass({ client, config, executor, state: fileState(config.stateFile), log });
}

async function main(argv) {
  const loop = argv.includes("--loop");
  if (!loop && !argv.includes("--once")) {
    console.error("usage: node src/main.mjs --once | --loop");
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
  if (!loop) {
    const outcome = await pass(config, executor);
    console.log(`[picker] pass outcome: ${outcome.kind}`);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}

export { DAY_MS };
