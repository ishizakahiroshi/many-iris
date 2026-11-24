import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Advance only these synthetic records' age in the stopped, temporary workerd database.
export function ageTestConfirmations(temp, requests) {
  for (const file of readdirSync(temp, { recursive: true }).filter(name => name.endsWith(".sqlite"))) {
    const db = new DatabaseSync(join(temp, file));
    try {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE name='confirmations'").get()) continue;
      const update = db.prepare("UPDATE confirmations SET updated_at=? WHERE request_id=?");
      const yesterday = Date.now() - 86_400_000 - 60_000;
      for (const request of requests) {
        if (update.run(yesterday, request).changes !== 1) throw new Error("Expected one synthetic confirmation");
      }
      return;
    } finally {
      db.close();
    }
  }
  throw new Error("Temporary confirmation database not found");
}

export async function checkConfirmations({ base, asOwner, call, code, check, source, other }) {
  const endpoint = base + "/api/confirmations";
  const ref = { request_id: randomBytes(16).toString("hex") };
  const prompt = { ...ref, project: "fixture", agent: "local assistant", task: "Review report", question: "Include the sample chart?" };
  const request = (key, args = prompt) => call(key, "iris_request_confirmation", args);
  const status = (key, args = ref) => call(key, "iris_confirmation_status", args);
  const close = (key, outcome, args = ref) => call(key, "iris_close_confirmation", { ...args, outcome });
  const list = async () => (await fetch(endpoint, { headers: asOwner() })).json();
  const approve = (id, headers = { ...asOwner(), origin: base }) => fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ id, op: "approve" }),
  });
  check("inbox requires Access", (await fetch(endpoint)).status === 401);
  check("writer cannot list inbox", (await fetch(endpoint, { headers: { authorization: "Bearer " + source } })).status === 401);
  check("trusted source can register", (await request(source)).state === "pending");
  check("identical registration idempotent", (await request(source)).state === "pending");
  check("same identity cannot change registered contents", code(await request(source, { ...prompt, task: "Changed" })) === "CONFIRMATION_CONFLICT");
  check("source cannot read another source's id", code(await status(other)) === "NOT_FOUND");
  check("source cannot complete another source's id", code(await close(other, "expired")) === "NOT_FOUND");
  check("source cannot apply pending", code(await close(source, "applied")) === "CONFIRMATION_CONFLICT");
  check("MCP cannot approve", code(await call(source, "iris_approve_confirmation", ref)) === -32602);
  check("restricted source can independently use the same request_id", (await request(other, { ...prompt, task: "Different source" })).state === "pending");
  let items = (await list()).items;
  const first = items.find(item => item.task === prompt.task);
  const second = items.find(item => item.task === "Different source");
  check("owner sees two items with distinct opaque ids and authenticated sources", first.id !== second.id &&
    first.source === "alpha" && second.source === "grokbot" && first.question === prompt.question &&
    first.local_only === false && new Date(first.created_at).toISOString() === first.created_at &&
    !("request_id" in first));
  check("question absent from generic item data", !JSON.stringify(await call(source, "board_list", {})).includes(prompt.question));
  check("source keys cannot approve", (await approve(first.id, { authorization: "Bearer " + source, origin: base })).status === 401);
  check("owner missing Origin refused", (await approve(first.id, asOwner())).status === 403);
  check("owner wrong Origin refused", (await approve(first.id, { ...asOwner(), origin: "https://other.example" })).status === 403);
  const replies = await Promise.all([approve(first.id), approve(first.id)]);
  check("parallel owner clicks are idempotent", replies.every(response => response.status === 200));
  check("only selected source sees approval", (await status(source)).state === "approved" && (await status(other)).state === "pending");
  check("approved appears waiting for receipt", (await list()).items.some(item => item.id === first.id && item.state === "approved"));
  check("confirmed close and retry exact", (await close(source, "applied")).state === "applied" && (await close(source, "applied")).state === "applied");
  check("closed item cannot reopen", (await request(source)).state === "applied" && (await approve(first.id)).status === 409);
  check("owner cannot approve cancelled or delivery-unknown item", (await close(other, "unknown")).state === "unknown" && (await approve(second.id)).status === 409);
  items = (await list()).items;
  check("applied leaves inbox and unknown remains visible", items.length === 1 && items[0].state === "unknown" && items[0].id === second.id);
  const native = { ...prompt, request_id: randomBytes(16).toString("hex"), local_only: true };
  check("local-only is immutable", (await request(source, native)).state === "pending" &&
    code(await request(source, { ...native, local_only: false })) === "CONFIRMATION_CONFLICT");
  const local = (await list()).items.find(item => item.local_only);
  check("local-only cannot be remotely approved", local.local_only === true && (await approve(local.id)).status === 403);
  await close(source, "expired", { request_id: native.request_id });
  for (const patch of [{ request_id: "not-an-id" }, { question: " ".repeat(6) }, { task: "x".repeat(161) }, { agent: "z".repeat(81) },
    { project: "p".repeat(81) }, { question: "q".repeat(1001) }, { local_only: "false" }, { source: "alpha" }]) {
    check("invalid confirmation field " + Object.keys(patch)[0], (await request(source, { ...prompt, ...patch })).ok !== true);
  }
}
