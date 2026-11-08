"""Regression tests for independent observer, not a candidate's own code."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from runner import Candidate, stats


class ObserverTests(unittest.TestCase):
    def test_cleanup_never_uses_event_pids(self):
        with tempfile.TemporaryDirectory() as directory:
            candidate = Candidate.__new__(Candidate)
            candidate.directory = Path(directory)
            (candidate.directory / "stale.events.jsonl").write_text(json.dumps(dict(pid=1, child_pid=2)), encoding="utf-8")
            candidate.job = Mock()
            owned_job = candidate.job
            candidate.proc = Mock()
            candidate.stderr = Mock()
            candidate.close()
            owned_job.close.assert_called_once_with()
            candidate.proc.kill.assert_not_called()
            candidate.proc.wait.assert_called_once_with(timeout=10)

    def test_nearest_rank_p95_and_median(self):
        self.assertEqual(stats(list(range(1, 31)))["p95_ms"], 29)
        self.assertEqual(stats([1, 4])["median_ms"], 2.5)
        self.assertEqual(stats([1, 2, 9])["median_ms"], 2)
        self.assertIsNone(stats([]))


if __name__ == "__main__":
    unittest.main()
