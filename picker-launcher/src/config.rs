use serde::Deserialize;
use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Debug, Deserialize)]
pub struct LauncherConfigFile {
    pub picker_dir: Option<PathBuf>,
    pub board_json: PathBuf,
    pub writer: Option<String>,
    pub node_exe: Option<PathBuf>,
    pub interval_secs: Option<u64>,
    pub version_dirs: Option<String>,
    pub log_file: Option<PathBuf>,
    pub state_file: Option<PathBuf>,
    pub stop_file: Option<PathBuf>,
    pub board_web_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BoardJson {
    url: String,
    #[serde(default)]
    repos: Vec<BoardRepo>,
    local_taker: LocalTaker,
}

#[derive(Debug, Deserialize)]
struct BoardRepo {
    project: Option<String>,
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LocalTaker {
    key_file: String,
    timeout_secs: Option<u64>,
    max_runs_per_day: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    pub picker_dir: PathBuf,
    pub worker_script: PathBuf,
    pub board_json: PathBuf,
    pub board_mcp_url: String,
    pub board_web_url: String,
    pub key_file: String,
    pub writer: String,
    pub projects: String,
    pub node_exe: PathBuf,
    pub timeout_secs: u64,
    pub max_runs_per_day: u64,
    pub interval_secs: u64,
    pub version_dirs: Option<String>,
    pub log_file: PathBuf,
    pub state_file: PathBuf,
    pub stop_file: PathBuf,
}

pub fn config_path_from_args(args: &[String], exe_dir: &Path) -> PathBuf {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--config"
            && let Some(next) = iter.next()
        {
            return PathBuf::from(next);
        }
        if let Some(rest) = arg.strip_prefix("--config=") {
            return PathBuf::from(rest);
        }
    }
    exe_dir.join("picker-launcher.json")
}

pub fn derive_board_web_url(mcp_url: &str) -> String {
    if let Some(stripped) = mcp_url.strip_suffix("/mcp") {
        stripped.to_string()
    } else if let Some(stripped) = mcp_url.strip_suffix("/mcp/") {
        stripped.to_string()
    } else {
        mcp_url.to_string()
    }
}

pub fn load_config(config_path: &Path, base_dir: &Path) -> io::Result<ResolvedConfig> {
    let raw = fs::read_to_string(config_path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("設定ファイルを読めませんでした ({}): {e}", config_path.display()),
        )
    })?;
    let file: LauncherConfigFile = serde_json::from_str(&raw).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("設定ファイルの JSON が不正です ({}): {e}", config_path.display()),
        )
    })?;

    let picker_dir = resolve_path(
        base_dir,
        file.picker_dir
            .unwrap_or_else(|| PathBuf::from("many-iris/picker")),
    );
    let board_json = resolve_path(base_dir, file.board_json);
    let log_file = resolve_path(
        base_dir,
        file.log_file.unwrap_or_else(|| PathBuf::from("picker.log")),
    );
    let state_file = resolve_path(
        base_dir,
        file.state_file
            .unwrap_or_else(|| PathBuf::from("picker-state.json")),
    );
    let stop_file = resolve_path(
        base_dir,
        file.stop_file.unwrap_or_else(|| PathBuf::from("STOP")),
    );

    let board_raw = fs::read_to_string(&board_json).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("board.json を読めませんでした ({}): {e}", board_json.display()),
        )
    })?;
    let board: BoardJson = serde_json::from_str(&board_raw).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("board.json の形式が不正です ({}): {e}", board_json.display()),
        )
    })?;

    let mut project_set = BTreeSet::new();
    for repo in &board.repos {
        if let Some(name) = repo.project.as_deref().filter(|s| !s.trim().is_empty()) {
            project_set.insert(name.trim().to_string());
        } else if let Some(path) = repo.path.as_deref()
            && let Some(leaf) = Path::new(path).file_name().and_then(|s| s.to_str())
        {
            project_set.insert(leaf.to_string());
        }
    }
    let projects = project_set.into_iter().collect::<Vec<_>>().join(",");
    let worker_script = picker_dir.join("workers").join("local-claude.mjs");
    let node_exe = file
        .node_exe
        .unwrap_or_else(|| find_node_exe().unwrap_or_else(|| PathBuf::from("node.exe")));
    let board_web_url = file
        .board_web_url
        .unwrap_or_else(|| derive_board_web_url(&board.url));

    Ok(ResolvedConfig {
        picker_dir,
        worker_script,
        board_json,
        board_mcp_url: board.url,
        board_web_url,
        key_file: board.local_taker.key_file,
        writer: file.writer.unwrap_or_else(|| "local-claude".to_string()),
        projects,
        node_exe,
        timeout_secs: board.local_taker.timeout_secs.unwrap_or(1800),
        max_runs_per_day: board.local_taker.max_runs_per_day.unwrap_or(6),
        interval_secs: file.interval_secs.unwrap_or(300),
        version_dirs: file.version_dirs,
        log_file,
        state_file,
        stop_file,
    })
}

fn resolve_path(base: &Path, path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

fn find_node_exe() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join("node.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn derives_board_web_url_from_mcp_url() {
        assert_eq!(
            derive_board_web_url("https://board.example.com/board/mcp"),
            "https://board.example.com/board"
        );
        assert_eq!(
            derive_board_web_url("https://board.example.com/board"),
            "https://board.example.com/board"
        );
    }

    #[test]
    fn loads_config_and_board_projects() {
        let dir = tempdir().unwrap();
        let board_path = dir.path().join("board.json");
        fs::write(
            &board_path,
            r#"{
                "url": "https://board.example.com/board/mcp",
                "repos": [
                    {"project": "alpha", "path": "C:/work/alpha"},
                    {"path": "C:/work/beta"},
                    {"project": "alpha", "path": "C:/work/alpha2"}
                ],
                "local_taker": {
                    "key_file": "C:/keys/writer.key",
                    "timeout_secs": 900,
                    "max_runs_per_day": 10
                }
            }"#,
        )
        .unwrap();
        let cfg_path = dir.path().join("picker-launcher.json");
        fs::write(
            &cfg_path,
            r#"{
                "board_json": "board.json",
                "interval_secs": 120
            }"#,
        )
        .unwrap();

        let resolved = load_config(&cfg_path, dir.path()).unwrap();
        assert_eq!(resolved.board_web_url, "https://board.example.com/board");
        assert_eq!(resolved.projects, "alpha,beta");
        assert_eq!(resolved.timeout_secs, 900);
        assert_eq!(resolved.max_runs_per_day, 10);
        assert_eq!(resolved.interval_secs, 120);
        assert_eq!(resolved.writer, "local-claude");
    }
}
