use crate::config::ResolvedConfig;
use std::{
    fs::{self, OpenOptions},
    io,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_LOG_LINES: usize = 4000;

pub fn trim_log_file(path: &Path, max_lines: usize) -> io::Result<()> {
    if !path.is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(path)?;
    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= max_lines {
        return Ok(());
    }
    let tail = &lines[lines.len() - max_lines..];
    let mut out = tail.join("\n");
    out.push('\n');
    fs::write(path, out)
}

#[cfg(windows)]
struct JobGuard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for JobGuard {}
#[cfg(windows)]
unsafe impl Sync for JobGuard {}

#[cfg(windows)]
impl JobGuard {
    fn create_kill_on_close() -> io::Result<Self> {
        use std::ffi::c_void;
        use std::ptr::null;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            let err = io::Error::last_os_error();
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Err(err);
        }
        Ok(Self(handle))
    }

    fn assign(&self, child: &Child) -> io::Result<()> {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle()) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn terminate(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        unsafe {
            TerminateJobObject(self.0, 0);
        }
    }
}

#[cfg(windows)]
impl Drop for JobGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

pub struct PickerRunner {
    config: ResolvedConfig,
    running: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    #[cfg(windows)]
    job: Arc<Mutex<Option<JobGuard>>>,
}

impl PickerRunner {
    pub fn new(config: ResolvedConfig) -> Self {
        Self {
            config,
            running: Arc::new(AtomicBool::new(false)),
            stopping: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
            #[cfg(windows)]
            job: Arc::new(Mutex::new(None)),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    pub fn is_paused(&self) -> bool {
        self.config.stop_file.exists()
    }

    pub fn start<F>(&self, on_state_change: F) -> io::Result<()>
    where
        F: Fn(bool) + Send + Sync + 'static,
    {
        if let Some(parent) = self.config.log_file.parent() {
            fs::create_dir_all(parent)?;
        }
        let _ = trim_log_file(&self.config.log_file, MAX_LOG_LINES);

        let log_out = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.config.log_file)?;
        let log_err = log_out.try_clone()?;

        let worker_args = serde_json::to_string(&[self
            .config
            .worker_script
            .to_string_lossy()
            .into_owned()])
        .map_err(io::Error::other)?;

        let mut cmd = Command::new(&self.config.node_exe);
        cmd.arg("src/main.mjs")
            .arg("--watch")
            .current_dir(&self.config.picker_dir)
            .env("PICKER_BOARD_URL", &self.config.board_mcp_url)
            .env("PICKER_KEY_FILE", &self.config.key_file)
            .env("PICKER_WRITER", &self.config.writer)
            .env("PICKER_PROJECTS", &self.config.projects)
            .env("PICKER_EXECUTOR", "command")
            .env("PICKER_COMMAND", &self.config.node_exe)
            .env("PICKER_COMMAND_ARGS", worker_args)
            .env("PICKER_TIMEOUT_SECS", self.config.timeout_secs.to_string())
            .env(
                "PICKER_MAX_RUNS_PER_DAY",
                self.config.max_runs_per_day.to_string(),
            )
            .env("PICKER_INTERVAL_SECS", self.config.interval_secs.to_string())
            .env("PICKER_STATE_FILE", &self.config.state_file)
            .env("PICKER_STOP_FILE", &self.config.stop_file)
            .env("LOCAL_WORKER_BOARD_JSON", &self.config.board_json)
            .env_remove("MANY_AI_CLI")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log_out))
            .stderr(Stdio::from(log_err));

        if let Some(ref version_dirs) = self.config.version_dirs {
            cmd.env("PICKER_VERSION_DIRS", version_dirs);
        }

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let spawned = cmd.spawn().map_err(|e| {
            io::Error::new(
                e.kind(),
                format!(
                    "picker (node) を起動できませんでした ({}): {e}",
                    self.config.node_exe.display()
                ),
            )
        })?;

        #[cfg(windows)]
        {
            if let Ok(job) = JobGuard::create_kill_on_close() {
                let _ = job.assign(&spawned);
                *self.job.lock().unwrap_or_else(|p| p.into_inner()) = Some(job);
            }
        }

        *self.child.lock().unwrap_or_else(|p| p.into_inner()) = Some(spawned);
        self.running.store(true, Ordering::Release);
        on_state_change(true);

        let running = self.running.clone();
        let stopping = self.stopping.clone();
        let child_slot = self.child.clone();
        thread::spawn(move || loop {
            if stopping.load(Ordering::Acquire) {
                break;
            }
            let exited = {
                let mut guard = child_slot.lock().unwrap_or_else(|p| p.into_inner());
                match guard.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(_)) => {
                            *guard = None;
                            true
                        }
                        Ok(None) => false,
                        Err(_) => {
                            *guard = None;
                            true
                        }
                    },
                    None => true,
                }
            };
            if exited {
                running.store(false, Ordering::Release);
                on_state_change(false);
                break;
            }
            thread::sleep(Duration::from_millis(500));
        });

        Ok(())
    }

    pub fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        #[cfg(windows)]
        {
            if let Some(job) = self.job.lock().unwrap_or_else(|p| p.into_inner()).take() {
                job.terminate();
            }
        }
        let mut guard = self.child.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.running.store(false, Ordering::Release);
    }
}

impl Drop for PickerRunner {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn trims_log_to_tail_lines() {
        let dir = tempdir().unwrap();
        let log = dir.path().join("picker.log");
        fs::write(&log, "a\nb\nc\nd\ne\n").unwrap();
        trim_log_file(&log, 3).unwrap();
        assert_eq!(fs::read_to_string(&log).unwrap(), "c\nd\ne\n");
    }
}
