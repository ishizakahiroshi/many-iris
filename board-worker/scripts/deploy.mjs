// Deploy the committed candidate only if it preserves the active release's history or equivalent changes.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const cf = (...args) => execFileSync(process.execPath, [wrangler, ...args], { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });

function activeRelease() {
  const list = JSON.parse(cf("deployments", "list", "--json"));
  const latest = list.sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
  const versions = latest?.versions;
  if (versions?.length !== 1 || versions[0].percentage !== 100) throw Error("Expected a single active Worker at 100%.");
  const hash = /\(([a-f0-9]{7,40})\)$/.exec(latest.annotations?.["workers/message"] ?? "")?.[1];
  if (!hash) throw Error("No Git SHA in the active deployment message. Verify the deployed source before continuing.");
  return { version: versions[0].version_id, commit: git("rev-parse", "--verify", hash + "^{commit}") };
}

const apply = process.argv[2] === "--apply";
const compare = process.argv[2] === "--candidate" && process.argv.length === 4;
if (!compare && process.argv.length !== (apply ? 3 : 2)) throw Error("Usage: deploy.mjs [--apply | --candidate <revision>]");
if (git("status", "--porcelain", "--untracked-files=normal")) throw Error("Deploy from a clean worktree.");
const candidate = git("rev-parse", "--verify", "--end-of-options", (compare ? process.argv[3] : "HEAD") + "^{commit}");
const live = activeRelease();
console.log("Active version", live.version, "Git", live.commit, "candidate", candidate);
console.log(git("diff", "--stat", live.commit, candidate) || "Identical trees");
if (git("merge-tree", "--write-tree", candidate, live.commit) !== git("rev-parse", candidate + "^{tree}")) {
  throw Error("The candidate omits active changes. Reconcile the two commits and rerun.");
}
if (apply) {
  if (activeRelease().version !== live.version || git("rev-parse", "HEAD") !== candidate || git("status", "--porcelain")) {
    throw Error("Deployment inputs changed during the check.");
  }
  execFileSync(process.execPath, [wrangler, "deploy", "--keep-vars", "--message", `Deploy board (${candidate})`], { cwd, stdio: "inherit" });
}
