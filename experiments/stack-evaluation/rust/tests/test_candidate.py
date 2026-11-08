"""Focused synthetic integration checks, not comparative benchmarks."""
import argparse
from contextlib import closing
import ctypes
from ctypes import wintypes
import hashlib
import http.client
import json
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import sqlite3
import threading
import time
import unittest

HERE = Path(__file__).resolve().parents[1]
CONFIG = {}
KERNEL = ctypes.WinDLL("kernel32", use_last_error=True)
KERNEL.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
KERNEL.OpenProcess.restype = wintypes.HANDLE
KERNEL.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
KERNEL.GetExitCodeProcess.restype = wintypes.BOOL
KERNEL.CloseHandle.argtypes = [wintypes.HANDLE]
KERNEL.CloseHandle.restype = wintypes.BOOL


class Server:
    def __init__(self, directory, restored=False, db=None):
        self.directory = directory
        self.db = db or directory / "state.db"
        source = "Synthetic source only"
        self.digest = hashlib.sha256(source.encode()).hexdigest()
        fixture = directory / "fixture.json"
        fixture.write_text(json.dumps({"version": 1, "now": 2000000000, "tasks": [
            {"id": f"task-{i}", "title": f"Synthetic {i}", "source": source,
             "source_hash": self.digest, "revision": 1} for i in range(5)]}), encoding="utf-8")
        ui = directory / "ui.html"
        ui.write_text("<!doctype html><title>Synthetic test</title>", encoding="utf-8")
        args = [str(CONFIG["exe"]), "--db", str(self.db), "--fixture", str(fixture),
                "--helper", str(CONFIG["helper"]), "--python", sys.executable,
                "--ui", str(ui), "--port", "0", "--test-mode"]
        if restored:
            args.append("--restored")
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True)
        self.token = "synthetic-integration-token"
        self.proc.stdin.write(json.dumps({"token": self.token}) + "\n")
        self.proc.stdin.flush()
        ready = queue.Queue()
        threading.Thread(target=lambda: ready.put(self.proc.stdout.readline()), daemon=True).start()
        try:
            line = ready.get(timeout=30)
            if not line:
                raise RuntimeError(self.proc.stderr.read())
            self.ready = json.loads(line)
            self.port = self.ready["port"]
        except BaseException:
            self.close()
            raise

    def api(self, op, **fields):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request("POST", "/api", json.dumps(dict(op=op, **fields)),
                         {"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
            return json.loads(conn.getresponse().read())
        finally:
            conn.close()

    def ok(self, op, **fields):
        result = self.api(op, **fields)
        if not result.get("ok"):
            raise AssertionError(result)
        return result["data"]

    def queued(self, suffix="0"):
        run = "run-" + suffix
        self.ok("start", task_id="task-" + suffix, request_id=run)
        self.ok("approve", run_id=run, revision=1, source_hash=self.digest, expires_at=2000000100)
        self.ok("enqueue", run_id=run)
        return run

    def terminal(self, run, limit=10):
        deadline = time.monotonic() + limit
        while time.monotonic() < deadline:
            state = self.ok("status", run_id=run)
            if state["state"] != "running":
                return state
            time.sleep(.02)
        raise AssertionError("timeout waiting for synthetic process")

    def close(self):
        if getattr(self, "proc", None):
            if self.proc.poll() is None:
                self.proc.kill()
            self.proc.wait(timeout=10)
            for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
                if stream:
                    stream.close()


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.server = Server(self.directory)

    def tearDown(self):
        self.server.close()
        self.temp.cleanup()

    def test_runtime_success_result_and_storage_unknown(self):
        self.assertRegex(self.server.ready["sqlite_version"], r"^3\.")
        run = self.server.queued()
        self.server.ok("dispatch", run_id=run, mode="success")
        self.assertEqual(self.server.terminal(run)["state"], "completed")
        self.assertFalse(self.server.api("result", run_id=run, epoch=0, attempt=1,
                                         revision=1, source_hash=self.server.digest)["ok"])
        run = self.server.queued("1")
        self.server.ok("fault", kind="result_full")
        self.server.ok("dispatch", run_id=run, mode="success")
        self.assertEqual(self.server.terminal(run)["state"], "unknown")
        self.assertEqual(self.server.api("dispatch", run_id=run, mode="success")["error"], "STATE")

    def test_job_descendants_and_stop(self):
        run = self.server.queued()
        running = self.server.ok("dispatch", run_id=run, mode="slow")
        events = Path(running["events_path"])
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if events.exists() and '"descendant"' in events.read_text():
                break
            time.sleep(.01)
        self.assertIn('"descendant"', events.read_text())
        self.assertEqual(self.server.ok("stop", run_id=run)["state"], "stopped")
        for event in map(json.loads, events.read_text().splitlines()):
            process_id = event.get("child_pid", event["pid"])
            handle = KERNEL.OpenProcess(0x1000, False, process_id)
            if handle:
                code = ctypes.c_ulong()
                self.assertTrue(KERNEL.GetExitCodeProcess(handle, ctypes.byref(code)))
                KERNEL.CloseHandle(handle)
                self.assertNotEqual(code.value, 259)

    def test_orphan_is_not_complete_and_can_be_stopped(self):
        run = self.server.queued()
        self.server.ok("dispatch", run_id=run, mode="orphan")
        self.assertEqual(self.server.terminal(run)["state"], "stop_unconfirmed")
        self.assertEqual(self.server.api("start", task_id="task-0", request_id="replacement")["error"], "ACTIVE_RUN")
        self.assertEqual(self.server.ok("stop", run_id=run)["state"], "stopped")

    def test_restart_unknown_and_backup_restore_hold(self):
        run = self.server.queued()
        self.server.ok("snapshot", path="snapshot.db")
        self.server.ok("dispatch", run_id=run, mode="slow")
        self.server.close()
        self.server = Server(self.directory)
        self.assertEqual(self.server.ok("status", run_id=run)["state"], "unknown")
        self.assertEqual(self.server.api("start", task_id="task-0", request_id="replacement")["error"], "ACTIVE_RUN")
        self.server.close()
        self.server = Server(self.directory, restored=True, db=self.directory / "snapshot.db")
        self.assertEqual(self.server.api("dispatch", run_id=run, mode="success")["error"], "RESTORE_HOLD")
        self.assertEqual(self.server.ok("list", offset=0, limit=50)["total"], 5)

    def test_exact_result_cannot_complete_live_job_or_clear_unknown(self):
        run = self.server.queued()
        running = self.server.ok("dispatch", run_id=run, mode="slow")
        injected = self.server.api("result", run_id=run, epoch=running["epoch"],
                                   attempt=1, revision=1, source_hash=self.server.digest)
        self.assertFalse(injected["ok"])
        self.assertEqual(self.server.ok("status", run_id=run)["state"], "running")
        self.assertEqual(self.server.ok("stop", run_id=run)["state"], "stopped")
        run = self.server.queued("1")
        self.server.ok("fault", kind="result_full")
        self.server.ok("dispatch", run_id=run, mode="success")
        self.assertEqual(self.server.terminal(run)["state"], "unknown")
        stopped = self.server.ok("stop", run_id=run)
        self.assertEqual(stopped["state"], "unknown")
        self.assertFalse(stopped["process_stop_confirmed"])
        self.assertEqual(self.server.ok("status", run_id=run)["state"], "unknown")
        self.assertEqual(self.server.api("start", task_id="task-1", request_id="replacement")["error"], "ACTIVE_RUN")

    def test_pid_persistence_failure_does_not_release_work(self):
        run = self.server.queued()
        with closing(sqlite3.connect(self.server.db)) as db:
            db.execute("CREATE TRIGGER fail_pid BEFORE UPDATE OF pid ON runs WHEN NEW.pid>0 "
                       "BEGIN SELECT RAISE(ABORT,'synthetic PID persistence failure'); END")
            db.commit()
        self.assertEqual(self.server.api("dispatch", run_id=run, mode="slow")["error"], "STORAGE")
        self.assertEqual(self.server.ok("status", run_id=run)["state"], "unknown")
        stopped = self.server.ok("stop", run_id=run)
        self.assertEqual(stopped["state"], "unknown")
        self.assertFalse(stopped["process_stop_confirmed"])
        self.assertEqual(self.server.api("start", task_id="task-0", request_id="replacement")["error"], "ACTIVE_RUN")

    def test_same_db_and_hardlink_alias_fail_before_epoch_update(self):
        with self.assertRaisesRegex(RuntimeError, "DB_LOCKED"):
            Server(self.directory)
        alias = self.directory / "alias.db"
        alias.hardlink_to(self.server.db)
        with self.assertRaisesRegex(RuntimeError, "DB_ALIAS"):
            Server(self.directory, db=alias)
        with closing(sqlite3.connect(self.server.db)) as db:
            self.assertEqual(db.execute("SELECT epoch FROM metadata").fetchone()[0], 1)

    def test_final_symlink_alias_uses_original_owner_lock(self):
        alias = self.directory / "symlink.db"
        try:
            alias.symlink_to(self.server.db)
        except OSError as error:
            self.skipTest(f"file symlink creation unavailable: {error.winerror}")
        with self.assertRaisesRegex(RuntimeError, "DB_LOCKED"):
            Server(self.directory, db=alias)

    def test_unknown_owned_job_can_stop_without_releasing_outcome(self):
        run = self.server.queued()
        running = self.server.ok("dispatch", run_id=run, mode="slow")
        events = Path(running["events_path"])
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if events.exists() and '"descendant"' in events.read_text():
                break
            time.sleep(.01)
        self.assertIn('"descendant"', events.read_text())
        with closing(sqlite3.connect(self.server.db)) as db:
            db.execute("UPDATE runs SET state='unknown' WHERE id=?", (run,))
            db.commit()
        stopped = self.server.ok("stop", run_id=run)
        self.assertEqual(stopped["state"], "unknown")
        self.assertTrue(stopped["process_stop_confirmed"])
        for event in map(json.loads, events.read_text().splitlines()):
            process_id = event.get("child_pid", event["pid"])
            handle = KERNEL.OpenProcess(0x1000, False, process_id)
            if handle:
                code = ctypes.c_ulong()
                self.assertTrue(KERNEL.GetExitCodeProcess(handle, ctypes.byref(code)))
                KERNEL.CloseHandle(handle)
                self.assertNotEqual(code.value, 259)
        self.assertEqual(self.server.ok("status", run_id=run)["state"], "unknown")
        self.assertEqual(self.server.api("start", task_id="task-0", request_id="replacement")["error"], "ACTIVE_RUN")
        repeated = self.server.ok("stop", run_id=run)
        self.assertEqual(repeated["state"], "unknown")
        self.assertFalse(repeated["process_stop_confirmed"])

    def test_unknown_after_restart_does_not_signal_persisted_numeric_pid(self):
        run = self.server.queued()
        self.server.ok("dispatch", run_id=run, mode="slow")
        self.server.close()
        unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL)
        try:
            with closing(sqlite3.connect(self.server.db)) as db:
                db.execute("UPDATE runs SET pid=? WHERE id=?", (unrelated.pid, run))
                db.commit()
            self.server = Server(self.directory)
            stopped = self.server.ok("stop", run_id=run)
            self.assertEqual(stopped["state"], "unknown")
            self.assertFalse(stopped["process_stop_confirmed"])
            self.assertIsNone(unrelated.poll())
            self.assertEqual(self.server.api("start", task_id="task-0", request_id="replacement")["error"], "ACTIVE_RUN")
        finally:
            unrelated.terminate()
            unrelated.wait(timeout=5)


def repeated_lifecycles(count):
    """Stability regression, no elapsed-time samples or comparative benchmark."""
    successes = unknowns = 0
    for _ in range(count):
        with tempfile.TemporaryDirectory() as directory:
            server = Server(Path(directory))
            try:
                run = server.queued()
                server.ok("dispatch", run_id=run, mode="success")
                result = server.terminal(run)
                if result["state"] != "completed":
                    raise AssertionError(result)
                successes += 1
                run = server.queued("1")
                server.ok("fault", kind="result_full")
                server.ok("dispatch", run_id=run, mode="success")
                result = server.terminal(run)
                if result["state"] != "unknown":
                    raise AssertionError(result)
                unknowns += 1
            finally:
                server.close()
    return dict(cycles=count, success_completed=successes, result_storage_unknown=unknowns, failures=0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--exe", type=Path, default=HERE / "target/release/iris-stack-rust.exe")
    parser.add_argument("--metadata", action="store_true")
    parser.add_argument("--repeat", type=int)
    args, remaining = parser.parse_known_args()
    CONFIG.update(helper=args.helper.resolve(), exe=args.exe.resolve())
    if args.repeat is not None:
        print(json.dumps(repeated_lifecycles(args.repeat)))
    elif args.metadata:
        with tempfile.TemporaryDirectory() as directory:
            server = Server(Path(directory))
            try:
                print(json.dumps(server.ready))
            finally:
                server.close()
    else:
        unittest.main(argv=[sys.argv[0], *remaining])
