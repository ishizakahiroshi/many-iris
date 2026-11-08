# Many Iris — Rust / MCP candidate

指定した計画と許可、判断待ち、実行の状態、成果の根拠を一つの流れで確認するローカル候補です。中核はRust、画面はHTML/CSS/JavaScript、接続口はMCPです。

この候補は合成データと合成executorだけを使います。実AI、実案件、ChatGPT、Cloudflare/VPS、本人スマホ、Pushには接続しません。旧Go/Python比較の実行物とは別です。OSS正式版の公開・受入完了を示すものではありません。

## 起動

Rustの対応toolchainで、このディレクトリから `cargo build --locked --release` を実行します。実行物は `target/release/many-iris`（Windowsは `.exe`）です。利用者の起動にRust開発環境を必要としない配布候補ですが、署名・配布チャネル・自動更新の受入は未実施です。

```powershell
.\target\release\many-iris.exe --db .state\iris.sqlite3 --port 0
```

標準出力のJSONにある通常のloopback URLをPCのブラウザで開きます。初回は状態DB横の `iris.ui.key` に保存された本人用キーを入力してください。キーはチャットや外部サービスへ渡さないでください。URLに認証情報は含めません。bindは127.0.0.1だけです。外部公開・トンネル接続には使わないでください。停止は起動した端末のCtrl+Cです。

案件を選び、計画を開始すると、合成作業が進み本人判断で待ちます。判断の対象と版を読み、承認または却下します。停止の依頼と停止の確認は別で、停止証拠と副作用なしの結果を確認してから合成担当を交代できます。通信断・結果不明では再実行や担当交代を始めません。

本人用キーでログインしてから画面用session資格を発行し、MCP用資格と分けます。未認証の画面へsession資格を埋め込みません。MCP資格は状態DB横の `.mcp.token` に保存し、値は標準出力へ出しません。外側MCPから本人判断を確定するtoolは提供しません。この区別は、同一OSユーザー権限を持つプログラムからの完全な隔離や遠隔公開用の正式本人認証を保証しません。

## MCP

`POST /mcp` は2026-07-28 profileを使うローカル検査用endpointです。各要求metadataとHTTP mirror headersを照合します。`server/discover`、`tools/list`、公開された `iris_` toolsに対応します。実ChatGPTの対応版、OAuth/TLS、ネットワーク到達性は別の受入です。旧`initialize` profileへの自動fallbackはしません。

中核から合成executorへは同じ実行物を専用子processとして起動し、stdio MCPで要求します。合成executorは別SQLiteへ受理・結果・停止証拠を保存します。providerや任意shellの起動は行いません。

### owned HTTP の合成接続

`--executor-config <file>` は固定設定から executor を明示選択します。省略時は従来の stdio 合成経路です。`schema_version: 1` と `profile: "stdio-synthetic/1"` の設定も同じ経路を明示します。未知の版や接続失敗では別経路へ切り替えません。

別 profile `iris-owned-dispatch/1` の設定には `schema_version`、`profile`、loopback の `port`、別資格を持つ既存 `credential_file`、完全な `binding`、保存する開始 `request_id` が必要です。相対資格パスは設定ファイルから解決します。資格値は設定・引数・URLへ直接書かず、専用ファイルから読みます。Windows wrapper は `-ExecutorConfig <file>` を受けます。

この段階の owned 経路は既存の合成計画と `synthetic` provider/profile、`synthetic-host` の範囲に限定します。CLI 側はテストで fake launch port を明示注入する構成だけです。通常 Hub の production owner は inspection-only のままで、実 AI を有効化する設定ではありません。

許す owned profile は `iris-owned-dispatch/1`（既定）と `iris-owned-real-bounded/1` の2つだけで、設定の `profile` に完全一致で書いたときだけ使います。ほかの文字列、`profile` の省略、重複指定は起動時に拒否し、片方へ読み替えません。`iris-owned-real-bounded/1` の `binding` は `provider: "claude"` に限ります。`profile_id` には、many-ai-cli で実際に使う subscription profile の名前を本人が設定に書きます（既定値はなく、ASCII の英数字・`-`・`_` だけの 1〜128 文字で、`synthetic` は使えません。Iris は形だけを検査し、many-ai-cli はセッションが動かしている profile と違う名前を拒否します）。`execution_host_id` は many-ai-cli 側 identity の `execution_host_id` と同じ値を本人が設定に書きます（既定値はなく、ASCII の英数字・`-`・`_` だけの 1〜128 文字に限ります。many-ai-cli 側の identity と binding の規則と同じで、`.` を含む名前（`lab-pc.local` など）、空白・全角文字・Unicode の書式文字・制御文字・129 文字以上は拒否します。many-ai-cli 側の identity にも `.` は書けないため、`.` を含まない値を両方に書いてください。接続先の報告する値が設定と完全に一致しなければ送信前に止めます）。`iris-owned-dispatch/1` では従来どおり `synthetic` と `synthetic-host` だけです。計画自体は `synthetic-host` を名乗る合成のままです。profile と binding の組が合わない設定も拒否します。どちらの profile でも計画は合成のままで、Iris が成功や効果を確定しない扱い、unknown の再送禁止、元 request 照会は変わりません。

`iris-owned-real-bounded/1` の設定だけは、任意の `real_bounded` を書けます（`iris-owned-dispatch/1` と `stdio-synthetic/1` に書くと、中身が空や null でも起動時に拒否します）。`instruction_file`（many-ai-cli が読む指示ファイルのパス。相対パスは設定ファイルから解決）と `tasks`（1〜3 件の `{plan_id, task_id, approval_id}`）を書きます。3 つの id は件をまたいで1つも重ならず（plan と task の id も互いに別）、ASCII の英数字・`-`・`_` の 1〜80 文字に限ります。指示ファイルが無い・通常ファイルでない・空または空白だけ・65536 bytes 超・NUL を含む・UTF-8 でないときは起動時に拒否します。書いたときの状態は、合成計画の代わりに `tasks` 1 件につき 1 計画・1 task（人の判断なし）を持ち、各 task の `instruction_hash` は指示ファイルの bytes の SHA-256 です（改行・BOM・Unicode 形を変換しません）。`binding` は `tasks` のどれか 1 件の id の組と、その hash を持つ必要があります。`scope_hash` は `tasks` と指示ファイルだけから決まる値（作成時刻には依存せず、同じ設定なら同じ値）で、状態を作ってから snapshot の `approval.scope_hash` で確かめて書きます。読込時には `scope_hash` を検査しないので、確かめるまでは 64 桁の 16 進の仮の値で起動できますが、その binding では送信前に止まります。この状態は同じ `real_bounded` で起動したときだけ開き、合成計画の状態とは互いに開けません。`real_bounded` を書かない `iris-owned-real-bounded/1` は従来どおり合成計画で動きますが、その hash は many-ai-cli の指示ファイルと一致しないため、送信前に止まります。指示ファイルの本文は Iris の状態（SQLite）と snapshot に入ります。

Iris は初回送信前に完全 binding と元 request ID を domain transaction で保存し、その仕事を unknown に固定します。応答喪失や再起動後は同じ ID を照会し、start・attempt・fence を作り直しません。利用者の停止要求も送達を試す前に一度限りの印を保存します。停止送達が不明な場合は照会を続けます。native owner/固定 payload の比較記録は原形で保存し、仕事の成功、全副作用なし、合成停止証拠、自動担当交代の許可へ変換しません。

## 看板（board）

案件・計画・Issue・PR・作業の一覧と、それぞれの出来事の記録です。実行系とは別の機能で、既存の表と挙動は変えません。同じ SQLite ファイルに `board_items` と `board_events` の2表を足すだけで、`user_version` も変えません（何度起動しても同じ結果です）。

起動の引数:

```powershell
.\target\release\many-iris.exe --db .state\iris.sqlite3 --port 0 --board-writers .state\board-writers.json
.\target\release\many-iris.exe --db .state\iris.sqlite3 --port 0 --board-writers .state\board-writers.json --public-origin https://board.example.com
```

`--board-writers <file>` を渡したときだけ看板が有効になります。渡さなければ `/board/mcp`・`/board`・`/api/board` は 404（`BOARD_DISABLED`）で、起動時の出力も従来のままです。書き込み鍵の一覧ファイルは要求のたびに読み直すので、鍵の追加や `enabled` の切り替えは再起動なしで効きます。ファイルが読めない・不正なときは、誰も入れず 503 になります。

`--public-origin https://<host>` は、入口のトンネルや中継が付ける公開側の Host と Origin を受け付けます（`https` の host と任意の port だけ。パス・ユーザー情報は不可）。待ち受けは 127.0.0.1 のままで、127.0.0.1 の検査も残ります。公開側の Host または Origin で届いた要求が到達できるのは、看板（`/board`・`/board.js`・`/board.css`・`/api/board`・`/board/mcp`）とそのログイン（`/session`・`/login.js`・`/app.css`）、`/health` だけです。`/`・`/api/action`・`/api/state`・`/mcp` などの実行系は公開側からは 404 です。公開側でログインしたときの cookie には `Secure` が付きます。`--board-writers` なしの `--public-origin` は起動時に拒否します。

書き込み鍵の発行:

```powershell
.\target\release\many-iris.exe --board-add-writer many-ai-cli --board-writers .state\board-writers.json --board-token-out .state\many-ai-cli.board.key
```

32バイトの乱数を16進にして `--board-token-out` のファイルへ書き（既存ファイルは上書きせず止まります。Unix では権限 0600）、鍵の SHA-256 だけを `--board-writers` の一覧へ足します。鍵そのものは標準出力にもログにも出ません。出るのは actor とファイルの場所だけです。一覧の形は `{"schema_version":1,"writers":[{"actor":"many-ai-cli","token_sha256":"<hex>","enabled":true}]}` で、actor は `^[a-z0-9-]{1,32}$` です。`enabled` を `false` にした鍵は 403（`WRITER_DISABLED`）で拒否します。

道具（`POST /board/mcp`、`Authorization: Bearer <鍵>`。読み取りも鍵が必要です。MCP の検査は `/mcp` と同じです）:

`board_upsert_item`: 項目の作成と更新。`item_id`（`^[A-Za-z0-9._:/-]{1,128}$`）だけが必須で、作成時は `project`（1〜80字）・`kind`（project / plan / context / issue / pr / task）・`title`（1〜200字）・`state`（planned / in_progress / waiting / done / stopped）も要ります。任意で `source_ref`（`docs/local/plan_x.md` のようなリポジトリ相対パスか `https://` の URL、500字まで。絶対パス・`file:`・`..`・制御文字は拒否）・`parent_id`（同じ project の既存項目。循環と深さ6超は拒否）・`waiting_reason`（state が waiting のとき必須、200字まで）・`planned_start` / `planned_end`（`YYYY-MM-DD`、end は start 以後）・`expected_revision`（食い違えば `REVISION_CONFLICT` で書かず、後勝ちで上書きしません）。`source_ref`・`parent_id`・`waiting_reason`・予定日は `null` で消せます。state が変わると `state_change` の出来事が自動で1件増えます。

`board_add_event`: 既存の項目に出来事を足す。`item_id`・`kind`（session_start / session_end / note）・`text`（2000字まで）、任意で `ref`（https の URL）。

`board_list`: 項目（各項目に最新の出来事つき）と、`since_seq` より後の出来事（古い順、1回500件まで）を返す。`project` で絞れます。`next_since_seq` を次の `since_seq` に渡すと続きを読めます。

書いた人（`updated_by`・出来事の `actor`）は、いつも鍵から決まります。本文で名乗る項目は無く、`actor` を付けた要求は引数の検査で拒否します。項目は5000件、出来事は50000件までで、超えると古いものを消さずに `BOARD_ITEM_LIMIT` / `BOARD_EVENT_LIMIT` で断ります。出来事と項目は SQLite の trigger で更新・削除できません。

画面: `GET /board` は読み取り専用の1ページです。案件ごとに項目を親子の木で並べ、状態・予定日・最後の出来事を表示し、下に最近100件の出来事を出します。`/` と同じく本人用キーでログインします（未ログインならログイン画面）。データは `GET /api/board`（`/api/state` と同じ本人用の画面 session 資格）から読み、書き込みの鍵は画面に渡しません。

## 状態・診断・復旧

```powershell
.\target\release\many-iris.exe --doctor --db .state\iris.sqlite3
.\target\release\many-iris.exe --db .state\iris.sqlite3 --backup-to .state\snapshot.sqlite3
.\target\release\many-iris.exe --db .state\restored.sqlite3 --restore-from .state\snapshot.sqlite3 --port 0
```

backupコマンドは対象serverを停止してから使います。同じDBの二重ownerは拒否します。既存backupや復元先を上書きしません。復元後はinspection-only holdで起動し、古い承認・実行要求を再送しません。holdの無条件解除機能はありません。原本のDB、backup、合成executor DB、資格ファイルは公開しないでください。

更新はserver停止→旧実行物と状態の保全→新実行物の診断→別の試験状態で起動確認→既存状態の互換確認の順です。未来schemaや破損DBを初期化して進めません。自動更新・自動rollback・実データの復旧保証はありません。実行中状態を含む再起動後は、結果を推測せずunknownとして確認を待ちます。

Windowsでバックグラウンド起動する場合は `& .\scripts\Start-ManyIris.ps1` を呼び、返されたready fileと実行物を `Stop-ManyIris.ps1 -ReadyFile <path> -Binary <path>` へ渡します。wrapperは実行物を独立した非表示consoleで起動し、別の非対話PowerShellからwrapperの出力をcaptureする場合もserverの出力pipeを引き継ぎません。状態DBをDrive等の同期フォルダへ置かないでください。起動診断の範囲は末尾の「Windowsバックグラウンド起動の診断」を参照してください。

## 検査と限界

probeへ `--executor-evidence-binding <file>` を追加すると、指定した完全bindingのowner記録を読み取り専用で照会します。起動能力が不足していても照会でき、出力はローカルtree停止・成果file完全性・業務結果/副作用の確認状態の真偽に限定します。`local_tree_ceased` はWindows Job内だけの確認で、遠隔job・副作用・業務成功の証明にはしません。Owner記録から実行再送や自動交代は行いません。

`--executor-probe-port <port> --executor-token-file <file>` は、別資格でmany-ai-cliの専用HTTP MCP実行契約を照会する非送信の診断です。資格はURLや引数の実値にせずファイルから読みます。DBを開く前に診断だけで終了し、結果には既知の能力の真偽だけを出します。`cli_executor::Client` は固定loopbackへ接続し、永続受理・許可版・停止/成果の証拠能力がそろわなければ実行を拒否します。現在の実provider用CLI側能力は不足を明示するため、通常の合成schedulerを実AIへ切り替える機能にはしていません。接続先Hubの停止/再起動も行いません。

`cargo test --locked` はdomain、MCP parser、合成executorの局所検査です。HTTP/stdio往復、作者以外の故障受入、PC/狭幅の描画、起動/更新/復旧は別々に証拠を保存します。実スマホの本人受入へ換算しません。

SQLite、通信、JSON、非同期runtime等はCargo.lockで固定します。`unsafe`/native境界やSQLiteのC実装を含めた安全性が、Rustという言語だけで保証されるわけではありません。原文は合成fixtureを表示し、任意のローカルファイルを読み出すAPIは提供しません。

## Windowsバックグラウンド起動の診断

`Start-ManyIris.ps1` はWindowsのShellExecuteで実行物を直接、非表示で起動します。追加shellや任意command文字列を実行せず、実行物への引数は個別に渡します。起動wrapperのstdoutにはready情報と実行物のhashを返します。起動待ちは最大20秒で、待ち切れない場合に同じDBへ二重起動しないでください。

この経路はserverのstdout/stderrをlogへredirectしません。receiptの `startup_error_file` はnull、`startup_diagnostics` はready fileとprocess終了情報による診断を示します。起動失敗の詳細出力が必要な場合は、同じ実行物をforegroundで起動して確認してください。独自の子process環境変数overrideを渡す機能はありません。通常の継承環境と、引数で指定した実行物・状態directoryを使います。

captureの完了はserver停止の証拠ではありません。停止は保存したready fileを指定して行い、停止未確認なら起動や交代を繰り返さないでください。この起動経路の局所合成検査は、通常Hubの切替や実providerの受入を含みません。

## 送達不明のrequestを照会する

専用probeへ `--executor-request-id <saved-request-id> --executor-request-binding <file>` を追加すると、保存済みの開始または停止request receiptを照会します。binding fileは元の完全な16フィールドの識別情報を持つJSONです。新しいrequest IDを作り直さず、送信時に保存したIDを指定します。owner evidence照会との同時指定は拒否します。

実行能力が無効でもこの照会は可能です。開始・停止・自動再送は行わず、保存receiptと現在記録の完全bindingが一致することを確かめます。再起動後の `unknown` や `stop_unconfirmed` はそのまま出力し、「未送信」「成功」「もう一度起動してよい」へ変換しません。資格・request ID・principal・bindingの実値は診断出力へ出しません。照会はDBを作る前に終了します。

`cli_binding::from_snapshot` はStoreから直に取得した信頼済みsnapshotについて、計画・指示・許可・scopeのhashと版、期限、必要な本人判断、登録済みexecutorと保存attempt/fenceを照合します。初版は固定の合成担当Aのみで、新しいattemptを創作しません。hashは内容の対応を示し、任意JSONの出所を認証するものではありません。失効後の復旧照会には、新しいbindingを再生成するのではなく送信時の完全bindingを使います。

通常schedulerは引き続き合成stdioです。この変換・照会は、実AI dispatch、一般の業務結果判定、遠隔jobや副作用の停止証明を有効にしません。
