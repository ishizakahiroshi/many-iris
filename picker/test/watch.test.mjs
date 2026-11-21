// Unit tests for the watch connection and the resident --watch loop.
// The WebSocket and the passes are fakes; the timing and wiring are real.
//
//   node test/watch.test.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchResident } from "../src/main.mjs";
import { watchBoard, watchUrl } from "../src/watch.mjs";

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A scripted socket: records construction, can be told to open / message / close.
class FakeSocket {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.sent = [];
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data) { this.sent.push(data); }
  close() { this.onclose?.(); }
  static instances = [];
}

async function main() {
  // --- watchUrl
  check("https becomes wss, path kept", watchUrl("https://iris.example.com/board/mcp").toString() === "wss://iris.example.com/board/mcp");
  check("http becomes ws", watchUrl("http://127.0.0.1:8787/board/mcp").toString() === "ws://127.0.0.1:8787/board/mcp");

  // --- watchBoard wiring
  FakeSocket.instances = [];
  const delays = [];
  let wakes = 0;
  const states = [];
  const watcher = watchBoard({
    url: new URL("wss://iris.example.com/board/mcp"),
    key: "writer-key",
    onWake: () => { wakes += 1; },
    onState: (s) => states.push(s),
    WebSocketImpl: FakeSocket,
    reconnectDelayMs: (attempt) => { delays.push(attempt); return 5; },
  });
  await wait(0);
  check("socket connects with the key in the header only",
    FakeSocket.instances.length === 1
    && FakeSocket.instances[0].url.toString() === "wss://iris.example.com/board/mcp"
    && FakeSocket.instances[0].options.headers.authorization === "Bearer writer-key"
    && !FakeSocket.instances[0].url.toString().includes("writer-key"));
  check("open reports up", states.includes("up"));

  FakeSocket.instances[0].onmessage({ data: JSON.stringify({ type: "wake", at: 1 }) });
  FakeSocket.instances[0].onmessage({ data: JSON.stringify({ type: "other" }) });
  FakeSocket.instances[0].onmessage({ data: "pong" });
  check("only wake messages wake", wakes === 1);

  // A drop schedules a reconnect; the new socket opens and reports up again.
  FakeSocket.instances[0].onclose();
  check("drop reports down", states[states.length - 1] === "down");
  await wait(20);
  check("a reconnect is attempted", FakeSocket.instances.length === 2, `instances=${FakeSocket.instances.length}`);
  check("backoff counts attempts", delays[0] === 1);
  await wait(0);
  check("reconnect reports up again", states[states.length - 1] === "up");

  // A close during a backoff still reconnects exactly once.
  FakeSocket.instances[1].onerror?.();
  await wait(20);
  check("error also reconnects", FakeSocket.instances.length >= 3, `instances=${FakeSocket.instances.length}`);

  watcher.close();
  const after = FakeSocket.instances.length;
  await wait(20);
  check("closed watcher stops reconnecting", FakeSocket.instances.length === after);

  // --- watchResident: wake and interval both run passes, serialized,
  //     and the stop file suppresses them.
  const temp = mkdtempSync(join(tmpdir(), "iris-picker-watch-"));
  try {
    const keyFile = join(temp, "key.txt");
    writeFileSync(keyFile, "k\n");
    const stateFile = join(temp, "state.json");
    const stopFile = join(temp, "STOP");
    const config = {
      boardUrl: "http://127.0.0.1:9/board/mcp",
      keyFile, writer: "muse",
      intervalMs: 40, stateFile, stopFiles: [stopFile],
    };
    const passes = [];
    let capturedWake = null;
    const passImpl = async () => {
      passes.push(passes.length === 0 ? "startup" : `run-${passes.length}`);
      return { kind: "nothing" };
    };
    const watcherImpl = ({ onWake }) => { capturedWake = onWake; return { close() {} }; };

    const resident = watchResident({ config, executor: null, passImpl, watcherImpl, log: () => {} });
    await resident; // returns after the startup pass; timers keep running
    check("startup pass runs", passes.length === 1);

    capturedWake();
    await wait(10);
    check("a wake runs a pass", passes.length === 2);

    // The interval fallback fires on its own.
    await wait(80);
    check("interval fallback runs passes", passes.length >= 3, `passes=${passes.length}`);

    // Coalescing and the stop file, with a long-interval resident so only
    // wakes can make passes (no interval ticks to confuse the count).
    const config2 = { ...config, intervalMs: 60000 };
    const passes2 = [];
    let capturedWake2 = null;
    let gate = null;
    const passImpl2 = async () => {
      passes2.push(passes2.length);
      if (gate) await gate;
      return { kind: "nothing" };
    };
    const watcherImpl2 = ({ onWake }) => { capturedWake2 = onWake; return { close() {} }; };
    await watchResident({ config: config2, executor: null, passImpl: passImpl2, watcherImpl: watcherImpl2, log: () => {} });
    check("second resident starts", passes2.length === 1);

    // Several wakes during one pass coalesce into exactly one queued pass.
    let release;
    gate = new Promise((r) => { release = r; });
    capturedWake2();
    await wait(5);
    capturedWake2();
    capturedWake2();
    release();
    await wait(20);
    check("wakes during a pass coalesce to one queued pass", passes2.length === 3, `passes=${passes2.length}`);

    // The stop file suppresses both wake and interval passes.
    writeFileSync(stopFile, "stop\n");
    capturedWake2();
    await wait(20);
    check("stop file suppresses wake passes", passes2.length === 3, `passes=${passes2.length}`);
    const before = passes.length;
    capturedWake();
    await wait(80);
    check("stop file suppresses interval passes too", passes.length === before, `before=${before} now=${passes.length}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
