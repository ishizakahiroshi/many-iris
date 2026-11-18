# ipad-2027 — Many Iris 夜間一気通貫マスタープラン

> 2026-11-18 JST / 設計・実行引継ぎ用。実行開始の命令ではない。正本: https://github.com/ishizakahiroshi/many-iris/issues/7

## 0. ゴールと非ゴール

**ゴール**: 寝る前に所有者が安全な範囲の仕事を明示して渡し、翌朝に「依頼→受領→調査→実装→試験→Draft PR→レビュー→看板へ証跡付き完了/保留」をiPadだけで確認できる状態を目指す。最初の夜は合成ジョブと安全な公開repoの小さな変更を使う。手元PC停止中も動くかを実測し、未確認を成功扱いしない。

**非ゴール**: 新規の万能指揮者の同時開発、PRの自動マージ、外部公開、デプロイ、許可されないサービスの操作、承認の自動代行。既存のCloudflare看板とRust Irisを作り直さない。

## 1. 確認済みの既存資産（実行前に最新版再照合）

| 資産 | 現状の役割 | 夜間計画での扱い |
|---|---|---|
| [Many Iris PR #4](https://github.com/ishizakahiroshi/many-iris/pull/4) | generation/fencing、lease、heartbeat、unknown隔離、復旧 | **第一依存**。HEAD `10914cd30330f90375ee4cf5b9faa50ec8d0f7a2`（11/18確認時点）。レビュー・回帰試験を先行 |
| [Many Iris PR #5](https://github.com/ishizakahiroshi/many-iris/pull/5) | Node `picker/` で担当ジョブを受理・送出・報告 | #4 上に積まれた Draft。HEAD `89b58cb822720d9fa0793d50b7554694f7274fae`。#4 に依存 |
| [many-ai-cli](https://github.com/ishizakahiroshi/many-ai-cli) | 既存Hub、local_taker、セッション | PR #4 の導入による `FENCE_REQUIRED` と heartbeat の互換性を確認。看板に追随コミット `18a2f7bb` の記録あり、**実物のビルドと配備は未確認** |
| [Many Iris #6](https://github.com/ishizakahiroshi/many-iris/issues/6) | 指揮者候補比較 | 第一PoCはKAGOYA VPS + `claude -p`。Hermes+Codex/Devin/Jevは代替・補助として保留 |
| [many-ai-cli #48](https://github.com/ishizakahiroshi/many-ai-cli/issues/48) | 承認待ち/継続待ち監視 | ユーザーに無断で承認しない。許可済み操作と新規意思決定を峻別 |
| [Many Iris #1](https://github.com/ishizakahiroshi/many-iris/issues/1) | エージェント間handoff設計 | 必須のファイルハッシュ照合と受領証跡を最小限で実施。機構全体の採用決定は後続 |

Many Iris board-worker はCloudflare Workers + Durable Objectで稼働しており、Clef-flashによる単純な振り分けがある。Rust `iris/` は現在ローカル/合成実行の候補であり、VPS実運用済みとはみなさない。私有の `docs/local/plan_many-iris-overnight-to-goal.md` が手元環境にあるという看板の記録はあるが、公開repoの main から本文を取得できていない。実行担当は実ファイルを読んで差分・優先規則を確認すること。推測して上書きしない。

## 2. 実行可能な依存グラフ

```text
P0 現況凍結・権限/事前審査
 |---- P1a PR #4 安全性レビュー -----------|
 |---- P1b many-ai-cli互換性/Hub照合 ----|---- P2 #4+#5 統合試験（隔離環境）
 |---- P1c KAGOYA/Claude認証調査 --------|          |
 |---- P1d PR #5 コードレビュー（並行）----|          v
                                             P3 picker/指揮者薄い接続PoC
                                                      |
                                             P4 模擬E2E+故障注入
                                                      |
                                             P5 翌朝レポート・Draft PR
```

**重要**: #4/#5を既存PRのまま順序に従って取り込む方針。1本の巨大PRにコードをまとめない。統合検証は隔離ブランチ/一時環境で行い、既存PRのレビュー文脈を保持する。

## 3. 夜間バッチの作業指示

### P0 — 事前確認（書込より先に）
- GitHubで #4/#5、many-ai-cli のHEAD、CI、レビュー、open issues、既存作業ブランチとローカル計画を読み直す。2026-11-18のSHAは照合用スナップショットであり固定実行対象ではない。
- 使用するアカウントが `ishizakahiroshi-bot` で、書込み権限があることを確認。メインへの無断切替えは禁止。実行担当・対象repo/path・許可範囲・終了条件を記録する。
- KAGOYA VPSのホスト/容量/実際の契約・Claudeのログイン方式/利用上限/自動従量課金の有無は現物で確認。資格情報をIssue/ログへ出さない。未確認なら **本番VPS実行は行わず** 疑似実行へ進む。
- 既存インフラ、既存DB、他サービスへの影響が読めない操作は実施しない。

### P1 — 並行にできる独立レビュー（上限2並列、1ブランチ1書き手）
- **R4**: PR #4 の型・境界・既存データ移行・dispatch claim/refused/unknown・fencingと回帰を検査。`board-worker` テストと秘密検査の結果を添える。
- **R5**: PR #5 の `picker` 条件 `requested_by=page:owner` と `to_set_by=page:owner`、世代検査、コマンド実行権限、資格保護、timeoutを検査。stacked baseを尊重。
- **RCLI**: many-ai-cli のHubの現物バージョン、local_takerのfencedツール追随、heartbeat、`vps-claude` 宛て経路、PR #4 の本番適用前互換性を検査。ホスト上の実更新はしない。
- **RCOST**: `claude -p` のサブスク利用と従量課金を分け、CLIの認証更新/制限/規約を検証。本人申告の利用枠は実測・契約確認前に「保証済」と書かない。APIキー自動フォールバック禁止。
- 指摘があれば、独立したbot修正ブランチ・Draft PRまたは既存bot Draft PRの安全な追記案にまとめる。既存の別担当の作業をforce-pushしない。

### P2 — #4 → #5 の隔離統合
- #4上に#5の差分が乗る既存stackの順序を保つ。`main`は触らない。各ツールの`pnpm test`/`npm test`、`picker`テスト、Rust側の関連テストを実行できる範囲で検証する。
- `local_taker`がfencingなしで書く問題を再現し、現行修正のHEADを確認。新しいCloudflare看板を先に配備して既存Hubを壊すことは禁止。
- 実機が未確認のままなら `BLOCKED_HUB_VERSION` として独立した合成PoCを続ける。本番更新・既存PRのマージには進まない。

### P3 — 指揮者の最小実装
- KAGOYA上の常駐プロセスの責務は**看板の監視・ジョブ受理・実行状態記録・`claude -p`を必要時だけ非対話起動**。LLMの判断を履歴DBの正本にしない。
- 新規巨大フレームワークを採用しない。まずは既存pickerの `CommandExecutor` 等への薄いアダプタで比較する。複雑な計画判断以外は既存Clef/決定論的な規則を使う。
- 実運用の承認範囲が固まるまで `RecordExecutor` と合成指示だけで進む。shellの任意解釈・所有者の意図しないコード実行・見知らぬIssueの自動取得は禁止。
- 指揮者のセッション継続に依存せず、実行ID・親タスク・世代・repo/branch/commit・期限・状態・未確認事項を看板と成果物へ残す。

### P4 — 一気通貫の合成受入
1. 持ち主に許可された固定の合成依頼1件をiPadの代わりの画面/APIで発行（本人承認の偽装は不可）。
2. 看板で受領→担当指定→pickerが1回だけ拾う→合成担当が小さなファイルを生成→テスト→bot Draft PRを提出→request_id/generationと実SHA・テスト結果を看板に戻す。
3. 同じrequest_idの二重受理、起動応答消失、CLI異常終了、レート制限、リース失効、Hub再起動を個別に注入。unknownは保留して自動再送しない。
4. 成果物のハッシュ・PR HEAD・試験ログを受け手が再検証。報告と受領、実装成功とレビュー、本人の承認を混同しない。
5. **本物のiPad実機/手元PC停止状態/本番KAGOYA接続**は実際に試していなければ明示して残件にする。

### P5 — 翌朝の引継ぎ
- 1枚の成果報告に `DONE / BLOCKED / UNKNOWN / NOT_RUN`、各PR URL・base/head・commit SHA、試験コマンドと実数、外部API費用/利用枠、再現手順と修正の戻し方を記録。
- 本人に決めてほしい事項は最大3件に集約。停止時も他の独立タスクは許可範囲で継続する。
- 証拠不十分のものを完了にしない。公開Issueに秘密・個人の契約状況・非公開成果物を載せない。

## 4. 休んでいる間の実行ポリシー（PoCの初期上限案）

| 境界 | 提案 |
|---|---|
| GitHub | `ishizakahiroshi-bot`。Draft PR・Issueコメントとテストまで。マージ/リリースは不可 |
| 並列実行 | 最大2ワーカー。単一ブランチの書込みは直列 |
| ジョブ数 | まず合成1件＋小さな実repoテスト1件まで。翌夜に拡張 |
| 利用枠 | 上限/認証の不確実性では停止。課金方式の自動切替は禁止 |
| 自動承認 | なし。人が明示した限定作業以外は保留 |
| 再試行 | idempotencyが実証され、起動されていないと確定できる場合のみ。unknownは保留 |
| 本番変更 | Cloudflare deploy、KAGOYAの恒久設定変更、DB migration、Hub置換、PR merge、記事/X投稿は今回の許可外 |
| 作業時間 | 夜間枠はランナー側で明示し上限に達したらレポートして停止。勝手な翌日への継続なし |

**外部自動化の起動はこの文書からは行われない。** 現在このChatGPTセッションから寝ている間にCLIを常駐起動する手段はない。実行担当へこのIssue/PRのURLを渡し、既に運用中の実行経路で明示的に開始させること。

## 5. 再開と完了の判定

- **最小合格**: 合成依頼1件が、担当確認、実行・検証、bot Draft PR、看板への完了または安全なholdまで一周し、翌朝追跡可能なURL/実測が揃うこと。
- **完全合格**: 上記に加え、許可された本物のVPS・iPadで動作、PC停止中の継続を実証し、通信断等で二重実行されないこと。ただし本番変更には改めて承認が必要。
- **NG**: AIが本人承認を代行、旧世代が状態を書換、通信断なのに盲目的に再起動、API従量課金へ無断切替、メインGitHubアカウントで書込み、PRを無断マージ。

## 6. 関連リンク

- 親計画: `ipad-2027`（Many Iris看板）
- 統括Issue: https://github.com/ishizakahiroshi/many-iris/issues/7
- 指揮者検討: https://github.com/ishizakahiroshi/many-iris/issues/6
- 成果物handoff: https://github.com/ishizakahiroshi/many-iris/issues/1
- 自動承認の制限: https://github.com/ishizakahiroshi/many-ai-cli/issues/48

## 7. 着手前チェック

- [ ] 現場の `docs/local/plan_many-iris-overnight-to-goal.md` を読んで矛盾を整理した
- [ ] 現行PRのHEAD/CIと既存承認範囲を再確認した
- [ ] 本人の許可した実行範囲と環境が特定できている
- [ ] 起動する夜間ランナーと停止/報告経路が存在する
- [ ] 本番変更は別承認とし、Draft PRまでに制限した

このマスタープランは既存PRを上書きするものではなく、夜間担当が迷わず検証・開発を進め、判断が必要な地点では**安全にholdして朝に返すための手順書**である。

## 8. ローカルAIに委ねる現物確認

実機確認を伴うL0〜L4の指示は [ipad-2027-overnight-local-ai-handoff-2026-11-18.md](ipad-2027-overnight-local-ai-handoff-2026-11-18.md) を正本とする。

- 手元の正本計画の本文、Hubの稼働バイナリ、KAGOYAの実状態と`claude -p`認証をローカルAIが調査する。
- 変更操作をする前にownerの既存承認範囲を確認。ローカルAIへ自動マージ・本番デプロイ・Hub差替えの許可を与えない。
- GitHub上で確認できる現行のPR・テスト・互換性論点はこの計画とIssue #7に集約し、別個の巨大計画を作らない。
