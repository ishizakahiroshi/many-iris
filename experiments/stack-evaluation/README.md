# Many Iris stack comparison

Synthetic localhost experiment, isolated from the unborn product main branch.
Three independent candidates share CONTRACT.md, deterministic fixtures, a fixed
harmless workload, one UI and root's independent observer. This is not a release.

The next implementation candidate is recorded in the local comparison report,
not inferred from this directory's languages. No real AI adapter, real records,
phone access, production authentication, signed update or notification delivery
has been accepted. The Python workload is common test apparatus, not a promised
dependency of a future Go/Rust product distribution.

## Local preview

After the reviewed native executable has been preserved under `artifacts/`, run:

```powershell
python -B common/preview.py --candidate go --name demo --port 8875 --duration 600
```

Open the printed localhost URL. Enter the deliberately public synthetic token
`synthetic-local-preview-only`. It grants access only to synthetic fixtures and a
fixed harmless helper in this preview. Never use this launcher for real data.
No token goes into a URL. A preview stops after ten minutes, or when its printed
stop-file path is created. The launcher owns its processes by Job handle.

Choose a task, view its original, start, approve or reject, execute the synthetic
helper, and refresh or stop. On the same browser tab and fixed port, run IDs are
retained in session storage and checked against the task on reload/reselection.
Tokens are not stored. Server restart preserves DB state; old running work is held
as unknown and never replayed. A new browser/origin has no run-discovery index.

Preview state is under `output/<name>/`. Reusing the name and fixed port reopens
the same synthetic DB after the previous controller has stopped. Schema/version
and execution/restore holds are enforced by the server. No clearing hold endpoint
exists. Never point this preview at a real DB or a cloud-synchronized active DB.

## Independent checks

```powershell
python -B -m unittest discover -s common -p "test_*.py" -v
node common/test_ui.mjs
python -B common/generate_fixtures.py
python -B common/runner.py --command-json <local-argv-array.json> --output <new-output-directory> --mode safety
python -B common/runner.py --command-json <local-argv-array.json> --output <new-output-directory> --mode benchmark
```

Measurements run serially. Receipts include fixture, common workload, UI, observer
and executable hashes and reject changes during a run. Python sidecar sources are
additionally fixed by candidate commit and the local source-hash receipt. The
observer verifies normal cleanup through an owned Job; observer-crash cleanup
has not been qualified. Physical disk exhaustion, power loss, arbitrary provider
process trees, and same-user tampering are outside these synthetic checks.

The 10,000-task input is a generated 2MB artifact and is intentionally untracked;
run generate_fixtures.py before benchmark use. Its exact bytes and SHA256 are
fixed in fixtures/manifest.json. The reviewed generator and small inputs stay in
Git. This keeps the ordinary source scanner's size limit visible rather than
claiming that a skipped large artifact was scanned.
