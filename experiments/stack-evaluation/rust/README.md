# Rust comparison candidate

Synthetic localhost candidate implementing the root `../CONTRACT.md`; this is
neither the selected product implementation nor a release. Only generated fixtures
and the configured fixed harmless helper may be executed. No provider integration,
remote login, smartphone setup or notification delivery is implemented.

## Build and launch

The comparison is pinned to the existing Rust 1.98.1 x86_64 MSVC toolchain,
MSVC 14.44.35207 and Windows SDK 10.0.26100.0. `build.ps1` sets only its own
process environment. It never changes rustup defaults, OS settings or credentials.
Its local Cargo cache is ignored and seeded from previously downloaded public
crates; missing public crates were downloaded using ordinary crates.io access.

Run from this directory:

```powershell
pwsh -NoProfile -File ./build.ps1 -Mode test
pwsh -NoProfile -File ./build.ps1 -Mode build -Release
```

Both commands default to `--locked --offline`; use a separately authorized
`-Online` invocation when a public dependency is missing. The resulting executable
is `target/release/iris-stack-rust.exe`. After integration, root can point
`-CachePath` to this task's existing cache without modifying a global cache.

The root launcher starts this executable with an argument array:

```text
iris-stack-rust.exe --db <new-local-directory>/state.db --fixture <common-fixture.json> --helper <common/helper.py> --python <python.exe> --ui <common-ui.html> --port 0 --test-mode
```

Send exactly one JSON line containing a task-generated token on stdin. The token
is never printed or put into a URL, argv, database, event file or diagnostics.
Stdout emits one ready record with localhost port, PID, language and the actual
linked SQLite version. The measured binary reports SQLite 3.53.2. HTTP clients
send the token in the Authorization header; production authentication is unbuilt.

Targeted black-box checks (pass the shared helper path):

```powershell
python tests/test_candidate.py --helper <common/helper.py> -v
python tests/test_candidate.py --helper <common/helper.py> --metadata
python dependency_inventory.py
```

## Safety and persistence

SQLite WAL, synchronous FULL and foreign keys are configured; decisions use
BEGIN IMMEDIATE transactions under one application mutex. A Windows exclusive
sharing handle rejects a second owner before it changes epoch or state. Existing
DB final symlinks resolve to the same canonical sibling lock; multiple hardlinks
are rejected before SQLite opens. Mutations also fence the current durable epoch.
Restore hold and epoch increment commit in one startup transaction, and normal
restart preserves that hold. Runs bind
approval to task revision/hash, epoch, attempt and synthetic expiry. Transactions
invalidate queued grants after source changes and after restart. Unknown outcomes
block replacement and never replay automatically. A stop request for unknown
work terminates only a Job still owned by this controller, and preserves unknown
even when cessation is verified. Its transient `process_stop_confirmed` response
means this request verified the owned Job stopped; it never authorizes replacement
or reconciles the external result. After restart, no saved numeric PID is used to
signal a process. Storage fault controls are
explicit synthetic injection, not evidence of physical disk-full behavior.

The Windows supervisor is the explicit unsafe/native boundary. It creates a
kill-on-close Job, starts Python suspended using CreateProcessW, assigns the
process before its first instruction, then resumes its primary thread. No shell
or arbitrary user command is used. Descendants inherit the Job. Completion needs
a bound helper completion event, successful parent exit and no active Job members.
Parent-only exit with live descendants stays stop_unconfirmed.
The Job active count can briefly lag a signaled parent. That parent-only lag
keeps running until the count settles; a recorded descendant is classified live
only after checking its current Job membership and process wait state. No
completion is accepted while any Job member remains counted active. Stop commits its
intent, terminates the owned Job and checks that its active-process count is zero.
Failure to assign, query, terminate or confirm fails closed. OS handle ownership
is confined to process.rs with explicit safety comments. Synthetic parent/child,
orphan and forced server-exit checks passed; this is not an audit of arbitrary
provider launchers, breakaway permissions or all Windows host policies.

The online backup API reserves a new sibling filename, rejects traversal and
existing destinations, and uses SQLite's backup API. `--restored` sets a durable
execution hold; this prototype has no endpoint that clears it. Original core
termination and external-result reconciliation remain required design work.
Unsupported schema versions fail at startup; no schema migration exists.

## Maintenance and distribution boundary

Rust source is safe except for the documented Windows FFI wrapper. SQLite's C
amalgamation and its build compiler remain native dependencies; memory safety of
Rust code does not establish their safety. Axum/Hyper/Tokio own HTTP parsing and
concurrency; rusqlite/libsqlite3-sys own SQLite binding/build; windows-sys declares
Windows bindings; sha2 computes source digests. Cargo.lock fixes direct/transitive
versions and crate checksums. `dependency-inventory.json` verifies all 92 locked
registry package archives and captures their declared SPDX licenses, including
target-only crates. The inventory is not a legal or vulnerability audit.

One executable contains application code and bundled SQLite; Windows native APIs
and the MSVC runtime remain OS/runtime responsibilities. The fixed Python helper
is a comparison workload, not part of a promised production distribution. Adding
a production provider does not inherit permission to execute arbitrary commands.
The distributable product, installer, MSVC runtime policy, signing, trust roots,
update feed, rollback delivery and software bill of materials are not built.

For updates, rebuild from reviewed Cargo.lock and toolchain, verify a copy of
synthetic/retained state, and roll back the executable only when the schema is
compatible. Restoring older data must remain execution-held until uncertain
external outcomes are reconciled; executable rollback alone cannot solve this.
No automatic Cargo updates or unsigned downloads occur at runtime. Known-issue
review, signed update/rollback tests, real power-loss/disk-full tests, TLS/login,
multi-user isolation and production data handling remain root evaluation gates.

## Verification at this candidate checkpoint

Rust unit tests cover request idempotency, unique active work, stale/revoked/
expired grants, storage-before-dispatch failure, restart/restore behavior, strict
input/test-mode controls, backup path checks, second-owner rejection, source
revision invalidation, auth Host/Origin matching and Windows argv quoting.
Separate black-box tests execute the shared helper and descendant: completion,
result-storage unknown, verified tree stop, orphan hold, crash/restart unknown and
snapshot restore hold. Additional checks reject a concurrent controller and a
hardlink DB alias, reject an exactly bound injected result while its Job is alive,
preserve unknown after stop, and retain unknown after a real SQLite-triggered PID
persistence failure. Comparative timing and UI acceptance belong to root.
