import argparse
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest

from server import DomainError, Engine, Handler, ThreadingHTTPServer
from windows_job import JobProcess

SHARED = None


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.fixture = self.directory / "fixture.json"
        source = "Synthetic input only.\n"
        self.tasks = [dict(id=f"task-{i}", title=f"Synthetic {i}", source=source,
                           source_hash=hashlib.sha256(source.encode()).hexdigest(), revision=1) for i in range(3)]
        self.fixture.write_text(json.dumps(dict(version=1, now=2000000000, tasks=self.tasks)), encoding="utf-8")
        self.engine = self.open()

    def open(self, restored=False, test_mode=True):
        return Engine(self.directory / "state.db", self.fixture, SHARED / "helper.py", sys.executable,
                      test_mode=test_mode, restored=restored)

    def tearDown(self):
        self.engine.close()
        self.temp.cleanup()

    def call(self, op, **values):
        return self.engine.apply(dict(op=op, **values))

    def assert_error(self, expected, op, **values):
        with self.assertRaisesRegex(DomainError, "^" + expected + "$"):
            self.call(op, **values)

    def queued(self, name="run-1", task="task-0"):
        self.call("start", task_id=task, request_id=name)
        item = self.call("detail", task_id=task)
        self.call("approve", run_id=name, revision=item["revision"], source_hash=item["source_hash"], expires_at=2000000060)
        return self.call("enqueue", run_id=name)

    def terminal(self, name="run-1"):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            state = self.call("status", run_id=name)
            if state["state"] != "running":
                return state
            time.sleep(.01)
        self.fail("helper did not reach terminal within bound")

    def test_request_id_idempotence_and_conflict(self):
        a = self.call("start", task_id="task-0", request_id="same")
        self.assertEqual(a, self.call("start", task_id="task-0", request_id="same"))
        self.assert_error("REQUEST_CONFLICT", "start", task_id="task-1", request_id="same")
        self.assert_error("ACTIVE_RUN", "start", task_id="task-0", request_id="different")

    def test_concurrent_start_single_durable_run(self):
        def operation(i):
            try:
                return self.call("start", task_id="task-0", request_id=f"race-{i}")["state"]
            except DomainError as error:
                return str(error)
        with ThreadPoolExecutor(max_workers=8) as pool:
            outcomes = list(pool.map(operation, range(16)))
        self.assertEqual(outcomes.count("waiting"), 1)
        self.assertEqual(outcomes.count("ACTIVE_RUN"), 15)
        self.assertEqual(self.engine.db.execute("SELECT count(*) FROM runs").fetchone()[0], 1)

    def test_old_revision_hash_expiry_rejected(self):
        self.call("start", task_id="task-0", request_id="run-1")
        task = self.tasks[0]
        for change in (dict(revision=2), dict(source_hash="0" * 64), dict(expires_at=2000000000)):
            values = dict(run_id="run-1", revision=1, source_hash=task["source_hash"], expires_at=2000000060)
            values.update(change)
            self.assert_error("STALE_APPROVAL", "approve", **values)
        self.assertFalse((self.directory / "run-1.events.jsonl").exists())

    def test_revoked_queued_grant_no_helper(self):
        self.queued()
        self.call("revoke", run_id="run-1")
        self.assert_error("STATE", "dispatch", run_id="run-1", mode="success")
        self.assertFalse((self.directory / "run-1.events.jsonl").exists())

    def test_expiry_between_enqueue_dispatch(self):
        self.queued()
        self.call("advance", seconds=61)
        self.assert_error("STALE_APPROVAL", "dispatch", run_id="run-1", mode="success")
        self.assertFalse((self.directory / "run-1.events.jsonl").exists())

    def test_source_change_after_queue(self):
        self.queued()
        self.call("revise", task_id="task-0", source="Synthetic replacement")
        self.assert_error("STATE", "dispatch", run_id="run-1", mode="success")
        self.assertEqual(self.call("status", run_id="run-1")["state"], "waiting")
        self.assertFalse((self.directory / "run-1.events.jsonl").exists())

    def test_success_is_bound_to_actual_helper(self):
        self.queued()
        self.call("dispatch", run_id="run-1", mode="success")
        self.assertEqual(self.terminal()["state"], "completed")
        events = [json.loads(v) for v in (self.directory / "run-1.events.jsonl").read_text().splitlines()]
        self.assertEqual(sum(e["kind"] == "started" for e in events), 1)
        self.assert_error("STATE", "dispatch", run_id="run-1", mode="success")

    def test_delayed_wrong_epoch_attempt_revision_hash(self):
        self.queued()
        state = self.call("dispatch", run_id="run-1", mode="slow")
        for field, value in (("epoch", state["epoch"] - 1), ("attempt", 2), ("revision", 2), ("source_hash", "0" * 64)):
            args = dict(run_id="run-1", epoch=state["epoch"], attempt=1, revision=1, source_hash=self.tasks[0]["source_hash"])
            args[field] = value
            self.assert_error("STALE_RESULT", "result", **args)
        self.assertEqual(self.call("status", run_id="run-1")["state"], "running")
        self.call("stop", run_id="run-1")

    def test_intent_failure_does_not_launch(self):
        self.queued()
        for kind in ("intent_full", "busy"):
            self.call("fault", kind=kind)
            self.assert_error("STORAGE", "dispatch", run_id="run-1", mode="success")
            self.assertFalse((self.directory / "run-1.events.jsonl").exists())
            self.assertEqual(self.call("status", run_id="run-1")["state"], "queued")

    def test_result_failure_unknown_blocks_replacement(self):
        self.queued()
        self.call("fault", kind="result_full")
        self.call("dispatch", run_id="run-1", mode="success")
        self.assertEqual(self.terminal()["state"], "unknown")
        self.assert_error("ACTIVE_RUN", "start", task_id="task-0", request_id="replacement")
        self.assert_error("STATE", "dispatch", run_id="run-1", mode="success")

    def test_stop_cannot_erase_unknown_external_outcome(self):
        self.queued()
        self.call("fault", kind="result_full")
        self.call("dispatch", run_id="run-1", mode="success")
        self.assertEqual(self.terminal()["state"], "unknown")
        self.assertEqual(self.call("stop", run_id="run-1")["state"], "unknown")
        self.assert_error("ACTIVE_RUN", "start", task_id="task-0", request_id="replacement")

    def test_result_requires_completion_event(self):
        self.queued()
        state = self.call("dispatch", run_id="run-1", mode="success")
        self.assertEqual(self.engine.children["run-1"].wait(timeout=5), 0)
        path = Path(state["events_path"])
        observed = [json.loads(v) for v in path.read_text().splitlines()]
        path.write_text("\n".join(json.dumps(e) for e in observed if e["kind"] != "completed") + "\n")
        self.assert_error("STATE", "result", run_id="run-1", epoch=state["epoch"],
                          attempt=1, revision=1, source_hash=self.tasks[0]["source_hash"])
        self.assertEqual(self.call("status", run_id="run-1")["state"], "unknown")

    def test_result_requires_no_active_job_descendants(self):
        self.queued()
        state = self.call("dispatch", run_id="run-1", mode="orphan")
        self.assertEqual(self.engine.children["run-1"].wait(timeout=5), 0)
        # Event history is not a replacement for the independent owned Job count.
        # Hide the descendant announcement, then assert completion while it lives.
        path = Path(state["events_path"])
        observed = [json.loads(v) for v in path.read_text().splitlines()]
        path.write_text("\n".join(json.dumps(e) for e in observed if e["kind"] != "descendant") + "\n")
        with path.open("a") as stream:
            stream.write(json.dumps(dict(kind="completed", run_id="run-1", epoch=state["epoch"], attempt=1)) + "\n")
        self.assert_error("STATE", "result", run_id="run-1", epoch=state["epoch"],
                          attempt=1, revision=1, source_hash=self.tasks[0]["source_hash"])
        self.assertIn(self.call("status", run_id="run-1")["state"], ("running", "stop_unconfirmed"))
        self.assert_error("ACTIVE_RUN", "start", task_id="task-0", request_id="replacement")
        self.call("stop", run_id="run-1")

    def test_second_owner_denied_before_epoch_change(self):
        before = self.engine.meta()["epoch"]
        with self.assertRaisesRegex(OSError, "DB_LOCKED"):
            self.open()
        self.assertEqual(self.engine.meta()["epoch"], before)

    def test_hardlink_alias_denied(self):
        alias = self.directory / "alias.db"
        os.link(self.engine.path, alias)
        with self.assertRaisesRegex(OSError, "DB_ALIASED"):
            Engine(alias, self.fixture, SHARED / "helper.py", sys.executable, test_mode=True)

    def test_exit_code_alone_is_not_termination_proof(self):
        class Kernel:
            def WaitForSingleObject(self, process, timeout):
                return 258  # Teardown not signaled, even if exit code is visible.
            def GetExitCodeProcess(self, process, output):
                output._obj.value = 0
                return True
        child = JobProcess.__new__(JobProcess)
        child.api, child.process = Kernel(), 1
        self.assertIsNone(child.poll())

    def test_exited_parent_job_accounting_lag_remains_active(self):
        self.queued()
        self.call("dispatch", run_id="run-1", mode="success")
        child = self.engine.children["run-1"]
        self.assertEqual(child.wait(timeout=5), 0)
        actual_active = child.active
        try:
            child.active = lambda: 1
            self.assertEqual(self.call("status", run_id="run-1")["state"], "running")
            self.assert_error("ACTIVE_RUN", "start", task_id="task-0", request_id="replacement")
        finally:
            child.active = actual_active
        self.assertEqual(self.terminal()["state"], "completed")

    def test_stop_owns_descendant_tree(self):
        self.queued()
        self.call("dispatch", run_id="run-1", mode="slow")
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and not self.engine.descendants(self.engine.run("run-1")):
            time.sleep(.01)
        self.assertTrue(self.engine.descendants(self.engine.run("run-1")))
        stopped = self.call("stop", run_id="run-1")
        self.assertEqual(stopped["state"], "stopped")
        self.assertEqual(self.engine.children["run-1"].active(), 0)

    def test_orphan_is_not_false_success_and_can_be_stopped(self):
        self.queued()
        self.call("dispatch", run_id="run-1", mode="orphan")
        self.assertEqual(self.terminal()["state"], "stop_unconfirmed")
        self.assert_error("ACTIVE_RUN", "start", task_id="task-0", request_id="replacement")
        self.assertEqual(self.call("stop", run_id="run-1")["state"], "stopped")
        self.assertEqual(self.engine.children["run-1"].active(), 0)

    def test_restart_invalidates_queue_persists_records(self):
        state = self.queued()
        self.engine.close()
        self.engine = self.open()
        self.assertEqual(self.engine.epoch, state["epoch"] + 1)
        self.assertEqual(self.call("status", run_id="run-1")["state"], "waiting")
        self.assert_error("STATE", "dispatch", run_id="run-1", mode="success")
        self.assertEqual(self.call("list")["total"], 3)

    def test_restart_uncertain_intent_stays_unknown(self):
        self.queued()
        self.engine.db.execute("UPDATE runs SET state='dispatching' WHERE id='run-1'")
        self.engine.close()
        self.engine = self.open()
        self.assertEqual(self.call("status", run_id="run-1")["state"], "unknown")
        self.assert_error("ACTIVE_RUN", "start", task_id="task-0", request_id="replacement")

    def test_backup_restored_hold_is_durable(self):
        self.queued()
        snapshot = self.call("snapshot", path="backup.db")["path"]
        with closing(sqlite3.connect(snapshot)) as backup:
            self.assertEqual(backup.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(backup.execute("SELECT count(*) FROM tasks").fetchone()[0], 3)
        restored = Engine(snapshot, self.fixture, SHARED / "helper.py", sys.executable, test_mode=True, restored=True)
        try:
            with self.assertRaisesRegex(DomainError, "RESTORE_HOLD"):
                restored.apply(dict(op="start", task_id="task-1", request_id="restored"))
            self.assertEqual(restored.apply(dict(op="list"))["total"], 3)
        finally:
            restored.close()
        reopened = Engine(snapshot, self.fixture, SHARED / "helper.py", sys.executable, test_mode=True)
        try:
            with self.assertRaisesRegex(DomainError, "RESTORE_HOLD"):
                reopened.apply(dict(op="start", task_id="task-1", request_id="restored"))
        finally:
            reopened.close()
        self.assert_error("INVALID", "snapshot", path="backup.db")
        self.assert_error("INVALID", "snapshot", path="../outside.db")

    def test_production_disables_test_controls(self):
        self.engine.close()
        self.engine = self.open(test_mode=False)
        for op, args in (("fault", dict(kind="busy")), ("advance", dict(seconds=1)),
                         ("revise", dict(task_id="task-0", source="x")), ("snapshot", dict(path="no.db")),
                         ("result", dict(run_id="x", epoch=1, attempt=1, revision=1, source_hash="x"))):
            self.assert_error("INVALID", op, **args)

    def test_strict_input_validation(self):
        for op, args in (("start", dict(task_id="../task-0", request_id="x")),
                         ("list", dict(limit=True)), ("list", dict(limit=101)),
                         ("list", dict(offset=-1)), ("list", dict(unrecognized=True))):
            self.assert_error("INVALID", op, **args)

    def test_http_auth_origin_host_json_size_controls(self):
        web = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        web.daemon_threads = True
        web.engine, web.token, web.ui = self.engine, "synthetic-comparison-only", b"<html>synthetic</html>"
        thread = threading.Thread(target=web.serve_forever, daemon=True)
        thread.start()
        def post(payload, headers=None, route="/api"):
            connection = http.client.HTTPConnection("127.0.0.1", web.server_port, timeout=3)
            base = {"Authorization": "Bearer " + web.token, "Content-Type": "application/json"}
            base.update(headers or {})
            connection.request("POST", route, body=payload, headers=base)
            response = connection.getresponse()
            value = json.loads(response.read())
            connection.close()
            return value
        try:
            self.assertTrue(post('{"op":"list"}')["ok"])
            self.assertFalse(post('{"op":"list"}', {"Authorization": "Bearer incorrect"})["ok"])
            self.assertFalse(post('{"op":"list"}', {"Origin": "https://example.invalid"})["ok"])
            self.assertFalse(post('{"op":"list"}', {"Host": "example.invalid"})["ok"])
            self.assertFalse(post('{"op":"list","op":"start"}')["ok"])
            self.assertFalse(post('{"op":NaN}')["ok"])
            self.assertFalse(post("bad-json")["ok"])
            self.assertFalse(post(" " * 65537)["ok"])
        finally:
            web.shutdown()
            web.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--shared", type=Path, required=True)
    args, remaining = parser.parse_known_args()
    SHARED = args.shared.resolve()
    unittest.main(argv=[sys.argv[0]] + remaining)
