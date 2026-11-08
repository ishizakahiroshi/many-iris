# Stack comparison contract v1

This is a synthetic Windows comparison, not the product API or a production
security claim. All candidates implement this contract without importing another
candidate. Root owns this file, common inputs, helper, UI and measurements.

## Launch and transport

Launch with `--db PATH --fixture PATH --helper PATH --python PATH --ui PATH
--port 0 --test-mode` (optional `--restored`). Bind only 127.0.0.1. Read one
JSON line `{ "token": "..." }` from stdin before listening. Do not log it.
Emit one stdout JSON line containing `port`, `pid`, `sqlite_version`, and
`language`. Diagnostics go to stderr and contain no request bodies or credentials.
No normal-mode fault controls. No TLS, remote access or real provider calls.

GET / serves root's shared UI file; GET /health returns `{ "ok":true }`.
POST /api requires `Authorization: Bearer TOKEN`, exact Host
`127.0.0.1:PORT`, and either no Origin or exact `http://127.0.0.1:PORT`.
Other methods/routes are rejected. Limit bodies to 65536 bytes; malformed JSON
and unsupported fields/operations fail closed. No CORS. JSON response envelope:
`{"ok":true,"data":...}` or `{"ok":false,"error":"CODE"}`. Domain errors
may use HTTP 400/409/403; runner checks envelope, not one arbitrary HTTP code.
All mutations are serialized through SQLite transactions, WAL, synchronous FULL,
foreign_keys ON, busy timeout 1000ms. Report actual SQLite version at runtime.

## Shared input and clock

Fixture JSON has `version:1`, `now:2000000000`, and `tasks:[{id,title,source,
source_hash,revision:1}]`. SHA256 is over UTF-8 source bytes. IDs are ASCII.
Load fixture only for a new DB. Durable data survives normal restart; no reseeding.
Epoch is incremented durably on every process startup. On restart, running work
becomes unknown, queued approvals are invalidated, no automatic dispatch occurs.
All caller-supplied IDs are <=80 ASCII `[A-Za-z0-9_-]` characters. Times are
integer seconds. Test clock starts at fixture now; `advance` increments it.
Production wall clock is outside this experiment.

## Operations (all via POST /api)

* `list {offset:0,limit:50}` -> `{tasks:[{id,title,revision}],total:N}`.
  Limit 1..100, offset >=0, deterministic ascending task ID ordering.
* `detail {task_id}` -> original fixture task including source/hash/revision.
* `start {task_id,request_id}` -> `{run_id,state,epoch,attempt:1}`.
  run_id equals request_id. Public run includes task_id for UI binding validation.
  Initial state waiting. One nonterminal run per task;
  unknown/stop_unconfirmed count as nonterminal. Duplicate request with identical
  semantic fields returns the same run (current state); different task ->
  REQUEST_CONFLICT. A different request on an active task -> ACTIVE_RUN.
* `approve {run_id,revision,source_hash,expires_at}` -> run; requires waiting,
  exact task revision/hash, expiry strictly greater than now. Persist grant with
  run/attempt/epoch/revision/hash/expiry. Any mismatch -> STALE_APPROVAL.
* `reject {run_id}` -> run state rejected; only waiting/approved/queued.
* `revoke {run_id}` -> run state waiting; only approved/queued; removes grant.
* `enqueue {run_id}` -> queued; requires approved and current valid grant.
* `dispatch {run_id,mode:"success"|"slow"|"orphan"}` -> running.
  Requires queued; validate grant again in same transaction as durable intent.
  Then launch fixed shared helper ONLY (argv list, no shell, no arbitrary command).
  No helper if transaction/permission validation fails. Child path must be the
  configured helper, event path is DB sibling `<run_id>.events.jsonl`.
  Helper arguments: `--events PATH --mode MODE --run-id ID --epoch N --attempt 1`.
  Only test mode permits slow/orphan. Actual lifecycle is polled in `status`.
* `status {run_id}` -> run including state, epoch, attempt, pid (if started),
  and `events_path` (synthetic experiment path). A clean helper exit alone does
  not mean success: require completion event matching run/epoch/attempt, and
  reject late completions after stop/revoke/unknown. If helper has exited but a
  recorded descendant is alive, state must be stop_unconfirmed or unknown.
* `result {run_id,epoch,attempt,revision,source_hash}`: TEST ONLY delayed result
  injection. Wrong binding -> STALE_RESULT, no state change. Must not promote a
  terminal/unknown run. Real completion uses the same binding checks.
* `stop {run_id}`: persist stop intent before termination. waiting/approved/queued
  -> stopped. Running: terminate parent AND descendants, verify gone; stopped only
  after verification, else stop_unconfirmed/unknown. No replacement can start
  while cessation is unconfirmed. stop acceptance and completion measured apart.
  Unknown with a retained owned Job must still accept a stop attempt while keeping
  the outcome unknown, even after verified cessation. No owned handle after
  restart means do not signal the saved PID. Cessation never reconciles outcome.
* `snapshot {path}`: test-only SQLite online backup into a new, nonexistent file
  under DB parent; reject traversal and existing destination. Never raw WAL copy.
* `advance {seconds}`: test-only, 0..86400. Persist new synthetic time.
* `revise {task_id,source}`: test-only; increment revision and recompute hash.
  Must invalidate existing queued/granted actions before any dispatch.
* `fault {kind:"none"|"intent_full"|"result_full"|"busy"}`: test-only one
  durable fault control. intent_full/busy make dispatch return STORAGE without
  helper launch. result_full after launch yields unknown, never blind retry.
  These are injected transaction failures, NOT actual OS disk exhaustion tests.

Unknown IDs -> NOT_FOUND, invalid input -> INVALID, illegal transition -> STATE,
missing/expired/changed grant -> STALE_APPROVAL, restored -> RESTORE_HOLD.
`--restored` always opens with execution disabled; reject all execution mutations
with RESTORE_HOLD. No automatic restore-release endpoint in v1. Inspect allowed.
Candidate may add internal columns, never relax these guards.

## Durable minimum schema semantics

metadata(schema_version,epoch,now,execution_enabled,fault); tasks(id,title,source,
source_hash,revision); runs(id,task_id,request_id unique,state,epoch,attempt,
revision,source_hash,expires_at,pid,events_path,mode); requests(request_id,task_id).
An active-task uniqueness constraint or transactional equivalent prevents races.
Persist intent before process launch; any uncertain gap after intent becomes
unknown on restart. Never replay dispatch. SQLite is authoritative, not UI state.

## Measurement protocol frozen before candidates

Before SQLite open, acquire exclusive lifetime OS ownership of canonical DB;
reject hardlinked DB aliases, resolve existing final-file symlinks. A rejected
second owner must not update epoch. Mutation transactions fence durable epoch.
These are controller cooperation guards, not same-user isolation.

Inputs: 100, 1000, 10000 synthetic tasks; seed 0; common helper success waits
200ms and slow descendant waits 5000ms plus process/event overhead. Per language
and size: separate initial fixture-import sample, then 7 cold launches of the
same persisted DB. Seed 100/1000/10000 rejected-run history via the same API before
warm measurements (history seeding is separately timed). Then 2 discarded request warmups and 30 measured list/detail
requests. Lifecycle: 7 successful isolated runs; sample start/approve/enqueue/
dispatch receipt and time to terminal separately. Include list response during
slow helper, restart persistence, backup/restore hold. Execute languages serially
in Python, Go, Rust order, repeat in reverse order for drift if available.
Record raw samples, median, p95 nearest rank, min/max, failures, process RSS and
artifact bytes with their measurement limits. No invented universal passing ms.
Safety cases are mandatory gates, cannot be offset by speed.

Actual DB-full, OS crash consistency, production authentication/TLS, signed update,
cross-version migration, real provider, smartphone and release remain unverified
unless separate evidence is collected. Contract success is not product acceptance.
