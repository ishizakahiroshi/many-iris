// Copies the page's scripts and styles into ./public before `wrangler dev` and
// `wrangler deploy` (wrangler.toml [build]). The Rust board's files in
// iris/web stay the only original; ./public is generated and not committed.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public");
const sources = [
  [join(root, "..", "iris", "web"), ["app.css", "board.css", "board.js"]],
  [join(root, "web"), ["_headers"]],
];

mkdirSync(out, { recursive: true });
for (const name of readdirSync(out)) rmSync(join(out, name), { recursive: true, force: true });
for (const [dir, names] of sources) {
  for (const name of names) copyFileSync(join(dir, name), join(out, name));
}
console.log(`sync-web: ${sources.reduce((n, [, names]) => n + names.length, 0)} files -> public/`);
