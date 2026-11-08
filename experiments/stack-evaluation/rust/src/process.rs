//! Narrow Windows FFI boundary. Child starts suspended, joins a kill-on-close
//! Job before its first instruction, then resumes. Descendants stay in the Job.
use std::os::windows::io::AsRawHandle;
use std::{ffi::OsStr, os::windows::ffi::OsStrExt, path::Path, ptr, thread, time::Duration};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
            TerminateJobObject,
        },
        Threading::{
            CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessW, GetExitCodeProcess, OpenProcess,
            PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, ResumeThread, STARTUPINFOW,
            TerminateProcess, WaitForSingleObject,
        },
    },
};

pub struct Job {
    job: HANDLE,
    process: HANDLE,
    pub pid: u32,
}

pub fn require_single_link(path: &Path) -> Result<(), &'static str> {
    let file = std::fs::File::open(path).map_err(|_| "CONFIG")?;
    // SAFETY: File owns a live handle; output is the exact Win32 structure.
    // Query failure refuses DB ownership before any SQLite open or writes.
    unsafe {
        let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        if GetFileInformationByHandle(file.as_raw_handle(), &mut info) == 0 {
            return Err("CONFIG");
        }
        if info.nNumberOfLinks != 1 {
            return Err("DB_ALIAS");
        }
    }
    Ok(())
}

// SAFETY: handles belong exclusively to Job; all operations occur while Core's
// mutex is held. Windows handles can be used by a different OS thread.
unsafe impl Send for Job {}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn process_signaled(wait: u32) -> Result<bool, &'static str> {
    match wait {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => Err("PROCESS"),
    }
}

fn quote(value: &str) -> String {
    let mut output = String::from("\"");
    let mut slashes = 0;
    for c in value.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        if c == '"' {
            output.push_str(&"\\".repeat(slashes * 2 + 1));
        } else {
            output.push_str(&"\\".repeat(slashes));
        }
        slashes = 0;
        output.push(c);
    }
    output.push_str(&"\\".repeat(slashes * 2));
    output.push('"');
    output
}

impl Job {
    pub fn live_descendant(&self, pid: u32) -> Result<bool, &'static str> {
        if pid == 0 || pid == self.pid {
            return Ok(false);
        }
        // SAFETY: query/synchronization-only handle is closed on every path.
        // Membership confirms this is still an owned Job member, not a reused
        // numeric PID. SYNCHRONIZE is the standard Win32 right 0x00100000.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | 0x0010_0000, 0, pid);
            if handle.is_null() {
                return if GetLastError() == 87 {
                    Ok(false)
                } else {
                    Err("PROCESS")
                };
            }
            let mut member = 0;
            let queried = IsProcessInJob(handle, self.job, &mut member);
            let wait = WaitForSingleObject(handle, 0);
            CloseHandle(handle);
            if queried == 0 {
                return Err("PROCESS");
            }
            match wait {
                WAIT_OBJECT_0 => Ok(false),
                WAIT_TIMEOUT => Ok(member != 0),
                _ => Err("PROCESS"),
            }
        }
    }

    pub fn spawn(
        python: &Path,
        helper: &Path,
        events: &Path,
        mode: &str,
        run_id: &str,
        epoch: i64,
        attempt: i64,
    ) -> Result<Self, &'static str> {
        let argv = [
            python.to_string_lossy().into_owned(),
            helper.to_string_lossy().into_owned(),
            "--events".into(),
            events.to_string_lossy().into_owned(),
            "--mode".into(),
            mode.into(),
            "--run-id".into(),
            run_id.into(),
            "--epoch".into(),
            epoch.to_string(),
            "--attempt".into(),
            attempt.to_string(),
        ];
        let command = argv.iter().map(|s| quote(s)).collect::<Vec<_>>().join(" ");
        let mut command = wide(OsStr::new(&command));
        let executable = wide(python.as_os_str());
        // SAFETY: all structs have correct cb/size, all string pointers are NUL
        // terminated and live for the call; no inherited handles; ownership of
        // process/job handles is transferred to Job only on full success.
        unsafe {
            let job = CreateJobObjectW(ptr::null(), ptr::null());
            if job.is_null() {
                return Err("PROCESS");
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                CloseHandle(job);
                return Err("PROCESS");
            }
            let mut startup: STARTUPINFOW = std::mem::zeroed();
            startup.cb = std::mem::size_of_val(&startup) as u32;
            let mut info: PROCESS_INFORMATION = std::mem::zeroed();
            if CreateProcessW(
                executable.as_ptr(),
                command.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                0,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                ptr::null(),
                ptr::null(),
                &startup,
                &mut info,
            ) == 0
            {
                CloseHandle(job);
                return Err("PROCESS");
            }
            if AssignProcessToJobObject(job, info.hProcess) == 0
                || ResumeThread(info.hThread) == u32::MAX
            {
                TerminateProcess(info.hProcess, 1);
                WaitForSingleObject(info.hProcess, 2000);
                CloseHandle(info.hThread);
                CloseHandle(info.hProcess);
                CloseHandle(job);
                return Err("PROCESS");
            }
            CloseHandle(info.hThread);
            Ok(Self {
                job,
                process: info.hProcess,
                pid: info.dwProcessId,
            })
        }
    }

    pub fn active(&self) -> Result<u32, &'static str> {
        // SAFETY: job handle is live and output has the declared struct size.
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            if QueryInformationJobObject(
                self.job,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of_val(&info) as u32,
                ptr::null_mut(),
            ) == 0
            {
                return Err("PROCESS");
            }
            Ok(info.ActiveProcesses)
        }
    }

    pub fn exited(&self) -> Result<Option<u32>, &'static str> {
        // SAFETY: process handle is owned until Drop and output points to u32.
        unsafe {
            if !process_signaled(WaitForSingleObject(self.process, 0))? {
                return Ok(None);
            }
            let mut code = 0;
            if GetExitCodeProcess(self.process, &mut code) == 0 {
                return Err("PROCESS");
            }
            Ok(Some(code))
        }
    }

    pub fn stop(&self) -> bool {
        // SAFETY: live job handle; termination applies only to owned fixed helper.
        unsafe {
            if TerminateJobObject(self.job, 1) == 0 {
                return false;
            }
        }
        for _ in 0..100 {
            if self.active() == Ok(0) {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: each handle is exclusively owned, closed exactly once. Closing
        // job kills any remaining descendants because KILL_ON_JOB_CLOSE is set.
        unsafe {
            CloseHandle(self.process);
            CloseHandle(self.job);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{process_signaled, quote};
    use windows_sys::Win32::Foundation::{WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
    #[test]
    fn failed_wait_is_not_running() {
        assert_eq!(process_signaled(WAIT_OBJECT_0), Ok(true));
        assert_eq!(process_signaled(WAIT_TIMEOUT), Ok(false));
        assert_eq!(process_signaled(WAIT_FAILED), Err("PROCESS"));
    }
    #[test]
    fn windows_argument_quoting() {
        assert_eq!(quote("a b"), "\"a b\"");
        assert_eq!(quote("a\\"), "\"a\\\\\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
    }
}
