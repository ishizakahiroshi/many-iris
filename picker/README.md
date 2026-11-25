# picker — 看板の仕事を拾う側

Many Iris の看板（board-worker）で自分宛てに任された仕事を拾い、
実行系に渡し、結果を看板へ返すための独立した Node.js プログラムです。
設計と調査の記録は `docs/ipad-picker.md` にあります。

看板の行き先のうち、`devin` は看板自身の cron dispatcher が拾います。この
picker はそれ以外の行き先（`vps-claude`・`vps-devin`・`muse`・`grokbot` など、
鍵の担当者名で決まります）を拾います。VPS では常駐（`--watch`）か cron の `--once` で、
手元の PC の `local-claude` も、下の「手元の PC で動かす」の作業役で拾えます
（many-ai-cli の Hub の `local_taker` の代わり）。

## 前提

- 看板側に PR #4（`muse/ipad-cloud-resume`）の fenced ツール
  （`board_heartbeat_handoff` / `board_progress_handoff` /
  `board_complete_handoff` と世代 fencing）が必要です。世代が返らない
  看板に対しては、picker は汎用書込みへフォールバックせず、
  何も実行せずに止まります。
- Node.js 18 以上。依存パッケージはありません。
  （`--watch` 常駐は組み込みの WebSocket を使うため Node.js 22 以上。）
- 担当者の書き手キー（ファイルで渡す。値はログ・成果物に出ません）。

## 使い方

```sh
cd picker
PICKER_BOARD_URL=https://iris.ishizakahiroshi.com/board/mcp \
PICKER_KEY_FILE=/path/to/writer.key \
PICKER_WRITER=muse \
node src/main.mjs --once    # 1 回だけ見に行く（cron 向け）
node src/main.mjs --loop    # 常駐して繰り返す
node src/main.mjs --watch   # 常駐: 看板の通知で即見に行く + ポーリング併用
```

`--watch` は、同じ `/board/mcp` の URL へ WebSocket で接続し、自分宛ての仕事
（手渡し・会話）が出た通知 `{"type":"wake"}` で即パスを回します。接続が
切れた・届かなかったときのために、いままでどおり `PICKER_INTERVAL_SECS`
おきのポーリングも常に併用し、切断中はバックオフで張り直します。鍵は
従来どおり Authorization ヘッダだけに乗せ、URL には載せません。
`PICKER_STOP_FILE` にファイルを指定すると、そのファイルがある間は
通知・ポーリングのどちらのパスも止まります（VPS の `STOP` 作法の常駐版。
カンマ区切りで複数指定でき、例えば `STOP,STOP-devin` はどちらかがあれば止まります）。

看板を見るのは `board_my_work`（自分宛ての分だけ）です。この道具が無い古い看板では、
いままでどおり `board_list` を読みます。看板で持ち主が「全部止める」を押している間は
何も受けず、動いている実行は次の連絡で `stop: true` を受け取ったら作業役を止め、
仕事を `board_release_handoff` で積み直します（完了は書きません）。
作業役の最後の 1 行が JSON `{"summary": "...", "ref": "https://...", "commit": "<16進>"}`
なら、`summary` を結果の文、`ref` と `commit` をカードの「結果」として
`board_complete_handoff` へ渡します。JSON でなければ文はそのままで、文の中の
最初の GitHub の PR のリンクを `ref` にします。

cron の例（5 分おきに 1 回）:

```cron
*/5 * * * * cd /path/to/many-iris/picker && PICKER_BOARD_URL=... PICKER_KEY_FILE=... PICKER_WRITER=muse node src/main.mjs --once
```

状態ファイルの隣に置く鍵（ロックファイル）で同時に動くのは 1 つだけに保たれ、前の回が終わっていなければ後の回は何もせず終わるので、間隔は 1 分おき（`* * * * *`）にしてもかまいません。

同じ機械で 2 つ目の picker（別の担当者名 `PICKER_WRITER`）を動かすときは、次を 1 つ目と分けてください。

- 鍵: `PICKER_KEY_FILE` はその担当者の書き手キーにする（actor を共有しない）。
- 状態: `PICKER_STATE_FILE` を別のファイルにする。ロックファイルも状態ファイルの隣に置かれるので、共有すると片方が動いている間もう片方が止まり、1 日の上限も合算されます。
- ログ: cron の出力先を別のファイルにする。
- 作業役: `PICKER_COMMAND`・`PICKER_COMMAND_CWD` を担当者ごとに分け、作業フォルダや認証情報を共有しない。

## 設定（環境変数）

| 名前 | 必須 | 既定 | 意味 |
|---|---|---|---|
| `PICKER_BOARD_URL` | ○ | — | 看板の MCP エンドポイント |
| `PICKER_KEY_FILE` | ○ | — | 書き手キーのファイル。毎回読み直す |
| `PICKER_WRITER` | ○ | — | 自分の担当者名（鍵の actor と一致させる） |
| `PICKER_PROJECTS` | | 全て | 見る project（カンマ区切り） |
| `PICKER_OWNER_ONLY` | | `1` | `0` で「持ち主が任せた仕事だけ」の門を外す（下記） |
| `PICKER_TRUSTED_REQUESTERS` | | なし | 門を開けたまま、持ち主と同じに扱う書き手（カンマ区切り。下記）。自分の `PICKER_WRITER` は入れられない |
| `PICKER_INTERVAL_SECS` | | 300 | `--loop` の間隔（30 以上） |
| `PICKER_HEARTBEAT_SECS` | | 300 | 実行中のハートビート間隔（リース 30 分より十分短く） |
| `PICKER_MAX_RUNS_PER_DAY` | | 6 | 1 日に拾う上限（1〜50）。`0` で上限なし（止めるときは `PICKER_STOP_FILE` か cron 側の STOP） |
| `PICKER_STATE_FILE` | | `picker-state.json` | 1 日の実行数の記録 |
| `PICKER_STOP_FILE` | | なし | `--watch` 用。カンマ区切りのファイルのどれかがある間は全パスを止める |
| `PICKER_VERSION_DIRS` | | なし | 受けるときに看板へ伝える版。`rules=/path,skills=/path` のように名前とフォルダを並べると、各フォルダの git の commit を、拾い手自身の commit（`picker=`）と一緒に `board_accept_handoff` の `versions` で送る |
| `PICKER_ATTACH_DIR` | | OS の一時フォルダの `many-iris-attachments-<書き手>` | 会話の添付を置くフォルダ。拾い手の利用者のフォルダでなければ（リンクや、ほかの利用者が先に作ったもの）使わず、0700 に締める。1 回分ごとに推測できない名前の 0700 のフォルダを作り、ファイルは 0600 で書いて、実行が終わったら消す。作業役には `job.attachments` でパスを渡す |
| `PICKER_EXECUTOR` | | `record` | `record`（記録のみ）か `command`（下記） |
| `PICKER_COMMAND` | command 時 | — | 実行するコマンド（シェルを介さず直接起動） |
| `PICKER_COMMAND_ARGS` | | `[]` | コマンドの引数（JSON 配列） |
| `PICKER_COMMAND_CWD` | | — | コマンドの作業フォルダ |
| `PICKER_TIMEOUT_SECS` | | 1800 | コマンドの制限時間 |

## 実行系（executor）

仕事の実体は差し替え可能です。既定の `record` は「受けた」ことだけを
記録し、実作業はしません（看板との一周を安全に試すためのものです）。
`command` は指定したコマンドを起動し、仕事（項目・題名など）を
JSON 1 行で標準入力に渡します。題名は作業の「名前（データ）」で
あって picker への指示にはなりません。コマンドの最終行が結果として
看板に残ります。そのコマンドが使う認証情報は、このプログラムの
外（コマンド自身の環境）で用意してください。

### 看板に作業工程を返す

作業役が担当の AI プロセスの起動を確認したときは `worker_started`、提出物の検査を開始したときは `checking_submission` を送れます。看板には「担当AI起動」「提出前検査中」と表示します。

コマンドを起動すると、picker は「作業コマンド起動」を報告します。作業役は工程が変わったときに、専用のファイル記述子 3 へ `investigating`（調査中）、`implementing`（実装中）、`testing`（テスト中）、`awaiting_input`（回答待ち）のいずれかを改行付きで書けます。たとえばテストを開始するときは、シェルなら `printf 'testing\n' >&3`、Node.jsなら `writeSync(3, "testing\n")` です。通常のコマンド出力やエラーの内容から工程を推測しません。

看板は工程の報告時刻と担当との最終通信時刻を別々に表示します。以前の担当から工程が届いていない依頼には「工程未報告」と表示します。MCPで照会する場合は `board_request_status` の `lifecycle.reported_phase` で確認できます。

## 手元の PC で動かす（`workers/local-claude.mjs`）

持ち主の PC の書き手 `local-claude` の仕事も、この picker で拾えます（many-ai-cli の
`local_taker` と同じ動きを、picker の作業役として書いたもの）。`PICKER_EXECUTOR=command`、
`PICKER_COMMAND` に node、`PICKER_COMMAND_ARGS` に `["<このフォルダ>/workers/local-claude.mjs"]`
を指定し、`LOCAL_WORKER_BOARD_JSON` に many-ai-cli の `board.json` の絶対パスを渡します。

- 作業するフォルダは、`board.json` の `repos` にその案件で最初に書いた `path` です。
  載っていない案件は断ります（`PICKER_PROJECTS` を `repos` の案件にそろえると、受ける前に外せます）。
- `claude -p` は `local_taker.env_file` の `ANTHROPIC_API_KEY` の行だけで動かし、
  サブスクリプションのログインは使いません。権限の段階は `local_taker.permission_mode`
  （`default`・`acceptEdits`・`plan`。既定 `acceptEdits`）。
- push・公開・送信・削除・commit はしません。結果は文だけを返します。
- 書き手の鍵・`env_file`・`board.json` は、claude のファイルの道具から読めないようにし
  （Windows では `//c/...` の形で書く）、picker の設定（`PICKER_*`）は claude の環境に渡しません。
- 続き（takeover）は扱いません。
- 止めるのは看板の「全部止める」か `PICKER_STOP_FILE` です。Windows で実行を止めるときは、
  作業役の下のプロセスまで `taskkill /T` で止めます。

## 安全の既定

- 拾うのは `handoff.to` が自分宛てで、持ち主が画面から任せ、
  行き先も持ち主が決めた仕事だけです（`PICKER_OWNER_ONLY=0` で
  外せますが、書き手キーだけで題名を書ける以上、無人実行の範囲が
  広がることを理解してからにしてください）。
- 持ち主の代わりに頼める書き手を `PICKER_TRUSTED_REQUESTERS` で名指しできます
  （例: 持ち主が自分の PC で動かす AI の `local-claude`）。そのときも、任せた人と
  行き先を決めた人の両方が、持ち主か名指しした書き手でなければ拾いません。
  行き先を看板の振り分け（おまかせ）に任せた依頼は拾わないので、名指しした
  書き手は `board_request_handoff` の `to` で行き先を書いて頼みます。
  外の AI の鍵は入れないでください。
- 1 回のパスで拾うのは 1 件まで。1 日の上限もあります。
- 実行中はハートビートでリースを延ばします。世代が合わなくなった
  （別の実行に替わった）、看板と通信できなくなった場合は、実行を
  中止し、結果を書きません。自動の再実行・再試行はしません。
  行き先不明の仕事は看板側の `unknown` 隔離と人の復旧手順に委ねます。
- 進捗・完了の書込みは、汎用ツールではなく世代で fence された
  専用ツールだけを使います。

## テスト

```sh
cd picker
npm test   # 単体（フェイク看板）+ 実看板（wrangler dev）での e2e
```

e2e は `../board-worker` の依存（`npm install` 済み）を使います。
