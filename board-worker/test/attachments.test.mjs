// The attachment helpers (no wrangler). Node loads the .ts files directly.
//
//   node test/attachments.test.mjs
import {
  ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, ATTACHMENT_PER_MESSAGE, ATTACHMENT_TOTAL_BYTES, ATTACHMENT_TTL_MS,
  attachmentKey, cleanName, countChars, headOf, markerText, parseText, sliceChars, validAttachmentId,
} from "../src/attachments.ts";

let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
}
const bytes = (s) => new TextEncoder().encode(s);

check("limits: 1 MB a file, 5 MiB, 20 files, 5 a message, 30 days",
  ATTACHMENT_MAX_BYTES === 1048576 && ATTACHMENT_TOTAL_BYTES === 5242880 && ATTACHMENT_MAX_COUNT === 20 && ATTACHMENT_PER_MESSAGE === 5 && ATTACHMENT_TTL_MS === 30 * 86400000);
check("ids are 32 hex characters", validAttachmentId("a".repeat(32)) && !validAttachmentId("A".repeat(32)) && !validAttachmentId("a".repeat(31)) && !validAttachmentId(5));
check("the R2 key is under att/", attachmentKey("a".repeat(32)) === `att/${"a".repeat(32)}`);

check("a name loses its path and control characters", cleanName("C:\\x\\y/メモ\u0007.txt") === "メモ.txt");
check("an empty name becomes 貼り付け.txt", cleanName("") === "貼り付け.txt" && cleanName("/") === "貼り付け.txt");
check("a long name is cut to 80 characters", [...cleanName("あ".repeat(200) + ".txt")].length === 80);

const p = parseText(bytes("一行目\n\n二行目\r\n三行目\n四行目\n"));
check("parseText counts characters and bytes", p !== null && p.chars === countChars("一行目\n\n二行目\r\n三行目\n四行目\n") && p.bytes === bytes("一行目\n\n二行目\r\n三行目\n四行目\n").length);
check("the head is the first 3 non-empty lines", p.head === "一行目\n二行目\n三行目", JSON.stringify(p.head));
check("the head is at most 300 characters", [...headOf("a".repeat(1000))].length === 300);
check("characters are code points (an emoji is 1)", countChars("a😀b") === 3 && parseText(bytes("a😀b")).chars === 3);
check("invalid UTF-8 is not text", parseText(new Uint8Array([0xff, 0xfe, 0x41])) === null);
check("a NUL is not text", parseText(bytes("a\u0000b")) === null);

const s1 = sliceChars("a😀bcd", 1, 2);
check("a slice by characters", s1.text === "😀b" && s1.next === 3 && s1.total === 5);
const s2 = sliceChars("abc", 1, 100);
check("the last slice has no next", s2.text === "bc" && s2.next === null);
check("past the end is empty", sliceChars("abc", 10, 5).text === "" && sliceChars("abc", 10, 5).next === null);

const m = markerText({ id: "a".repeat(32), name: "貼り付け.txt", bytes: 9000, chars: 3000, head: "一行目\n二行目" });
check("the marker has name, sizes, id, head and the tool name", m.includes("貼り付け.txt") && m.includes("3000 字") && m.includes("9000 バイト") && m.includes("a".repeat(32)) && m.includes("board_chat_attachment") && m.includes("> 一行目") && m.includes("> 二行目"));
check("the marker is short", m.length < 400, String(m.length));

console.log(`passed ${passed}, failed ${failures.length}`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
