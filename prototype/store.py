"""Small transactional SQLite store; every operation owns its connection."""
from contextlib import contextmanager
import json
import sqlite3


class Store:
    def __init__(self, path):
        self.path = str(path)
        with self.connection() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)")
            conn.execute("CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL)")
            conn.execute("INSERT OR IGNORE INTO state VALUES (1, ?)", (json.dumps({}),))

    @contextmanager
    def connection(self):
        conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        conn.execute("PRAGMA busy_timeout=10000")
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def transaction(self):
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                state = json.loads(conn.execute("SELECT body FROM state WHERE id=1").fetchone()[0])
                yield conn, state
                conn.execute("UPDATE state SET body=? WHERE id=1", (json.dumps(state, ensure_ascii=False, allow_nan=False),))
                conn.commit()
            except BaseException:
                conn.rollback()
                raise

    def read(self):
        with self.connection() as conn:
            return json.loads(conn.execute("SELECT body FROM state WHERE id=1").fetchone()[0])
