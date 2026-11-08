use std::time::Duration;

#[tokio::test]
async fn recovery_arguments_fail_before_network_or_state_creation() {
    let root = tempfile::tempdir().unwrap();
    for args in [
        vec!["--executor-request-id", "private-request-value"],
        vec!["--executor-request-binding", "private-binding-path"],
        vec![
            "--executor-request-id",
            "private-request-value",
            "--executor-request-binding",
            "private-binding-path",
            "--executor-evidence-binding",
            "private-owner-path",
        ],
        vec![
            "--executor-request-id",
            "private-request-value",
            "--executor-request-binding",
            "private-binding-path",
        ],
    ] {
        let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_many-iris"));
        child
            .args(args)
            .current_dir(root.path())
            .env_clear()
            .kill_on_drop(true);
        #[cfg(windows)]
        child.env(
            "SystemRoot",
            std::env::var_os("SystemRoot").unwrap_or_default(),
        );
        let output = tokio::time::timeout(Duration::from_secs(3), child.output())
            .await
            .unwrap()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let message = String::from_utf8_lossy(&output.stderr);
        assert!(!message.contains("private-request-value"));
        assert!(!message.contains("private-binding-path"));
        assert!(!message.contains("private-owner-path"));
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
