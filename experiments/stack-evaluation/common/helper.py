"""Fixed harmless workload; event stream is independently observable by root."""
import argparse
import json
import os
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--events", required=True)
    parser.add_argument("--mode", choices=("success", "slow", "orphan", "descendant"), required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--epoch", type=int, required=True)
    parser.add_argument("--attempt", type=int, required=True)
    args = parser.parse_args()

    def emit(kind, **extra):
        event = dict(kind=kind, run_id=args.run_id, epoch=args.epoch,
                     attempt=args.attempt, pid=os.getpid(), **extra)
        with open(args.events, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(event, separators=(",", ":")) + "\n")
            stream.flush()
            os.fsync(stream.fileno())

    emit("started")
    if args.mode in ("orphan", "slow"):
        child = subprocess.Popen([sys.executable, __file__, "--events", args.events,
                                  "--mode", "descendant", "--run-id", args.run_id,
                                  "--epoch", str(args.epoch), "--attempt", str(args.attempt)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
        emit("descendant", child_pid=child.pid)
        if args.mode == "orphan":
            emit("parent_exiting")
            return
        child.wait(timeout=15)
    time.sleep(5 if args.mode == "descendant" else (.2 if args.mode == "success" else 0))
    if args.mode != "descendant":
        emit("completed")


if __name__ == "__main__":
    main()
