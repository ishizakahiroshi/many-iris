// The status-only registration parser (src/status-only.ts) with no board
// and no wrangler, the same way test/route.test.mjs loads route.ts.
//
//   node test/status-only.test.mjs
import { parseStatusOnly, statusOnlyActors, STATUS_ONLY_COMPLETION, STATUS_ONLY_PROGRESS } from "../src/status-only.ts";

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
}

const doc = (entries) => JSON.stringify({ schema_version: 1, status_only: entries });

// --- the good shape -----------------------------------------------------
const parsed = parseStatusOnly(doc([{ project: "quiet", actor: "muse" }, { project: "quiet", actor: "grokbot" }, { project: "other", actor: "muse" }]));
check("a valid registration parses", parsed !== null && parsed.length === 3);
const actors = statusOnlyActors(parsed ?? []);
check("projects map to their registered takers",
  actors.get("quiet")?.size === 2 && actors.get("quiet")?.has("muse") && actors.get("other")?.has("muse") && !actors.has("open"));
check("an empty list is allowed", parseStatusOnly(doc([]))?.length === 0);

// --- anything unexpected makes the whole list unusable ------------------
for (const [name, raw] of [
  ["missing", undefined],
  ["not JSON", "{broken"],
  ["an array", "[]"],
  ["a wrong schema version", JSON.stringify({ schema_version: 2, status_only: [] })],
  ["an extra top-level key", JSON.stringify({ schema_version: 1, status_only: [], x: 1 })],
  ["a missing field", doc([{ project: "quiet" }])],
  ["an extra field", doc([{ project: "quiet", actor: "muse", board: "b" }])],
  ["an empty project", doc([{ project: "", actor: "muse" }])],
  ["a bad actor name", doc([{ project: "quiet", actor: "No_Good" }])],
  ["a non-string actor", doc([{ project: "quiet", actor: 3 }])],
  ["a duplicate pair", doc([{ project: "quiet", actor: "muse" }, { project: "quiet", actor: "muse" }])],
]) check(`malformed registration (${name}) is unusable`, parseStatusOnly(raw) === null);

// --- the status words the tests and the picker rely on -------------------
check("the status words are a small closed set",
  STATUS_ONLY_PROGRESS.length === 3 && STATUS_ONLY_COMPLETION.length === 2
    && [...STATUS_ONLY_PROGRESS, ...STATUS_ONLY_COMPLETION].every((s) => /^状態：(着手|作業中|要確認|完了)$/.test(s)),
  JSON.stringify({ progress: STATUS_ONLY_PROGRESS, completion: STATUS_ONLY_COMPLETION }));

console.log(`status-only.test: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
