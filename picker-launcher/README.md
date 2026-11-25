# picker-launcher — Windows 常駐ランチャー

Many Iris の手元 PC 拾い手（`picker/src/main.mjs --watch`）を、PowerShell ウィンドウを出さずに独自アイコン付きの Windows 常駐 exe として動かすための小さなランチャーです。

## 仕組み

- `#![windows_subsystem = "windows"]` でコンソールを出さず、子プロセス `node src/main.mjs --watch` も `CREATE_NO_WINDOW`＋Windows Job Object（親終了時に子も終了）で管理します。
- `build.rs` が `../assets/icons/favicon.ico` と `app.manifest` を exe リソースへ埋め込みます。
- 起動中はデスクトップ右下に小さいカード窓（アイコン・状態表示・`しまう`・`看板を開く`・`終了`）を出します。二重起動時は既存の窓を前面へ出します。

## 設定ファイル（`picker-launcher.json`）

`many-iris-picker.exe` と同じフォルダに `picker-launcher.json` を置きます（`--config <path>` でも指定可能）。

```json
{
  "picker_dir": "many-iris/picker",
  "board_json": "C:/path/to/board.json",
  "writer": "local-claude",
  "interval_secs": 300,
  "log_file": "picker.log",
  "state_file": "picker-state.json",
  "stop_file": "STOP"
}
```

## ビルドとテスト

```powershell
cd picker-launcher
cargo test
cargo build --release
```

生成された `target/release/many-iris-picker.exe` を配置し、タスクスケジューラから直接起動します。
