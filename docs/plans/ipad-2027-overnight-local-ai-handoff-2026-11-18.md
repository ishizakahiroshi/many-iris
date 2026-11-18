# ローカルAIへの引き継ぎ — ipad-2027 夜間実行前の実機確認

2026-11-18 / 親: https://github.com/ishizakahiroshi/many-iris/issues/7
計画: `docs/plans/ipad-2027-overnight-integration-2026-11-18.md`

## あなたへの依頼

この引き継ぎは、ChatGPTの接続環境から**確認できない現物だけ**をローカルAIに調査してもらうための指示。実装や配備の白紙委任ではない。各段階の結果を `PASS / FAIL / BLOCKED / UNKNOWN` に分類し、根拠と非機密ログをまとめる。疑問があっても、許可済みの独立した読み取り作業は進め、危険な変更のみ hold。

**現時点で許可される操作**: ローカル・VPSの読み取り診断、バージョン照合、隔離ワークツリー/一時環境でのテスト、公開情報の調査、非機密のレポート作成とbot Draft PR作成。**許可されない操作**: 本番VPSやCloudflareの設定変更/デプロイ、Hubの実行中バイナリの置換、PRマージ、権限変更、追加課金、契約操作、本人認証の代行、保有データの削除。

## L0: ローカルにしかない計画の読取・整合（最優先）

1. ローカルの `docs/local/plan_many-iris-overnight-to-goal.md` の存在、正本、更新日時、残タスクを読む。無い場合は UNKNOWN と記録し推測で補完しない。
2. `many-iris` の PR #4（HEAD `10914cd...`）、PR #5（HEAD `89b58c...`）、Issue #7 と照合。SHAは2026-11-18のスナップショット。作業時の現行HEADを優先する。
3. 合流時に上書きする必要がある未コミット変更・実行中のプロセス・既存のローカルブランチを列挙。既存作業を消さず、新しい隔離worktreeを使う。
4. この作業が既存の `many-ai-cli` の手順・計画と重複するなら、その計画の該当箇所へ参照を返し二重管理を増やさない。

## L1: HubのバージョンとPR #4互換性の証明

- 実際に起動中の `many-ai-cli` Hubプロセスの実行ファイル、起動時刻、ビルド識別子を確認。**見えているソースのコミットと実プロセスが同じとは推測しない**。
- `many-ai-cli` の `rust/src/application/board_sync/taker.rs` とHubの「任された仕事から開始」を確認し、PR #4で導入する受領後の `request_id + generation` 要件とハートビートに追随していることをコード/試験で検証。
- 過去の看板記録には「many-ai-cli develop `18a2f7bb`へ追随コミット」「Hubは旧バイナリのまま」とある。再確認し、すでに更新済みならその実測を優先。
- 更新が必要でも夜間に本番Hubを勝手に入れ替えない。安全なビルド/停止/復元手順と実行すべき差分を成果物にする。
- `FENCE_REQUIRED`、リース切れ、unknown、回線断、二重acceptのケースを**隔離試験環境**で再現できるかをチェック。

## L2: KAGOYA VPSの診断（読み取りのみ）

VPSのホスト名、IP、SSH鍵、トークン、契約名、アカウントID、個人パスを公開レポートへ載せない。すでに承認済みのアクセス手段がある場合のみ接続し、なければ BLOCKED。

実機で確かめるもの:
- OS/アーキテクチャ、CPU数・RAM・空きディスク、Node/Rust/Claude CLIの有無とバージョン
- `claude -p` が**サブスクリプションの正当なログイン経路**を使うか。環境変数のAPIキー優先・無断従量課金への切替がないか
- 非対話実行、JSON出力、exit code、timeout、kill時の子プロセス、login/session切れ、利用枠到達時の挙動
- systemdなどの常駐サービス候補を読み取りで調べる。**本番serviceの作成/有効化は行わない**
- API秘密情報の保存先、ログへの出力、最小権限ユーザー、git書込みユーザーの分離
- 本人の認証操作が必要ならその地点で停止して、具体的な次の1手だけ報告する

読み取り確認の例（認証・接続先は既存の安全な手段で解決）:

```sh
uname -a
id
nproc
free -h
df -h
node --version
command -v claude
claude --version
```

コマンドが無いときは `not installed` と記録。環境変数・token・設定ファイル本文・認証JSONは標準出力に流さない。新たに認証やパッケージ導入が必要なら提案のみ。

## L3: 依存PRの隔離検証

- #4 の branch `muse/ipad-cloud-resume`、#5 の branch `muse/ipad-picker` の依存を確認。#5を#4から切り離さない。
- #4, #5の試験をそれぞれ隔離worktreeで実行し、コマンド、実行日、合格/失敗、再現ログ、環境差分を残す。テストに外部副作用がある場合は**合成/localhost専用**にする。
- 必要なら既存のbot Draft PRへ小さな修正提案を作る。ただし他担当のブランチへ無断pushせず、別ブランチに切ってDraft PRでレビュー可能にする。
- PR #5の実LLM連携は未確認のため、RecordExecutor→合成CommandExecutor→限定CLIの順に段階を分ける。実業務・本番GitHubデータに無許可でアクセスさせない。

## L4: 最小の夜間ランナー実行可能性を判断

- KAGOYA上で `vps-claude` 宛てに受けられる実行主体が**存在しているか**。現時点のMany Iris READMEにはVPS picker未実装とあり、Node pickerは未マージDraftのまま。計画文書があるだけで「夜に自動で走る」と書かない。
- 認証が整い、隔離PoC/owner-authorizedタスクが揃ったときだけ実LLMを試験。無人で回すのは**事前に範囲の特定された仕事**のみ。
- `requested_by` / `to_set_by` の一致、時間・同時数・利用枠・コスト上限、二重起動防止、停止/復旧、翌朝の報告先が検査可能かを示す。
- 外部AIの承認カード・続行確認は本人承認を代行せず、受けられる形式が無いなら BLOCKED/hold。

## 提出形式（公開版）

```md
# ipad-2027 夜間実行前のローカル診断
検査日時（JST）:
対象: many-iris #7 / Draft PR #8
現行HEAD: many-iris main / #4 / #5、many-ai-cli develop
L0 計画: PASS|FAIL|BLOCKED|UNKNOWN / 理由
L1 Hub: PASS|FAIL|BLOCKED|UNKNOWN / 実バージョン(非機密) / fence互換
L2 KAGOYA: PASS|FAIL|BLOCKED|UNKNOWN / 容量・CLI有無のみ
L3 試験: PASS|FAIL|BLOCKED|UNKNOWN / コマンド・件数・リグレッション
L4 夜間ランナー: PASS|FAIL|BLOCKED|UNKNOWN / 起動方法(非機密) / 実際の到達性
リスク/保留:
新規・更新Draft PR URL と HEAD:
必要な本人判断（最大3件）:
次の許可済み一手:
```

公開できない診断データはローカルの安全な場所へ保管し、公開Issueには要約と参照可能な非機密証跡のみ記録。ローカルAIがGitHubへ書き込むときも **`ishizakahiroshi-bot`** を使用し、接続不可なら停止して理由を報告する。

### 成果物の完了判定

- **完了**: 実機の状態と互換性が根拠で示され、隔離試験の結果が追跡可能。未完の承認事項を列挙。
- **未完**: ローカル計画・Hub実バージョン・VPS・認証が不明なら、該当部分を保留。未実測を成功として埋めない。
- **夜間実行可能**: 許可済みの独立ランナーと実際の作業範囲が確認されていること。文書作成だけでは満たさない。
