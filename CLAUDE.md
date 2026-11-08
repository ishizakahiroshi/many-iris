# Many Iris 開発ガイド

このファイルはプロジェクト固有の入口です。詳細な設計や進捗は正本を参照してください。

## プロジェクト概要

Many Iris は複数人・複数組織の協働を目指す公開 OSS です。Many Board や独立した OSS と連携し、外部の成果物を正本に残して参照する Junction を構想しています。いまは作者自身が使う範囲で、計画と実行の本体（`iris/`）と、進捗の看板（`board-worker/`）を実装しています。

## 開発上の境界

旧製品の成果は参照し、再利用する前に権利、秘密情報、設計と検証状態を確認します。旧製品の状態をこのリポジトリに複製して正本にしません。

## スタックとコマンド

本体は Rust（`iris/`。試験は `iris/` で `cargo test`）、看板は Cloudflare Workers の TypeScript（`board-worker/`。試験は `board-worker/` で `node test/board.test.mjs`）です。`prototype/` と `tests/` は旧 Python 試作、`experiments/` は言語比較の記録です。ガイドの構造検査は `node scripts/check-claude-md.mjs` を手動で実行します。

## AI 作業共通ルール

各利用者のグローバル AI 設定に従ってください。公開する資料と fixture は秘密情報や個人情報を含めず、例には合成データを使います。

## Obsidian artifacts

If `docs/obsidian/README.md` exists, use it as an index. Use the repository-relative entry; do not silently fall back to `docs/local` if it is missing.

## secrets-scan（このリポジトリの配線）

legacy scanner: `node scripts/secrets-scan.mjs --staged --block`。ローカル pre-commit と GitHub Actions を配置済み。実際の検出範囲・CI は未受入です。Rust 版 doxguard は固定候補の実行ファイル不在のため未導入です。

## 関連ドキュメント

`AGENTS.md` は AI 用入口です。ルートの `README.md` は旧 Python 試作の説明のままで、本体の説明は `iris/README.md` にあります。
