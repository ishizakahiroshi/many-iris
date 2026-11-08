import subprocess
import os
import sys
import queue
import threading
import tempfile
import unittest
from pathlib import Path

from prototype.lease import ExecutionLease


class LeaseTests(unittest.TestCase):
    def test_hardlinked_database_aliases_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / "synthetic.sqlite3"
            alias = Path(directory) / "alias.sqlite3"
            original.write_bytes(b"synthetic file identity test")
            os.link(original, alias)
            self.assertTrue(os.path.samefile(original, alias))
            for path in (original, alias):
                with self.assertRaisesRegex(RuntimeError, "aliases"):
                    with ExecutionLease(path):
                        self.fail("hardlinked DB accepted")

    def test_second_owner_rejected_and_release_recovers(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "synthetic.sqlite3"
            with ExecutionLease(db):
                with self.assertRaisesRegex(RuntimeError, "already owns"):
                    with ExecutionLease(db):
                        self.fail("second owner entered")
            with ExecutionLease(db):
                pass

    def test_process_exit_releases_lock_without_pid_guess(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "synthetic.sqlite3"
            helper = "from prototype.lease import ExecutionLease;import sys;lease=ExecutionLease(sys.argv[1]);lease.__enter__();raise SystemExit(0)"
            result = subprocess.run([sys.executable, "-B", "-c", helper, str(db)], timeout=5, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            with ExecutionLease(db):
                pass

    def test_cli_second_scheduler_is_rejected_before_serving(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "synthetic.sqlite3"
            process = subprocess.Popen([sys.executable, "-B", "-u", "-m", "prototype.server", "--db", str(db)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            output = queue.Queue()
            reader = threading.Thread(target=lambda: output.put(process.stdout.readline()), daemon=True)
            reader.start()
            try:
                line = output.get(timeout=5)
                self.assertIn(b'"synthetic": true', line)
                second = subprocess.run([sys.executable, "-B", "-m", "prototype.server", "--db", str(db)],
                                        timeout=5, capture_output=True)
                self.assertEqual(second.returncode, 2)
                self.assertIn(b"already owns", second.stderr)
                self.assertEqual(second.stdout, b"")
            finally:
                process.terminate()
                process.wait(timeout=5)
                reader.join(timeout=1)
                process.stdout.close()
                process.stderr.close()
