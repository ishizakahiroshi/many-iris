from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest

from prototype.engine import DomainError, Engine


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "fixture.sqlite3"
        self.engine = Engine(self.path)
        self.engine.seed_demo()

    def start(self, request="start"):
        return self.engine.start("demo-plan", 1, request)["run"]

    def waiting(self):
        run = self.start()
        for _ in range(3):
            self.engine.tick(run["id"])
        state = self.engine.snapshot()
        return run, state["approvals"][0]

    def assert_code(self, code, callback):
        with self.assertRaises(DomainError) as caught:
            callback()
        self.assertEqual(code, caught.exception.code)

    def test_seed_idempotent(self):
        before = self.engine.snapshot()
        self.assertFalse(self.engine.seed_demo()["seeded"])
        after = self.engine.snapshot()
        before.pop("observed_at")
        after.pop("observed_at")
        self.assertEqual(before, after)

    def test_start_retry_bound_to_body(self):
        first = self.engine.start("demo-plan", 1, "same")
        self.assertEqual(first, self.engine.start("demo-plan", 1, "same"))
        self.assert_code("request_conflict", lambda: self.engine.start("other-plan", 1, "same"))
        self.assert_code("request_conflict", lambda: self.engine.pause(first["run"]["id"], "same"))

    def test_distinct_requests_cannot_duplicate_plan_run(self):
        self.start()
        self.assert_code("already_started", lambda: self.start("other"))

    def test_concurrent_start_same_and_different_identifiers(self):
        def call(n):
            try:
                return self.engine.start("demo-plan", 1, "same" if n < 5 else f"unique-{n}")
            except DomainError as error:
                return error.code
        with ThreadPoolExecutor(max_workers=8) as pool:
            outcomes = list(pool.map(call, range(10)))
        self.assertEqual(1, len(self.engine.snapshot()["runs"]))
        self.assertEqual(1, len([e for e in self.engine.snapshot()["events"] if e["kind"] == "run_started"]))
        self.assertTrue(all(o == "already_started" or isinstance(o, dict) for o in outcomes))

    def test_plan_scope_and_approval_gate_then_complete(self):
        run, approval = self.waiting()
        state = self.engine.snapshot()
        self.assertEqual("waiting_approval", state["runs"][0]["status"])
        self.assertEqual("completed", state["tasks"][0]["status"])
        self.assertTrue(all(t["status"] == "pending" for t in state["tasks"] if t["plan_id"] == "other-plan"))
        self.engine.tick()
        self.assertEqual(0, self.engine.snapshot()["tasks"][1]["execution_count"])
        decision = self.engine.decide(approval["id"], "approve", 1, "approve")
        self.assertEqual(decision, self.engine.decide(approval["id"], "approve", 1, "approve"))
        for _ in range(6):
            self.engine.tick()
        self.assertEqual("completed", self.engine.snapshot()["runs"][0]["status"])
        self.assertEqual([1, 1, 1], [t["execution_count"] for t in self.engine.snapshot()["tasks"][:3]])
        self.assert_code("already_started", lambda: self.start("restart-completed"))

    def test_rejection_is_terminal_and_does_not_run_remaining_work(self):
        run, approval = self.waiting()
        self.engine.decide(approval["id"], "reject", 1, "reject")
        for _ in range(6):
            self.engine.tick()
        state = self.engine.snapshot()
        self.assertEqual("rejected", state["runs"][0]["status"])
        self.assertEqual([1, 0, 0], [t["execution_count"] for t in state["tasks"][:3]])
        self.assert_code("invalid_state", lambda: self.engine.resume(run["id"], "resume-rejected"))

    def test_stale_plan_revision_cannot_start_or_approve(self):
        run, approval = self.waiting()
        self.engine.revise_plan("demo-plan", "revision")
        self.assert_code("stale_revision", lambda: self.engine.decide(approval["id"], "approve", 1, "old"))
        self.assert_code("stale_revision", lambda: self.engine.start("demo-plan", 1, "old-start"))
        self.assertEqual("pending", self.engine.snapshot()["approvals"][0]["status"])

    def test_decision_revision_bool_and_invalid_text_rejected(self):
        run, approval = self.waiting()
        self.assert_code("invalid_revision", lambda: self.engine.decide(approval["id"], "approve", True, "bad-bool"))
        self.assert_code("invalid_decision", lambda: self.engine.decide(approval["id"], "yes", 1, "bad-choice"))
        self.assert_code("stale_revision", lambda: self.engine.decide(approval["id"], "approve", 2, "bad-revision"))

    def test_pause_resume_does_not_lose_approval_gate(self):
        run, approval = self.waiting()
        self.engine.pause(run["id"], "pause")
        self.engine.resume(run["id"], "resume")
        self.assertEqual("waiting_approval", self.engine.snapshot()["runs"][0]["status"])
        self.engine.pause(run["id"], "pause-again")
        self.engine.decide(approval["id"], "approve", 1, "approve-paused")
        self.assertEqual("paused", self.engine.snapshot()["runs"][0]["status"])
        self.engine.tick()
        self.assertEqual(0, self.engine.snapshot()["tasks"][1]["execution_count"])
        self.engine.resume(run["id"], "resume-again")
        self.engine.tick()
        self.assertEqual(1, self.engine.snapshot()["tasks"][1]["execution_count"])

    def test_restart_keeps_committed_results_and_journal(self):
        first = self.start("durable")
        self.engine.tick()
        self.engine.tick()
        reopened = Engine(self.path)
        self.assertEqual({"synthetic": True, "run": first}, reopened.start("demo-plan", 1, "durable"))
        reopened.tick()
        self.assertEqual("waiting_approval", reopened.snapshot()["runs"][0]["status"])
        self.assertEqual(1, reopened.snapshot()["tasks"][0]["execution_count"])

    def test_restart_in_flight_becomes_unknown_without_replay(self):
        self.start()
        self.engine.tick()
        reopened = Engine(self.path)
        reopened.tick()
        for _ in range(5):
            reopened.tick()
        state = reopened.snapshot()
        self.assertEqual("unknown", state["runs"][0]["status"])
        self.assertEqual("unknown", state["tasks"][0]["status"])
        self.assertEqual(1, state["tasks"][0]["execution_count"])

    def test_unknown_cannot_stop_handoff_or_accept_late_result(self):
        run = self.start()
        self.engine.tick()
        self.engine.mark_unknown(run["id"], "uncertain")
        self.assert_code("invalid_state", lambda: self.engine.stop_agent(run["id"], "stop-unknown"))
        self.assert_code("stop_not_confirmed", lambda: self.engine.handoff(run["id"], "handoff-unknown"))
        self.assert_code("invalid_state", lambda: self.engine.submit_result(run["id"], "demo-plan-task-1", 1, "late", "late"))

    def test_handoff_requires_confirmed_stop_and_fences_old_owner(self):
        run = self.start()
        self.engine.tick()
        self.assert_code("stop_not_confirmed", lambda: self.engine.handoff(run["id"], "too-early"))
        self.engine.stop_agent(run["id"], "stop")
        self.engine.handoff(run["id"], "handoff")
        self.assert_code("stale_owner", lambda: self.engine.submit_result(run["id"], "demo-plan-task-1", 1, "late", "late"))
        self.engine.tick()
        self.engine.tick()
        state = self.engine.snapshot()
        self.assertEqual(2, state["runs"][0]["epoch"])
        self.assertEqual("completed", state["tasks"][0]["status"])

    def test_handoff_approval_must_be_reissued_for_new_owner(self):
        run, approval = self.waiting()
        self.engine.stop_agent(run["id"], "stop")
        self.engine.handoff(run["id"], "handoff")
        self.assert_code("approval_closed", lambda: self.engine.decide(approval["id"], "approve", 1, "late-approval"))
        self.engine.tick()
        approvals = self.engine.snapshot()["approvals"]
        self.assertEqual(["superseded", "pending"], [a["status"] for a in approvals])
        self.assertEqual(2, approvals[-1]["epoch"])

    def test_approved_but_not_started_is_reapproved_after_handoff(self):
        run, approval = self.waiting()
        self.engine.decide(approval["id"], "approve", 1, "approve")
        self.engine.stop_agent(run["id"], "stop")
        self.engine.handoff(run["id"], "handoff")
        self.engine.tick()
        state = self.engine.snapshot()
        self.assertEqual("waiting_approval", state["runs"][0]["status"])
        self.assertEqual(0, state["tasks"][1]["execution_count"])

    def test_notifications_are_generic_and_not_repeated_while_waiting(self):
        self.waiting()
        for _ in range(10):
            self.engine.tick()
        notes = self.engine.notifications()["notifications"]
        self.assertEqual(1, len(notes))
        self.assertEqual([], self.engine.notifications(notes[0]["id"])["notifications"])
        self.assertNotIn("demo", str(notes))
        self.assertNotIn("架空", str(notes))
        self.assert_code("invalid_input", lambda: self.engine.notifications(True))

    def test_failed_mutation_rolls_back_state_and_request(self):
        self.assert_code("stale_revision", lambda: self.engine.start("demo-plan", 2, "retry"))
        self.assertEqual([], self.engine.snapshot()["runs"])
        self.engine.start("demo-plan", 1, "retry")
        self.assertEqual(1, len(self.engine.snapshot()["runs"]))

    def test_plan_change_rejects_inflight_result(self):
        run = self.start()
        self.engine.tick()
        self.engine.revise_plan("demo-plan", "revise-inflight")
        self.assert_code("stale_revision", lambda: self.engine.submit_result(
            run["id"], "demo-plan-task-1", 1, "old instruction result", "stale-result"))
        self.assertEqual("running", self.engine.snapshot()["tasks"][0]["status"])

    def test_task_change_rejects_inflight_result(self):
        run = self.start()
        self.engine.tick()
        with self.engine.store.transaction() as (_, state):
            state["tasks"][0]["revision"] += 1
        self.assert_code("stale_revision", lambda: self.engine.submit_result(
            run["id"], "demo-plan-task-1", 1, "old instruction result", "stale-task-result"))
        self.assertEqual("running", self.engine.snapshot()["tasks"][0]["status"])
        self.engine.tick()
        self.assertEqual("revision_changed", self.engine.snapshot()["runs"][0]["status"])
        self.assertNotEqual("completed", self.engine.snapshot()["tasks"][0]["status"])

    def test_document_is_detached_and_unknown_ids_safe(self):
        doc = self.engine.document("demo-plan-doc-1")
        doc["body"] = "changed"
        self.assertNotEqual("changed", self.engine.document("demo-plan-doc-1")["body"])
        self.assert_code("not_found", lambda: self.engine.document("../anything"))


if __name__ == "__main__":
    unittest.main()
