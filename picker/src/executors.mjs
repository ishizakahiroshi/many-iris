// Executors: the replaceable boundary between "the picker took a
// piece of work" and "something does the work". An executor gets the
// job ({ itemId, project, requestId, title }) plus { signal, progress }
// and resolves { outcome: "done" | "stopped", text }.
//
// The title is the name of the work — data handed over on the board —
// never instructions to the picker itself. Executors that pass it on
// (the command executor) hand it over on stdin, like many-ai-cli's
// taker does, never as a command-line argument and never through a
// shell.
//
// No executor here talks to a real external AI service by itself:
// - RecordExecutor (the default) only records that the job would have
//   run. It exists so the picker can be tried and tested end to end —
//   board flow included — without anything doing real work.
// - CommandExecutor runs one operator-configured local command (for
//   example a `claude -p` wrapper script the operator wrote) and
//   reports its exit state. Configuring that command, and giving it
//   whatever credentials it needs through its own environment, is the
//   operator's step, outside this repository's code.

import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";

export class RecordExecutor {
  constructor() {
    this.jobs = [];
  }

  async run(job, { signal } = {}) {
    this.jobs.push(job);
    if (signal?.aborted) return { outcome: "stopped", text: "aborted before the recorded run started" };
    return {
      outcome: "done",
      text: `記録のみ: 「${job.title}」は実行系が未設定のため記録だけを行った（実作業はしていない）`,
    };
  }
}

// The tail of the output is kept: the last line is the answer, and a
// conversation answer may be 20,000 characters long.
const OUTPUT_MAX = 256 * 1024;

// fd 3 is for explicit milestones. Worker stdout/stderr may contain private data.
const phases = new Map([
  ["worker_started", "担当AI起動"], ["checking_submission", "提出前検査中"],
  ["investigating", "調査中"], ["implementing", "実装中"], ["testing", "テスト中"], ["awaiting_input", "回答待ち"],
]);
async function forwardPhases(pipe, progress, signal) {
  if (signal?.aborted) return;
  // Consume fd 3 immediately. Node drains child stdio on exit, even when
  // the board has not acknowledged the launch note yet.
  await pipeline(pipe, new PassThrough(), input => reportPhases(input, progress, signal));
}
async function reportPhases(input, progress, signal) {
  await progress("工程：作業コマンド起動");
  let last = "";
  let line = "";
  for await (const chunk of input) {
    for (const byte of chunk) {
      if (signal?.aborted) return;
      if (byte !== 10) {
        // Keep an oversized line invalid until its newline without buffering it all.
        if (line.length <= 32) line += String.fromCharCode(byte);
        continue;
      }
      const label = phases.get(line.replace(/\r$/, ""));
      line = "";
      if (label && label !== last) {
        await progress("工程：" + label);
        last = label;
      }
    }
  }
}

// Stops the command and what it started. On Windows a kill ends only the
// process itself and its SIGTERM handler never runs. A node worker's own
// children still end with it (node keeps them in a job that closes with it;
// seen 2026-11-23), but a worker that is not node would leave its `claude`
// working, so the whole tree is ended with taskkill.
export function stopTree(child, { platform = process.platform, run = spawn } = {}) {
  if (platform === "win32" && child.pid) {
    try {
      const killer = run("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on?.("error", () => child.kill("SIGTERM"));
      return;
    } catch {
      /* fall back to the plain kill */
    }
  }
  child.kill("SIGTERM");
}

export class CommandExecutor {
  /**
   * @param {{ command: string, args?: string[], cwd?: string, timeoutMs?: number }} opts
   * The command is a single executable path from the operator's
   * configuration; it is spawned directly (no shell), the job is
   * given to it as one JSON line on stdin, and its last stdout line
   * (truncated) becomes the reported result text.
   */
  constructor({ command, args = [], cwd, timeoutMs = 30 * 60 * 1000 }) {
    if (typeof command !== "string" || command.length === 0) throw new Error("command executor needs a command");
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
  }

  async run(job, { signal, progress } = {}) {
    if (signal?.aborted) return { outcome: "stopped", text: "run aborted before the command started" };
    return new Promise((resolve) => {
      const report = !job.turn && typeof progress === "function";
      let child;
      try {
        child = spawn(this.command, this.args, {
          cwd: this.cwd,
          stdio: report ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
          env: process.env,
          windowsHide: true,
        });
      } catch (error) {
        resolve({ outcome: "stopped", text: `command could not be started: ${error.message}` });
        return;
      }
      let output = "";
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => {
        stopTree(child);
        finish({ outcome: "stopped", text: "run aborted (the picker was fenced out or lost the board)" });
      };
      const timer = setTimeout(() => {
        stopTree(child);
        finish({ outcome: "stopped", text: `command did not finish within ${Math.round(this.timeoutMs / 1000)}s and was stopped` });
      }, this.timeoutMs);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      child.stdout.on("data", (chunk) => {
        output = (output + chunk.toString("utf8")).slice(-OUTPUT_MAX);
      });
      child.stderr.on("data", () => {});
      let reported = Promise.resolve();
      if (report) child.once("spawn", () => {
        reported = forwardPhases(child.stdio[3], progress, signal).catch(() => {
          if (settled) return;
          stopTree(child);
          finish({ outcome: "stopped", text: "工程を看板に報告できなかったため停止しました" });
        });
      });
      child.on("error", (error) => finish({ outcome: "stopped", text: `command failed to run: ${error.message}` }));
      child.on("close", async (code) => {
        await reported;
        const lastLine = output.trim().split("\n").filter((line) => line.trim().length > 0).at(-1) ?? "";
        if (code === 0) finish({ outcome: "done", text: lastLine || "command finished without output" });
        else finish({ outcome: "stopped", text: `command exited with code ${code}${lastLine ? `: ${lastLine}` : ""}` });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(`${JSON.stringify(job)}\n`);
    });
  }
}
