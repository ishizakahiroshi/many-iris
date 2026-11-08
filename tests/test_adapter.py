import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

from prototype.adapter import AdapterError, LocalProcessAdapter, WorkRequest


REQUEST = WorkRequest("run-demo", "task-demo", "plan-demo", 1, 1, "Synthetic task only")
ECHO = "import json,sys; r=json.load(sys.stdin);r.pop('instruction');r.update(status='completed',result='synthetic result');print(json.dumps(r))"


class AdapterTests(unittest.TestCase):
    def adapter(self, script, **kwargs):
        return LocalProcessAdapter([sys.executable, "-I", "-c", script], **kwargs)

    def test_disabled_by_default(self):
        with self.assertRaisesRegex(AdapterError, "execution_not_enabled"):
            self.adapter(ECHO).invoke(REQUEST)

    def test_synthetic_transport_roundtrip(self):
        result = self.adapter(ECHO).invoke(REQUEST, allow_execution=True)
        self.assertEqual(result["result"], "synthetic result")
        self.assertEqual(result["agent_epoch"], 1)

    def test_timeout_does_not_retry(self):
        started = time.monotonic()
        with self.assertRaisesRegex(AdapterError, "outcome_unknown_timeout"):
            self.adapter("import time;time.sleep(5)", timeout=0.1).invoke(REQUEST, allow_execution=True)
        self.assertLess(time.monotonic() - started, 3)

    def test_identity_mismatch_is_unknown(self):
        script = ECHO.replace("r.pop('instruction');", "r.pop('instruction');r['agent_epoch']=2;")
        with self.assertRaisesRegex(AdapterError, "outcome_unknown_identity_mismatch"):
            self.adapter(script).invoke(REQUEST, allow_execution=True)

    def test_nonreading_child_cannot_block_input_deadline(self):
        request = WorkRequest("r", "t", "p", 1, 1, "x" * 32768)
        started = time.monotonic()
        with self.assertRaisesRegex(AdapterError, "outcome_unknown_timeout"):
            self.adapter("import time;time.sleep(5)", timeout=0.1).invoke(request, allow_execution=True)
        self.assertLess(time.monotonic() - started, 3)

    def test_type_confusion_rejected(self):
        script = ECHO.replace("r.pop('instruction');", "r.pop('instruction');r['agent_epoch']=True;")
        with self.assertRaisesRegex(AdapterError, "outcome_unknown_identity_mismatch"):
            self.adapter(script).invoke(REQUEST, allow_execution=True)

    def test_output_limit(self):
        with self.assertRaisesRegex(AdapterError, "outcome_unknown_output_limit"):
            self.adapter("print('x'*100000)", max_output=128).invoke(REQUEST, allow_execution=True)

    def test_exit_and_malformed_result(self):
        for script, code in [("raise SystemExit(2)", "process_exit"), ("print('not json')", "invalid_result"),
                             ("print('{\"a\":1,\"a\":2}')", "invalid_result"), ("print('NaN')", "invalid_result")]:
            with self.subTest(script=script), self.assertRaisesRegex(AdapterError, "outcome_unknown_" + code):
                self.adapter(script).invoke(REQUEST, allow_execution=True)

    def test_relative_executable_and_scripts_rejected(self):
        with self.assertRaisesRegex(AdapterError, "executable_must_be_pinned"):
            LocalProcessAdapter(["python", "-c", "pass"])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "demo.cmd"
            path.write_text("echo synthetic", encoding="utf-8")
            with self.assertRaisesRegex(AdapterError, "shell_scripts_not_supported"):
                LocalProcessAdapter([str(path)])

    def test_secret_environment_is_not_inherited(self):
        sentinel = "MANY_IRIS_SYNTHETIC_TEST_SECRET"
        previous = os.environ.get(sentinel)
        os.environ[sentinel] = "synthetic-only"
        try:
            script = ECHO.replace("'synthetic result'", "str(__import__('os').environ.get('" + sentinel + "','absent'))")
            self.assertEqual(self.adapter(script).invoke(REQUEST, allow_execution=True)["result"], "absent")
        finally:
            if previous is None:
                os.environ.pop(sentinel, None)
            else:
                os.environ[sentinel] = previous

    def test_bad_request_never_launches(self):
        for revision in [True, 0, -1, "1"]:
            bad = WorkRequest("r", "t", "p", revision, 1, "synthetic")
            with self.subTest(revision=revision), self.assertRaises(AdapterError):
                self.adapter(ECHO).invoke(bad, allow_execution=True)

    def test_inherited_pipe_does_not_escape_deadline(self):
        # Short-lived synthetic descendant; wait for cleanup before test exits.
        script = "import subprocess,sys;subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(2)']);print('done')"
        started = time.monotonic()
        try:
            with self.assertRaisesRegex(AdapterError, "outcome_unknown_open_pipe"):
                self.adapter(script, timeout=0.1).invoke(REQUEST, allow_execution=True)
            self.assertLess(time.monotonic() - started, 1.5)
        finally:
            remaining = 2.3 - (time.monotonic() - started)
            if remaining > 0:
                time.sleep(remaining)


if __name__ == "__main__":
    unittest.main()
