import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from generate_fixtures import fixture, write_all


class SharedInputsTest(unittest.TestCase):
    def test_repeatable_exact_manifest_and_content(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            self.assertEqual(write_all(Path(a)), write_all(Path(b)))
            manifest = json.loads((Path(a) / "manifest.json").read_text())
            for name, item in manifest.items():
                data = (Path(a) / name).read_bytes()
                self.assertEqual(item["sha256"], hashlib.sha256(data).hexdigest())
                tasks = json.loads(data)["tasks"]
                self.assertEqual(len(tasks), int(name.split("-")[1].split(".")[0]))
                self.assertEqual(len(tasks), len({t["id"] for t in tasks}))
                for task in tasks:
                    self.assertEqual(task["source_hash"], hashlib.sha256(task["source"].encode()).hexdigest())

    def test_helper_binding_and_no_premature_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            events = Path(directory) / "events.jsonl"
            proc = subprocess.Popen([sys.executable, str(Path(__file__).with_name("helper.py")),
                                     "--events", str(events), "--mode", "success",
                                     "--run-id", "synthetic-run", "--epoch", "3", "--attempt", "1"])
            self.assertEqual(proc.wait(timeout=5), 0)
            observed = [json.loads(line) for line in events.read_text().splitlines()]
            self.assertEqual([e["kind"] for e in observed], ["started", "completed"])
            self.assertTrue(all(e["run_id"] == "synthetic-run" and e["epoch"] == 3
                                and e["attempt"] == 1 for e in observed))


if __name__ == "__main__":
    unittest.main()
