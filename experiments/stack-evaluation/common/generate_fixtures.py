"""Deterministic, public synthetic input. No clock, environment or real records."""
import hashlib
import json
from pathlib import Path


def fixture(size):
    tasks = []
    for i in range(size):
        source = f"Synthetic source {i:05d}\nReview the generated example only.\n"
        tasks.append(dict(id=f"task-{i:05d}", title=f"Synthetic task {i:05d}",
                          source=source, revision=1,
                          source_hash=hashlib.sha256(source.encode()).hexdigest()))
    return dict(version=1, now=2000000000, tasks=tasks)


def write_all(directory):
    directory.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for size in (100, 1000, 10000):
        name = f"tasks-{size}.json"
        payload = (json.dumps(fixture(size), ensure_ascii=True, separators=(",", ":")) + "\n").encode()
        (directory / name).write_bytes(payload)
        manifest[name] = dict(bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    print(json.dumps(write_all(Path(__file__).resolve().parent.parent / "fixtures"), indent=2))
