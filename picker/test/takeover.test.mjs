// Unit tests for takeover.mjs (continuing a stopped session from its
// progress record). All records here are synthetic.
//
//   node test/takeover.test.mjs
import {
  continuationBranch, folderMatchesProject, matchRecord, parseRecord, recordExcerpt, takeoverInstructions, takeoverRef,
} from "../src/takeover.mjs";

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
}

const recordText = ({ folder = "X--src-demo", session = "aaaa1111-0000", started = "2026-11-19T06:37:40.961Z", body } = {}) => [
  `# ${folder}`,
  "",
  `- session: ${session}`,
  "- host: test-pc",
  `- started: ${started}`,
  "- 機械が transcript から抜き出した進み具合。transcript の写しではない。",
  "",
  "## 2026-11-19",
  "",
  ...(body ?? [
    "- 15:37 場所: X:\\src\\demo @ main",
    "- 15:38 依頼: 一覧の並び順を直して",
    "- 15:40 操作: 一覧の並びを決める関数を読む",
    "- 15:42 場所: X:\\src\\demo @ wt/list-order",
    "- 15:45 区切り: 並び順の関数を直した。試験はまだ。",
  ]),
  "",
].join("\n");

// --- which work is a takeover ------------------------------------------
check("a session item handed over itself is a takeover", takeoverRef({ itemId: "session/1933", title: "anything" }) === "session/1933");
check("a sub-session item is a takeover", takeoverRef({ itemId: "session/1854/2", title: "" }) === "session/1854/2");
check("a title naming a session is a takeover", takeoverRef({ itemId: "task1", title: "session/1933 の続き" }) === "session/1933");
check("ordinary work is not", takeoverRef({ itemId: "task1", title: "README を直す" }) === null);
check("a path that merely contains session/ is not", takeoverRef({ itemId: "t", title: "see docs/session/12 notes" }) === null);

// --- reading a record --------------------------------------------------
{
  const r = parseRecord(recordText());
  check("folder, session and start are read from the header",
    r.folder === "X--src-demo" && r.session === "aaaa1111-0000" && r.started === Date.parse("2026-11-19T06:37:40.961Z"), JSON.stringify(r));
  check("every line becomes an entry with its day", r.entries.length === 5 && r.entries.every((e) => e.day === "2026-11-19"));
  check("the last place wins", r.place?.cwd === "X:\\src\\demo" && r.place?.branch === "wt/list-order", JSON.stringify(r.place));
  const unknown = parseRecord(recordText({ started: "unknown" }));
  check("an unknown start stays unknown", unknown.started === null);
  const crlf = parseRecord(recordText().replace(/\n/g, "\r\n"));
  check("CRLF files read the same", crlf.entries.length === 5 && crlf.place?.branch === "wt/list-order");
}

// --- folder ↔ project --------------------------------------------------
check("the checkout folder matches its project", folderMatchesProject("X--src-demo", "demo"));
check("a linked worktree matches its project", folderMatchesProject("X--src-worktrees-demo-list-order", "demo"));
check("a worktree under one grouping folder matches its project", folderMatchesProject("F--worktrees-public-demo-list-order", "demo"));
check("a hyphenated project in a grouped worktree matches", folderMatchesProject("F--worktrees-public-many-demo-trial", "many-demo"));
check("a grouped worktree of another project does not", !folderMatchesProject("F--worktrees-public-other-trial", "demo"));
check("another project ending in the same word does not", !folderMatchesProject("X--src-demo-old", "demo"));
check("a different project does not", !folderMatchesProject("X--src-other", "demo"));

// --- matching the board item to one record ------------------------------
{
  const created = Date.parse("2026-11-19T06:37:35.656Z"); // the board item is made a few seconds before
  const mine = parseRecord(recordText());
  const earlier = parseRecord(recordText({ session: "bbbb2222", started: "2026-11-18T09:43:07.872Z" }));
  const otherProject = parseRecord(recordText({ folder: "X--src-other", session: "cccc3333" }));
  const one = matchRecord([earlier, mine, otherProject], { createdAt: created, project: "demo" });
  check("the record that started with the board item is chosen", one.record?.session === "aaaa1111-0000", JSON.stringify(one.error));

  const none = matchRecord([earlier, otherProject], { createdAt: created, project: "demo" });
  check("no record in the window is a stop, not a guess", none.error === "none" && none.record === undefined);

  const twin = parseRecord(recordText({ session: "dddd4444", started: "2026-11-19T06:37:50.000Z" }));
  const two = matchRecord([mine, twin], { createdAt: created, project: "demo" });
  check("two sessions in the window is a stop", two.error === "ambiguous" && two.sessions === 2, JSON.stringify(two));

  const noTime = matchRecord([mine], { createdAt: undefined, project: "demo" });
  check("a board item without a time matches nothing", noTime.error === "none");

  const nextMonth = parseRecord(recordText({ body: ["- 00:10 場所: X:\\src\\demo @ wt/list-order-2", "- 00:11 区切り: 続きの試験を足した"] }));
  const joined = matchRecord([mine, nextMonth], { createdAt: created, project: "demo" });
  check("files of one session (a month rollover) are joined in order",
    joined.record?.entries.length === 7 && joined.record?.entries.at(-1).text === "続きの試験を足した" && joined.record?.place?.branch === "wt/list-order-2",
    JSON.stringify(joined.record?.place));
}

// --- the branch to continue on ----------------------------------------
{
  const r = parseRecord(recordText());
  check("the session's own branch is continued", continuationBranch(r, "main") === "wt/list-order");
  check("the default branch means start from the default", continuationBranch({ place: { branch: "main" } }, "main") === null);
  check("no place means start from the default", continuationBranch({ place: null }, "main") === null);
  check("a branch name that could be an option is refused", continuationBranch({ place: { branch: "-x" } }, "main") === null);
  check("a branch name with .. is refused", continuationBranch({ place: { branch: "a..b" } }, "main") === null);
}

// --- what the worker's AI is given ---------------------------------------
{
  const r = parseRecord(recordText());
  const all = recordExcerpt(r);
  check("a short record is given whole", all.split("\n").length === 5 && all.endsWith("区切り: 並び順の関数を直した。試験はまだ。"));
  const cut = recordExcerpt(r, 80);
  check("a long record keeps the newest lines and says how many were dropped",
    cut.startsWith("(古い ") && cut.endsWith("試験はまだ。"), cut);
  const text = takeoverInstructions({ ref: "session/1933", record: r, branch: "wt/list-order" });
  check("the instructions name the session and the branch", text.includes("session/1933") && text.includes("wt/list-order"));
  check("the record sits between markers as data", /record start -----\n[\s\S]*依頼: 一覧の並び順を直して[\s\S]*\n----- record end/.test(text));
  const fromDefault = takeoverInstructions({ ref: "session/1933", record: r, branch: null });
  check("without a branch the AI is told the PC's changes are not there", fromDefault.includes("never pushed"));
}

console.log(`takeover.test: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
