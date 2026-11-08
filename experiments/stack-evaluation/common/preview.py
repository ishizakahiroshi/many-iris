"""Bounded localhost preview using a deliberately public synthetic credential.

Only generated tasks and a fixed harmless helper exist here. This credential is
not a security mechanism for real data. Never use this launcher for real records.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

from owned_job import OwnedJob

ROOT = Path(__file__).resolve().parent.parent
SYNTHETIC_TOKEN = "synthetic-local-preview-only"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--candidate', choices=('go', 'rust', 'python'), default='go')
    parser.add_argument('--port', type=int, default=8875)
    parser.add_argument('--duration', type=int, default=600)
    parser.add_argument('--name', default='preview')
    args = parser.parse_args()
    if not args.name.isalnum() or not 1 <= args.duration <= 3600 or not 1024 <= args.port <= 65535:
        parser.error('use an alphanumeric name, port 1024..65535, duration 1..3600')
    state = ROOT / 'output' / args.name
    state.mkdir(parents=True, exist_ok=True)
    stop_file = state / f'stop-{os.getpid()}.request'
    if stop_file.exists():
        parser.error('stop.request already exists; choose another preview name')
    if args.candidate == 'python':
        command = [sys.executable, '-B', str(ROOT / 'python' / 'server.py')]
    else:
        command = [str(ROOT / 'artifacts' / f'iris-stack-{args.candidate}.exe')]
    command += ['--db', str(state / 'state.sqlite'), '--fixture', str(ROOT / 'fixtures' / 'tasks-100.json'),
                '--helper', str(ROOT / 'common' / 'helper.py'), '--python', sys.executable,
                '--ui', str(ROOT / 'common' / 'index.html'), '--port', str(args.port), '--test-mode']
    job = process = None
    with (state / 'stderr.log').open('a', encoding='utf-8') as diagnostics:
        try:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=diagnostics, text=True, encoding='utf-8')
            job = OwnedJob(process)
            process.stdin.write(json.dumps(dict(token=SYNTHETIC_TOKEN)) + '\n')
            process.stdin.flush()
            lines = queue.Queue()
            threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True).start()
            ready = json.loads(lines.get(timeout=30))
            ready.update(url=f'http://127.0.0.1:{ready["port"]}',
                         executable_sha256=hashlib.sha256(Path(command[0]).read_bytes()).hexdigest(),
                         synthetic_only=True, stop_file=str(stop_file))
            (state / 'preview-ready.json').write_text(json.dumps(ready, indent=2) + '\n', encoding='utf-8')
            print(json.dumps(ready), flush=True)
            deadline = time.monotonic() + args.duration
            while process.poll() is None and time.monotonic() < deadline and not stop_file.exists():
                time.sleep(.2)
        finally:
            if job:
                job.close()
            if process:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=10)
                process.stdin.close()
                process.stdout.close()


if __name__ == '__main__':
    main()
