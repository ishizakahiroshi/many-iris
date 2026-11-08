import tempfile
import unittest
from pathlib import Path

from prototype.engine import Engine
from prototype.scheduler import Scheduler


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.engine = Engine(Path(self.temp.name) / "synthetic.sqlite3")
        self.engine.seed_demo()
        self.scheduler = Scheduler(self.engine)

    def start(self, plan="demo-plan"):
        return self.engine.start(plan, 1, request_id="start:" + plan)["run"]["id"]

    def test_confirmed_stop_hands_off_without_human(self):
        run_id = self.start()
        self.engine.stop_agent(run_id, request_id="synthetic-stop")
        self.scheduler.step()
        run = self.engine.snapshot()["runs"][0]
        self.assertEqual(run["agent_id"], "synthetic-agent-2")
        self.assertEqual(run["status"], "active")
        self.assertEqual(len([e for e in self.engine.snapshot()["events"] if e["kind"] == "handoff"]), 1)
        self.scheduler.step()
        self.assertEqual(len([e for e in self.engine.snapshot()["events"] if e["kind"] == "handoff"]), 1)

    def test_unknown_is_neither_handed_off_nor_reexecuted(self):
        run_id = self.start()
        self.scheduler.step()
        self.engine.mark_unknown(run_id, request_id="uncertain")
        for _ in range(5):
            self.scheduler.step()
        state = self.engine.snapshot()
        self.assertEqual(state["runs"][0]["status"], "unknown")
        self.assertEqual(state["tasks"][0]["execution_count"], 1)
        self.assertFalse(any(e["kind"] == "handoff" for e in state["events"]))

    def test_waiting_run_does_not_block_other_explicitly_started_plan(self):
        first = self.start()
        for _ in range(3):
            self.scheduler.step()
        self.assertEqual(self.engine.snapshot()["runs"][0]["status"], "waiting_approval")
        second = self.start("other-plan")
        self.scheduler.step()
        self.scheduler.step()
        state = self.engine.snapshot()
        self.assertEqual(next(t for t in state["tasks"] if t["id"] == "other-plan-task-1")["status"], "completed")
        self.assertEqual(next(r for r in state["runs"] if r["id"] == first)["status"], "waiting_approval")
        self.assertEqual(next(r for r in state["runs"] if r["id"] == second)["status"], "active")

    def test_plan_changed_before_handoff_stays_blocked(self):
        run_id = self.start()
        self.engine.stop_agent(run_id, request_id="stop")
        self.engine.revise_plan("demo-plan", request_id="revise")
        result = self.scheduler.step()
        self.assertEqual(result["handoffs"][0]["error"], "stale_revision")
        self.assertEqual(self.engine.snapshot()["runs"][0]["status"], "agent_stopped")
