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
  注記: 2026-11-21 から、行き先なしの依頼は Clef-flash ではなく持ち主の
  順番で振り分ける（`board-worker/src/route.ts`。順番の先頭から生きている
  行き先を選び、誰もいなければ `hold`）。
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
  汎用書込みにも境界がある（次の「レビュー修正」の節）。
- 新ツール 6 つ: `board_heartbeat_handoff`、`board_progress_handoff`、
  `board_complete_handoff`、`board_mark_handoff_unknown`、
  `board_release_handoff`、`board_resume_handoff`。
  レビュー修正で `board_resolve_dispatch` を足して計 14 ツール。
- 画面の持ち主操作に `mark_unknown` / `release` / `resume` を追加
  （`POST /api/board/item`、`op` で指定、依頼番号の一致が必須）。

## レビュー修正（2026-11-16、初回レビューを受けて）

初回レビューで「実利用を妨げる」とされた 3 点への対応です。

### 1. 汎用書込み（board_upsert_item / board_add_event）の fencing 境界

問題: 世代チェックは実行専用ツールにしか無く、差し替えられた旧実行が
汎用ツールからそのまま書けて fencing を回避できた。

境界の設計（`src/resume.ts` の `checkGenericWrite`、`store.ts` が書込み
トランザクションの中で判定）:

- 看板の鍵は「担当者（writer）」を識別するもので、「実行（セッション）」
  は識別しない（`src/keys.ts`: actor は鍵ごとに固定、形式は
  `^[a-z0-9-]{1,32}$`。OAuth のクライアントも actor はクライアント名）。
  旧実行が成り代われるのは**自分の担当者の名前だけ**なので、境界はそこに引く。
- 項目の handoff が `accepted` の間、その項目を受けた担当者**本人**の
  汎用書込みは、現在の `request_id` と `generation` の提示が必須
  （任意引数として追加。片方だけは INVALID）。提示が無ければ
  `FENCE_REQUIRED`、古い世代なら `STALE_GENERATION` で拒否する。
  実行専用ツールを使う書き方でもよい。
- handoff が `unknown` の間は、その担当者の汎用書込みは fence を添えても
  拒否する（`HANDOFF_CONFLICT`）。隔離中は resume するまで実行の書込みは無い。
- **他の担当者と持ち主は従来どおり**。他の担当者の書込みはその人の名前で
  記録される共同の書込みであり、看板は元々項目ごとの書込み権限を持たない
  （例: 受けた担当でない writer が項目の題名を直す、といった既存の使い方は
  テストで守ったまま）。持ち主の画面操作は actor が `page:owner` で、
  鍵の担当者とは衝突せず、この境界の対象外（画面の操作自体が従来どおり
  制限された op のみ）。

権限境界のまとめ:

| 誰 | 受理済み項目への汎用書込み |
|---|---|
| 受けた担当者本人（現在の実行） | fence（request_id + generation）を添えれば可。実行専用ツールでも可 |
| 受けた担当者本人（旧実行・別セッション） | 拒否（fence 無しは FENCE_REQUIRED、旧世代は STALE_GENERATION） |
| 他の担当者 | 従来どおり可（自分の名前で記録される） |
| 持ち主（画面、`page:owner`） | 従来どおり（制限された op のみ） |
| dispatcher（内部、`dispatcher`） | 従来どおり（起動の記録イベント） |

残る限界（正直な記録）:

- 仕事が**別の担当者に**引き継がれた後では、旧実行の汎用書込みは
  「他の担当者の書込み」と区別できない（鍵が担当者までしか識別しないため）。
  その書込みは旧担当者自身の名前で残り、実行としての書込み
  （進捗・完了・状態の締め）は fencing 付きツール側で拒否される。
  実行を識別する鍵（セッションごとの鍵）は看板の鍵の仕組みに無いので、
  必要なら鍵の発行単位の変更として別途検討する。
- 完了（`completed`）後の汎用書込みは通常の書込みに戻る。完了した実行の
  遅い書込みと、その担当者の通常の追記は区別できない（同じ理由）。

### 2. dispatcher の二重起動: 起動前の原子的 claim

問題: 従来は Devin を起動してから `dispatch_log` に記録していたため、
並行した tick や「起動したのに応答が消えた」場合に二重起動し得た
（旧コードで並行 tick が 2 回起動することを実測して再現済み）。

設計（`store.ts` の `claimDispatch` / `confirmDispatch` /
`markDispatchUnknown` / `resolveDispatch`、`dispatch.ts`）:

- 起動の**前**に、確認と挿入を 1 トランザクションで行う claim を記録する
  （Durable Object 内なので原子的）。claim を取れなかった tick は起動しない。
  上限（1 依頼 2 回まで・1 日 6 回まで・15 分デデュープ）は claim の中で
  同じ条件で数える（従来の事前確認も残すが、正は claim）。
- claim の行が起動の記録そのものになる。状態遷移:
  `claimed`（起動中）→ `started`（応答が返り、セッション ID を記録）/
  `unknown`（起動の呼び出しが失敗したか応答が消えた。起動したかどうか
  自体が不明）→ 人が後始末して `resolved`（retry の確定）または
  `started`（started の確定）。Devin が 4xx（鍵の誤り・失効、要求の誤り、
  回数制限）で断ったときは、起動していないことが確かなので `refused` に
  する。`refused` は何も止めず、人の後始末も要らない。1 依頼 2 回・1 日
  6 回の上限には数えるので、鍵が誤ったままでも起動の試行は 1 依頼 2 回で
  止まる。5xx・応答なし・読めない応答は従来どおり `unknown`。
- **`unknown` は自動では絶対に再試行しない**。claim が残る限り dispatcher
  はその依頼を素通りし、看板には「unknown: 応答が消えたので自動では
  再試行しない」という出来事が残る。
- 人の復旧は新ツール `board_resolve_dispatch`（どの担当者でも呼べる。
  出来事に誰が確定したかが残る）:
  - `resolution: "retry"`: Devin 側を見て「セッションは動いていない」と
    確認できた場合。claim は `resolved` になり、dispatcher は再び claim
    できる（ただしこの試行も 1 依頼 2 回までの上限に数える。上限に
    達したら、それ以上の自動起動はせず、人が直接任せる/受ける）。
  - `resolution: "started"` + `session_id`: 「実は起動していた」場合。
    そのセッションが自分で `board_accept_handoff` して進めるので、
    dispatcher はもう起動しない。
  - `unknown` でない依頼への呼び出しは `HANDOFF_CONFLICT` で拒否する。
- 起動中の取り下げ・行き先変更との競合: claim は依頼（handoff）側を
  ロックしないので、起動中でも取り下げ・行き先変更は従来どおりできる。
  その場合セッションは起動してしまう（起動は取り消せない）が、
  受理の段階で看板が拒否する（取り下げ後は `HANDOFF_CONFLICT`、
  行き先が変わっていれば `FORBIDDEN`）ため、仕事を引き受けることはない。
  dispatcher が Devin に渡す手順も「受理に失敗したら終了する」と明記済み。
  この競合は e2e テスト（`test/dispatch.test.mjs`）で実測している。
- 移行: claim 導入前の `dispatch_log` の行は status が NULL で、
  「起動後に記録された＝started」として数える（当時の記録方法がそうだった）。

### 3. 既存の受理済みデータ（generation / lease が null）の移行

世代・リースの列ができる前に受理された仕事は、両方が null のまま残る。
新コードでの実測した振る舞いと復旧:

- 表示: `handoff.legacy_run: true` が付く。`lease_expired` は false
  （リースの記録自体が無いため）。
- 実行専用ツール: 世代が無いので fence が一致せず `STALE_GENERATION`
  になる（その実行は元々世代を受け取っていないので、当然の帰結）。
- 汎用書込み: 受けた担当者本人のものは**従来どおり通る**（送るべき
  世代が存在しないため、境界の対象外とした。上の表の例外）。
- `unknown` にできる: リースの記録が無い受理は「生きている証拠が無い」
  ものとして、`board_mark_handoff_unknown` / 画面の操作を即座に許可する
  （`canMarkUnknown` の条件に追加。リースがある受理は従来どおり
  期限切れが条件）。
- 世代の付与（移行の完了）は 3 経路ある。いずれも人の操作か本人の再試行が
  起点で、自動では付けない:
  1. 本人の受理の再試行: 同じ担当者が同じ request_id で
     `board_accept_handoff` をもう一度呼ぶと、冪等な応答の中で世代と
     リースが付き、その応答で両方を学べる。
  2. `unknown` → resume: 世代が無い実行を resume すると、その場で
     次の世代とリースが付き、応答で返る。
  3. 解放して任せ直す: 新しい依頼は従来どおり依頼時点で世代が付く。
  また、世代導入前に**依頼だけ**されていた仕事は、受理の時点で世代が
  付く（受理の UPDATE が COALESCE で補う）。
- 制限: 上記のどれも踏まない旧実行は、世代なしのまま汎用書込みだけが
  使える状態が続く。これは「止めない」ための互換措置であり、
  fencing の保護は世代が付いた時点から効く。旧実行が残っているかは
  `legacy_run: true` で見えるので、持ち主は計画的に 2. の経路へ寄せられる。

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

レビュー修正（2 回目のコミット）で追加で触った場所:

- `board-worker/src/resume.ts`（`checkGenericWrite`、`isLegacyRun`、
  `canMarkUnknown` のリース無し許可）
- `board-worker/src/store.ts`（汎用書込みの guard、受理・resume での
  世代の補完、`dispatch_log` の status / session_id 列と claim 一式、
  `resolveDispatch`）
- `board-worker/src/mcp.ts`（汎用 2 ツールへ fence 引数の追加、
  `board_resolve_dispatch` の追加）
- `board-worker/src/index.ts`（新ツールの配線、claim の受け口、
  `FENCE_REQUIRED` の HTTP 409 対応）
- `board-worker/src/dispatch.ts`（claim → 起動 → 確定/unknown の流れ）
- `board-worker/test/dispatch.test.mjs`（新規。Devin の受け口を立てた
  実物 e2e）、`test/route.test.mjs`（フェイクを claim 方式にし、並行・
  応答消失・後始末のケース追加）、`test/resume.test.mjs`（境界と移行の
  判定テスト追加）、`test/board.test.mjs`（ツール数 14、汎用書込みの
  fencing の e2e、常に真だったダミー検査
  `check("unknown work is not pending for the dispatcher", true)` を
  handoff.state の実測に置き換え、既存の「a writer still writes after
  the owner」検査は『実行本人の汎用書込みには fence が要る』という
  新しい境界に合わせて書き換え）
- `README.md`（ツール数の更新）、この文書

3 回目のレビュー修正（2026-11-17）で触った場所:

- `board-worker/src/dispatch.ts`（Devin の起動を `spawnDevinSession` として
  ここへ移し、4xx を `refused` として返す。dispatcher は `refused` を人の
  後始末なしで記録する）、`board-worker/src/store.ts`（`refuseDispatch`）、
  `board-worker/src/index.ts`（配線）
- `board-worker/test/route.test.mjs`（断られた起動・応答の読み分けの試験）
- `README.md`（Devin の起動の説明）、この文書（`refused` と「配備の前に」）

手元にあった別の試作（起動前の予約だけを作ったもの、未コミット）とは
2026-11-17 に突き合わせた。試作にあってこの PR に無い判断は「起動を
試みた依頼は取り下げ・行き先変更をさせない」だけで、この PR は取り下げを
許したうえで受理の時点で断る形にしているので、取り込まなかった。

試作が同じ場所を触っている場合は、次を正として照合してください:
世代は項目単位で単調増加し消さない／リース切れで自動動作しない／
解放は unknown + 停止確認が必須／進捗・完了は request_id + generation で
fencing する／汎用書込みは「受けた担当者本人だけ」を fence し、他の
担当者と持ち主は従来どおり／dispatcher は起動前に claim し、結果不明は
自動再試行せず人が `board_resolve_dispatch` で確定する／世代の無い
旧実行は `legacy_run` として見え、受理の再試行・resume・任せ直しで
世代が付く。試作側に別の列名・ツール名がある場合は、どちらかに
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

## 配備の前に（既存の拾い手の追随）

この変更を本番へ出すと、受けた担当者本人の `board_upsert_item` /
`board_add_event` に世代の提示が要るようになる。いま本番の看板に書いて
いる拾い手のうち、次の 2 つは世代を送らないので、配備した時点から
受けた仕事への書き込みが `FENCE_REQUIRED` で断られる（2026-11-17 に
many-ai-cli の `rust/src/application/board_sync/taker.rs` を読んで確認）。

- many-ai-cli の手元の受け取り（`local_taker`）: `board_accept_handoff` の
  後、「開始」「[完了] …」「終了」を `board_add_event` で、状態を
  `board_upsert_item` で書く。配備後は受けた仕事が `in_progress` のまま
  残り、`claude -p` の結果は看板に載らない（`claude -p` 自体は動く）。
- many-ai-cli の Hub の「看板から任された仕事」の一覧から始めたセッション:
  受けた書き手の鍵で、同じ項目へセッションの記録を書く。

順番は、many-ai-cli 側を先に直して（受理の応答の `handoff.generation` を
控え、`board_progress_handoff` / `board_complete_handoff` か、世代つきの
汎用書込みにする）Hub を入れ替え、その後で看板を配備する。配備の時点で
まだ受けられていない依頼（`requested`）が無いことも、`board_list` で
確かめる。配備前に旧い手順書で起こした Devin のセッションが配備後に
受けると、受理で世代が付くので、その後の旧手順の書き込みが断られる
（配備前に受理済みの実行は `legacy_run` として従来どおり書ける）。

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

## 次段: 拾う側（picker/）

この文書の受理→ハートビート→進捗→完了の手順に従う拾う側は、
stacked PR の `picker/` として実装しました。設計と調査
（many-ai-cli の既存の拾い手との重複回避を含む）は
`docs/ipad-picker.md` が正本です。この PR（#4）が未統合の間、
picker も main へは入れられません。
