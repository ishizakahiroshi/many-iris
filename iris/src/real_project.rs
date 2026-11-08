//! The real-project profile's own cases (`iris-owned-real-project/1`): one to
//! three markdown files the user approved, each sent with its own instruction
//! file, request id and binding.
//!
//! The configuration is checked without opening any file. A case's files are
//! read only through `read_case_file`, which accepts an absolute local path to a
//! single-link regular file whose own final path is exactly the configured one
//! (no junction, link, stream, UNC or `\\?\` alias, no offline or cloud
//! placeholder), holding 1 to 64 KiB of non-blank UTF-8 text without NUL. Every
//! refusal is a fixed code; no message ever carries a file's content.
use crate::cli_binding::{CliBinding, OwnedProfile, sha256_hex};
use crate::domain::{RealTask, real_project_scope_hash, real_tasks_valid};
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

/// The most bytes a case's markdown or instruction file may hold.
pub const REAL_CASE_FILE_LIMIT: usize = 65536;
/// At most three cases are sent.
pub const REAL_CASE_LIMIT: usize = 3;

fn yes() -> bool {
    true
}

/// One case as the configuration names it. Its plan, task and approval ids are
/// the binding's own.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RealCase {
    pub project_title: String,
    pub title: String,
    /// The markdown the user approved; absolute, `.md`, never `*.local.md`.
    pub source_file: PathBuf,
    pub source_sha256: String,
    /// The text the CLI sends; absolute, never `*.local.md`.
    pub instruction_file: PathBuf,
    pub instruction_sha256: String,
    /// When true (the default) the instruction must hold the markdown's whole
    /// text unchanged.
    #[serde(default = "yes")]
    pub instruction_contains_source: bool,
    pub request_id: String,
    pub binding: CliBinding,
}

/// Validated cases. Built only from explicit configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealProject {
    cases: Vec<RealCase>,
}

/// The text of one case's two files, read once when a store is created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaseContent {
    pub source: String,
    pub instruction: String,
}

/// A case file that could not be used: the case number (from 1) and a fixed
/// code. It never carries the file's content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaseFailure {
    pub case: usize,
    pub code: &'static str,
}
impl std::fmt::Display for CaseFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "real case {}: {}", self.case, self.code)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaseFile {
    Source,
    Instruction,
}

fn lower_hex_64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn request_id_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
fn display_text(s: &str) -> bool {
    !s.trim().is_empty() && s.chars().count() <= 200 && !s.chars().any(char::is_control)
}
/// The key two paths are compared by: Windows file names ignore ASCII case.
fn path_key(path: &Path) -> String {
    path.to_string_lossy().to_ascii_lowercase()
}

/// The shape of a configured case path, checked without touching the disk.
pub fn path_shape(path: &Path, kind: CaseFile) -> Result<(), &'static str> {
    let bad = Err("REAL_CASE_PATH");
    let Some(text) = path.to_str() else {
        return bad;
    };
    if !path.is_absolute() || text.contains('\0') {
        return bad;
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        // Only a plain drive path: no UNC share, no `\\?\` or `\\.\` form.
        match path.components().next() {
            Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)) => {}
            _ => return bad,
        }
        // A `:` after the drive names an alternate data stream; `/` would make
        // the configured path differ from the file's own final path.
        if text.len() < 3 || text[2..].contains(':') || text.contains('/') {
            return bad;
        }
    }
    if path.components().any(|c| {
        matches!(
            c,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    }) {
        return bad;
    }
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return bad;
    };
    let name = name.to_ascii_lowercase();
    if name.ends_with(".local.md") || name.ends_with('.') || name.ends_with(' ') {
        return bad;
    }
    if kind == CaseFile::Source && !name.ends_with(".md") {
        return bad;
    }
    Ok(())
}

fn text_of(bytes: Vec<u8>) -> Result<String, &'static str> {
    if bytes.is_empty() || bytes.contains(&0) {
        return Err("REAL_CASE_TEXT");
    }
    let text = String::from_utf8(bytes).map_err(|_| "REAL_CASE_TEXT")?;
    if text.trim().is_empty() {
        return Err("REAL_CASE_TEXT");
    }
    Ok(text)
}

/// Read one case file under the rules in the module documentation.
pub fn read_case_file(path: &Path, kind: CaseFile) -> Result<String, &'static str> {
    path_shape(path, kind)?;
    let bytes = platform::read(path)?;
    text_of(bytes)
}

#[cfg(windows)]
mod platform {
    use super::REAL_CASE_FILE_LIMIT;
    use std::{
        io::Read,
        os::windows::{
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawHandle,
        },
        path::Path,
    };

    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    const ATTRIBUTE_OFFLINE: u32 = 0x1000;
    const ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
    const ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;

    #[repr(C)]
    struct FileInfo {
        attributes: u32,
        created: [u32; 2],
        accessed: [u32; 2],
        written: [u32; 2],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut FileInfo) -> i32;
        fn GetFinalPathNameByHandleW(
            handle: *mut std::ffi::c_void,
            path: *mut u16,
            length: u32,
            flags: u32,
        ) -> u32;
    }

    /// The opened object's own normalized DOS path, without the `\\?\` prefix.
    fn final_path(file: &std::fs::File) -> Result<String, &'static str> {
        let mut buffer = vec![0u16; 1024];
        for _ in 0..2 {
            // The File owns the live handle for this call; the buffer length
            // passed is the buffer's own, so the API never writes past it.
            let written = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    0,
                )
            } as usize;
            if written == 0 {
                return Err("REAL_CASE_UNAVAILABLE");
            }
            if written < buffer.len() {
                let path = String::from_utf16(&buffer[..written]).map_err(|_| "REAL_CASE_ALIAS")?;
                // A network volume comes back as `\\?\UNC\...`; only a drive path
                // can equal the configured one.
                return path
                    .strip_prefix(r"\\?\")
                    .filter(|p| !p.starts_with(r"UNC\"))
                    .map(str::to_owned)
                    .ok_or("REAL_CASE_ALIAS");
            }
            buffer = vec![0u16; written + 1];
        }
        Err("REAL_CASE_UNAVAILABLE")
    }

    pub fn read(path: &Path) -> Result<Vec<u8>, &'static str> {
        let mut options = std::fs::OpenOptions::new();
        // Open the final component itself: a link is inspected, never followed.
        options
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        let mut file = options.open(path).map_err(|_| "REAL_CASE_UNAVAILABLE")?;
        let metadata = file.metadata().map_err(|_| "REAL_CASE_UNAVAILABLE")?;
        let attributes = metadata.file_attributes();
        if !metadata.is_file() || attributes & ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("REAL_CASE_NOT_REGULAR");
        }
        if attributes
            & (ATTRIBUTE_OFFLINE | ATTRIBUTE_RECALL_ON_OPEN | ATTRIBUTE_RECALL_ON_DATA_ACCESS)
            != 0
        {
            return Err("REAL_CASE_OFFLINE");
        }
        let mut info = FileInfo {
            attributes: 0,
            created: [0; 2],
            accessed: [0; 2],
            written: [0; 2],
            volume: 0,
            size_high: 0,
            size_low: 0,
            links: 0,
            index_high: 0,
            index_low: 0,
        };
        // FileInfo mirrors the fixed BY_HANDLE_FILE_INFORMATION integer layout;
        // the File owns the live handle and no pointer escapes this call.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err("REAL_CASE_UNAVAILABLE");
        }
        if info.links != 1 {
            return Err("REAL_CASE_LINKED");
        }
        let configured = path.to_str().ok_or("REAL_CASE_PATH")?;
        let actual = final_path(&file)?;
        if actual != configured {
            return Err(if actual.eq_ignore_ascii_case(configured) {
                "REAL_CASE_PATH_CASE"
            } else {
                "REAL_CASE_ALIAS"
            });
        }
        if metadata.len() > REAL_CASE_FILE_LIMIT as u64 {
            return Err("REAL_CASE_TOO_LARGE");
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take(REAL_CASE_FILE_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "REAL_CASE_UNAVAILABLE")?;
        if bytes.len() > REAL_CASE_FILE_LIMIT {
            return Err("REAL_CASE_TOO_LARGE");
        }
        Ok(bytes)
    }
}

#[cfg(unix)]
mod platform {
    use super::REAL_CASE_FILE_LIMIT;
    use std::{io::Read, os::unix::fs::MetadataExt, path::Path};

    pub fn read(path: &Path) -> Result<Vec<u8>, &'static str> {
        let link = std::fs::symlink_metadata(path).map_err(|_| "REAL_CASE_UNAVAILABLE")?;
        if !link.file_type().is_file() {
            return Err("REAL_CASE_NOT_REGULAR");
        }
        if link.nlink() != 1 {
            return Err("REAL_CASE_LINKED");
        }
        if std::fs::canonicalize(path).map_err(|_| "REAL_CASE_UNAVAILABLE")? != path {
            return Err("REAL_CASE_ALIAS");
        }
        let mut file = std::fs::File::open(path).map_err(|_| "REAL_CASE_UNAVAILABLE")?;
        let opened = file.metadata().map_err(|_| "REAL_CASE_UNAVAILABLE")?;
        if opened.dev() != link.dev() || opened.ino() != link.ino() {
            return Err("REAL_CASE_ALIAS");
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take(REAL_CASE_FILE_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "REAL_CASE_UNAVAILABLE")?;
        if bytes.len() > REAL_CASE_FILE_LIMIT {
            return Err("REAL_CASE_TOO_LARGE");
        }
        Ok(bytes)
    }
}

#[cfg(not(any(unix, windows)))]
mod platform {
    pub fn read(_path: &std::path::Path) -> Result<Vec<u8>, &'static str> {
        Err("REAL_CASE_UNAVAILABLE")
    }
}

/// The instruction file must still hash to the configured value and, when the
/// case asks for it, hold `source` unchanged. Used right before an intent is
/// stored, with the source text the store holds.
pub fn check_instruction(case: &RealCase, source: &str) -> Result<(), &'static str> {
    let instruction = read_case_file(&case.instruction_file, CaseFile::Instruction)?;
    if sha256_hex(instruction.as_bytes()) != case.instruction_sha256 {
        return Err("REAL_CASE_INSTRUCTION_CHANGED");
    }
    if case.instruction_contains_source && !instruction.contains(source) {
        return Err("REAL_CASE_SOURCE_NOT_IN_INSTRUCTION");
    }
    Ok(())
}

impl RealProject {
    /// Checks every case and the cases together. No file is opened.
    pub fn new(cases: Vec<RealCase>) -> Result<Self, String> {
        Self::check_shape(&cases)?;
        let first = &cases[0].binding;
        let mut sources = BTreeSet::new();
        for (n, case) in cases.iter().enumerate() {
            let n = n + 1;
            let b = &case.binding;
            if !sources.insert(case.source_sha256.as_str()) {
                return Err(format!(
                    "Real case {n}: its markdown has the same SHA-256 as another case's"
                ));
            }
            if b.instruction_hash != case.instruction_sha256 {
                return Err(format!(
                    "Real case {n}: the binding's instruction_hash is not the case's instruction_sha256"
                ));
            }
            if b.scope_hash
                != real_project_scope_hash(
                    &b.plan_id,
                    &b.task_id,
                    &case.source_sha256,
                    &case.instruction_sha256,
                )
            {
                return Err(format!(
                    "Real case {n}: the binding's scope_hash is not the case's own (see --real-cases-preview)"
                ));
            }
            if b.execution_host_id != first.execution_host_id
                || b.executor_instance_id != first.executor_instance_id
                || b.profile_id != first.profile_id
            {
                return Err(format!(
                    "Real case {n}: every case must name the same execution host, executor instance and subscription profile"
                ));
            }
        }
        Ok(Self { cases })
    }

    /// The checks that need no hash agreement: shapes, ids, the claude scope,
    /// and no repeated id, request or file. `--real-cases-preview` uses only
    /// these, so it can report the hashes a configuration should carry.
    pub fn check_shape(cases: &[RealCase]) -> Result<(), String> {
        if cases.is_empty() || cases.len() > REAL_CASE_LIMIT {
            return Err("Real cases must be 1 to 3 entries".into());
        }
        let mut requests = BTreeSet::new();
        let mut files = BTreeSet::new();
        for (n, case) in cases.iter().enumerate() {
            let n = n + 1;
            let b = &case.binding;
            if !display_text(&case.project_title) || !display_text(&case.title) {
                return Err(format!(
                    "Real case {n}: titles must be 1 to 200 characters without control characters"
                ));
            }
            if path_shape(&case.source_file, CaseFile::Source).is_err() {
                return Err(format!(
                    "Real case {n}: source_file must be an absolute local .md path (not *.local.md, no stream, UNC or \\\\?\\ form)"
                ));
            }
            if path_shape(&case.instruction_file, CaseFile::Instruction).is_err() {
                return Err(format!(
                    "Real case {n}: instruction_file must be an absolute local path (not *.local.md, no stream, UNC or \\\\?\\ form)"
                ));
            }
            if !lower_hex_64(&case.source_sha256) || !lower_hex_64(&case.instruction_sha256) {
                return Err(format!(
                    "Real case {n}: hashes must be lowercase hex SHA-256"
                ));
            }
            if !request_id_valid(&case.request_id) || !requests.insert(case.request_id.as_str()) {
                return Err(format!(
                    "Real case {n}: request_id must be a distinct id of ASCII letters, digits, - and _"
                ));
            }
            if !files.insert(path_key(&case.source_file))
                || !files.insert(path_key(&case.instruction_file))
            {
                return Err(format!(
                    "Real case {n}: every source and instruction file must be its own"
                ));
            }
            if b.validate().is_err()
                || !OwnedProfile::RealProject.admits(b)
                || b.principal_id != "local-user"
                || b.workspace_id != "synthetic-workspace"
                || b.plan_revision != 1
                || b.approval_revision != 1
                || b.instruction_revision != 1
                || b.fence != 1
                || b.attempt_id != format!("attempt-{}-1", b.task_id)
            {
                return Err(format!(
                    "Real case {n}: the binding is outside the real-project profile's scope"
                ));
            }
        }
        let tasks: Vec<RealTask> = cases.iter().map(|c| c.task()).collect();
        if !real_tasks_valid(&tasks) {
            return Err(
                "Real cases must not repeat a plan, task or approval id (plan and task ids share one namespace)"
                    .into(),
            );
        }
        Ok(())
    }

    pub fn cases(&self) -> &[RealCase] {
        &self.cases
    }

    /// Read both files of every case (only when a store is created) and check
    /// them against the configuration.
    pub fn read_contents(&self) -> Result<Vec<CaseContent>, CaseFailure> {
        self.cases
            .iter()
            .enumerate()
            .map(|(n, case)| {
                let fail = |code| CaseFailure { case: n + 1, code };
                let source = read_case_file(&case.source_file, CaseFile::Source).map_err(fail)?;
                if sha256_hex(source.as_bytes()) != case.source_sha256 {
                    return Err(fail("REAL_CASE_SOURCE_CHANGED"));
                }
                let instruction =
                    read_case_file(&case.instruction_file, CaseFile::Instruction).map_err(fail)?;
                if sha256_hex(instruction.as_bytes()) != case.instruction_sha256 {
                    return Err(fail("REAL_CASE_INSTRUCTION_CHANGED"));
                }
                if case.instruction_contains_source && !instruction.contains(&source) {
                    return Err(fail("REAL_CASE_SOURCE_NOT_IN_INSTRUCTION"));
                }
                Ok(CaseContent {
                    source,
                    instruction,
                })
            })
            .collect()
    }
}

impl RealCase {
    pub fn task(&self) -> RealTask {
        RealTask {
            plan_id: self.binding.plan_id.clone(),
            task_id: self.binding.task_id.clone(),
            approval_id: self.binding.approval_id.clone(),
        }
    }
}

/// What `--real-cases-preview` reports for each case: ids, sizes, the hashes
/// actually read, the scope hash those hashes give, and whether the instruction
/// holds the markdown. Never any content.
pub fn preview(cases: &[RealCase]) -> serde_json::Value {
    use serde_json::json;
    let mut ready = true;
    let mut out = Vec::new();
    for case in cases {
        let b = &case.binding;
        let mut row = json!({"plan_id":b.plan_id,"task_id":b.task_id,"approval_id":b.approval_id,
            "request_id":case.request_id,"instruction_contains_source_required":case.instruction_contains_source});
        let source = read_case_file(&case.source_file, CaseFile::Source);
        let instruction = read_case_file(&case.instruction_file, CaseFile::Instruction);
        match &source {
            Ok(text) => {
                let sha = sha256_hex(text.as_bytes());
                row["source_bytes"] = json!(text.len());
                row["source_sha256_matches"] = json!(sha == case.source_sha256);
                row["source_sha256"] = json!(sha);
            }
            Err(code) => row["source_error"] = json!(code),
        }
        match &instruction {
            Ok(text) => {
                let sha = sha256_hex(text.as_bytes());
                row["instruction_bytes"] = json!(text.len());
                row["instruction_sha256_matches"] = json!(sha == case.instruction_sha256);
                row["binding_instruction_hash_matches"] = json!(sha == b.instruction_hash);
                row["instruction_sha256"] = json!(sha);
            }
            Err(code) => row["instruction_error"] = json!(code),
        }
        let mut case_ready = false;
        if let (Ok(source), Ok(instruction)) = (&source, &instruction) {
            let contains = instruction.contains(source.as_str());
            let scope = real_project_scope_hash(
                &b.plan_id,
                &b.task_id,
                &sha256_hex(source.as_bytes()),
                &sha256_hex(instruction.as_bytes()),
            );
            row["instruction_contains_source"] = json!(contains);
            row["binding_scope_hash_matches"] = json!(scope == b.scope_hash);
            row["scope_hash"] = json!(scope);
            case_ready = row["source_sha256_matches"] == true
                && row["instruction_sha256_matches"] == true
                && row["binding_instruction_hash_matches"] == true
                && row["binding_scope_hash_matches"] == true
                && (contains || !case.instruction_contains_source);
        }
        row["ready"] = json!(case_ready);
        ready &= case_ready;
        out.push(row);
    }
    json!({"preview_only":true,"execution_sent":false,"profile":OwnedProfile::RealProject.as_str(),
        "ready":ready,"cases":out})
}
