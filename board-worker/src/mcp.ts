// MCP over plain HTTP POST (JSON responses, no sessions, no streaming).
// Accepts the usual `initialize` handshake used by today's clients and the
// per-request `_meta` form the Rust board speaks; the tools are the same.
import { HANDOFF_TARGETS, KINDS, STATES, WRITER_EVENT_KINDS } from "./rules";

/** Newest first. */
export const PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "many-iris-board", version: "0.1.0" };

type Json = Record<string, unknown>;
export type ToolRunner = (tool: string, args: Json) => Promise<Json>;

function tool(name: string, description: string, properties: Json, required: string[]): Json {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
const text = (description: string) => ({ type: "string", description });
const clearable = (description: string) => ({ type: ["string", "null"], description });

export const TOOLS: Json[] = [
  tool(
    "board_upsert_item",
    "Create an item (project, kind, title and state are required) or update the given fields of an existing one. The writer is taken from the key, not from the request.",
    {
      item_id: text("Stable id, ^[A-Za-z0-9._:/-]{1,128}$"),
      project: text("Project name, 1 to 80 characters"),
      kind: { type: "string", enum: KINDS },
      title: text("1 to 200 characters"),
      state: { type: "string", enum: STATES },
      source_ref: clearable("Repository-relative path or https URL; null clears"),
      parent_id: clearable("Id of an existing item in the same project; null clears"),
      waiting_reason: clearable("Required while state is waiting"),
      planned_start: clearable("YYYY-MM-DD; null clears"),
      planned_end: clearable("YYYY-MM-DD, not before planned_start; null clears"),
      expected_revision: { type: "integer", description: "Refuses the write when the item is at another revision (0 = must not exist)" },
    },
    ["item_id"],
  ),
  tool(
    "board_add_event",
    "Append an event to an item. The writer is taken from the key.",
    {
      item_id: text("An existing item"),
      kind: { type: "string", enum: WRITER_EVENT_KINDS },
      text: text("1 to 2000 characters"),
      ref: text("Optional https URL"),
    },
    ["item_id", "kind", "text"],
  ),
  tool(
    "board_list",
    "Read the items (each with its latest event) and the events after since_seq, oldest first.",
    {
      project: text("Only this project"),
      since_seq: { type: "integer", description: "Only events after this sequence number" },
    },
    [],
  ),
  tool(
    "board_request_handoff",
    "Mark work on the pile (kind task, state planned) as handed over — the writer-side form of the page's \"hand\", so delegating work does not need the owner to open the board. Returns the item with its new handoff.request_id; whoever takes the work sends that id to board_accept_handoff. With `to`, only that writer can take it (owner and hold: nobody, until the owner routes it); without `to`, the board chooses.",
    {
      item_id: text("The item to hand over"),
      day: text("Optional calendar day YYYYMMDD for the request id (board day or the day before/after it)"),
      to: { type: "string", enum: [...HANDOFF_TARGETS], description: "Optional destination. Leave it out to let the board choose" },
    },
    ["item_id"],
  ),
  tool(
    "board_accept_handoff",
    "Take a piece of work the board's owner asked to have done (an item whose handoff.state is \"requested\" in board_list). Send the item's handoff.request_id. When handoff.to is set, only the writer of that name can take it. Only the first writer gets it; the item then becomes in progress under that writer.",
    {
      item_id: text("The item that was handed over"),
      request_id: text("handoff.request_id of that item"),
    },
    ["item_id", "request_id"],
  ),
];

const validId = (v: unknown) => typeof v === "string" || (typeof v === "number" && Number.isSafeInteger(v));

export function errorResponse(id: unknown, code: number, message: string): Json {
  const response: Json = { jsonrpc: "2.0", error: { code, message } };
  if (validId(id)) response.id = id;
  return response;
}

function toolResponse(id: unknown, data: Json): Json {
  const isError = data.ok === false;
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError } };
}

function argumentsMatchSchema(definition: Json, args: Json): boolean {
  const schema = definition.inputSchema as { properties: Record<string, { type?: unknown }>; required: string[] };
  if (schema.required.some((f) => !Object.prototype.hasOwnProperty.call(args, f))) return false;
  return Object.entries(args).every(([k, v]) => {
    const prop = Object.prototype.hasOwnProperty.call(schema.properties, k) ? schema.properties[k] : undefined;
    if (prop === undefined) return false;
    if (prop.type === "string") return typeof v === "string" && v.length > 0;
    if (prop.type === "integer") return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    return true;
  });
}

/** Handles one JSON-RPC message. Returns `null` for a notification (the HTTP
 * layer answers 202 with no body), otherwise the HTTP status and body. */
export async function handle(request: unknown, run: ToolRunner): Promise<{ status: number; body: Json } | null> {
  if (request === null || typeof request !== "object" || Array.isArray(request))
    return { status: 400, body: errorResponse(null, -32600, "Invalid JSON-RPC request") };
  const r = request as Json;
  if (r.jsonrpc === "2.0" && !("id" in r) && typeof r.method === "string" && r.method.startsWith("notifications/")) return null;
  if (r.jsonrpc !== "2.0" || !validId(r.id) || typeof r.method !== "string" || "result" in r || "error" in r)
    return { status: 400, body: errorResponse(r.id, -32600, "Invalid JSON-RPC request") };
  const params = r.params === undefined ? {} : r.params;
  if (params === null || typeof params !== "object" || Array.isArray(params))
    return { status: 400, body: errorResponse(r.id, -32602, "Object params required") };
  const p = params as Json;
  const meta = p._meta as Json | undefined;
  const metaVersion = meta && typeof meta === "object" ? meta["io.modelcontextprotocol/protocolVersion"] : undefined;
  if (metaVersion !== undefined && !PROTOCOL_VERSIONS.includes(metaVersion as string)) {
    const body = errorResponse(r.id, -32022, "Unsupported protocol version");
    (body.error as Json).data = { supported: PROTOCOL_VERSIONS };
    return { status: 400, body };
  }
  const ok = (result: Json) => ({ status: 200, body: { jsonrpc: "2.0", id: r.id, result } });
  switch (r.method) {
    case "initialize": {
      const asked = p.protocolVersion;
      const version = typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1];
      return ok({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Many Iris board. Write progress with board_upsert_item and board_add_event; read with board_list. Your name on the board comes from your key.",
      });
    }
    case "server/discover":
      return ok({ resultType: "complete", supportedVersions: PROTOCOL_VERSIONS, capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } });
    case "ping":
      return ok({});
    case "tools/list":
      if ("cursor" in p) return { status: 200, body: errorResponse(r.id, -32602, "Pagination cursor is not supported") };
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = p.name;
      const definition = TOOLS.find((t) => t.name === name);
      if (typeof name !== "string" || definition === undefined)
        return { status: 200, body: errorResponse(r.id, -32602, "Unknown or invalid tool") };
      const args = p.arguments === undefined ? {} : p.arguments;
      if (args === null || typeof args !== "object" || Array.isArray(args))
        return { status: 200, body: errorResponse(r.id, -32602, "Tool arguments must be an object") };
      if (!argumentsMatchSchema(definition, args as Json))
        return { status: 200, body: errorResponse(r.id, -32602, "Invalid tool argument schema") };
      return { status: 200, body: toolResponse(r.id, await run(name, args as Json)) };
    }
    default:
      return { status: 404, body: errorResponse(r.id, -32601, "Method not found") };
  }
}
