// The root README lists the board's MCP tools by name and says how many there are.
// When a tool is added or removed in src/mcp.ts, this fails until the README is updated
// (the list went stale once: a 19th tool was added while the README still said 18).
//
//   node test/readme.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mcp = readFileSync(join(here, "..", "src", "mcp.ts"), "utf8");
const readme = readFileSync(join(here, "..", "..", "README.md"), "utf8");

const tools = [...mcp.matchAll(/^ {2}tool\(\s*\n\s*"((?:board|iris)_[a-z_]+)"/gm)].map((m) => m[1]);
const failures = [];
if (tools.length === 0) failures.push("no tools found in src/mcp.ts (did the declaration format change?)");
for (const name of tools) if (!readme.includes(`\`${name}\``)) failures.push(`README does not name ${name}`);
const said = readme.match(/の (\d+) 個です/);
if (!said) failures.push("README does not say how many tools there are (\"の N 個です\")");
else if (Number(said[1]) !== tools.length) failures.push(`README says ${said[1]} tools, src/mcp.ts has ${tools.length}`);

console.log(`readme.test: ${tools.length} tools, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exitCode = failures.length === 0 ? 0 : 1;
