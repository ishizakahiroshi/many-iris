"""Lifetime controller ownership; no stale PID files or automatic lock stealing."""
import ctypes
from ctypes import wintypes as w
import os


class OwnershipLock:
    def __init__(self, database):
        self.handle = None
        # resolve() is done by the caller, including the final-file symlink.
        # Hardlinks have different sidecar names; refuse that ambiguous identity.
        if database.exists() and database.stat().st_nlink != 1:
            raise OSError("DB_ALIASED")
        if os.name != "nt":
            raise OSError("Windows controller ownership required")
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p,
                                         w.DWORD, w.DWORD, w.HANDLE]
        self.api.CreateFileW.restype = w.HANDLE
        self.api.CloseHandle.argtypes = [w.HANDLE]
        lock_path = str(database) + ".owner-lock"
        handle = self.api.CreateFileW(lock_path, 0x80000000 | 0x40000000, 0, None, 4, 0x80, None)
        if handle == ctypes.c_void_p(-1).value:
            raise OSError("DB_LOCKED")
        self.handle = handle

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None

    def __del__(self):
        self.close()
