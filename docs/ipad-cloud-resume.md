# iPad から任せた仕事の安全な再開（board-worker）

iPad（看板の画面）から仕事を依頼し、クラウド側の担当（Muse・Devin など）の
作業状況と結果を看板で追い、通信断や担当の停止があっても**安全に**再開できる
ようにするための設計と実装の記録です。PC の常時稼働は前提にしません
（看板は Cloudflare Workers + Durable Object で動きます）。

この文書は、2026-11-16 にブランチ `muse/ipad-cloud-resume` で入れた変更の
正本メモです。変更範囲・インターフェース・判断をここに固定するので、
手元にある未コミットの試作は、後からこの文書と PR の差分を見て
衝突箇所を照合できます（試作の内容はこの変更には取り込んでいません）。

## 実装前調査（コード根拠）

既にあったもの:

- 依頼と受理: `board_request_handoff` / 画面の「任せる」で `REQ-…` の番号を
  発行し、`board_accept_handoff` が番号の一致と行き先（`handoff.to`）を
  原子的に確かめて最初の 1 者だけが受けられる（`board-worker/src/store.ts`
  の `acceptHandoff`、Durable Object の `transactionSync` 内）。
  二重受理は `HANDOFF_CONFLICT`。
- 二重起動防止（Devin）: dispatcher が `dispatch_log` で起動を数え、
  15 分以内の再起動防止・1 依頼 2 回まで・1 日 6 回までを守る
  （`src/dispatch.ts`）。
- 振り分け: 行き先なしの依頼は cron が Clef-flash で振り分け、失敗や
  自信不足は安全側の `hold` に倒す（`src/route.ts`）。
- 本体（`iris/`）側には実行の世代（fence）や unknown で再送しない規律が
  合成 executor 向けにあるが、看板の handoff には無かった。Rust 版の看板に
  handoff 自体が無い（`iris/README.md`）ため、今回の変更は
  `board-worker/` と共有画面 `iris/web/board.js` だけに閉じています。

無かったもの（今回入れた理由）:

1. 受理の冪等な再試行: 受理の応答が通信で消えると、同じ担当がもう一度
   受理しても `HANDOFF_CONFLICT` になり、「受けられたのか」が分からなかった。
2. 実行の生存確認: 受理後にハートビートも期限（リース）も無く、担当が
   死んでも看板上は永遠に「受けた」のままだった。
3. 古い実行の書込み防止: 受理後の進捗・結果の書き込み
   （`board_add_event` / `board_upsert_item`）は誰の実行のものか確かめず、
   差し替えられた古い実行の遅い書き込みが新しい実行の上に乗る余地があった。
4. 状態不明からの復旧経路: 取り下げ・行き先変更は「まだ誰も受けていない」
   依頼だけが対象で、受理済みの仕事を人が安全に戻す手段が無かった。
   そのため、止まった仕事は他の仕事と関係なく固まるしかなかった。

## 設計

### 世代（generation）による fencing

- 項目ごとに単調増加する `handoff.generation` を持つ。依頼のたびに
  +1 し、取り下げ・解放・完了でも**消さない**（次の依頼が必ず大きい世代に
  なるため、過去の世代は二度と一致しない）。
- 受理の応答で世代が返る。以後の実行専用ツールは
  `request_id` と `generation` を必須とし、看板の現在の世代と一致しない
  書き込みは `STALE_GENERATION` で拒否する（`src/resume.ts` の
  `checkFence`）。担当違いは `FORBIDDEN`、依頼そのものが進んでいる場合は
  `HANDOFF_CONFLICT` と、理由を分けて返す。

### リースとハートビート

- 受理で 30 分のリース（`handoff.lease_until`）が付き、
  `board_heartbeat_handoff` と進捗書き込みで延長される。ハートビートは
  出来事を書かない（看板の出来事上限を消費しないため）。
- **リース切れは情報であって動作ではない。** 切れても自動で再実行・
  再依頼・解放は一切しない。画面と `board_list` の
  `handoff.lease_expired` で「切れている」ことだけが見える。

### 状態不明（unknown）の隔離と人の復旧

状態遷移: `requested → accepted → completed` が通常系。異常系は
`accepted →（リース切れ後に人が mark）→ unknown →（人が判断）→ 解放して
積み直し / 同じ実行のまま resume`。

- `board_mark_handoff_unknown` / 画面の「状態不明にする」:
  リース切れの accepted だけを `unknown` にできる。`unknown` の間は
  dispatcher の対象外（`pendingHandoffs` は `requested` だけ）で、
  旧実行の進捗・完了書き込みも拒否される。
- 解放（積み直し）: `unknown` からだけ。MCP では
  `stopped_confirmed: true`（人が旧実行の停止と結果の確認をしたという
  明示）が必須で、画面では持ち主のボタン操作がその確認にあたる。
  解放すると項目は `planned` に戻り、別の仕事は一切ブロックされない。
- resume: `unknown` から、同じ依頼・同じ世代のまま `accepted` に戻す。
  呼べるのは受けた担当本人（MCP）と持ち主（画面）だけ。
- 実行自身の解放: accepted の実行が自分の世代を添えて
  `board_release_handoff` を呼ぶと、その場で積み直せる
  （自分が止まることは自分が一番よく知っているため）。

### 受理の冪等性

同じ担当が同じ `request_id` で受理を再試行したら、同じ handoff を
`changed: false` で返す（二重実行にはならない）。別の担当の再受理は
従来どおり `HANDOFF_CONFLICT`。

### 既存ツールとの関係（互換性）

- 既存 7 ツールと項目・出来事の規則（`src/rules.ts`、Rust 版との一致）は
  変えていない。受理の応答にリース・世代の項目が増えただけ。
- `board_add_event` / `board_upsert_item` は従来どおり使える（看板への
  共同の書き込みを壊さない）。ただし**実行の進捗・結果は fencing 付きの
  `board_progress_handoff` / `board_complete_handoff` を使う**のが新しい
  規約で、dispatcher が Devin に渡す手順もそちらに更新した。
- 新ツール 6 つ: `board_heartbeat_handoff`、`board_progress_handoff`、
  `board_complete_handoff`、`board_mark_handoff_unknown`、
  `board_release_handoff`、`board_resume_handoff`。
- 画面の持ち主操作に `mark_unknown` / `release` / `resume` を追加
  （`POST /api/board/item`、`op` で指定、依頼番号の一致が必須）。

### 保存の追加列（board_items）

`handoff_generation`（INTEGER、消さない）、`handoff_heartbeat_at`、
`handoff_lease_until`。いずれも `Store.init()` の `addColumn` で既存の
看板にも後付けできる形にしてある。テスト用にリース長は環境変数
`BOARD_LEASE_MS` で差し替えられる（本番の既定は 30 分、
`src/resume.ts` の `HANDOFF_LEASE_MS`）。

## 試作との衝突回避メモ

手元の未コミット試作と照合するときの目安です。この変更が触ったのは:

- `board-worker/src/resume.ts`（新規。純粋な判定だけ）
- `board-worker/src/store.ts`（handoff 列の追加、受理の冪等化、新メソッド、
  持ち主操作への復旧 3 op）
- `board-worker/src/mcp.ts`（新ツール 6 つの定義追加のみ）
- `board-worker/src/index.ts`（新ツールの配線、リース長の環境変数、
  `STALE_GENERATION` の HTTP 409 対応）
- `board-worker/src/dispatch.ts`（Devin への手順文だけ）
- `iris/web/board.js`（世代・期限の表示と復旧ボタン。Rust 版の看板では
  handoff が無いので表示は出ない）
- `board-worker/test/resume.test.mjs`（新規）、
  `board-worker/test/board.test.mjs`（ツール数の期待値、受理冪等性の
  期待値、新フローの e2e）、`board-worker/package.json`（test の連結）
- `README.md`（看板の説明）、この文書

試作が同じ場所を触っている場合は、次を正として照合してください:
世代は項目単位で単調増加し消さない／リース切れで自動動作しない／
解放は unknown + 停止確認が必須／進捗・完了は request_id + generation で
fencing する。試作側に別の列名・ツール名がある場合は、どちらかに
寄せる判断が要ります（この PR では試作を取り込んでいません）。

## 復旧手順（持ち主向け）

1. 看板で「連絡の期限を過ぎています」と出た仕事について、担当の側
   （セッションの有無、成果物の有無）を先に確かめる。
2. 担当がまだ動いていると確認できたら: 何もしない（次のハートビートで
   期限が延びる）。`unknown` にしてしまった後は「まだ作業中なので
   続ける」で同じ実行に戻す。
3. 担当が止まっていて、途中結果も確認できたら: 「状態不明にする」→
   「停止を確認したので戻す」。仕事は積み直され、新しい依頼・新しい
   世代で任せ直せる。
4. 結果が一部だけ出ているなど判断が付かない間は `unknown` のまま置く。
   その仕事以外は止まらない。

## 未検証・残り

- 実在のクラウド AI（Muse / Devin 等）との実接続での一周は未実施。
  理由: この環境からは実セッションを起こす権限・鍵を使わないため。
  代替として、看板の実物（wrangler dev + Durable Object）での e2e と、
  判定ロジックの単体テストで検証した。
- Cloudflare 本番への配備はしていない（この PR の範囲外。配備は
  持ち主の操作）。
- VPS・手元 PC の担当が自分で依頼を拾う側（poller）は、このリポジトリには
  元々無く、今回も入れていない。拾う側は `board_list` で
  `handoff.to` が自分宛ての `requested` を探し、この文書の受理→
  ハートビート→進捗→完了の手順に従う想定。
