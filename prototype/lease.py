"""OS-owned local scheduler lease. Stale PID text is never stop evidence."""
import os
from pathlib import Path


class ExecutionLease:
    def __init__(self, db_path):
        self.database = Path(db_path).resolve()
        self.path = Path(str(self.database) + ".scheduler-lock")
        self.stream = None

    def __enter__(self):
        if self.database.exists() and self.database.stat().st_nlink != 1:
            raise RuntimeError("Database file aliases are not supported.")
        self.stream = self.path.open("a+b")
        try:
            self.stream.seek(0, 2)
            if self.stream.tell() == 0:
                self.stream.write(b"0")
                self.stream.flush()
            self.stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.stream.close()
            self.stream = None
            raise RuntimeError("A scheduler already owns this local database.") from None
        return self

    def __exit__(self, *_args):
        if self.stream is not None:
            try:
                self.stream.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
            finally:
                self.stream.close()
                self.stream = None
