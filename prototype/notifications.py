"""Generic notification preview only. No network or phone registration."""
import argparse
import json
import sqlite3
from pathlib import Path

MESSAGES = {
    "approval_required": "判断が必要です。内容は作業画面で確認してください。",
    "attention_required": "人の対応が必要な状態です。作業画面を確認してください。",
    "run_completed": "今回の実行が完了しました。結果を作業画面で確認してください。",
}


def preview_notifications(engine, after=0):
    if type(after) is not int or after < 0:
        raise ValueError("Notification cursor must be a nonnegative integer.")
    snapshot = engine.snapshot()
    if type(snapshot) is not dict or snapshot.get("synthetic") is not True:
        raise ValueError("Only the synthetic candidate database is supported.")
    rows = engine.notifications(after=after)["notifications"]
    if type(rows) is not list:
        raise ValueError("Invalid notification collection.")
    notices = []
    for row in rows:
        if type(row) is not dict:
            raise ValueError("Invalid notification record.")
        kind = row.get("kind")
        if kind not in MESSAGES or type(row.get("id")) is not int:
            continue
        notices.append({"id": row["id"], "title": "Many Iris", "body": MESSAGES[kind],
                        "kind": kind, "delivery": "not_configured"})
    return {"synthetic": True, "external_send": False, "notifications": notices,
            "next_cursor": max([after, *(n["id"] for n in notices)])}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Preview privacy-minimized local notification events")
    parser.add_argument("--db", required=True)
    parser.add_argument("--after", type=int, default=0)
    args = parser.parse_args(argv)
    if not Path(args.db).is_file() or args.after < 0:
        parser.error("An existing synthetic database and nonnegative cursor are required")
    class ReadOnlyState:
        def snapshot(self):
            uri = Path(args.db).resolve().as_uri() + "?mode=ro"
            conn = sqlite3.connect(uri, uri=True)
            try:
                return json.loads(conn.execute("SELECT body FROM state WHERE id=1").fetchone()[0])
            finally:
                conn.close()

        def notifications(self, after=0):
            return {"notifications": [n for n in self.snapshot().get("notifications", []) if n["id"] > after]}
    try:
        result = preview_notifications(ReadOnlyState(), args.after)
    except (ValueError, sqlite3.Error, TypeError):
        print(json.dumps({"external_send": False, "error": "synthetic_database_required"}))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
