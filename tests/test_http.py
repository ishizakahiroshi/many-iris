"""HTTP boundary tests use a controlled in-memory engine, never personal state."""
import http.client
import json
import threading
import time
import unittest

from prototype.server import MAX_BODY, make_server


class DomainError(Exception):
    def __init__(self, code, message, status=409):
        self.code, self.message, self.status = code, message, status


class StubEngine:
    def __init__(self):
        self.calls = []
        self.ticks = 0

    def snapshot(self):
        return {"synthetic": True, "schema_version": "many-iris-foundation/1",
                "projects": [], "plans": [], "tasks": [], "runs": [],
                "approvals": [], "events": [], "notifications": [],
                "observed_at": "2030-01-01T00:00:00Z"}

    def document(self, document_id):
        if document_id == "missing":
            raise DomainError("not_found", "Document not found.", 404)
        return {"id": document_id, "title": "合成の根拠", "body": "本文", "revision": 1}

    def notifications(self, after=0):
        return [{"id": after + 1, "kind": "attention", "body": "確認してください。"}]

    def start(self, **args):
        self.calls.append(("start", args))
        if args["plan_id"] == "conflict":
            raise DomainError("revision_conflict", "The revision has changed.")
        if args["plan_id"] == "explode":
            raise ValueError("secret local database path must never escape")
        return {"id": "run-1", **args}

    def decide(self, **args):
        self.calls.append(("decide", args))
        return {"accepted": True}

    def pause(self, **args):
        self.calls.append(("pause", args))
        return {"accepted": True}

    resume = pause
    stop_agent = pause
    handoff = pause

    def tick(self, run_id=None):
        self.ticks += 1
        self.calls.append(("tick", {"run_id": run_id}))
        return {"advanced": True}


class HTTPBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.engine = StubEngine()
        self.server = make_server(self.engine, port=0, tick_interval=0)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive())

    def request(self, method="GET", path="/api/snapshot", body=None, headers=None):
        headers = list(headers or [])
        if not any(key.lower() == "host" for key, _ in headers):
            headers.insert(0, ("Host", f"127.0.0.1:{self.server.server_port}"))
        if body is not None and not any(key.lower() == "content-length" for key, _ in headers):
            headers.append(("Content-Length", str(len(body))))
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        try:
            conn.putrequest(method, path, skip_host=True)
            for key, value in headers:
                conn.putheader(key, value)
            conn.endheaders(body)
            response = conn.getresponse()
            data = response.read()
            return response.status, dict(response.getheaders()), data
        finally:
            conn.close()

    def post(self, data, headers=None):
        return self.request("POST", "/api/actions", json.dumps(data).encode(),
                            [("Content-Type", "application/json"), *(headers or [])])

    def start_data(self, **overrides):
        return {"action": "start", "request_id": "request-1", "plan_id": "demo-plan", "revision": 1, **overrides}

    def assert_error(self, response, status, code=None):
        actual, headers, body = response
        self.assertEqual(actual, status, body)
        result = json.loads(body)
        self.assertIn("error", result)
        if code:
            self.assertEqual(result["error"]["code"], code)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        return result

    def test_snapshot_preserves_observation_and_marks_local(self):
        status, headers, raw = self.request()
        self.assertEqual(status, 200)
        data = json.loads(raw)
        self.assertEqual(data["observed_at"], "2030-01-01T00:00:00Z")
        self.assertTrue(data["synthetic"])
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])

    def test_host_is_exact_for_reads_and_writes(self):
        for host in ("localhost:" + str(self.server.server_port), "example.invalid", "127.0.0.1"):
            with self.subTest(host=host):
                self.assert_error(self.request(headers=[("Host", host)]), 403, "invalid_host")
                self.assert_error(self.post(self.start_data(), [("Host", host)]), 403)
        self.assertEqual(self.engine.calls, [])

    def test_duplicate_host_rejected(self):
        host = f"127.0.0.1:{self.server.server_port}"
        self.assert_error(self.request(headers=[("Host", host), ("Host", host)]), 403)

    def test_origin_is_checked_for_reads_and_writes(self):
        for origin in ("https://example.invalid", "null", self.server.origin + "/"):
            with self.subTest(origin=origin):
                self.assert_error(self.request(headers=[("Origin", origin)]), 403)
                self.assert_error(self.post(self.start_data(), [("Origin", origin)]), 403)
        self.assertEqual(self.post(self.start_data(), [("Origin", self.server.origin)])[0], 200)

    def test_duplicate_origin_and_cross_site_rejected(self):
        self.assert_error(self.request(headers=[("Origin", self.server.origin), ("Origin", self.server.origin)]), 403)
        self.assert_error(self.request(headers=[("Sec-Fetch-Site", "cross-site")]), 403)

    def test_transfer_encoding_rejected_even_with_content_length(self):
        self.assert_error(self.request("POST", "/api/actions", b"{}", [("Transfer-Encoding", "chunked")]), 400)

    def test_cross_site_navigation_only_allows_static_landing(self):
        navigation = [("Sec-Fetch-Site", "cross-site"), ("Sec-Fetch-Mode", "navigate"), ("Sec-Fetch-Dest", "document")]
        self.assertEqual(self.request(path="/", headers=navigation)[0], 200)
        self.assert_error(self.request(path="/api/snapshot", headers=navigation), 403)
        self.assert_error(self.request(path="/", headers=navigation + [("Origin", "https://example.invalid")]), 403)
        self.assert_error(self.post(self.start_data(), navigation), 403)
        self.assertEqual(self.engine.calls, [])

    def test_framing_with_content_length_rejected(self):
        self.assert_error(self.request(headers=[("Transfer-Encoding", "chunked")]), 400)
        self.assert_error(self.request("POST", "/api/actions", b"{}", [
            ("Content-Type", "application/json"), ("Transfer-Encoding", "chunked")]), 400)

    def test_duplicate_content_length_rejected(self):
        self.assert_error(self.request("POST", "/api/actions", b"{}", [
            ("Content-Type", "application/json"), ("Content-Length", "2"), ("Content-Length", "2")]), 400)
        self.assert_error(self.request(headers=[("Content-Length", "0"), ("Content-Length", "0")]), 400)

    def test_body_limit_before_body_read(self):
        self.assert_error(self.request("POST", "/api/actions", None, [
            ("Content-Type", "application/json"), ("Content-Length", str(MAX_BODY + 1))]), 413)

    def test_content_type_and_length_required(self):
        self.assert_error(self.request("POST", "/api/actions", b"{}"), 415)
        self.assert_error(self.request("POST", "/api/actions", b"{}", [("Content-Type", "text/plain")]), 415)
        self.assert_error(self.request("POST", "/api/actions", None, [("Content-Type", "application/json")]), 400)

    def test_invalid_json_duplicate_nonfinite_utf8(self):
        for raw in (b'{"a":1,"a":2}', b'{"x":NaN}', b'{"x":Infinity}', b'\xff', b'{', b'[]', b'null', b'{"x":' + b'9' * 5000 + b'}'):
            with self.subTest(raw=raw):
                self.assert_error(self.request("POST", "/api/actions", raw, [("Content-Type", "application/json")]), 400)
        self.assertEqual(self.engine.calls, [])

    def test_payload_schema_rejects_unknown_fields_and_types(self):
        invalid = [self.start_data(extra="no"), self.start_data(revision=True),
                   self.start_data(revision=0), self.start_data(request_id=""),
                   self.start_data(plan_id="../private"), self.start_data(action="exec"),
                   self.start_data(action=[]), {"action": "start", "request_id": "r"}]
        for data in invalid:
            with self.subTest(data=data):
                self.assert_error(self.post(data), 400)
        self.assertEqual(self.engine.calls, [])

    def test_action_passes_exact_fields_and_request_id(self):
        status, _, _ = self.post(self.start_data())
        self.assertEqual(status, 200)
        self.assertEqual(self.engine.calls, [("start", {"request_id": "request-1", "plan_id": "demo-plan", "revision": 1})])

    def test_decide_requires_known_decision(self):
        data = {"action": "decide", "request_id": "decision-1", "approval_id": "a-1", "revision": 2, "decision": "approve"}
        self.assertEqual(self.post(data)[0], 200)
        data["decision"] = "maybe"
        self.assert_error(self.post(data), 400, "invalid_decision")

    def test_domain_error_status_and_internal_error_do_not_leak(self):
        self.assert_error(self.post(self.start_data(plan_id="conflict")), 409, "revision_conflict")
        result = self.assert_error(self.post(self.start_data(plan_id="explode")), 500, "internal_error")
        self.assertNotIn("database", json.dumps(result))
        self.assertNotIn("secret", json.dumps(result))

    def test_document_and_static_path_allowlist(self):
        for path in ("/../server.py", "/%2e%2e/server.py", "/app.js/../server.py", "/api/documents/%2e%2e", "/api/documents/a%2fb", "/api/documents/a?path=private"):
            with self.subTest(path=path):
                result = self.request(path=path)
                self.assertIn(result[0], (400, 404))
                self.assertNotIn(b"Loopback-only", result[2])
        self.assertEqual(self.request(path="/api/documents/doc-1")[0], 200)
        self.assert_error(self.request(path="/api/documents/missing"), 404)

    def test_static_assets_are_self_contained_and_source_is_text_safe(self):
        for path in ("/", "/style.css", "/app.js"):
            with self.subTest(path=path):
                status, headers, body = self.request(path=path)
                self.assertEqual(status, 200)
                self.assertGreater(len(body), 100)
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        js = self.request(path="/app.js")[2]
        self.assertNotIn(b"innerHTML", js)
        self.assertIn(b"textContent", js)

    def test_notification_cursor_validated(self):
        self.assertEqual(json.loads(self.request(path="/api/notifications?after=5")[2])[0]["id"], 6)
        for query in ("after=-1", "after=x", "after=1&after=2", "path=x", "after="):
            with self.subTest(query=query):
                self.assert_error(self.request(path="/api/notifications?" + query), 400)

    def test_unsupported_methods_do_not_mutate(self):
        for method in ("PUT", "DELETE", "PATCH", "OPTIONS"):
            with self.subTest(method=method):
                self.assert_error(self.request(method, "/api/actions"), 405)
        self.assertEqual(self.engine.calls, [])

    def test_background_scheduler_lifetime(self):
        self.server.tick_interval = .015
        self.server.start_scheduler()
        deadline = time.monotonic() + 1
        while self.engine.ticks < 2 and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertGreaterEqual(self.engine.ticks, 2)
        self.server.stop_scheduler()
        count = self.engine.ticks
        time.sleep(.04)
        self.assertEqual(self.engine.ticks, count)

    def test_scheduler_failure_visible_without_crashing_reads(self):
        def fail():
            raise ValueError("private detail")
        self.engine.tick = fail
        self.server.tick_interval = .01
        self.server.start_scheduler()
        deadline = time.monotonic() + 1
        while not self.server.scheduler_failed and time.monotonic() < deadline:
            time.sleep(.01)
        status, _, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["scheduler_error"], "scheduler_stopped")
        self.assertNotIn(b"private", body)

    def test_invalid_server_parameters_rejected(self):
        for port in (-1, 65536, True):
            with self.subTest(port=port):
                with self.assertRaises(ValueError):
                    make_server(self.engine, port=port)
        for interval in (-1, float("nan"), float("inf"), True):
            with self.subTest(interval=interval):
                with self.assertRaises(ValueError):
                    make_server(self.engine, tick_interval=interval)


if __name__ == "__main__":
    unittest.main()
