"""Bounded, opt-in stdio transport for an explicitly configured local agent.

This transport is deliberately not connected to the synthetic scheduler. It
does not discover provider credentials or start a real provider automatically.
"""
from __future__ import annotations

import json
import math
import os
import queue
import subprocess
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path


class AdapterError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class WorkRequest:
    run_id: str
    task_id: str
    plan_id: str
    plan_revision: int
    agent_epoch: int
    instruction: str

    def validate(self):
        for value in (self.run_id, self.task_id, self.plan_id):
            if not isinstance(value, str) or not value.strip() or len(value) > 200:
                raise AdapterError("invalid_identity")
        for value in (self.plan_revision, self.agent_epoch):
            if type(value) is not int or value < 1:
                raise AdapterError("invalid_revision")
        if not isinstance(self.instruction, str) or not self.instruction.strip():
            raise AdapterError("invalid_instruction")
        try:
            size = len(self.instruction.encode("utf-8"))
        except UnicodeError:
            raise AdapterError("invalid_instruction") from None
        if size > 32768:
            raise AdapterError("instruction_too_large")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise AdapterError("duplicate_result_field")
        result[key] = value
    return result


class LocalProcessAdapter:
    """Launches a pinned command once, never through a shell; no automatic retry.

    Timeout or malformed output means outcome_unknown: a process can have done
    its work before response loss. Caller must reconcile before another invoke.
    Only synthetic helpers are accepted in this candidate's validation.
    """

    def __init__(self, command, *, timeout=10.0, max_output=65536, cwd=None):
        if not isinstance(command, (tuple, list)) or not command:
            raise AdapterError("invalid_command")
        if any(not isinstance(arg, str) or "\x00" in arg for arg in command):
            raise AdapterError("invalid_command")
        executable = Path(command[0])
        if not executable.is_absolute() or not executable.is_file():
            raise AdapterError("executable_must_be_pinned")
        if executable.suffix.lower() in {".cmd", ".bat", ".ps1", ".sh"}:
            raise AdapterError("shell_scripts_not_supported")
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0.05 <= timeout <= 300:
            raise AdapterError("invalid_timeout")
        if type(max_output) is not int or not 64 <= max_output <= 1048576:
            raise AdapterError("invalid_output_limit")
        if cwd is not None and (not Path(cwd).is_absolute() or not Path(cwd).is_dir()):
            raise AdapterError("invalid_working_directory")
        self.command = tuple(command)
        self.timeout = float(timeout)
        self.max_output = max_output
        self.cwd = str(cwd) if cwd is not None else str(executable.parent)

    def describe(self):
        return {"kind": "local_process", "configured": True,
                "enabled": False, "real_provider_verified": False,
                "automatic_retry": False, "credential_discovery": False}

    def invoke(self, request: WorkRequest, *, allow_execution=False):
        request.validate()
        if allow_execution is not True:
            raise AdapterError("execution_not_enabled")
        payload = (json.dumps(asdict(request), ensure_ascii=True, allow_nan=False) + "\n").encode("utf-8")
        # Do not hand arbitrary API keys, Hub tokens, or provider homes to a child.
        allowed_environment = ("SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL")
        child_env = {key: os.environ[key] for key in allowed_environment if key in os.environ}
        child_env["PYTHONIOENCODING"] = "utf-8"
        child_env["PYTHONUTF8"] = "1"
        process = None
        readers = []
        writer = None
        sink = queue.Queue(maxsize=1)
        buffers = {"stdout": bytearray(), "stderr": bytearray()}
        buffer_lock = threading.Lock()

        def drain(stream, name):
            try:
                while True:
                    chunk = stream.read(4096)
                    if not chunk:
                        return
                    with buffer_lock:
                        total = sum(len(value) for value in buffers.values())
                        remaining = max(0, self.max_output - total)
                        buffers[name].extend(chunk[:remaining])
                        overflow = len(chunk) > remaining
                    if overflow:
                        try:
                            sink.put_nowait("output_limit")
                        except queue.Full:
                            pass
                        return
            except (OSError, ValueError):
                return
            finally:
                stream.close()

        try:
            process = subprocess.Popen(self.command, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False,
                cwd=self.cwd, env=child_env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            for name in buffers:
                reader = threading.Thread(target=drain, args=(getattr(process, name), name), daemon=True)
                reader.start()
                readers.append(reader)
            def write_input():
                try:
                    process.stdin.write(payload)
                    process.stdin.close()
                except (OSError, ValueError):
                    try:
                        sink.put_nowait("transport")
                    except queue.Full:
                        pass
            writer = threading.Thread(target=write_input, daemon=True)
            writer.start()
            deadline = time.monotonic() + self.timeout
            while process.poll() is None:
                if not sink.empty():
                    raise AdapterError("outcome_unknown_output_limit")
                if time.monotonic() >= deadline:
                    raise AdapterError("outcome_unknown_timeout")
                time.sleep(0.01)
            for reader in readers:
                reader.join(timeout=0.05)
            writer.join(timeout=0.05)
            if any(reader.is_alive() for reader in readers):
                raise AdapterError("outcome_unknown_open_pipe")
            if not sink.empty():
                raise AdapterError("outcome_unknown_output_limit")
            if process.returncode != 0:
                raise AdapterError("outcome_unknown_process_exit")
            try:
                result = json.loads(bytes(buffers["stdout"]).decode("utf-8"),
                    object_pairs_hook=_unique_object,
                    parse_constant=lambda _: (_ for _ in ()).throw(AdapterError("nonfinite_result")))
            except (ValueError, UnicodeError, RecursionError, AdapterError):
                raise AdapterError("outcome_unknown_invalid_result") from None
            expected = asdict(request)
            expected.pop("instruction")
            if type(result) is not dict or set(result) != set(expected) | {"status", "result"}:
                raise AdapterError("outcome_unknown_invalid_result")
            for key, value in expected.items():
                if type(result[key]) is not type(value) or result[key] != value:
                    raise AdapterError("outcome_unknown_identity_mismatch")
            if result["status"] != "completed" or not isinstance(result["result"], str):
                raise AdapterError("outcome_unknown_invalid_result")
            return result
        except (OSError, BrokenPipeError):
            raise AdapterError("outcome_unknown_transport") from None
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
                if writer is not None:
                    writer.join(timeout=0.5)
                # A descendant may inherit a pipe after the direct child exits.
                # BufferedIO.close() would wait for the reader's lock forever.
                # Its owning daemon reader closes it on EOF; do not close from
                # this thread while that read is active. Descendant containment
                # is intentionally NOT claimed by this transport candidate.
                if writer is None or not writer.is_alive():
                    process.stdin.close()
                for reader, stream in zip(readers, (process.stdout, process.stderr)):
                    reader.join(timeout=0.05)
                    if not reader.is_alive():
                        stream.close()
