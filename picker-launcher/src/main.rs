#![cfg_attr(windows, windows_subsystem = "windows")]

mod config;
mod runner;
#[cfg(windows)]
mod window;

use std::sync::Arc;

fn main() {
    if let Err(err) = run() {
        #[cfg(windows)]
        window::show_error(&err.to_string());
        #[cfg(not(windows))]
        eprintln!("{err}");
        std::process::exit(1);
    }
}

fn run() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let exe_path = std::env::current_exe()?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| std::io::Error::other("実行ファイルのフォルダを特定できませんでした"))?;
    let cfg_path = config::config_path_from_args(&args, exe_dir);
    let base_dir = cfg_path.parent().unwrap_or(exe_dir);
    let cfg = config::load_config(&cfg_path, base_dir)?;
    let board_web_url = cfg.board_web_url.clone();
    let picker_runner = Arc::new(runner::PickerRunner::new(cfg));

    #[cfg(windows)]
    {
        window::run(picker_runner, board_web_url)
    }

    #[cfg(not(windows))]
    {
        let _ = (picker_runner, board_web_url);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "many-iris-picker launcher is only supported on Windows",
        ))
    }
}
