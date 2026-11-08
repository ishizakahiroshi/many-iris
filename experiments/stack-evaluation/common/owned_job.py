"""Observer's cleanup boundary: handles owned before sending launch handshake.

The candidate blocks on stdin until assignment. Event file PIDs are observations
only and never authorize signaling. This is test cleanup, not a product sandbox.
"""
import ctypes
from ctypes import wintypes as w
import time


class Accounting(ctypes.Structure):
    _fields_ = [("user", ctypes.c_int64), ("kernel", ctypes.c_int64),
                ("period_user", ctypes.c_int64), ("period_kernel", ctypes.c_int64),
                ("faults", w.DWORD), ("total", w.DWORD), ("active", w.DWORD), ("terminated", w.DWORD)]


class OwnedJob:
    def __init__(self, process):
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        self.api.CreateJobObjectW.restype = w.HANDLE
        self.api.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.api.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
        self.api.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p]
        self.api.CloseHandle.argtypes = [w.HANDLE]
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        if not self.api.AssignProcessToJobObject(self.handle, w.HANDLE(int(process._handle))):
            self.api.CloseHandle(self.handle)
            self.handle = None
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self):
        if not self.handle:
            return
        try:
            if not self.api.TerminateJobObject(self.handle, 1):
                raise ctypes.WinError(ctypes.get_last_error())
            deadline = time.monotonic() + 5
            while True:
                counters = Accounting()
                if not self.api.QueryInformationJobObject(self.handle, 1, ctypes.byref(counters), ctypes.sizeof(counters), None):
                    raise ctypes.WinError(ctypes.get_last_error())
                if counters.active == 0:
                    return
                if time.monotonic() >= deadline:
                    raise RuntimeError("owned test processes did not stop; cleanup unconfirmed")
                time.sleep(.01)
        finally:
            self.api.CloseHandle(self.handle)
            self.handle = None
