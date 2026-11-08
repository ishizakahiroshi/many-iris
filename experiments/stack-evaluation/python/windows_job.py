"""Windows child tree owned before first instruction; synthetic helper only."""
import ctypes
from ctypes import wintypes as w
import subprocess
import time


class StartupInfo(ctypes.Structure):
    _fields_ = [("cb", w.DWORD), ("reserved", w.LPWSTR), ("desktop", w.LPWSTR),
                ("title", w.LPWSTR), ("x", w.DWORD), ("y", w.DWORD),
                ("xsize", w.DWORD), ("ysize", w.DWORD), ("xchars", w.DWORD),
                ("ychars", w.DWORD), ("fill", w.DWORD), ("flags", w.DWORD),
                ("show", w.WORD), ("reserved_size", w.WORD), ("reserved_bytes", ctypes.c_void_p),
                ("stdin", w.HANDLE), ("stdout", w.HANDLE), ("stderr", w.HANDLE)]


class ProcessInfo(ctypes.Structure):
    _fields_ = [("process", w.HANDLE), ("thread", w.HANDLE), ("pid", w.DWORD), ("tid", w.DWORD)]


class BasicLimits(ctypes.Structure):
    _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                ("flags", w.DWORD), ("minimum", ctypes.c_size_t), ("maximum", ctypes.c_size_t),
                ("active_limit", w.DWORD), ("affinity", ctypes.c_size_t),
                ("priority", w.DWORD), ("scheduling", w.DWORD)]


class IOInfo(ctypes.Structure):
    _fields_ = [(key, ctypes.c_uint64) for key in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [("basic", BasicLimits), ("io", IOInfo), ("process_memory", ctypes.c_size_t),
                ("job_memory", ctypes.c_size_t), ("peak_process_memory", ctypes.c_size_t),
                ("peak_job_memory", ctypes.c_size_t)]


class Accounting(ctypes.Structure):
    _fields_ = [("user_time", ctypes.c_int64), ("kernel_time", ctypes.c_int64),
                ("period_user_time", ctypes.c_int64), ("period_kernel_time", ctypes.c_int64),
                ("page_faults", w.DWORD), ("total", w.DWORD), ("active", w.DWORD), ("terminated", w.DWORD)]


class JobProcess:
    def __init__(self, argv):
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.job = self.process = None
        self.returncode = None
        self._configure()
        self.job = self.api.CreateJobObjectW(None, None)
        self._check(self.job)
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        try:
            self._check(self.api.SetInformationJobObject(self.job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
            startup = StartupInfo()
            startup.cb = ctypes.sizeof(startup)
            info = ProcessInfo()
            command = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
            self._check(self.api.CreateProcessW(argv[0], command, None, None, False,
                                                0x4 | 0x08000000, None, None,
                                                ctypes.byref(startup), ctypes.byref(info)))
            self.process, self.pid = info.process, info.pid
            try:
                self._check(self.api.AssignProcessToJobObject(self.job, self.process))
                resumed = self.api.ResumeThread(info.thread)
                self._check(resumed != 0xFFFFFFFF)
            except BaseException:
                self.api.TerminateProcess(self.process, 1)
                self.api.WaitForSingleObject(self.process, 5000)
                raise
            finally:
                self.api.CloseHandle(info.thread)
        except BaseException:
            self.close()
            raise

    def _configure(self):
        self.api.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        self.api.CreateJobObjectW.restype = w.HANDLE
        self.api.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        self.api.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p]
        self.api.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
                                          w.BOOL, w.DWORD, ctypes.c_void_p, w.LPCWSTR,
                                          ctypes.POINTER(StartupInfo), ctypes.POINTER(ProcessInfo)]
        self.api.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.api.ResumeThread.argtypes = [w.HANDLE]
        self.api.ResumeThread.restype = w.DWORD
        self.api.CloseHandle.argtypes = [w.HANDLE]
        self.api.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
        self.api.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
        self.api.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
        self.api.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
        self.api.WaitForSingleObject.restype = w.DWORD

    @staticmethod
    def _check(result):
        if not result:
            raise ctypes.WinError(ctypes.get_last_error())

    def poll(self):
        # Exit code may become visible while teardown is still in progress.
        # Observe the process handle's termination signal before Job accounting.
        signaled = self.api.WaitForSingleObject(self.process, 0)
        if signaled == 258:
            self.returncode = None
            return None
        self._check(signaled == 0)
        code = w.DWORD()
        self._check(self.api.GetExitCodeProcess(self.process, ctypes.byref(code)))
        self.returncode = code.value
        return self.returncode

    def wait(self, timeout):
        result = self.api.WaitForSingleObject(self.process, int(timeout * 1000))
        if result == 258:
            raise subprocess.TimeoutExpired("synthetic-helper", timeout)
        self._check(result == 0)
        return self.poll()

    def active(self):
        counters = Accounting()
        self._check(self.api.QueryInformationJobObject(self.job, 1, ctypes.byref(counters), ctypes.sizeof(counters), None))
        return counters.active

    def terminate_tree(self):
        self._check(self.api.TerminateJobObject(self.job, 1))
        deadline = time.monotonic() + 5
        while self.active() and time.monotonic() < deadline:
            time.sleep(.01)
        return self.active() == 0

    def close(self):
        if self.job:
            self.api.CloseHandle(self.job)
            self.job = None
        if self.process:
            self.api.CloseHandle(self.process)
            self.process = None
