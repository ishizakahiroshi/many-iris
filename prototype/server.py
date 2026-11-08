"""Loopback-only HTTP interface for the synthetic Many Iris foundation."""
from __future__ import annotations

import argparse
import json
import math
import re
import socket
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

MAX_BODY = 16_384
_ACTIONS = {
    "start": {"plan_id", "revision"},
    "tick": set(),
    "decide": {"approval_id", "decision", "revision"},
    "pause": {"run_id"},
    "resume": {"run_id"},
    "stop_agent": {"run_id"},
    "handoff": {"run_id"},
}
_ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}
_WEB = Path(__file__).with_name("web")
_POLICY = ("default-src 'self'; script-src 'self'; style-src 'self'; "
           "connect-src 'self'; img-src 'self'; object-src 'none'; "
           "base-uri 'none'; frame-ancestors 'none'; form-action 'self'")


class RequestError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        self.code, self.message, self.status = code, message, status


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise RequestError("invalid_json", "Duplicate JSON keys are not accepted.")
        result[key] = value
    return result


def _nonfinite(_value):
    raise RequestError("invalid_json", "Nonfinite numbers are not accepted.")


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, engine, port=0, tick_interval=0.8):
        if type(port) is not int or not 0 <= port <= 65535:
            raise ValueError("port must be between 0 and 65535")
        if (type(tick_interval) not in (int, float) or
                not math.isfinite(tick_interval) or tick_interval < 0):
            raise ValueError("tick_interval must be nonnegative")
        self.engine = engine
        from .scheduler import Scheduler
        self.scheduler = Scheduler(engine)
        self.tick_interval = tick_interval
        self._scheduler_stop = threading.Event()
        self._scheduler_thread = None
        self.scheduler_failed = False
        super().__init__(("127.0.0.1", port), Handler)

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.server_port}"

    def get_request(self):
        conn, address = super().get_request()
        conn.settimeout(5)
        return conn, address

    def start_scheduler(self):
        if self.tick_interval == 0 or self._scheduler_thread is not None:
            return
        self._scheduler_stop.clear()
        self._scheduler_thread = threading.Thread(
            target=self._schedule, name="many-iris-synthetic-scheduler", daemon=True
        )
        self._scheduler_thread.start()

    def _schedule(self):
        while not self._scheduler_stop.wait(self.tick_interval):
            try:
                self.scheduler.step()
            except Exception:
                # Failure must not terminate unrelated HTTP reads or leak DB details.
                self.scheduler_failed = True
                self._scheduler_stop.set()

    def stop_scheduler(self):
        self._scheduler_stop.set()
        if self._scheduler_thread is not None:
            self._scheduler_thread.join(timeout=6)
            self._scheduler_thread = None

    def server_close(self):
        self.stop_scheduler()
        super().server_close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ManyIrisLocal/1"
    sys_version = ""

    def log_message(self, _format, *_args):
        # No request body, source text or local DB path is written to the terminal.
        pass

    def _reply(self, status, body, content_type="application/json; charset=utf-8"):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", _POLICY)
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        if self.command != "HEAD":
            self.wfile.write(body)

    def _guard(self):
        expected = f"127.0.0.1:{self.server.server_port}"
        if self.headers.get_all("Host", []) != [expected]:
            raise RequestError("invalid_host", "Only the exact local host is accepted.", 403)
        origins = self.headers.get_all("Origin", [])
        if origins and origins != [self.server.origin]:
            raise RequestError("invalid_origin", "Only the local origin is accepted.", 403)
        initial_navigation = (self.command == "GET" and self.path == "/"
                              and self.headers.get("Sec-Fetch-Mode") == "navigate"
                              and self.headers.get("Sec-Fetch-Dest") == "document")
        if self.headers.get("Sec-Fetch-Site") == "cross-site" and not initial_navigation:
            raise RequestError("invalid_origin", "Cross-site requests are not accepted.", 403)
        if len(self.headers.get_all("Content-Length", [])) > 1:
            raise RequestError("invalid_length", "One Content-Length is accepted.")
        if self.headers.get("Transfer-Encoding") is not None:
            raise RequestError("invalid_transfer", "Transfer encoding is not supported.")
        if len(self.path) > 2048:
            raise RequestError("invalid_path", "Request path is too long.")
        try:
            target = urlsplit(self.path)
        except ValueError:
            raise RequestError("invalid_path", "A valid local path is required.") from None
        if target.scheme or target.netloc or target.fragment:
            raise RequestError("invalid_path", "An origin-relative path is required.")
        return target

    def _handle(self, operation):
        try:
            operation()
        except RequestError as exc:
            self._reply(exc.status, {"error": {"code": exc.code, "message": exc.message}})
        except (socket.timeout, TimeoutError):
            self._reply(408, {"error": {"code": "request_timeout", "message": "Request timed out."}})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as exc:
            # DomainError is imported lazily with the engine, so HTTP tests can inject a stub.
            if (exc.__class__.__name__ == "DomainError" and
                    getattr(exc, "status", None) in (400, 404, 409)):
                self._reply(exc.status, {"error": {"code": exc.code, "message": exc.message}})
            else:
                self._reply(500, {"error": {"code": "internal_error", "message": "Local operation failed."}})

    def do_GET(self):
        self._handle(self._get)

    def _get(self):
        target = self._guard()
        if target.path in _ASSETS:
            filename, content_type = _ASSETS[target.path]
            self._reply(200, (_WEB / filename).read_bytes(), content_type)
        elif target.path == "/api/snapshot" and not target.query:
            result = self.server.engine.snapshot()
            if self.server.scheduler_failed:
                result = dict(result, scheduler_error="scheduler_stopped")
            self._reply(200, result)
        elif target.path.startswith("/api/documents/") and not target.query:
            document_id = unquote(target.path[len("/api/documents/"):])
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", document_id):
                raise RequestError("invalid_document", "A document identifier is required.")
            self._reply(200, self.server.engine.document(document_id=document_id))
        elif target.path == "/api/notifications":
            args = parse_qs(target.query, keep_blank_values=True)
            if set(args) - {"after"} or len(args.get("after", [])) > 1:
                raise RequestError("invalid_query", "Only one after parameter is accepted.")
            after = args.get("after", ["0"])[0]
            if not re.fullmatch(r"[0-9]{1,12}", after):
                raise RequestError("invalid_query", "after must be a nonnegative integer.")
            self._reply(200, self.server.engine.notifications(after=int(after)))
        else:
            raise RequestError("not_found", "Local resource not found.", 404)

    def do_POST(self):
        self._handle(self._post)

    def _post(self):
        target = self._guard()
        if target.path != "/api/actions" or target.query:
            raise RequestError("not_found", "Local resource not found.", 404)
        types = self.headers.get_all("Content-Type", [])
        if (len(types) != 1 or types[0].split(";", 1)[0].strip().lower() != "application/json"):
            raise RequestError("invalid_content_type", "application/json is required.", 415)
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,10}", lengths[0]):
            raise RequestError("invalid_length", "One Content-Length is required.")
        size = int(lengths[0])
        if size > MAX_BODY:
            raise RequestError("body_too_large", "Request body is too large.", 413)
        raw = self.rfile.read(size)
        if len(raw) != size:
            raise RequestError("incomplete_body", "Request body is incomplete.")
        try:
            data = json.loads(raw.decode("utf-8"), object_pairs_hook=_object, parse_constant=_nonfinite)
        except (ValueError, RecursionError):
            raise RequestError("invalid_json", "A valid UTF-8 JSON object is required.") from None
        if type(data) is not dict:
            raise RequestError("invalid_action", "A JSON object is required.")
        action = data.get("action")
        if type(action) is not str or action not in _ACTIONS:
            raise RequestError("invalid_action", "Unknown local action.")
        required = _ACTIONS[action]
        optional = {"run_id"} if action == "tick" else set()
        if set(data) - ({"action", "request_id"} | required | optional) or not required <= set(data):
            raise RequestError("invalid_fields", "Action fields do not match the operation.")
        request_id = data.get("request_id")
        if type(request_id) is not str or not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", request_id):
            raise RequestError("invalid_request_id", "A request identifier is required.")
        args = {key: value for key, value in data.items() if key != "action"}
        for key in ("plan_id", "run_id", "approval_id"):
            if key in args and (type(args[key]) is not str or not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", args[key])):
                raise RequestError("invalid_identifier", "A valid entity identifier is required.")
        if "revision" in args and (type(args["revision"]) is not int or args["revision"] < 1):
            raise RequestError("invalid_revision", "A positive integer revision is required.")
        if "decision" in args and args["decision"] not in ("approve", "reject"):
            raise RequestError("invalid_decision", "approve or reject is required.")
        if action == "tick":
            # Tick has no user mutation token in the engine contract; it is synthetic only.
            args.pop("request_id")
        self._reply(200, getattr(self.server.engine, action)(**args))

    def do_OPTIONS(self):
        self._handle(lambda: (_ for _ in ()).throw(RequestError("method_not_allowed", "Method not allowed.", 405)))

    do_PUT = do_OPTIONS
    do_DELETE = do_OPTIONS
    do_PATCH = do_OPTIONS
    do_HEAD = do_OPTIONS


def make_server(engine, port=0, tick_interval=0.8):
    """Create a local server. Caller owns serve_forever and scheduler lifetime."""
    return LocalServer(engine, port=port, tick_interval=tick_interval)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Many Iris synthetic local foundation")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--db", default=".state/foundation.sqlite3")
    parser.add_argument("--tick-interval", type=float, default=0.8)
    options = parser.parse_args(argv)
    from .engine import Engine
    db = Path(options.db).resolve()
    db.parent.mkdir(parents=True, exist_ok=True)
    from .lease import ExecutionLease
    lease = ExecutionLease(db)
    try:
        lease.__enter__()
    except RuntimeError as error:
        parser.exit(2, str(error) + "\n")
    server = None
    try:
        engine = Engine(str(db))
        engine.seed_demo()
        server = make_server(engine, options.port, options.tick_interval)
        server.start_scheduler()
        print(json.dumps({"url": server.origin, "synthetic": True, "external_execution": False}), flush=True)
        try:
            server.serve_forever(poll_interval=0.2)
        except KeyboardInterrupt:
            pass
    finally:
        if server is not None:
            server.server_close()
        lease.__exit__(None, None, None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
