// Issues a key for the board: the key goes to a new file (never over an
// existing one), its SHA-256 into the key list. The key is never printed.
//
//   node scripts/new-key.mjs --list <keys.json> --actor <name> --key-out <file>
//
// Then upload the list (hashes only) as the Worker secret:
//   writers: Get-Content <keys.json> -Raw | wrangler secret put BOARD_WRITERS
//   readers: Get-Content <keys.json> -Raw | wrangler secret put BOARD_READERS
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function fail(message) {
  console.error(`new-key: ${message}`);
  process.exit(1);
}

const list = arg("--list");
const actor = arg("--actor");
const keyOut = arg("--key-out");
if (!list || !actor || !keyOut) fail("usage: --list <keys.json> --actor <name> --key-out <file>");
if (!/^[a-z0-9-]{1,32}$/.test(actor)) fail("actor must match ^[a-z0-9-]{1,32}$");

let keys = { schema_version: 1, writers: [] };
if (existsSync(list)) {
  try {
    keys = JSON.parse(readFileSync(list, "utf8"));
  } catch {
    fail("the key list is not valid JSON");
  }
  if (keys.schema_version !== 1 || !Array.isArray(keys.writers)) fail("the key list must have schema_version 1 and a writers list");
}
if (keys.writers.some((w) => w.actor === actor)) fail("that name already exists; use another name or edit the list");
if (keys.writers.length >= 64) fail("too many keys");

const key = randomBytes(32).toString("hex");
try {
  writeFileSync(keyOut, key, { flag: "wx", mode: 0o600 });
} catch (e) {
  fail(e.code === "EEXIST" ? "the key file already exists; it is not overwritten" : "cannot create the key file");
}
const hash = createHash("sha256").update(key).digest("hex");
keys.writers.push({ actor, token_sha256: hash, enabled: true });
const temp = `${list}.${hash.slice(0, 8)}.tmp`;
try {
  writeFileSync(temp, JSON.stringify(keys, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temp, list);
} catch {
  rmSync(temp, { force: true });
  rmSync(keyOut, { force: true });
  fail("cannot save the key list");
}
console.log(`new-key: added "${actor}". The key is in ${keyOut}; the list (hashes only) is ${list}.`);
