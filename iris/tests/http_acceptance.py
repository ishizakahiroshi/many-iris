"""Black-box synthetic HTTP/domain acceptance. Never prints credentials or HTML.

Usage: python http_acceptance.py --binary <iris executable> --output <receipt.json>
The harness owns each temporary server and only terminates that process tree.
No real AI, existing database, browser, network service, or provider is used.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
import uuid
from urllib.parse import urlsplit

VERSION = "2026-07-28"


class NotVerified(Exception):
    pass


def require(condition, message):
    if not condition:
        raise AssertionError(message)


class Server:
    def __init__(self, binary, root, database=None, restore=None):
        self.binary = binary
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.db = database or root / "state.sqlite3"
        self.ready = root / ("ready-" + uuid.uuid4().hex + ".json")
        self.token_path = root / ("credential-" + uuid.uuid4().hex)
        self.ui_key_path = root / ("ui-key-" + uuid.uuid4().hex)
        args = [str(binary), "--db", str(self.db), "--port", "0", "--ready-file", str(self.ready), "--mcp-token-file", str(self.token_path), "--ui-key-file", str(self.ui_key_path)]
        if restore:
            args += ["--restore-from", str(restore)]
        self.process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        self.host = None
        self.port = None
        self.ui_token = ""
        self.mcp_token = ""
        self.ui_key = ""
        self.cookie = ""
        self.cookie_attributes = ""

    def start(self):
        end = time.monotonic() + 20
        while time.monotonic() < end:
            if self.process.poll() is not None:
                raise AssertionError("owned_server_exited_before_ready")
            if self.ready.exists():
                try:
                    ready = json.loads(self.ready.read_text(encoding="utf-8"))
                    parsed = urlsplit(ready["url"])
                    require(parsed.hostname == "127.0.0.1", "server_not_loopback")
                    require(ready["pid"] == self.process.pid, "ready_pid_not_owned")
                    require(ready.get("synthetic") is True, "server_not_synthetic")
                    self.host, self.port = parsed.hostname, parsed.port
                    self.mcp_token = self.token_path.read_text(encoding="ascii").strip()
                    self.ui_key = self.ui_key_path.read_text(encoding="ascii").strip()
                    require(re.fullmatch(r"[0-9a-fA-F]{64}", self.ui_key) is not None, "ui_key_format_invalid")
                    require(self.ui_key != self.mcp_token, "login_key_equals_mcp_token")
                    status, headers, login_raw = self.request("POST", "/session", {"key": self.ui_key}, headers=[("Origin", f"http://{self.host}:{self.port}")], deadline=end)
                    require(status == 200 and json.loads(login_raw).get("ok") is True, "local_login_failed")
                    self.cookie_attributes = headers.get("set-cookie", "")
                    self.cookie = self.cookie_attributes.split(";", 1)[0]
                    require("=" in self.cookie, "login_cookie_missing")
                    status, _, raw = self.request("GET", "/", headers=[("Cookie", self.cookie)], deadline=end)
                    require(status == 200, "bootstrap_html_unavailable")
                    match = re.search(rb'<meta\s+name="iris-ui-token"\s+content="([^"]+)"', raw)
                    require(match is not None, "bootstrap_meta_missing")
                    self.ui_token = match.group(1).decode("ascii")
                    require(len(self.ui_token) >= 32 and len({self.ui_token, self.mcp_token, self.ui_key}) == 3, "credentials_not_separate")
                    return self
                except (OSError, ValueError, KeyError):
                    pass
            time.sleep(0.05)
        raise AssertionError("owned_server_startup_timeout_20s")

    def close(self):
        if self.process.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(self.process.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
            else:
                self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.ui_token = self.mcp_token = self.ui_key = self.cookie = self.cookie_attributes = ""
        self.token_path.unlink(missing_ok=True)
        self.ui_key_path.unlink(missing_ok=True)

    def request(self, method, path, payload=None, token=None, headers=None, raw=None, deadline=None):
        timeout = min(2.0, max(0.05, (deadline - time.monotonic()) if deadline else 2.0))
        connection = http.client.HTTPConnection(self.host, self.port, timeout=timeout)
        body = raw if raw is not None else (json.dumps(payload, separators=(",", ":")).encode() if payload is not None else None)
        pairs = [("Host", f"{self.host}:{self.port}")]
        if body is not None:
            pairs.extend([("Content-Type", "application/json"), ("Content-Length", str(len(body)))])
        if token:
            pairs.append(("Authorization", "Bearer " + token))
        overrides = headers or []
        names = {name.lower() for name, _ in overrides}
        pairs = [(k, v) for k, v in pairs if k.lower() not in names] + overrides
        try:
            connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            for name, value in pairs:
                connection.putheader(name, value)
            connection.endheaders(body)
            response = connection.getresponse()
            content = response.read(1_048_577)
            require(len(content) <= 1_048_576, "response_exceeds_harness_bound")
            return response.status, {k.lower(): v for k, v in response.getheaders()}, content
        finally:
            connection.close()

    def state(self, deadline=None):
        status, _, raw = self.request("GET", "/api/state", token=self.ui_token, deadline=deadline)
        require(status == 200, "state_request_failed")
        data = json.loads(raw)
        require(data.get("synthetic") is True, "state_not_synthetic")
        return data

    def action(self, operation, payload, request_id=None, deadline=None):
        envelope = {"operation": operation, "input": {"request_id": request_id or ("test-" + uuid.uuid4().hex), "payload": payload}}
        status, _, raw = self.request("POST", "/api/action", envelope, self.ui_token, deadline=deadline)
        return status, json.loads(raw), envelope

    def rpc(self, method, params=None, headers=None, token=None, deadline=None):
        params = dict(params or {})
        params.setdefault("_meta", {"io.modelcontextprotocol/protocolVersion": VERSION, "io.modelcontextprotocol/clientInfo": {"name": "acceptance-harness", "version": "1"}, "io.modelcontextprotocol/clientCapabilities": {}})
        request = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        mirrored = {"MCP-Protocol-Version": VERSION, "Mcp-Method": method, "Accept": "application/json, text/event-stream"}
        if "name" in params:
            mirrored["Mcp-Name"] = params["name"]
        for key, value in (headers or {}).items():
            if value is None:
                mirrored.pop(key, None)
            else:
                mirrored[key] = value
        status, _, raw = self.request("POST", "/mcp", request, token or self.mcp_token, list(mirrored.items()), deadline=deadline)
        return status, json.loads(raw)


def start_payload(plan):
    return {"plan_id": plan["plan_id"], "plan_revision": plan["plan_revision"], "plan_hash": plan["plan_hash"], "approval_id": plan["approval"]["approval_id"], "approval_revision": plan["approval"]["revision"]}


def decision_payload(plan, choice="approve"):
    decision = plan.get("decision")
    if not decision:
        raise NotVerified("decision_not_reached")
    return {"decision_id": decision["decision_id"], "decision_revision": decision["revision"], "content_hash": decision["content_hash"], "decision": choice}


class Harness:
    def __init__(self, binary, root):
        self.binary, self.root = binary, root
        self.servers = []
        self.results = []
        self.deadline = 0
        self.last_observed = None
        self.main = None
        self.stop_server = None
        self.restart_server = None

    def server(self, name, **kwargs):
        server = Server(self.binary, self.root / name, **kwargs)
        self.servers.append(server)
        return server.start()

    def case(self, case_id, function):
        started = time.monotonic()
        self.deadline = started + 5
        self.last_observed = None
        try:
            evidence = function() or {}
            require(time.monotonic() <= self.deadline + 0.1, "case_exceeded_5s")
            self.results.append({"id": case_id, "status": "passed", "evidence": evidence})
        except NotVerified as error:
            self.results.append({"id": case_id, "status": "unverified", "reason": str(error)})
        except AssertionError as error:
            self.results.append({"id": case_id, "status": "failed", "reason": str(error)})
        except Exception as error:
            # Never serialize exception bodies, URLs, requests or credentials.
            self.results.append({"id": case_id, "status": "failed", "reason": "unexpected_" + type(error).__name__})
        if self.results[-1]["status"] != "passed" and self.last_observed is not None:
            self.results[-1]["observed_state"] = self.last_observed
        self.results[-1]["elapsed_ms"] = round((time.monotonic() - started) * 1000)

    def wait_plan(self, server, predicate, index=0):
        while time.monotonic() < self.deadline:
            plan = server.state(self.deadline)["plans"][index]
            self.last_observed = {"plan_id": plan.get("plan_id"), "plan_state": plan.get("plan_state"), "decision_status": (plan.get("decision") or {}).get("status"), "tasks": [{k: task.get(k) for k in ("task_id", "attempt_id", "execution_state", "outcome", "fence", "event_seq")} for task in plan.get("tasks", [])]}
            if predicate(plan):
                return plan
            time.sleep(0.04)
        raise AssertionError("required_plan_state_not_reached_within_5s")

    def check_status(self, method, path, wanted, token=None, headers=None, raw=None):
        status, _, _ = self.main.request(method, path, token=token, headers=headers, raw=raw, deadline=self.deadline)
        require(status in wanted if isinstance(wanted, tuple) else status == wanted, "unexpected_http_status_" + str(status))
        return {"http_status": status}

    def startup(self):
        for label in ("main", "stop", "restart"):
            started = time.monotonic()
            try:
                server = self.server(label)
                setattr(self, label if label == "main" else label + "_server", server)
                self.results.append({"id": "startup-" + label, "status": "passed", "elapsed_ms": round((time.monotonic() - started) * 1000), "evidence": {"synthetic": True, "owned_pid": server.process.pid}})
            except Exception as error:
                self.results.append({"id": "startup-" + label, "status": "failed", "reason": "startup_" + type(error).__name__})

    def run(self):
        self.startup()
        if self.main is None:
            self.results.append({"id": "http-and-domain", "status": "unverified", "reason": "server_startup_failed"})
            return
        s = self.main
        for case_id, method, path, wanted, token, headers, raw in [
            ("unauth-state", "GET", "/api/state", 401, None, None, None),
            ("forged-host", "GET", "/health", 403, None, [("Host", "attacker.invalid")], None),
            ("forged-origin", "GET", "/health", 403, None, [("Origin", "https://attacker.invalid")], None),
            ("null-origin", "GET", "/health", 403, None, [("Origin", "null")], None),
            ("duplicate-host", "GET", "/health", (400, 403), None, [("Host", f"127.0.0.1:{s.port}"), ("Host", "attacker.invalid")], None),
            ("mcp-token-cannot-use-ui", "GET", "/api/state", 401, s.mcp_token, None, None),
            ("ui-token-cannot-use-mcp", "POST", "/mcp", 401, s.ui_token, None, b"{}"),
            ("query-rejected", "GET", "/api/state?x=1", 400, s.ui_token, None, None),
            ("oversized-body", "POST", "/api/action", 413, s.ui_token, None, b" " * 65537),
            ("duplicate-json-keys", "POST", "/api/action", 400, s.ui_token, None, b'{"operation":"pause_plan","operation":"start_plan","input":{}}'),
            ("escaped-duplicate-json-keys", "POST", "/api/action", 400, s.ui_token, None, b'{"operation":"pause_plan","\\u006fperation":"start_plan","input":{}}'),
            ("invalid-utf8", "POST", "/api/action", 400, s.ui_token, None, b'\xff'),
            ("unknown-action-field", "POST", "/api/action", 400, s.ui_token, None, b'{"operation":"pause_plan","input":{},"extra":true}'),
            ("claimed-principal-rejected", "POST", "/api/action", 400, s.ui_token, None, b'{"operation":"pause_plan","input":{"request_id":"x","payload":{},"principal_id":"synthetic-executor"}}'),
            ("fake-event-injection-rejected", "POST", "/api/action", 403, s.ui_token, None, b'{"operation":"record_executor_event","input":{"request_id":"x","payload":{}}}')
        ]:
            self.case(case_id, lambda m=method, p=path, w=wanted, t=token, h=headers, r=raw: self.check_status(m, p, w, t, h, r))
        self.case("bootstrap-security-headers", self.security_headers)
        self.case("anonymous-root-no-ui-credential", lambda: self.root_without_credential())
        self.case("mcp-root-no-ui-credential", lambda: self.root_without_credential(token=s.mcp_token))
        self.case("wrong-cookie-no-ui-credential", lambda: self.root_without_credential(cookie=s.cookie.split("=", 1)[0] + "=" + s.mcp_token))
        self.case("login-cookie-flags-and-authenticated-root", self.login_cookie)
        self.case("login-key-not-api-token", lambda: self.check_status("GET", "/api/state", 401, s.ui_key))
        self.case("cookie-not-api-bearer", lambda: self.check_status("GET", "/api/state", 401, headers=[("Cookie", s.cookie)]))
        self.case("session-wrong-key-denied", lambda: self.session_rejected({"key": "0" * 64}, 401))
        self.case("session-mcp-token-denied", lambda: self.session_rejected({"key": s.mcp_token}, 401))
        self.case("session-cross-origin-denied", lambda: self.session_rejected({"key": s.ui_key}, 403, origin="https://attacker.invalid"))
        self.case("session-missing-origin-denied", lambda: self.session_rejected({"key": s.ui_key}, 403, origin=None))
        self.case("session-unknown-field-denied", lambda: self.session_rejected({"key": s.ui_key, "extra": True}, 400))
        self.case("session-duplicate-key-denied", lambda: self.session_rejected(None, 400, raw=b'{"key":"x","key":"y"}'))
        self.case("session-invalid-utf8-denied", lambda: self.session_rejected(None, 400, raw=b'\xff'))
        self.case("mcp-discovery", lambda: self.rpc_ok("server/discover"))
        self.case("mcp-tools-no-human-decision", self.tools)
        for key in ("MCP-Protocol-Version", "Mcp-Method", "Accept"):
            self.case("mcp-missing-" + key.lower(), lambda k=key: self.rpc_rejected({k: None}))
        self.case("mcp-version-mismatch", lambda: self.rpc_rejected({"MCP-Protocol-Version": "2025-11-25"}))
        self.case("mcp-unsupported-version-supported-array", self.unsupported_version)
        self.case("mcp-method-mismatch", lambda: self.rpc_rejected({"Mcp-Method": "tools/call"}))
        self.case("mcp-name-missing", lambda: self.rpc_tool_rejected({"Mcp-Name": None}))
        self.case("mcp-name-mismatch", lambda: self.rpc_tool_rejected({"Mcp-Name": "iris_start_plan"}))
        self.case("mcp-self-approval-denied", self.self_approval)
        self.case("mcp-fake-event-denied", self.fake_event_tool)
        self.case("start-and-idempotent-receipt", self.start_main)
        self.case("same-request-conflict", self.request_conflict)
        self.case("automatic-worker-to-human-gate", self.human_gate)
        self.case("separate-plan-unaffected", self.plan_isolation)
        self.case("stale-human-decision-rejected", self.stale_decision)
        self.case("human-approve", self.approve)
        self.case("verified-result-evidence", self.complete_and_evidence)
        self.case("second-plan-start", self.start_second)
        self.case("human-reject-no-followup-attempt", self.reject)
        if self.stop_server:
            self.case("stop-before-proof-handoff-denied", self.request_stop)
            self.case("stop-proof-then-handoff", self.handoff)
        else:
            self.results.append({"id": "stop-proof-then-handoff", "status": "unverified", "reason": "stop_server_unavailable"})
        if self.restart_server:
            self.case("restart-fixture-active-attempt", self.prepare_restart)
            self.restart_unknown()
            self.case("same-db-second-owner-denied", self.second_owner)
            self.restore_hold()

    def security_headers(self):
        status, headers, _ = self.main.request("GET", "/", deadline=self.deadline)
        require(status == 200, "bootstrap_status")
        for key, wanted in {"cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer"}.items():
            require(headers.get(key) == wanted, "missing_bootstrap_security_header")
        csp = headers.get("content-security-policy", "")
        require("object-src 'none'" in csp and "frame-ancestors 'none'" in csp and "script-src 'self'" in csp, "weak_bootstrap_csp")
        return {"security_headers_present": True, "tokens_recorded": False}

    def root_without_credential(self, token=None, cookie=None):
        headers = [("Cookie", cookie)] if cookie is not None else None
        status, _, raw = self.main.request("GET", "/", token=token, headers=headers, deadline=self.deadline)
        require(status == 200, "anonymous_login_page_unavailable")
        require(re.search(rb'<meta\s+name="iris-ui-token"', raw) is None, "unauthenticated_root_exposes_ui_token_meta")
        require(self.main.ui_token.encode() not in raw and self.main.ui_key.encode() not in raw, "unauthenticated_root_exposes_ui_credential")
        return {"http_status": status, "ui_credential_exposed": False}

    def login_cookie(self):
        flags = self.main.cookie_attributes.lower()
        require("httponly" in flags and "samesite=strict" in flags and "path=/" in flags, "login_cookie_missing_security_flags")
        status, _, raw = self.main.request("GET", "/", headers=[("Cookie", self.main.cookie)], deadline=self.deadline)
        require(status == 200 and self.main.ui_token.encode() in raw, "authenticated_root_missing_bootstrap")
        require(self.main.ui_key.encode() not in raw and self.main.mcp_token.encode() not in raw, "authenticated_root_exposes_other_credential")
        return {"http_only": True, "same_site": "Strict", "cookie_recorded": False, "authenticated_bootstrap": True}

    def session_rejected(self, payload, wanted, origin="same", raw=None):
        headers = []
        if origin is not None:
            headers.append(("Origin", f"http://{self.main.host}:{self.main.port}" if origin == "same" else origin))
        status, response_headers, body = self.main.request("POST", "/session", payload, headers=headers, raw=raw, deadline=self.deadline)
        require(status == wanted, "invalid_session_request_status_" + str(status))
        require("set-cookie" not in response_headers, "failed_login_issued_cookie")
        require(all(secret.encode() not in body for secret in [self.main.ui_key, self.main.ui_token, self.main.mcp_token]), "session_failure_reflected_credential")
        return {"http_status": status, "cookie_issued": False}

    def unsupported_version(self):
        meta = {"io.modelcontextprotocol/protocolVersion": "2025-11-25", "io.modelcontextprotocol/clientCapabilities": {}}
        status, data = self.main.rpc("tools/list", {"_meta": meta}, headers={"MCP-Protocol-Version": "2025-11-25"}, deadline=self.deadline)
        require(status == 400 and data.get("error", {}).get("code") == -32022, "unsupported_version_error_missing")
        require(data["error"].get("data", {}).get("supported") == [VERSION], "unsupported_version_supported_array_missing")
        return {"http_status": status, "supported": [VERSION]}

    def rpc_ok(self, method):
        status, data = self.main.rpc(method, deadline=self.deadline)
        require(status == 200 and "result" in data and "error" not in data, "valid_mcp_request_rejected")
        return {"http_status": status, "method": method}

    def tools(self):
        _, data = self.main.rpc("tools/list", deadline=self.deadline)
        names = [tool["name"] for tool in data.get("result", {}).get("tools", [])]
        require("iris_snapshot" in names, "snapshot_tool_missing")
        require(not any("decision" in name or "executor_event" in name for name in names), "privileged_tool_public")
        return {"public_tool_names": names}

    def rpc_rejected(self, headers):
        status, data = self.main.rpc("tools/list", headers=headers, deadline=self.deadline)
        require(status == 400 and "error" in data, "invalid_mcp_mirror_accepted")
        return {"http_status": status, "rpc_error_code": data["error"].get("code")}

    def rpc_tool_rejected(self, headers):
        status, data = self.main.rpc("tools/call", {"name": "iris_snapshot", "arguments": {}}, headers=headers, deadline=self.deadline)
        require(status == 400 and "error" in data, "invalid_mcp_name_mirror_accepted")
        return {"http_status": status}

    def self_approval(self):
        _, data = self.main.rpc("tools/call", {"name": "iris_submit_decision", "arguments": {}}, deadline=self.deadline)
        structured = data.get("result", {}).get("structuredContent", {})
        require(structured.get("error", {}).get("code") == "HUMAN_DECISION_REQUIRED", "mcp_human_decision_not_denied")
        return {"code": "HUMAN_DECISION_REQUIRED"}

    def fake_event_tool(self):
        _, data = self.main.rpc("tools/call", {"name": "iris_record_executor_event", "arguments": {}}, deadline=self.deadline)
        require("error" in data, "fake_executor_tool_exposed")
        return {"rpc_error_code": data["error"].get("code")}

    def start_main(self):
        plan = self.main.state(self.deadline)["plans"][0]
        self.original_start = start_payload(plan)
        self.original_id = "acceptance-start"
        status, first, _ = self.main.action("start_plan", self.original_start, self.original_id, self.deadline)
        require(status == 200 and first.get("ok") is True, "start_not_accepted")
        _, second, _ = self.main.action("start_plan", self.original_start, self.original_id, self.deadline)
        require(first.get("receipt") == second.get("receipt"), "retry_receipt_changed")
        self.first_receipt = first["receipt"]
        return {"same_receipt": True, "run_id": first["snapshot"]["plans"][0]["run_id"]}

    def request_conflict(self):
        if not hasattr(self, "original_start"):
            raise NotVerified("start_precondition_missing")
        changed = dict(self.original_start, plan_hash="changed-synthetic-content")
        status, data, _ = self.main.action("start_plan", changed, self.original_id, self.deadline)
        require(status == 409 and data.get("code") == "REQUEST_CONFLICT", "conflicting_request_accepted")
        return {"code": data["code"]}

    def human_gate(self):
        plan = self.wait_plan(self.main, lambda p: p.get("plan_state") == "waiting_decision")
        require(plan["tasks"][0]["outcome"] == "succeeded", "first_step_not_completed")
        require(plan["tasks"][1]["attempt_id"] is None, "decision_task_started_without_human")
        self.gate_plan = plan
        return {"plan_state": plan["plan_state"], "human_task_not_dispatched": True}

    def plan_isolation(self):
        plan = self.main.state(self.deadline)["plans"][1]
        require(plan["plan_state"] == "ready" and plan["run_id"] is None, "unselected_plan_started")
        return {"second_plan": "ready"}

    def stale_decision(self):
        plan = self.main.state(self.deadline)["plans"][0]
        payload = decision_payload(plan)
        payload["content_hash"] = "synthetic-old-content"
        status, data, _ = self.main.action("submit_decision", payload, deadline=self.deadline)
        require(status == 409 and data.get("code") == "STALE_APPROVAL", "stale_decision_accepted")
        return {"code": data["code"]}

    def approve(self):
        plan = self.main.state(self.deadline)["plans"][0]
        status, data, _ = self.main.action("submit_decision", decision_payload(plan), deadline=self.deadline)
        require(status == 200 and data.get("ok") is True, "human_approval_not_accepted")
        return {"human_ui_approval_accepted": True, "formal_human_auth_proven": False}

    def complete_and_evidence(self):
        plan = self.wait_plan(self.main, lambda p: p.get("plan_state") == "completed")
        checked = []
        for task in plan["tasks"]:
            evidence = task.get("evidence") or {}
            payload = evidence.get("payload")
            require(evidence.get("kind") == "synthetic-sha256" and isinstance(payload, str), "missing_result_evidence")
            calculated = hashlib.sha256(payload.encode("utf-8")).hexdigest()
            require(calculated == evidence.get("sha256"), "result_hash_mismatch")
            expected = f'synthetic:completed:{task["attempt_id"]}:{task["fence"]}:{task["instruction_hash"]}'
            require(payload == expected, "result_evidence_binding_mismatch")
            checked.append({"task_id": task["task_id"], "sha256": calculated})
        return {"independently_recomputed": checked}

    def start_second(self):
        plan = self.main.state(self.deadline)["plans"][1]
        status, data, _ = self.main.action("start_plan", start_payload(plan), deadline=self.deadline)
        require(status == 200 and data.get("ok") is True, "second_plan_start_failed")

    def reject(self):
        plan = self.wait_plan(self.main, lambda p: p.get("plan_state") == "waiting_decision", 1)
        status, data, _ = self.main.action("submit_decision", decision_payload(plan, "reject"), deadline=self.deadline)
        require(status == 200 and data.get("ok") is True, "human_rejection_failed")
        time.sleep(0.35)
        current = self.main.state(self.deadline)["plans"][1]
        require(current["plan_state"] == "blocked" and current["tasks"][1]["attempt_id"] is None, "rejected_task_dispatched")
        return {"rejected_task_not_dispatched": True}

    def request_stop(self):
        server = self.stop_server
        plan = server.state(self.deadline)["plans"][0]
        status, data, _ = server.action("start_plan", start_payload(plan), deadline=self.deadline)
        require(status == 200 and data.get("ok"), "stop_fixture_start_failed")
        plan = self.wait_plan(server, lambda p: p["tasks"][0]["execution_state"] in ["accepted", "running"])
        task = plan["tasks"][0]
        early = {"old_attempt_id": task["attempt_id"], "stop_receipt_id": "invented-proof", "new_executor_id": "synthetic-executor-backup"}
        status, data, _ = server.action("handoff_task", early, deadline=self.deadline)
        require(status == 409 and data.get("code") == "STOP_UNCONFIRMED", "handoff_before_stop_accepted")
        status, data, _ = server.action("request_stop", {"attempt_id": task["attempt_id"], "fence": task["fence"]}, deadline=self.deadline)
        require(status == 200 and data.get("ok"), "stop_request_failed")
        require(data["snapshot"]["plans"][0]["tasks"][0]["execution_state"] == "stop_requested", "stop_receipt_pretended_confirmation")
        self.old_task = task
        return {"stop_receipt_not_stop_confirmation": True}

    def handoff(self):
        if not hasattr(self, "old_task"):
            raise NotVerified("stop_precondition_missing")
        plan = self.wait_plan(self.stop_server, lambda p: p["tasks"][0]["execution_state"] == "stopped_confirmed")
        task = plan["tasks"][0]
        evidence = task.get("evidence") or {}
        require(evidence.get("sha256") == hashlib.sha256(evidence.get("payload", "").encode()).hexdigest(), "stop_evidence_hash_mismatch")
        expected = f'synthetic:stopped:no-effects:{task["attempt_id"]}:{task["fence"]}'
        require(evidence.get("payload") == expected and task.get("outcome") == "failed", "stop_effects_not_reconciled")
        status, data, _ = self.stop_server.action("handoff_task", {"old_attempt_id": task["attempt_id"], "stop_receipt_id": task["stop_receipt_id"], "new_executor_id": "synthetic-executor-backup"}, deadline=self.deadline)
        require(status == 200 and data.get("ok"), "verified_handoff_failed")
        new = data["snapshot"]["plans"][0]["tasks"][0]
        require(new["fence"] > task["fence"] and new["attempt_id"] != task["attempt_id"], "handoff_did_not_fence_old_owner")
        return {"old_attempt": task["attempt_id"], "new_attempt": new["attempt_id"], "old_fence": task["fence"], "new_fence": new["fence"]}

    def prepare_restart(self):
        server = self.restart_server
        plan = server.state(self.deadline)["plans"][0]
        status, data, _ = server.action("start_plan", start_payload(plan), deadline=self.deadline)
        require(status == 200 and data.get("ok"), "restart_fixture_start_failed")
        plan = self.wait_plan(server, lambda p: p["tasks"][0]["execution_state"] in ["accepted", "running"])
        self.before_restart = plan["tasks"][0]

    def restart_unknown(self):
        if not hasattr(self, "before_restart"):
            self.results.append({"id": "restart-unknown-no-redispatch", "status": "unverified", "reason": "active_attempt_not_observed"})
            return
        old = self.restart_server
        database = old.db
        old.close()
        try:
            self.restart_server = self.server("restarted", database=database)
        except Exception as error:
            self.results.append({"id": "restart-server-startup", "status": "failed", "reason": type(error).__name__})
            return
        self.case("restart-unknown-no-redispatch", self.assert_restart_unknown)

    def assert_restart_unknown(self):
        time.sleep(0.6)
        plan = self.restart_server.state(self.deadline)["plans"][0]
        task = plan["tasks"][0]
        require(task["attempt_id"] == self.before_restart["attempt_id"] and task["fence"] == self.before_restart["fence"], "restart_created_new_attempt")
        require(task["outcome"] == "unknown" and task["execution_state"] == "unknown", "restart_guessed_old_outcome")
        status, data, _ = self.restart_server.action("continue_plan", {"run_id": plan["run_id"]}, deadline=self.deadline)
        require(status != 200 and data.get("ok") is False, "restart_unknown_automatically_resumed")
        return {"same_attempt": True, "outcome": "unknown", "no_redispatch": True}

    def second_owner(self):
        root = self.root / "second-owner"
        candidate = Server(self.binary, root, database=self.restart_server.db)
        self.servers.append(candidate)
        try:
            end = self.deadline
            while time.monotonic() < end:
                if candidate.process.poll() is not None:
                    require(candidate.process.returncode != 0 and not candidate.ready.exists(), "second_owner_not_rejected")
                    return {"second_owner_rejected": True}
                require(not candidate.ready.exists(), "second_owner_started")
                time.sleep(0.03)
            raise AssertionError("second_owner_did_not_fail_within_5s")
        finally:
            candidate.close()

    def restore_hold(self):
        backup = self.root / "synthetic-backup.sqlite3"
        try:
            source = sqlite3.connect(f"file:{self.restart_server.db.as_posix()}?mode=ro", uri=True, timeout=2)
            target = sqlite3.connect(backup, timeout=2)
            try:
                source.backup(target)
            finally:
                source.close()
                target.close()
            restored = self.server("restored", restore=backup)
        except Exception as error:
            self.results.append({"id": "restore-startup", "status": "failed", "reason": type(error).__name__})
            return
        def inspect():
            state = restored.state(self.deadline)
            require(state.get("restore_hold") is True, "restored_state_not_held")
            plan = state["plans"][0]
            before = [(t["attempt_id"], t["fence"]) for t in plan["tasks"]]
            status, data, _ = restored.action("pause_plan", {"run_id": plan["run_id"]}, deadline=self.deadline)
            require(status != 200 and data.get("code") == "RESTORE_HOLD", "restore_mutation_not_held")
            time.sleep(0.6)
            after = restored.state(self.deadline)["plans"][0]
            require(before == [(t["attempt_id"], t["fence"]) for t in after["tasks"]], "restore_dispatched_new_attempt")
            return {"restore_hold": True, "no_new_attempt": True}
        self.case("restore-inspection-only-hold", inspect)

    def close(self):
        errors = 0
        for server in reversed(self.servers):
            try:
                server.close()
            except Exception:
                errors += 1
        self.results.append({"id": "owned-process-cleanup", "status": "passed" if errors == 0 else "failed", "evidence": {"cleanup_errors": errors, "all_owned_processes_exited": all(s.process.poll() is not None for s in self.servers)}})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temp_root = Path(tempfile.mkdtemp(prefix="many-iris-http-acceptance-"))
    harness = Harness(binary, temp_root)
    started = time.time()
    try:
        try:
            harness.run()
        except Exception as error:
            harness.results.append({"id": "harness-orchestration", "status": "failed", "reason": type(error).__name__})
    finally:
        harness.close()
        # Only remove this newly allocated, resolved temporary child.
        safe_root = temp_root.resolve()
        require(safe_root.parent == Path(tempfile.gettempdir()).resolve() and safe_root.name.startswith("many-iris-http-acceptance-"), "cleanup_path_outside_owned_temp")
        try:
            shutil.rmtree(safe_root)
        except OSError:
            harness.results.append({"id": "temporary-artifact-cleanup", "status": "failed", "reason": "owned_temp_cleanup_failed"})
    counts = {name: sum(r["status"] == name for r in harness.results) for name in ("passed", "failed", "unverified")}
    receipt = {"kind": "synthetic-http-blackbox-acceptance", "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "harness_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "started_at_unix": round(started), "elapsed_seconds": round(time.time() - started, 3), "synthetic_only": True, "real_ai": False, "real_records": False, "independent_ui_acceptance": False, "ui_author_wrote_harness": True, "credentials_and_html_recorded": False, "limits": {"startup_seconds": 20, "case_seconds": 5}, "counts": counts, "results": harness.results}
    output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "counts": counts, "binary_sha256": receipt["binary_sha256"]}))
    return 0 if not counts["failed"] and not counts["unverified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
