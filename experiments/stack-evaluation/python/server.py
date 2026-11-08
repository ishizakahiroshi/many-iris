"""Independent synthetic SQLite/HTTP/process candidate; no provider integration."""
import argparse
import contextlib
import ctypes
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ownership import OwnershipLock
if os.name == "nt":
    from windows_job import JobProcess


class DomainError(Exception):
    pass


def require(condition, code="INVALID"):
    if not condition:
        raise DomainError(code)


def identifier(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value))
    return value


def integer(value, minimum=0, maximum=2**53 - 1):
    require(type(value) is int and minimum <= value <= maximum)
    return value


def alive(pid):
    if not pid:
        return False
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            # Access denied is uncertainty, not proof of termination.
            return ctypes.get_last_error() != 87
        try:
            code = ctypes.c_ulong()
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


FIELDS = {
    "list": ({"offset", "limit"}, set()), "detail": ({"task_id"}, {"task_id"}),
    "start": ({"task_id", "request_id"}, {"task_id", "request_id"}),
    "approve": ({"run_id", "revision", "source_hash", "expires_at"}, {"run_id", "revision", "source_hash", "expires_at"}),
    "reject": ({"run_id"}, {"run_id"}), "revoke": ({"run_id"}, {"run_id"}),
    "enqueue": ({"run_id"}, {"run_id"}), "dispatch": ({"run_id", "mode"}, {"run_id", "mode"}),
    "status": ({"run_id"}, {"run_id"}), "stop": ({"run_id"}, {"run_id"}),
    "result": ({"run_id", "epoch", "attempt", "revision", "source_hash"}, {"run_id", "epoch", "attempt", "revision", "source_hash"}),
    "snapshot": ({"path"}, {"path"}), "advance": ({"seconds"}, {"seconds"}),
    "revise": ({"task_id", "source"}, {"task_id", "source"}), "fault": ({"kind"}, {"kind"}),
}
TEST_OPS = {"snapshot", "advance", "revise", "fault", "result"}
READ_OPS = {"list", "detail", "status", "snapshot"}


class Engine:
    def __init__(self, db, fixture, helper, python, test_mode=False, restored=False):
        self.path = Path(db).resolve()
        # Acquire before SQLite opens, changes schema, or advances the epoch.
        self.ownership = OwnershipLock(self.path)
        self.helper, self.python = str(Path(helper).resolve()), str(Path(python).resolve())
        self.test_mode = test_mode
        self.lock = threading.RLock()
        self.children = {}
        self.db = sqlite3.connect(self.path, timeout=1, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
            PRAGMA busy_timeout=1000;
            CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1),
                schema_version INTEGER, epoch INTEGER, now INTEGER, execution_enabled INTEGER, fault TEXT);
            CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,title TEXT,source TEXT,source_hash TEXT,revision INTEGER);
            CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id),
                request_id TEXT UNIQUE,state TEXT,epoch INTEGER,attempt INTEGER,revision INTEGER,
                source_hash TEXT,expires_at INTEGER,pid INTEGER,events_path TEXT,mode TEXT);
            CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id));
            CREATE UNIQUE INDEX IF NOT EXISTS one_active_task ON runs(task_id)
                WHERE state NOT IN ('completed','rejected','stopped');
        """)
        with self.transaction():
            meta = self.db.execute("SELECT * FROM metadata").fetchone()
            if meta is None:
                source = json.loads(Path(fixture).read_text(encoding="utf-8"))
                require(source.get("version") == 1)
                integer(source["now"])
                self.db.execute("INSERT INTO metadata VALUES(1,1,0,?,1,'none')", (source["now"],))
                for task in source["tasks"]:
                    identifier(task["id"])
                    require(task["source_hash"] == hashlib.sha256(task["source"].encode()).hexdigest())
                    self.db.execute("INSERT INTO tasks VALUES(?,?,?,?,?)", (task["id"], task["title"], task["source"], task["source_hash"], task["revision"]))
            else:
                require(meta["schema_version"] == 1)
            self.db.execute("UPDATE metadata SET epoch=epoch+1")
            if restored:
                self.db.execute("UPDATE metadata SET execution_enabled=0")
            self.db.execute("UPDATE runs SET state='unknown' WHERE state IN ('running','stop_unconfirmed','dispatching')")
            self.db.execute("UPDATE runs SET state='waiting',expires_at=NULL WHERE state IN ('approved','queued')")
        self.epoch = self.meta()["epoch"]

    @contextlib.contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def meta(self):
        return self.db.execute("SELECT * FROM metadata WHERE id=1").fetchone()

    def task(self, task_id):
        result = self.db.execute("SELECT * FROM tasks WHERE id=?", (identifier(task_id),)).fetchone()
        require(result is not None, "NOT_FOUND")
        return dict(result)

    def run(self, run_id):
        result = self.db.execute("SELECT * FROM runs WHERE id=?", (identifier(run_id),)).fetchone()
        require(result is not None, "NOT_FOUND")
        value = dict(result)
        value["run_id"] = value["id"]
        return value

    def grant(self, run):
        task = self.task(run["task_id"])
        require(run["epoch"] == self.epoch and run["revision"] == task["revision"]
                and run["source_hash"] == task["source_hash"]
                and run["expires_at"] is not None and run["expires_at"] > self.meta()["now"], "STALE_APPROVAL")

    def event_data(self, run):
        try:
            data = Path(run["events_path"]).read_text(encoding="utf-8")
        except (OSError, TypeError):
            return []
        events = []
        for line in data.splitlines():
            try:
                event = json.loads(line)
                if event.get("run_id") == run["id"] and event.get("epoch") == run["epoch"] and event.get("attempt") == run["attempt"]:
                    events.append(event)
            except (ValueError, AttributeError):
                continue
        return events

    def descendants(self, run):
        return {e["child_pid"] for e in self.event_data(run)
                if e.get("kind") == "descendant" and type(e.get("child_pid")) is int and e["child_pid"] > 0}

    def refresh(self, run):
        if run["state"] != "running":
            return run
        child = self.children.get(run["id"])
        if child is None:
            state = "unknown"
        elif child.poll() is None:
            return run
        elif (child.active() > 0 if os.name == "nt" else any(alive(pid) for pid in self.descendants(run))):
            if any(alive(pid) for pid in self.descendants(run)):
                state = "stop_unconfirmed"
            else:
                # Windows process signaling and Job accounting are not atomic.
                # Remain active/held until the Job proves zero; an exited parent
                # alone must neither complete nor permanently misclassify a run.
                return run
        elif child.returncode != 0 or self.meta()["fault"] == "result_full":
            state = "unknown"
        else:
            task = self.task(run["task_id"])
            complete = any(e.get("kind") == "completed" for e in self.event_data(run))
            binding = run["epoch"] == self.epoch and run["revision"] == task["revision"] and run["source_hash"] == task["source_hash"]
            state = "completed" if complete and binding else "unknown"
        with self.transaction():
            self.db.execute("UPDATE runs SET state=? WHERE id=? AND state='running'", (state, run["id"]))
        return self.run(run["id"])

    def apply(self, request):
        require(type(request) is dict and type(request.get("op")) is str)
        op = request["op"]
        require(op in FIELDS)
        allowed, needed = FIELDS[op]
        require(set(request) <= allowed | {"op"} and needed <= set(request))
        require(op not in TEST_OPS or self.test_mode, "INVALID")
        with self.lock:
            if op not in READ_OPS:
                require(bool(self.meta()["execution_enabled"]), "RESTORE_HOLD")
            if op == "list":
                offset = integer(request.get("offset", 0))
                limit = integer(request.get("limit", 50), 1, 100)
                return dict(tasks=[dict(r) for r in self.db.execute("SELECT id,title,revision FROM tasks ORDER BY id LIMIT ? OFFSET ?", (limit, offset))],
                            total=self.db.execute("SELECT count(*) FROM tasks").fetchone()[0])
            if op == "detail":
                return self.task(request["task_id"])
            if op == "status":
                return self.refresh(self.run(request["run_id"]))
            if op == "snapshot":
                require(type(request["path"]) is str and ".." not in Path(request["path"]).parts)
                target = Path(request["path"])
                target = (self.path.parent / target).resolve() if not target.is_absolute() else target.resolve()
                require(target.parent == self.path.parent and target != self.path and not target.exists())
                descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(descriptor)
                with contextlib.closing(sqlite3.connect(target)) as backup:
                    self.db.backup(backup)
                return {"path": str(target)}
            if op == "dispatch":
                return self.dispatch(request)
            if op == "stop":
                return self.stop(request["run_id"])
            with self.transaction():
                if op == "start":
                    task_id, request_id = identifier(request["task_id"]), identifier(request["request_id"])
                    self.task(task_id)
                    previous = self.db.execute("SELECT * FROM requests WHERE request_id=?", (request_id,)).fetchone()
                    if previous:
                        require(previous["task_id"] == task_id, "REQUEST_CONFLICT")
                        return self.run(request_id)
                    active = self.db.execute("SELECT 1 FROM runs WHERE task_id=? AND state NOT IN ('completed','rejected','stopped')", (task_id,)).fetchone()
                    require(active is None, "ACTIVE_RUN")
                    task = self.task(task_id)
                    self.db.execute("INSERT INTO requests VALUES(?,?)", (request_id, task_id))
                    self.db.execute("INSERT INTO runs(id,task_id,request_id,state,epoch,attempt,revision,source_hash) VALUES(?,?,?,'waiting',?,1,?,?)", (request_id, task_id, request_id, self.epoch, task["revision"], task["source_hash"]))
                    return self.run(request_id)
                if op == "advance":
                    self.db.execute("UPDATE metadata SET now=now+?", (integer(request["seconds"], 0, 86400),))
                    return {"now": self.meta()["now"]}
                if op == "fault":
                    require(request["kind"] in ("none", "intent_full", "result_full", "busy"))
                    self.db.execute("UPDATE metadata SET fault=?", (request["kind"],))
                    return {"kind": request["kind"]}
                if op == "revise":
                    task = self.task(request["task_id"])
                    require(type(request["source"]) is str and len(request["source"].encode()) <= 32000)
                    self.db.execute("UPDATE tasks SET source=?,source_hash=?,revision=revision+1 WHERE id=?", (request["source"], hashlib.sha256(request["source"].encode()).hexdigest(), task["id"]))
                    self.db.execute("UPDATE runs SET state='waiting',expires_at=NULL WHERE task_id=? AND state IN ('approved','queued')", (task["id"],))
                    return self.task(task["id"])
                run = self.run(request["run_id"])
                if op == "approve":
                    task = self.task(run["task_id"])
                    require(run["state"] == "waiting", "STATE")
                    require(type(request["revision"]) is int and request["revision"] == task["revision"]
                            and request["source_hash"] == task["source_hash"]
                            and type(request["expires_at"]) is int and request["expires_at"] > self.meta()["now"], "STALE_APPROVAL")
                    integer(request["expires_at"])
                    self.db.execute("UPDATE runs SET state='approved',epoch=?,revision=?,source_hash=?,expires_at=? WHERE id=?", (self.epoch, task["revision"], task["source_hash"], request["expires_at"], run["id"]))
                elif op == "reject":
                    require(run["state"] in ("waiting", "approved", "queued"), "STATE")
                    self.db.execute("UPDATE runs SET state='rejected',expires_at=NULL WHERE id=?", (run["id"],))
                elif op == "revoke":
                    require(run["state"] in ("approved", "queued"), "STATE")
                    self.db.execute("UPDATE runs SET state='waiting',expires_at=NULL WHERE id=?", (run["id"],))
                elif op == "enqueue":
                    require(run["state"] == "approved", "STATE")
                    self.grant(run)
                    self.db.execute("UPDATE runs SET state='queued' WHERE id=?", (run["id"],))
                elif op == "result":
                    task = self.task(run["task_id"])
                    require(all(type(request[k]) is int and request[k] == run[k] for k in ("epoch", "attempt", "revision"))
                            and request["source_hash"] == run["source_hash"] and run["revision"] == task["revision"]
                            and run["source_hash"] == task["source_hash"] and run["epoch"] == self.epoch, "STALE_RESULT")
                    require(run["state"] == "running", "STATE")
                    # A caller assertion cannot complete a still-live process.
                    child = self.children.get(run["id"])
                    require(child is not None and child.poll() == 0, "STATE")
                    require(child.active() == 0 if os.name == "nt" else not any(alive(p) for p in self.descendants(run)), "STATE")
                    require(any(event.get("kind") == "completed" for event in self.event_data(run)), "STATE")
                    require(self.meta()["fault"] != "result_full", "STORAGE")
                    self.db.execute("UPDATE runs SET state='completed' WHERE id=?", (run["id"],))
                return self.run(run["id"])

    def dispatch(self, request):
        run = self.run(request["run_id"])
        mode = request["mode"]
        require(mode in ("success", "slow", "orphan"))
        require(self.test_mode or mode == "success")
        events_path = self.path.parent / (run["id"] + ".events.jsonl")
        with self.transaction():
            require(run["state"] == "queued", "STATE")
            self.grant(run)
            require(self.meta()["fault"] not in ("intent_full", "busy"), "STORAGE")
            require(not events_path.exists(), "STATE")
            self.db.execute("UPDATE runs SET state='dispatching',events_path=?,mode=? WHERE id=?", (str(events_path), mode, run["id"]))
        try:
            argv = [self.python, self.helper, "--events", str(events_path),
                    "--mode", mode, "--run-id", run["id"], "--epoch", str(run["epoch"]),
                    "--attempt", str(run["attempt"])]
            child = JobProcess(argv) if os.name == "nt" else subprocess.Popen(
                argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.children[run["id"]] = child
            with self.transaction():
                self.db.execute("UPDATE runs SET state='running',pid=? WHERE id=?", (child.pid, run["id"]))
        except (OSError, sqlite3.Error):
            # Durable intent stays fail-closed even if launch/result persistence is uncertain.
            with self.transaction():
                self.db.execute("UPDATE runs SET state='unknown' WHERE id=?", (run["id"],))
            raise DomainError("STORAGE")
        return self.run(run["id"])

    def stop(self, run_id):
        run = self.run(run_id)
        require(run["state"] not in ("completed", "rejected", "stopped"), "STATE")
        if run["state"] in ("waiting", "approved", "queued"):
            with self.transaction():
                self.db.execute("UPDATE runs SET state='stopped',expires_at=NULL WHERE id=?", (run["id"],))
            return self.run(run["id"])
        # No in-memory process handle after restart: do not signal a possibly reused PID.
        child = self.children.get(run["id"])
        with self.transaction():
            self.db.execute("UPDATE runs SET state=?,expires_at=NULL WHERE id=?", (
                "unknown" if run["state"] == "unknown" else "stop_unconfirmed", run["id"]))
        if child is None:
            return self.run(run["id"])
        descendants = self.descendants(run)
        confirmed = False
        uncertain_outcome = run["state"] == "unknown"
        if os.name == "nt":
            confirmed = child.terminate_tree()
        elif child.poll() is None:
            child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            return self.run(run["id"])
        if os.name != "nt":
            # POSIX path is diagnostic only; no process-tree guarantee.
            confirmed = run["state"] == "running" and not descendants
        if confirmed and not uncertain_outcome:
            with self.transaction():
                self.db.execute("UPDATE runs SET state='stopped' WHERE id=?", (run["id"],))
        elif uncertain_outcome:
            with self.transaction():
                self.db.execute("UPDATE runs SET state='unknown' WHERE id=?", (run["id"],))
        return self.run(run["id"])

    def close(self):
        with self.lock:
            for run_id, child in self.children.items():
                if child.poll() is None:
                    try:
                        self.stop(run_id)
                    except (OSError, subprocess.SubprocessError, sqlite3.Error, DomainError):
                        pass
                if os.name == "nt":
                    child.close()
            self.db.close()
            self.ownership.close()


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "SyntheticCandidate"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *_):
        pass

    def reply(self, status, payload, mime="application/json"):
        data = json.dumps(payload, separators=(",", ":")).encode() if mime == "application/json" else payload
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def transport(self, authenticated=False):
        expected = f"127.0.0.1:{self.server.server_port}"
        require(self.headers.get_all("Host") == [expected], "INVALID")
        origins = self.headers.get_all("Origin")
        require(origins is None or origins == ["http://" + expected], "INVALID")
        if authenticated:
            credentials = self.headers.get_all("Authorization")
            require(credentials is not None and len(credentials) == 1
                    and hmac.compare_digest(credentials[0], "Bearer " + self.server.token), "AUTH")

    def do_GET(self):
        try:
            self.transport()
            if self.path == "/health":
                self.reply(200, {"ok": True})
            elif self.path == "/":
                self.reply(200, self.server.ui, "text/html; charset=utf-8")
            else:
                self.reply(404, {"ok": False, "error": "NOT_FOUND"})
        except DomainError as error:
            self.reply(403, {"ok": False, "error": str(error)})

    def do_POST(self):
        try:
            self.transport(authenticated=True)
            require(self.path == "/api", "NOT_FOUND")
            lengths = self.headers.get_all("Content-Length")
            require(lengths is not None and len(lengths) == 1 and lengths[0].isdigit())
            length = int(lengths[0])
            require(self.headers.get("Transfer-Encoding") is None)
            if length > 65536:
                # Drain at most one byte beyond the limit before closing. For the
                # boundary probe this preserves the JSON rejection instead of an
                # unread-body TCP reset; arbitrary-size bodies are never buffered.
                self.rfile.read(min(length, 65537))
                raise DomainError("INVALID")
            require(length > 0)
            data = self.rfile.read(length)
            require(len(data) == length)
            request = json.loads(data, object_pairs_hook=object_pairs,
                                 parse_constant=lambda _: (_ for _ in ()).throw(DomainError("INVALID")))
            self.reply(200, {"ok": True, "data": self.server.engine.apply(request)})
        except DomainError as error:
            self.reply(400, {"ok": False, "error": str(error)})
        except (ValueError, TypeError, KeyError, UnicodeError):
            self.reply(400, {"ok": False, "error": "INVALID"})
        except (sqlite3.Error, OSError, subprocess.SubprocessError):
            self.reply(409, {"ok": False, "error": "STORAGE"})

    def do_OPTIONS(self):
        self.reply(405, {"ok": False, "error": "INVALID"})

    do_PUT = do_DELETE = do_PATCH = do_CONNECT = do_TRACE = do_OPTIONS

    def do_HEAD(self):
        self.send_response(405)
        self.send_header("Content-Length", "0")
        self.end_headers()


def main():
    parser = argparse.ArgumentParser()
    for argument in ("db", "fixture", "helper", "python", "ui"):
        parser.add_argument("--" + argument, required=True)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--test-mode", action="store_true")
    parser.add_argument("--restored", action="store_true")
    args = parser.parse_args()
    handshake = json.loads(sys.stdin.readline(4097), object_pairs_hook=object_pairs)
    require(set(handshake) == {"token"} and isinstance(handshake["token"], str)
            and 16 <= len(handshake["token"]) <= 256 and handshake["token"].isascii())
    engine = Engine(args.db, args.fixture, args.helper, args.python, args.test_mode, args.restored)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    server.engine, server.token, server.ui = engine, handshake["token"], Path(args.ui).read_bytes()
    print(json.dumps(dict(port=server.server_port, pid=os.getpid(), sqlite_version=sqlite3.sqlite_version, language="python")), flush=True)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    try:
        server.serve_forever(poll_interval=.05)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        engine.close()


if __name__ == "__main__":
    main()
