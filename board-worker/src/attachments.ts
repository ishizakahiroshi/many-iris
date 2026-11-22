// Text attachments of a conversation (design: docs/local/design_chat-attachments_2026-11-22.md).
// Plain functions without imports, so they run under node in tests.
//
// A long paste or a dropped .txt/.md/.log becomes an attachment: the body is
// kept in R2, the board keeps only the name, the sizes and the first lines.
// The worker AI is given a marker per attachment (never the body) and reads
// the text with the board_chat_attachment tool, in parts.

/** One file: 1 MB (bytes). */
export const ATTACHMENT_MAX_BYTES = 1024 * 1024;
/** All attachments of one conversation together: 5 MiB. */
export const ATTACHMENT_TOTAL_BYTES = 5 * 1024 * 1024;
/** At most this many attachments in one conversation. */
export const ATTACHMENT_MAX_COUNT = 20;
/** Uploaded but not yet sent (the owner can drop them again). */
export const ATTACHMENT_MAX_UNSENT = 10;
/** At most this many attachments on one message. */
export const ATTACHMENT_PER_MESSAGE = 5;
/** Kept this long (the R2 lifecycle rule deletes the objects; reads are refused after it too). */
export const ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** The first lines kept for the marker. */
export const HEAD_LINES = 3;
export const HEAD_CHARS = 300;
/** The most characters one board_chat_attachment call returns. */
export const READ_MAX_CHARS = 20000;

export const validAttachmentId = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{32}$/.test(s);
export const attachmentKey = (id: string) => `att/${id}`;

/** A file name for display: no path, no control characters, at most 80 characters. */
export function cleanName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const name = [...base.replace(/[\u0000-\u001f\u007f]/g, "").trim()].slice(0, 80).join("");
  return name === "" ? "貼り付け.txt" : name;
}

export const TEXT_FILE = /\.(txt|md|log)$/i;

export type Parsed = { text: string; bytes: number; chars: number; head: string };

/** The body as text: UTF-8, no NUL. Returns null when it is not text. */
export function parseText(bytes: Uint8Array): Parsed | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (text.includes("\u0000")) return null;
  const chars = countChars(text);
  return { text, bytes: bytes.length, chars, head: headOf(text) };
}

export function countChars(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** The first HEAD_LINES non-empty lines, at most HEAD_CHARS characters. */
export function headOf(text: string): string {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim() !== "").slice(0, HEAD_LINES);
  return [...lines.join("\n")].slice(0, HEAD_CHARS).join("");
}

/** A slice by characters (code points), as the reading tool counts them. */
export function sliceChars(text: string, offset: number, limit: number): { text: string; next: number | null; total: number } {
  const all = Array.from(text);
  const part = all.slice(offset, offset + limit);
  const end = offset + part.length;
  return { text: part.join(""), next: end < all.length ? end : null, total: all.length };
}

export type Marker = { id: string; name: string; bytes: number; chars: number; head: string };

/** What the worker sees in place of the body. */
export function markerText(a: Marker): string {
  const lines = a.head === "" ? "" : "\n" + a.head.split("\n").map((l) => `> ${l}`).join("\n");
  return `[添付 ${a.name}（${a.chars} 字・${a.bytes} バイト）id=${a.id}。中身は board_chat_attachment で取る。先頭:${lines}]`;
}
