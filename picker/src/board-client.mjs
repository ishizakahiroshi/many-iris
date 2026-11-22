// A small client for the Many Iris board's MCP endpoint (/board/mcp).
//
// The board speaks plain JSON-RPC over HTTP POST (no sessions, no
// streaming): one `tools/call` per request, the writer key as a Bearer
// token, and the tool's own result object in `result.structuredContent`.
// A tool refusal comes back as `{ ok: false, error: { code, detail } }`
// inside that result, not as an HTTP error, so refusals and transport
// failures are kept apart here on purpose:
//
// - BoardRefusal: the board answered and said no (STALE_GENERATION,
//   HANDOFF_CONFLICT, FORBIDDEN, ...). The picker must never retry its
//   way around one of these.
// - BoardUnreachable: no usable answer at all (network down, timeout,
//   non-JSON reply). Nothing is known about the board's state; the
//   picker stops safely instead of guessing.
//
// The key is only ever placed in the Authorization header. It is never
// logged, returned or embedded in an error message.

export class BoardRefusal extends Error {
  constructor(code, detail) {
    super(`board refused: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "BoardRefusal";
    this.code = code;
    this.detail = detail ?? null;
  }
}

export class BoardUnreachable extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "BoardUnreachable";
  }
}

let nextId = 0;

export class BoardClient {
  /**
   * @param {{ url: string, key: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
   * `key` is the writer key for this picker's actor; the board takes the
   * writer's name from the key, never from the request body.
   */
  constructor({ url, key, fetchImpl = fetch, timeoutMs = 30_000 }) {
    if (typeof url !== "string" || !url.startsWith("https://") && !url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) {
      throw new Error("board url must be an https URL (http is allowed only for a local test board)");
    }
    if (typeof key !== "string" || key.length === 0) throw new Error("a writer key is required");
    this.url = url;
    this.key = key;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /** Call one board tool and return its result object (`ok: true` data). */
  async call(tool, args = {}) {
    const result = await this.rpc(tool, args);
    const data = result.structuredContent ?? parseTextContent(result);
    if (data === null || typeof data !== "object") {
      throw new BoardUnreachable(`board call ${tool} returned no structured result`);
    }
    if (data.ok === false) {
      throw new BoardRefusal(data.error?.code ?? "UNKNOWN", data.error?.detail ?? null);
    }
    return data;
  }

  /**
   * One attachment of a conversation, whole: { name, mime, bytes: Buffer }.
   * A text comes in parts (board_chat_attachment pages it by characters);
   * an image comes as MCP image content.
   */
  async readAttachment(id) {
    const first = await this.rpc("board_chat_attachment", { attachment_id: id });
    const head = first.structuredContent ?? parseTextContent(first);
    if (head === null || typeof head !== "object") throw new BoardUnreachable("board_chat_attachment returned no description");
    if (head.ok === false) throw new BoardRefusal(head.error?.code ?? "UNKNOWN", head.error?.detail ?? null);
    const image = Array.isArray(first.content) ? first.content.find((c) => c?.type === "image") : undefined;
    if (image) {
      if (typeof image.data !== "string" || typeof image.mimeType !== "string") throw new BoardUnreachable("board_chat_attachment returned a broken image");
      return { name: String(head.name ?? "image"), mime: image.mimeType, bytes: Buffer.from(image.data, "base64") };
    }
    let text = String(head.text ?? "");
    let next = head.next_offset;
    // At most 1 MB of text: 20,000 characters a call, so a bounded number of calls.
    for (let calls = 0; Number.isSafeInteger(next) && calls < 200; calls++) {
      const part = await this.call("board_chat_attachment", { attachment_id: id, offset: next });
      text += String(part.text ?? "");
      next = part.next_offset;
    }
    if (Number.isSafeInteger(next)) throw new BoardUnreachable("board_chat_attachment did not reach the end of the text");
    return { name: String(head.name ?? "text.txt"), mime: "text/plain", bytes: Buffer.from(text, "utf8") };
  }

  /** The tool call itself: the JSON-RPC `result` (protocol failures throw BoardUnreachable). */
  async rpc(tool, args = {}) {
    let response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
          authorization: `Bearer ${this.key}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name: tool, arguments: args } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new BoardUnreachable(`board call ${tool} did not reach the board`, { cause });
    }
    let body;
    try {
      body = await response.json();
    } catch (cause) {
      throw new BoardUnreachable(`board call ${tool} returned a non-JSON reply (HTTP ${response.status})`, { cause });
    }
    if (body === null || typeof body !== "object" || body.error || !body.result) {
      const message = body?.error?.message ?? `HTTP ${response.status}`;
      throw new BoardUnreachable(`board call ${tool} failed at the protocol level: ${message}`);
    }
    return body.result;
  }

  /** All items of one project (or of every project), with no events. */
  async listItems(project) {
    // since_seq far in the future asks for the items alone, as in
    // many-ai-cli's board_sync (NO_EVENTS).
    const args = { since_seq: Number.MAX_SAFE_INTEGER };
    if (project) args.project = project;
    const data = await this.call("board_list", args);
    return Array.isArray(data.items) ? data.items : [];
  }
}

function parseTextContent(result) {
  const text = result?.content?.find((c) => c?.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
