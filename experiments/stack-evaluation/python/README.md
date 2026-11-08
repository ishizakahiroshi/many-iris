# Python comparison candidate

Independent synthetic implementation of the parent `CONTRACT.md`. This directory
does not import the former prototype or another language candidate. It is a local
comparison candidate, not a released product or production authentication service.

## Run

From the comparison parent worktree, supply the root-owned input/helper/UI paths:

```powershell
python -B experiments/stack-evaluation/python/server.py --db <task-dir>/state.db --fixture experiments/stack-evaluation/fixtures/tasks-100.json --helper experiments/stack-evaluation/common/helper.py --python <absolute-python.exe> --ui experiments/stack-evaluation/common/index.html --port 0 --test-mode
```

The launcher must write exactly one JSON line with the `token` field to the
process's stdin. The process emits one ready JSON line (port, PID, language and
actual SQLite version) to stdout. Never place credentials in an URL or command
argument. The shared UI and fixture are provided by root; this candidate does not
create them. `--restored` persists an execution hold. Omit `--test-mode` to reject
fault, clock, backup, source-revision and delayed-result controls and slow/orphan
helper modes. The remaining clock is still synthetic: this is not production mode.

POST `/api` uses `op` as discriminator. A bearer header, exact loopback Host and
same-origin-or-absent Origin are required. There is no CORS, TLS, remote listening,
provider access, arbitrary command execution or dynamic file-serving route.

Targeted safety verification from this directory:

```powershell
python -B test_candidate.py --shared <comparison-parent>/experiments/stack-evaluation/common -v
```

The tests cover actual helper launch count, concurrent start, old/revoked/expired
grants, changed source, late results, durable uncertain intent, injected intent and
result failures, Windows parent/descendant cessation, backup integrity/restore hold,
normal-mode rejection and HTTP auth/Host/Origin/JSON/body-size rejection.

## Windows process ownership

`windows_job.py` calls CreateProcessW with CREATE_SUSPENDED, assigns the process to
a new Job before ResumeThread, and enables KILL_ON_JOB_CLOSE. Descendants inherit
the Job. Successful completion requires a bound completion event, parent exit 0,
and no active Job processes. Stop saves intent, terminates the owned Job and checks
ActiveProcesses reaches zero. An orphan or uncertain result cannot free the
active-task uniqueness guard. After restart there is no owned process handle:
old running/dispatching work becomes unknown and cannot be replayed. Stop cannot
certify that unknown work from a numeric PID alone. The POSIX fallback is diagnostic
only; its process-tree behavior is not this Windows acceptance result.

The Job controls the configured synthetic helper. It does not sandbox another
same-user process or make this SQLite/event history tamper-proof. Closing the
server closes its Job handles; no service or scheduled watcher is installed.

## Maintenance, distribution and recovery

Dependencies: Python standard library only; SQLite and OpenSSL are native runtime
components owned by the Python distribution and need their own updates. Actual
observed runtime here is Python 3.14.4 / SQLite 3.50.4. The previously identified
SQLite WAL repair gate is **unresolved** for this runtime. Passing synthetic tests
does not waive that gate or permit real records. No claim of vulnerability-free
dependencies is made.

This source invocation requires Python already installed. A private embedded
Python distribution could package a pinned runtime and native libraries, but that
packaging, license inventory, updater, signing and clean-machine installation have
not been built or tested here. Updating Python alone is not proof SQLite is fixed;
the executable's reported SQLite version must be checked again. HTTP/TLS exposure
and production authentication would require separately selected mature components.

The existing database path is resolved through final-file symlinks; hardlink aliases
are rejected. A lifetime Windows share-zero sidecar handle is acquired before
SQLite opens or changes epoch/schema. A second controller fails before mutation;
process death releases the OS lock without PID-file ownership guesses. The lock
is a cooperating-controller guard, not isolation from arbitrary same-user tools.

SQLite uses WAL, FULL synchronous, foreign keys and a 1000ms busy timeout. Schema
version is fixed at 1; unsupported versions are rejected. `snapshot` uses SQLite's
online backup API into a new sibling file, never a raw WAL copy. Restored DBs must
be launched with `--restored`; that execution hold persists across subsequent
starts and has no automatic release API. The old core must stop and external
outcomes must be reconciled before a future explicit recovery design can release
the hold. There is no claimed cross-version migration or automatic rollback.

Known limits: disk-full/busy controls are deterministic injected failures, not real
volume-exhaustion tests; no OS crash/power-loss test, signed update, smartphone,
real provider, production TLS/authentication, deployment or release was performed.
Job handles are retained until server close for the bounded comparison workload;
unbounded long-running history/resource retention is not production-qualified.

Follow-up review fixes: stopping an unknown external outcome may terminate any
owned helper but keeps unknown held; it cannot authorize replacement. Test result
injection requires actual parent success, an independently empty Job, and the bound
completion event. Restore hold is written in the same startup transaction as epoch
change and remains disabled on ordinary subsequent startup. These fixes have
dedicated regressions; they do not resolve the native SQLite version gate.
