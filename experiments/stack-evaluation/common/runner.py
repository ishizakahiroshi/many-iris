"""Independent HTTP observer and serial comparison driver (synthetic only)."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import secrets
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from owned_job import OwnedJob

ROOT = Path(__file__).resolve().parent.parent
PYTHON = sys.executable


def alive(pid):
    if not pid:
        return False
    if os.name == "nt":
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000, False, int(pid))
        if not handle:
            # ERROR_INVALID_PARAMETER means PID does not exist; access denied is unknown.
            return False if ctypes.get_last_error() == 87 else None
        code = ctypes.c_ulong()
        try:
            if not kernel.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code)):
                return None
            return code.value == 259
        finally:
            kernel.CloseHandle(ctypes.c_void_p(handle))
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


class Candidate:
    def __init__(self, command, directory, size=100, restored=False, db=None, test_mode=True):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.db = Path(db) if db else self.directory / "state.sqlite"
        self.command, self.size = command, size
        self.token = secrets.token_hex(24)
        args = [*command, "--db", str(self.db), "--fixture", str(ROOT / "fixtures" / f"tasks-{size}.json"),
                "--helper", str(ROOT / "common" / "helper.py"), "--python", PYTHON,
                "--ui", str(ROOT / "common" / "index.html"), "--port", "0"]
        if test_mode:
            args.append("--test-mode")
        if restored:
            args.append("--restored")
        self.stderr = (self.directory / "stderr.log").open("a", encoding="utf-8")
        started = time.perf_counter_ns()
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=self.stderr, text=True, encoding="utf-8")
        self.job = None
        try:
            if os.name != "nt":
                raise RuntimeError("this observer's owned cleanup currently requires Windows")
            self.job = OwnedJob(self.proc)
        except BaseException:
            self.proc.kill()  # owned process handle, never a PID from a file
            self.proc.wait(timeout=5)
            self.stderr.close()
            raise
        self.proc.stdin.write(json.dumps({"token": self.token}) + "\n")
        self.proc.stdin.flush()
        lines = queue.Queue()
        threading.Thread(target=lambda: lines.put(self.proc.stdout.readline()), daemon=True).start()
        try:
            line = lines.get(timeout=30)
            self.ready = json.loads(line)
            self.port = int(self.ready["port"])
            self.base = f"http://127.0.0.1:{self.port}"
            with urllib.request.urlopen(self.base + "/health", timeout=5) as response:
                assert json.loads(response.read())["ok"]
            self.start_ms = (time.perf_counter_ns() - started) / 1e6
        except BaseException:
            self.close()
            raise

    def request(self, payload, *, token=True, origin=None, host=None, raw=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + self.token
        if origin is not None:
            headers["Origin"] = origin
        if host is not None:
            headers["Host"] = host
        request = urllib.request.Request(self.base + "/api", data=raw if raw is not None else json.dumps(payload).encode(), headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            data = response.read()
            try:
                return json.loads(data)
            except json.JSONDecodeError:
                return {"ok": False, "error": "NON_JSON", "http_status": response.status}

    def call(self, op, **fields):
        response = self.request(dict(op=op, **fields))
        if not response.get("ok"):
            raise AssertionError(f"{op}: {response}")
        return response.get("data", {})

    def denied(self, op, **fields):
        result = self.request(dict(op=op, **fields))
        assert result.get("ok") is False, f"accepted forbidden {op}: {result}"
        return result

    def start(self, ident="run-1", task="task-00000"):
        return self.call("start", request_id=ident, task_id=task)

    def grant(self, ident="run-1", task="task-00000", expires=2000000100):
        data = self.call("detail", task_id=task)
        return self.call("approve", run_id=ident, revision=data["revision"],
                         source_hash=data["source_hash"], expires_at=expires)

    def prepared(self, ident="run-1", task="task-00000"):
        self.start(ident, task)
        self.grant(ident, task)
        self.call("enqueue", run_id=ident)

    def wait(self, ident="run-1", timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = self.call("status", run_id=ident)
            if status["state"] not in ("running", "queued"):
                return status
            time.sleep(.02)
        raise AssertionError("terminal state timeout")

    def events(self):
        result = []
        for path in self.directory.glob("*.events.jsonl"):
            for line in path.read_text(encoding="utf-8").splitlines():
                try:
                    result.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # an in-flight final line is not a completed event
        return result

    def close(self):
        if getattr(self, "job", None):
            self.job.close()
            self.job = None
        if hasattr(self, "proc"):
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
            for stream in (self.proc.stdin, self.proc.stdout):
                if stream:
                    stream.close()
        # Event-file PIDs never authorize process termination (PID reuse).
        if hasattr(self, "stderr"):
            self.stderr.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def safety(command, output):
    results = []

    def case(name, action):
        directory = output / name
        before = time.perf_counter_ns()
        try:
            with Candidate(command, directory) as candidate:
                detail = action(candidate)
            results.append(dict(name=name, passed=True, detail=detail,
                                ms=(time.perf_counter_ns() - before) / 1e6))
        except Exception as exc:
            results.append(dict(name=name, passed=False, error=str(exc),
                                ms=(time.perf_counter_ns() - before) / 1e6))
        print(json.dumps(results[-1]), flush=True)

    def guards(c):
        for kwargs in ({"token": False}, {"origin": "https://invalid.example"}, {"host": "invalid.example"}, {"raw": b"{"}):
            assert c.request({"op": "list", "offset": 0, "limit": 1}, **kwargs).get("ok") is False
        c.denied("list", limit=101)
        c.denied("list", limit=1, offset=-1)
        c.denied("start", task_id="task-00000", request_id="../bad")
        c.denied("list", offset=0, limit=1, unexpected=True)
        c.denied("nonexistent")
        try:
            assert c.request({}, raw=b"x" * 65537).get("ok") is False
        except (ConnectionResetError, ConnectionAbortedError):
            # HTTP stacks may abort an oversized transport after rejecting it.
            # A fresh valid request must still work; a dead server is not a pass.
            assert c.call("list", offset=0, limit=1)["total"] == 100
        return c.ready

    def idempotency(c):
        first = c.start()
        same = c.start()
        assert first["run_id"] == same["run_id"]
        c.denied("start", task_id="task-00001", request_id="run-1")
        c.denied("start", task_id="task-00000", request_id="another")
        c.denied("dispatch", run_id="run-1", mode="success")
        assert not c.events()

    def concurrent(c):
        def request(i):
            return c.request(dict(op="start", task_id="task-00000", request_id=f"race-{i}"))
        with ThreadPoolExecutor(max_workers=8) as pool:
            answers = list(pool.map(request, range(8)))
        assert sum(a.get("ok") is True for a in answers) == 1
        return dict(accepted=1, rejected=7)

    def revoke(c):
        c.prepared()
        c.call("revoke", run_id="run-1")
        c.denied("dispatch", run_id="run-1", mode="success")
        assert not c.events()

    def expired(c):
        c.prepared()
        c.call("advance", seconds=101)
        c.denied("dispatch", run_id="run-1", mode="success")
        assert not c.events()

    def changed(c):
        c.prepared()
        c.call("revise", task_id="task-00000", source="Changed synthetic source")
        c.denied("dispatch", run_id="run-1", mode="success")
        assert not c.events()

    def old_approval(c):
        c.start()
        task = c.call("detail", task_id="task-00000")
        c.denied("approve", run_id="run-1", revision=0, source_hash=task["source_hash"], expires_at=2000000100)
        c.denied("approve", run_id="run-1", revision=1, source_hash="0" * 64, expires_at=2000000100)
        c.denied("approve", run_id="run-1", revision=1,
                 source_hash=c.call("detail", task_id="task-00000")["source_hash"], expires_at=2000000000)
        c.denied("enqueue", run_id="run-1")
        assert not c.events()

    def storage(kind):
        def run(c):
            c.prepared()
            c.call("fault", kind=kind)
            c.denied("dispatch", run_id="run-1", mode="success")
            time.sleep(.1)
            assert not c.events(), "helper launched despite failed durable intent"
        return run

    def successful(c):
        c.prepared()
        c.call("dispatch", run_id="run-1", mode="success")
        assert c.wait()["state"] == "completed"
        assert sum(e["kind"] == "started" for e in c.events()) == 1
        assert sum(e["kind"] == "completed" for e in c.events()) == 1
        c.denied("dispatch", run_id="run-1", mode="success")

    def stale_result(c):
        c.prepared()
        current = c.call("dispatch", run_id="run-1", mode="slow")
        task = c.call("detail", task_id="task-00000")
        correct = dict(run_id="run-1", epoch=current["epoch"], attempt=1,
                       revision=task["revision"], source_hash=task["source_hash"])
        for key, wrong in (("epoch", current["epoch"] - 1), ("attempt", 2),
                           ("revision", task["revision"] + 1), ("source_hash", "0" * 64)):
            c.denied("result", **dict(correct, **{key: wrong}))
        assert c.call("status", run_id="run-1")["state"] != "completed"
        c.call("stop", run_id="run-1")

    def result_full(c):
        c.prepared()
        c.call("fault", kind="result_full")
        c.call("dispatch", run_id="run-1", mode="success")
        assert c.wait()["state"] == "unknown"
        c.denied("dispatch", run_id="run-1", mode="success")
        c.denied("start", task_id="task-00000", request_id="retry")
        c.request(dict(op="stop", run_id="run-1"))
        assert c.call("status", run_id="run-1")["state"] in ("unknown", "stop_unconfirmed")
        c.denied("start", task_id="task-00000", request_id="retry-after-stop")

    def orphan(c):
        c.prepared()
        c.call("dispatch", run_id="run-1", mode="orphan")
        status = c.wait()
        assert status["state"] in ("unknown", "stop_unconfirmed"), status
        c.denied("start", task_id="task-00000", request_id="replacement")
        return dict(state=status["state"], helper_events=len(c.events()))

    def stop(c):
        c.prepared()
        c.call("dispatch", run_id="run-1", mode="slow")
        deadline = time.monotonic() + 3
        while not any(e["kind"] == "descendant" for e in c.events()) and time.monotonic() < deadline:
            time.sleep(.01)
        descendants = [e["child_pid"] for e in c.events() if e["kind"] == "descendant"]
        assert descendants, "helper descendant never observed"
        response = c.call("stop", run_id="run-1")
        status = c.call("status", run_id="run-1")
        living = [pid for pid in descendants if alive(pid) is not False]
        assert status["state"] != "completed"
        assert not (status["state"] == "stopped" and living), "false stopped while descendants alive"
        if living:
            assert status["state"] in ("unknown", "stop_unconfirmed")
            c.denied("start", task_id="task-00000", request_id="replacement")
        return dict(receipt=response["state"], final=status["state"], living_descendants=len(living))

    def backup(c):
        c.prepared()
        snapshot = c.directory / "backup.sqlite"
        c.call("snapshot", path=str(snapshot))
        assert snapshot.is_file()
        c.denied("snapshot", path=str(snapshot))
        c.denied("snapshot", path=str(c.directory.parent / "outside.sqlite"))
        with Candidate(command, c.directory / "restore-observer", restored=True, db=snapshot) as restored:
            restored.denied("dispatch", run_id="run-1", mode="success")
            restored.denied("start", task_id="task-00001", request_id="restore-new")
            assert restored.call("detail", task_id="task-00000")["revision"] == 1
        with Candidate(command, c.directory / "restore-restart", db=snapshot) as restored:
            restored.denied("start", task_id="task-00001", request_id="restore-next")

    def restart(c):
        c.prepared()
        old_epoch = c.call("dispatch", run_id="run-1", mode="slow")["epoch"]
        c.proc.kill()  # crash only the process whose handle this observer owns
        c.proc.wait(timeout=10)
        with Candidate(command, c.directory, db=c.db) as reopened:
            status = reopened.call("status", run_id="run-1")
            assert status["state"] in ("unknown", "stop_unconfirmed")
            reopened.denied("dispatch", run_id="run-1", mode="success")
            reopened.denied("start", task_id="task-00000", request_id="replacement")
            return dict(old_epoch=old_epoch, state=status["state"])

    def reject(c):
        c.prepared()
        c.call("reject", run_id="run-1")
        c.denied("dispatch", run_id="run-1", mode="success")
        assert c.call("status", run_id="run-1")["state"] == "rejected"
        assert not c.events()

    def queued_restart(c):
        c.prepared()
        c.close()
        with Candidate(command, c.directory, db=c.db) as reopened:
            reopened.denied("dispatch", run_id="run-1", mode="success")
            assert not reopened.events()

    def exclusive(c):
        c.prepared()
        second = None
        try:
            second = Candidate(command, c.directory / "second", db=c.db)
        except (ValueError, BrokenPipeError, queue.Empty, AssertionError):
            pass
        else:
            raise AssertionError("two live controllers accepted same DB")
        finally:
            if second:
                second.close()
        c.call("dispatch", run_id="run-1", mode="success")
        final = c.wait()
        assert final["state"] == "completed", f"first owner failed after refused second launch: {final}"

    def alias(c):
        alias_path = c.directory / "alias.sqlite"
        os.link(c.db, alias_path)
        second = None
        try:
            second = Candidate(command, c.directory / "alias-observer", db=alias_path)
        except (ValueError, BrokenPipeError, queue.Empty, AssertionError):
            pass
        else:
            raise AssertionError("hardlink alias opened same DB concurrently")
        finally:
            if second:
                second.close()

    def normal_mode(c):
        with Candidate(command, c.directory / "normal", test_mode=False) as normal:
            normal.start()
            for op, fields in (("advance", dict(seconds=1)), ("fault", dict(kind="intent_full")),
                               ("revise", dict(task_id="task-00000", source="Synthetic change")),
                               ("snapshot", dict(path=str(normal.directory / "backup.sqlite"))),
                               ("result", dict(run_id="run-1", epoch=1, attempt=1, revision=1, source_hash="0"*64))):
                normal.denied(op, **fields)

    def missing_completion(c):
        c.prepared()
        run = c.call("dispatch", run_id="run-1", mode="success")
        deadline = time.monotonic() + 3
        while not any(e["kind"] == "completed" for e in c.events()) and time.monotonic() < deadline:
            time.sleep(.01)
        assert any(e["kind"] == "completed" for e in c.events())
        for path in c.directory.glob("*.events.jsonl"):
            path.write_text("", encoding="utf-8")
        task = c.call("detail", task_id="task-00000")
        c.request(dict(op="result", run_id="run-1", epoch=run["epoch"], attempt=1,
                       revision=task["revision"], source_hash=task["source_hash"]))
        assert c.call("status", run_id="run-1")["state"] != "completed", "exit0 without completion evidence accepted"

    def unknown_job_stop(c):
        c.prepared()
        c.call("dispatch", run_id="run-1", mode="slow")
        deadline = time.monotonic() + 3
        while not any(e["kind"] == "descendant" for e in c.events()) and time.monotonic() < deadline:
            time.sleep(.01)
        events = c.events()
        assert any(e["kind"] == "descendant" for e in events)
        # Explicit test-only fault injection into this case's synthetic DB.
        with sqlite3.connect(c.db) as connection:
            connection.execute("UPDATE runs SET state='unknown' WHERE id='run-1'")
        response = c.call("stop", run_id="run-1")
        assert response["state"] == "unknown"
        for event in events:
            for key in ("pid", "child_pid"):
                if key in event:
                    assert alive(event[key]) is False, "owned helper cessation not confirmed"
        c.denied("start", task_id="task-00000", request_id="unknown-replacement")
        return dict(state="unknown", owned_processes_stopped=True)

    for name, action in [("http_guards", guards), ("idempotency", idempotency),
                         ("concurrent_start", concurrent), ("revoked_queue", revoke),
                         ("expired_queue", expired), ("changed_source", changed),
                         ("old_approval", old_approval), ("intent_full", storage("intent_full")),
                         ("intent_busy", storage("busy")), ("successful_helper", successful),
                         ("stale_result", stale_result), ("result_full_unknown", result_full),
                         ("orphan_parent", orphan), ("stop_descendants", stop),
                         ("backup_restore_hold", backup), ("restart_no_replay", restart),
                         ("reject_queued", reject), ("queued_restart", queued_restart),
                         ("exclusive_controller", exclusive), ("hardlink_alias", alias),
                         ("normal_mode_controls", normal_mode), ("missing_completion", missing_completion),
                         ("unknown_owned_job_stop", unknown_job_stop)]:
        case(name, action)
    return results


def stats(samples):
    values = sorted(samples)
    if not values:
        return None
    n = len(values)
    median = values[n // 2] if n % 2 else (values[n // 2 - 1] + values[n // 2]) / 2
    return dict(n=n, median_ms=median, p95_ms=values[math.ceil(n * .95) - 1], min_ms=values[0], max_ms=values[-1])


def working_set(process):
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes as w
    class Counters(ctypes.Structure):
        _fields_ = [("cb", w.DWORD), ("faults", w.DWORD),
                    *[(name, ctypes.c_size_t) for name in ("peak_working_set", "working_set", "peak_paged", "paged", "peak_nonpaged", "nonpaged", "pagefile", "peak_pagefile", "private")]]
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [w.HANDLE, ctypes.c_void_p, w.DWORD]
    if not psapi.GetProcessMemoryInfo(w.HANDLE(int(process._handle)), ctypes.byref(counters), counters.cb):
        return None
    return dict(working_set_bytes=counters.working_set, private_bytes=counters.private,
                scope="controller only; includes shared resident pages, excludes helper")


def benchmark(command, output):
    records = []
    for size in (100, 1000, 10000):
        cold = []
        import_ms = None
        for index in range(8):
            with Candidate(command, output / f"size-{size}" / "cold", size=size) as c:
                if index:
                    cold.append(c.start_ms)
                else:
                    import_ms = c.start_ms
        with Candidate(command, output / f"size-{size}" / "warm", size=size) as c:
            history_before = time.perf_counter_ns()
            for index in range(size):
                ident = f"history-{index}"
                c.start(ident)
                c.call("reject", run_id=ident)
            history_seed_ms = (time.perf_counter_ns() - history_before) / 1e6
            lists, details = [], []
            for index in range(32):
                for op, fields, samples in (("list", dict(offset=0, limit=50), lists),
                                            ("detail", dict(task_id=f"task-{size-1:05d}"), details)):
                    before = time.perf_counter_ns()
                    data = c.call(op, **fields)
                    elapsed = (time.perf_counter_ns() - before) / 1e6
                    if op == "list":
                        assert data["total"] == size and len(data["tasks"]) == 50
                    if index >= 2:
                        samples.append(elapsed)
            lifecycle = []
            for index in range(7):
                ident, task = f"measure-{index}", f"task-{index:05d}"
                timing = {}
                for op, fields in (("start", dict(request_id=ident, task_id=task)),
                                   ("approve", dict(run_id=ident, revision=1, expires_at=2000000100,
                                                    source_hash=c.call("detail", task_id=task)["source_hash"])),
                                   ("enqueue", dict(run_id=ident)),
                                   ("dispatch", dict(run_id=ident, mode="success"))):
                    before = time.perf_counter_ns()
                    c.call(op, **fields)
                    timing[op + "_receipt_ms"] = (time.perf_counter_ns() - before) / 1e6
                before_wait = time.perf_counter_ns()
                assert c.wait(ident)["state"] == "completed"
                timing["dispatch_to_result_ms"] = timing["dispatch_receipt_ms"] + (time.perf_counter_ns() - before_wait) / 1e6
                lifecycle.append(timing)
            c.prepared("slow-measure", "task-00020")
            c.call("dispatch", run_id="slow-measure", mode="slow")
            before = time.perf_counter_ns()
            c.call("list", offset=0, limit=50)
            slow_list = (time.perf_counter_ns() - before) / 1e6
            before = time.perf_counter_ns()
            stopped = c.call("stop", run_id="slow-measure")
            stop_receipt = (time.perf_counter_ns() - before) / 1e6
            final_stop = c.call("status", run_id="slow-measure")
            stop_completion = (time.perf_counter_ns() - before) / 1e6
            assert final_stop["state"] in ("stopped", "stop_unconfirmed", "unknown")
            records.append(dict(size=size, history_count=size, history_seed_ms=history_seed_ms,
                                initial_fixture_import_ms=import_ms, runtime=c.ready, cold_ms=cold, cold=stats(cold),
                                list_ms=lists, list=stats(lists), detail_ms=details, detail=stats(details),
                                lifecycle=lifecycle, list_during_helper_ms=slow_list,
                                stop_receipt_ms=stop_receipt, stop_receipt_state=stopped["state"],
                                stop_confirmation_ms=stop_completion, stop_final_state=final_stop["state"],
                                controller_memory=working_set(c.proc)))
        print(json.dumps(dict(size=size, cold=stats(cold), list=stats(lists))), flush=True)
    return records


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--command-json", required=True, help="JSON file containing argv array, no shell")
    parser.add_argument("--output", required=True)
    parser.add_argument("--mode", choices=("safety", "benchmark"), default="safety")
    args = parser.parse_args()
    command = json.loads(Path(args.command_json).read_text(encoding="utf-8-sig"))
    assert isinstance(command, list) and all(isinstance(x, str) for x in command)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    assert not (output / "results.json").exists(), "use fresh evidence directory; do not overwrite"
    manifest = json.loads((ROOT / "fixtures" / "manifest.json").read_text())
    for name, receipt in manifest.items():
        payload = (ROOT / "fixtures" / name).read_bytes()
        assert len(payload) == receipt["bytes"] and hashlib.sha256(payload).hexdigest() == receipt["sha256"], "fixture receipt mismatch"
    artifact_hashes = {}
    for path in [Path(__file__), ROOT / "common" / "helper.py", ROOT / "common" / "index.html", ROOT / "common" / "owned_job.py", *[Path(arg) for arg in command if Path(arg).is_file()]]:
        artifact_hashes[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
    result = dict(mode=args.mode, command=command, fixture_manifest=manifest, artifact_hashes=artifact_hashes,
                  contract_sha256=hashlib.sha256((ROOT / "CONTRACT.md").read_bytes()).hexdigest(),
                  runner_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    try:
        result["results"] = safety(command, output) if args.mode == "safety" else benchmark(command, output)
        result["passed"] = all(item.get("passed", True) for item in result["results"])
        changed = [name for name, digest in artifact_hashes.items() if hashlib.sha256(Path(name).read_bytes()).hexdigest() != digest]
        result["artifact_stability"] = not changed
        if changed:
            result.update(passed=False, error="artifacts changed during run", changed_artifacts=changed)
    except Exception as exc:
        result.update(passed=False, error=str(exc))
    (output / "results.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
