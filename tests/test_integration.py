"""Actual HTTP + transactional engine + scheduler, never a real AI provider."""
import http.client
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from prototype.engine import Engine
from prototype.server import make_server


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "synthetic.sqlite3"
        self.engine = Engine(self.db)
        self.engine.seed_demo()
        self.server = make_server(self.engine, tick_interval=0.01)
        self.server.start_scheduler()
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request(self, action=None, **args):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        try:
            if action:
                conn.request("POST", "/api/actions", json.dumps({"action": action, **args}),
                             {"Content-Type": "application/json", "Origin": self.server.origin})
            else:
                conn.request("GET", "/api/snapshot")
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def until(self, predicate):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            state = self.request()[1]
            if predicate(state):
                return state
            time.sleep(0.01)
        self.fail("local integration condition did not arrive within 3 seconds")

    def test_autonomy_handoff_approval_completion_and_restart(self):
        code, started = self.request("start", plan_id="demo-plan", revision=1, request_id="start")
        self.assertEqual(code, 200)
        self.assertEqual(self.request("start", plan_id="demo-plan", revision=1, request_id="start")[1], started)
        self.assertEqual(self.request("start", plan_id="demo-plan", revision=1, request_id="another")[0], 409)
        run_id = started["run"]["id"]
        state = self.until(lambda s: s["runs"][0]["status"] == "waiting_approval")
        old_approval = next(a for a in state["approvals"] if a["status"] == "pending")
        self.assertEqual(self.request("stop_agent", run_id=run_id, request_id="synthetic-stop")[0], 200)
        state = self.until(lambda s: s["runs"][0]["epoch"] == 2 and s["runs"][0]["status"] == "waiting_approval")
        self.assertEqual(self.request("decide", approval_id=old_approval["id"], decision="approve", revision=1, request_id="late-approval")[0], 409)
        approval = next(a for a in state["approvals"] if a["status"] == "pending")
        decision = dict(approval_id=approval["id"], decision="approve", revision=1, request_id="approve")
        response = self.request("decide", **decision)
        self.assertEqual(response[0], 200)
        self.assertEqual(self.request("decide", **decision), response)
        state = self.until(lambda s: s["runs"][0]["status"] == "completed")
        tasks = [t for t in state["tasks"] if t["plan_id"] == "demo-plan"]
        self.assertTrue(all(t["status"] == "completed" and t["execution_count"] == 1 for t in tasks))
        self.assertTrue(all(t["status"] == "pending" and t["execution_count"] == 0 for t in state["tasks"] if t["plan_id"] != "demo-plan"))
        self.assertEqual(len([e for e in state["events"] if e["kind"] == "handoff"]), 1)
        restored = Engine(self.db).snapshot()
        self.assertEqual(restored["runs"], state["runs"])

    def test_rejection_is_persisted_and_does_not_continue(self):
        self.assertEqual(self.request("start", plan_id="demo-plan", revision=1, request_id="start")[0], 200)
        state = self.until(lambda s: s["runs"][0]["status"] == "waiting_approval")
        approval = state["approvals"][0]
        self.assertEqual(self.request("decide", approval_id=approval["id"], decision="reject", revision=1, request_id="reject")[0], 200)
        state = self.until(lambda s: s["runs"][0]["status"] == "rejected")
        self.assertEqual(state["tasks"][1]["execution_count"], 0)
        self.assertEqual(state["tasks"][2]["execution_count"], 0)
        self.assertEqual(Engine(self.db).snapshot()["runs"][0]["status"], "rejected")
