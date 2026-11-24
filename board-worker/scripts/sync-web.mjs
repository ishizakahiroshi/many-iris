// Copies the page's scripts and styles into ./public before `wrangler dev` and
// `wrangler deploy` (wrangler.toml [build]). Every page file's original is in
// ./web: the chat page moved out of the frozen iris/ first, and the board page
// was copied out on 2026-11-22 (#46: iris/ gets no new features; its own copy in
// iris/web stays as the Rust board's). ./public is generated and not committed.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public");
const sources = [
  [join(root, "web"), ["_headers", "app.css", "board.css", "board.js", "board-activity.js", "chat.css", "chat.js"]],
];

mkdirSync(out, { recursive: true });
for (const name of readdirSync(out)) rmSync(join(out, name), { recursive: true, force: true });
for (const [dir, names] of sources) {
  for (const name of names) copyFileSync(join(dir, name), join(out, name));
}
console.log(`sync-web: ${sources.reduce((n, [, names]) => n + names.length, 0)} files -> public/`);
