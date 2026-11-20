# picker — 看板の仕事を拾う側

Many Iris の看板（board-worker）で自分宛てに任された仕事を拾い、
実行系に渡し、結果を看板へ返すための独立した Node.js プログラムです。
設計と調査の記録は `docs/ipad-picker.md` にあります。

看板の行き先のうち、`devin` は看板自身の cron dispatcher が、
`local-claude` は many-ai-cli の Hub（手元 PC）が拾います。この
picker はそれ以外の行き先（`vps-claude`・`vps-devin`・`muse`・`grokbot` など、
鍵の担当者名で決まります）を、PC の常時稼働に頼らずに拾うための
ものです。VPS の cron から数分おきに `--once` を叩く運用を想定
しています。

## 前提

- 看板側に PR #4（`muse/ipad-cloud-resume`）の fenced ツール
  （`board_heartbeat_handoff` / `board_progress_handoff` /
  `board_complete_handoff` と世代 fencing）が必要です。世代が返らない
  看板に対しては、picker は汎用書込みへフォールバックせず、
  何も実行せずに止まります。
- Node.js 18 以上。依存パッケージはありません。
- 担当者の書き手キー（ファイルで渡す。値はログ・成果物に出ません）。

## 使い方

```sh
cd picker
PICKER_BOARD_URL=https://iris.ishizakahiroshi.com/board/mcp \
PICKER_KEY_FILE=/path/to/writer.key \
PICKER_WRITER=muse \
node src/main.mjs --once   # 1 回だけ見に行く（cron 向け）
node src/main.mjs --loop   # 常駐して繰り返す
```

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
| `PICKER_INTERVAL_SECS` | | 300 | `--loop` の間隔（30 以上） |
| `PICKER_HEARTBEAT_SECS` | | 300 | 実行中のハートビート間隔（リース 30 分より十分短く） |
| `PICKER_MAX_RUNS_PER_DAY` | | 6 | 1 日に拾う上限 |
| `PICKER_STATE_FILE` | | `picker-state.json` | 1 日の実行数の記録 |
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

## 安全の既定

- 拾うのは `handoff.to` が自分宛てで、持ち主が画面から任せ、
  行き先も持ち主が決めた仕事だけです（`PICKER_OWNER_ONLY=0` で
  外せますが、書き手キーだけで題名を書ける以上、無人実行の範囲が
  広がることを理解してからにしてください）。
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
