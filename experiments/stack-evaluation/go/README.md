# Go comparison candidate

Synthetic local Windows experiment implementing the root comparison contract.
This is not a distribution, a production authentication implementation, or an
authorization boundary against another process running as the same OS user.
No provider, real record, remote listener, TLS or smartphone connection exists.

Build/test from this directory in PowerShell, with Go 1.26.8 already available:

```powershell
$env:GOMODCACHE = Join-Path (Get-Location) '.cache/mod'
$env:GOCACHE = Join-Path (Get-Location) '.cache/build'
go mod download
go test -count=1 ./...
go vet ./...
go build -o bin/iris-stack-go.exe .
```

For actual shared-helper integration tests, set IRIS_COMPARE_HELPER to root's
`common/helper.py` and IRIS_COMPARE_PYTHON to an existing Python executable
before `go test -count=1 -v ./...`. Without those two explicit paths the helper
test is skipped. The application needs Python only for this common synthetic
comparison helper; this is not a decision to require Python in a Go product.

Launch from a controlling process with redirected stdin/stdout:

```text
bin/iris-stack-go.exe --db <new-local-directory>/state.db --fixture <fixture.json> --helper <common/helper.py> --python <python.exe> --ui <shared-ui.html> --port 0 --test-mode
```

Write one JSON line containing `token` (16..512 characters) to stdin. Obtain a
random token in the controller; do not put it into command arguments, a URL or
logs. Read one stdout ready line with language, pid, port and SQLite runtime.
Use a Bearer header for POST /api with a JSON object containing `op` and the
contract fields. Exact loopback Host and optional exact Origin are required.
The served shared UI never receives the token automatically. No CORS is enabled.
Do not expose the port outside the local machine.

The candidate enables WAL, synchronous FULL, foreign keys and 1000ms busy timeout.
Before opening SQLite, the controller resolves the DB and parent symlink/junction
path, obtains a share=0 Windows handle on the adjacent `.controller.lock` file,
and retains that handle for its lifetime. A second live owner fails before touching
schema or epoch. A stale file without a live handle does not block startup.
Existing DBs with multiple hardlinks are rejected because distinct hardlink names
would otherwise have distinct sidecars. All requests also compare the current
durable epoch against the controller epoch inside the transaction. This is not
protection against arbitrary same-user filesystem or SQLite tampering.
All application operations are serialized under one mutex and a one-connection
SQL pool. A unique partial index also prevents concurrent nonterminal runs for a
task. Epoch increments before each startup; old grants are invalidated and running
intents become unknown. Request IDs cannot be reused with another task. Approval
binds source hash, revision, epoch, attempt and expiry; dispatch rechecks inside
the durable-intent transaction before launching the fixed helper by argv.

Helper creation is suspended; the controller assigns it to a native Windows Job
with KILL_ON_JOB_CLOSE before resuming its first instruction. Ordinary descendants
inherit that Job. Completion requires real helper exit, valid completion evidence,
matching source version, and Job ActiveProcesses zero. A delayed test result cannot
complete a still-running helper. Stop writes stop_unconfirmed before terminating
the owned Job and verifying its active count reaches zero. The native Job remains
owned independently of DB PID persistence and event-file writes. If saving a
launched PID fails, the Job is terminated, the outcome stays unknown, and no
replacement is allowed. Tests reproduce that failure with an aborting SQL trigger.
On restart a PID is not sufficient process identity: stopping an unknown old run
remains unconfirmed instead of killing a possibly reused PID. Unknown and
stop_unconfirmed block replacement. Same-user tampering with the synthetic event
file is outside this experiment's guarantees; production supervision needs
authenticated result ownership. Job handles are kept until controller close in
this bounded experiment; unbounded history/resource retention is not qualified.

Snapshot uses the SQLite online backup API via modernc NewBackup/Step/Finish,
into a fresh reserved sibling file. Existing targets and traversal are rejected.
Start a copied backup with `--restored`: execution is held persistently with no
release endpoint. Only inspection/backup is available. Reconciliation with old
processes and external outcomes is deliberately not automated.

Intent-full/busy are injected dispatch failures (no process launch), and
result-full causes unknown after launch. They do not reproduce actual disk
exhaustion. Actual power loss, OS crash, cross-version migrations, arbitrary
descendant escape, signed update and production TLS/authentication are untested.
Test clock, revision changes, injected results and fault controls require
`--test-mode`; normal mode still uses the synthetic fixture clock and is not a
production runtime. No shutdown API is added; the controller owns server lifetime.

## Dependency and maintenance record

Direct dependencies are pinned `modernc.org/sqlite v1.50.1` and
`golang.org/x/sys v0.44.0` (both BSD-3-Clause), with
`go.mod`/`go.sum` locking the complete module graph. Runtime query on the tested
Windows executable reports SQLite 3.53.1. The translated SQLite implementation
and modernc libc/memory packages contain unsafe/native-semantic boundaries;
pure Go and no CGO do not imply memory-safety or data-correctness guarantees.
Own Windows process management uses x/sys/windows and explicit unsafe buffers
for Job information. OS APIs and struct layout still require verification.

The x/sys pin was advanced from v0.42.0 after the lockfile scan identified
GO-2026-5024 / CVE-2026-39824. Source review found no NewNTUnicodeString call in
this candidate or its production dependency sources; that does not replace an
update or a compiler call-graph proof. The exact v0.44.0 acquisition and targeted
verification are recorded in `IMPORT-XSYS-UPDATE.json`. A subsequent OSV 2.4.0
lockfile query reported no known vulnerability in its 11 scanned packages; this
does not certify the Go toolchain, all bundled code, or future advisory coverage.
Measurements of the earlier executable remain evidence for that earlier build.

Runtime indirect packages: modernc.org/libc v1.72.3, mathutil v1.7.1, memory
v1.11.0 (BSD-3-Clause); github.com/dustin/go-humanize v1.0.1 (MIT), google/uuid
v1.6.0 (BSD-3-Clause), mattn/go-isatty v0.0.20 (MIT), ncruces/go-strftime v1.0.0
(MIT), remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec (BSD-3-Clause),
golang.org/x/sys v0.44.0 (BSD-3-Clause). See each pinned module's LICENSE in the
task cache; dependency test/build tooling may add modules to go.sum. License
notices must be assembled before any release. No release package is made here.

The maintainer must separately update Go's HTTP/TLS/security runtime, the SQLite
translation and its dependency graph, and OS APIs, then rebuild/retest. An embedded
DB is not updated by a separately installed sqlite3. A single candidate executable
contains Go runtime/HTTP/DB but needs the comparison helper/UI/fixture; this has
not validated a one-file product install. Reproducible production builds, support
policy enforcement, vulnerability scanning, signing, updater atomicity and rollback
across schema changes are not proven. Rolling back a binary alone does not roll
back external outcomes or schema; preserve DB copies, reopen in restore hold,
reconcile, and only then explicitly authorize execution.
