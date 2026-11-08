import json
import subprocess
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

from prototype.adapter import AdapterError
from prototype.doctor import check_config
from prototype.engine import Engine
from prototype.notifications import preview_notifications


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def config(self, data):
        path = self.directory / "adapter.json"
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    def test_empty_config_truthfully_disabled(self):
        result = check_config(self.config({"enabled": False, "command": []}))
        self.assertFalse(result["configured"])
        self.assertFalse(result["execution_enabled"])

    def test_config_validation_does_not_execute_command(self):
        marker = self.directory / "must-not-exist"
        command = [sys.executable, "-c", f"open({str(marker)!r},'w').write('synthetic')"]
        result = check_config(self.config({"command": command}))
        self.assertTrue(result["configured"])
        self.assertFalse(result["execution_enabled"])
        self.assertFalse(marker.exists())

    def test_real_enabled_and_secret_fields_rejected(self):
        for config in ({"enabled": True, "command": [sys.executable]},
                       {"command": [], "access_token": "synthetic-only"}):
            with self.assertRaises(AdapterError):
                check_config(self.config(config))

    def test_duplicate_and_nonfinite_config_rejected(self):
        path = self.directory / "invalid.json"
        for text in ('{"enabled":false,"enabled":true}', '{"timeout":NaN}'):
            path.write_text(text, encoding="utf-8")
            with self.assertRaises(AdapterError):
                check_config(path)

    def test_notification_payload_ignores_original_text(self):
        engine = Engine(self.directory / "synthetic.sqlite3")
        engine.seed_demo()
        engine.start("demo-plan", 1, "start")
        for _ in range(3):
            engine.tick()
        with engine.store.transaction() as (_, state):
            state["notifications"][0]["body"] = "Synthetic confidential source text; never forward"
        result = preview_notifications(engine)
        self.assertEqual(len(result["notifications"]), 1)
        self.assertNotIn("confidential", json.dumps(result))
        self.assertFalse(result["external_send"])
        self.assertEqual(preview_notifications(engine, result["next_cursor"])["notifications"], [])

    def test_notification_cli_does_not_modify_unrelated_database(self):
        db = self.directory / "unrelated.sqlite3"
        conn = sqlite3.connect(db)
        conn.execute("CREATE TABLE unrelated (value TEXT)")
        conn.commit()
        conn.close()
        before = db.read_bytes()
        result = subprocess.run([sys.executable, "-B", "-m", "prototype.notifications", "--db", str(db)],
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(db.read_bytes(), before)

    def test_notification_cli_malformed_state_has_safe_error(self):
        db = self.directory / "malformed.sqlite3"
        conn = sqlite3.connect(db)
        conn.execute("CREATE TABLE state(id INTEGER PRIMARY KEY, body TEXT)")
        conn.execute("INSERT INTO state VALUES(1,'[]')")
        conn.commit()
        conn.close()
        result = subprocess.run([sys.executable, "-B", "-m", "prototype.notifications", "--db", str(db)],
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(json.loads(result.stdout)["error"], "synthetic_database_required")
