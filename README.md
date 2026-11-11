# Many Iris

自分の開発の進み具合を、AI の作業と合わせて一か所で見渡すための個人用 OSS です。作者が自分で使う範囲で作っています。一般向けの設定不要なサービスや、すべての AI への対応を約束するものではありません。

## いまあるもの

| 場所 | 中身 | 状態 |
|---|---|---|
| `board-worker/` | 進捗の看板。Cloudflare Workers で動き、保存は SQLite 型の Durable Object | 作者の環境で稼働中 |
| `iris/` | 計画と実行の本体（Rust）。手元の PC だけで動く | 合成データと合成の担当だけで動く候補。詳しくは [`iris/README.md`](iris/README.md) |
| `prototype/`・`tests/`・`examples/`・`CONTRACT.md` | 最初に作った Python の試作 | 記録として残している。新しい機能は足さない |
| `experiments/stack-evaluation/` | 本体の言語を決めたときの比較（Python・Go・Rust） | 記録 |

## 看板（board-worker）

案件・計画・Issue・PR・作業を項目として並べ、それぞれに「始めた」「終わった」「メモ」などの出来事を書き足していく看板です。

項目の基本は次のとおりです。

- 項目には種類が 6 つあります：案件（`project`）・計画（`plan`）・文脈（`context`）・Issue（`issue`）・PR（`pr`）・作業（`task`）。
- 項目は、どれか 1 つの案件（`project` に書く名前）に属します。画面は案件ごとに分けて表示します。
- 項目には親を 1 つ付けられます（同じ案件の項目だけ。6 段まで）。たとえば、案件の下に計画、計画の下に作業を置きます。親を付けていない項目は、木のいちばん上に並びます。
- 状態は 5 つです：予定（`planned`）・進行中（`in_progress`）・待ち（`waiting`）・完了（`done`）・停止（`stopped`）。
- 項目は 5,000 件、出来事は 50,000 件まで。項目や出来事を消す道具はありません。
- 使える文字や長さなどの細かい決まりは、Rust 版の看板と同じです。全部の決まりは [`iris/README.md`](iris/README.md) の「看板（board）」にあります。

読み方と書き方は次のとおりです。

- 人は、ブラウザで `/board` を開いて読みます。入口は Cloudflare Access で、許可したメールアドレスの人だけが入れます。Worker も Access の署名を自分で確かめます。
- 看板の持ち主は、同じ画面から 3 つのことができます。「仕事を積む」（題名を書いて、予定の作業を 1 つ足す）、「入れる先を変える」（作業を、別の項目の下へ付け替える・どこにも入れない状態に戻す）、「上へ・下へ」（同じ項目の下に積んである作業の順番を変える）です。順番は持ち主だけのもので、AI の道具からは変えられません。題名や状態を直すこと、計画を動かすこと、消すことは、画面からはできません。画面から書いたものは、書いた人が `page:owner` と記録されます。
- AI や道具は、`/board/mcp`（MCP）へ書きます。道具は `board_upsert_item`（項目の作成と更新）・`board_add_event`（出来事の追加）・`board_list`（読み取り）の 3 つです。
- AI や道具の本人確認は、使う場面で 2 通りに分かれます。手元のスクリプトや CLI から書くときは、書き込み用の鍵を `Authorization: Bearer <鍵>` で送ります。ChatGPT のように鍵を送れない MCP の client は、OAuth で接続します。OAuth の許可の画面（`/authorize`）は、Access でログインした看板の持ち主だけが開けます。OAuth の部分は Cloudflare の [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) を使っています。
- 書いた人は、鍵か、許可した client から決まります。本文で名乗ることはできません。
- 作業（種類 `task`）のうち親の無いものは、画面では案件ごとの「まだ結ばれていない作業」にまとまります。既にある項目の親は、後から付けられます（AI からは `board_upsert_item` に `item_id` と `parent_id` だけを送る。持ち主は画面の「入れる先を変える」）。先に作業を記録し、あとで計画の下へ付け替える使い方ができます。
- 作業には、画面でもう 1 つ札が付きます。予定のままの作業は「積んである」、それ以外は「記録だけ」です。

### 自分の Cloudflare に置く

Cloudflare のアカウントと、Cloudflare で管理しているドメインが要ります。以下は `board.example.com` に置く例です。

1. `board-worker/` で依存を入れます（`pnpm install`）。
2. `wrangler.toml` の `routes` の `pattern` と `BOARD_PUBLIC_ORIGIN` を、自分のドメインに書き換えます。OAuth の保存先の KV を作り（`wrangler kv namespace create <名前>`）、出てきた id を `[[kv_namespaces]]` の `id` に書きます。
3. Cloudflare Zero Trust で、Access のアプリを 2 つ作ります。
   - `board.example.com` 全体：自分のメールアドレスだけを許可する（`/authorize` もここに入る）
   - `board.example.com/board/mcp`・`board.example.com/.well-known/*`・`board.example.com/oauth/*`：Bypass（MCP は Worker が鍵か OAuth の token で確かめ、OAuth の発見と token の受け渡しは client が直接呼ぶため）
4. 書き込み用の鍵を作ります。鍵は新しいファイルに書かれ、画面には出ません。一覧には鍵の SHA-256 だけが入ります。

   ```powershell
   node scripts/new-key.mjs --list <keys.json> --actor <書く人の名前> --key-out <鍵のファイル>
   ```

5. 秘密を 4 つ登録します（`wrangler secret put <名前>`）。
   - `BOARD_WRITERS`：手順 4 の一覧（鍵の SHA-256 だけ）
   - `ACCESS_TEAM_DOMAIN`：`https://<team>.cloudflareaccess.com`
   - `ACCESS_AUD`：手順 3 で作った全体用のアプリの Application Audience（AUD）タグ
   - `BOARD_OWNERS`：看板を読める人のメールアドレス（カンマ区切り）
6. `wrangler deploy` で配置します。`workers.dev` とプレビューの住所は、`wrangler.toml` で切ってあります。

鍵のファイルと `<keys.json>` は、リポジトリの外に置いてください。

### 試験

`board-worker/` で `node test/board.test.mjs` を実行します。`wrangler dev`（手元の workerd）の上で、鍵の拒否・Access の署名の確認・OAuth の一周（発見・client の登録・許可の画面・PKCE・token・使い回した code の取り消し）・項目と出来事の規則・持ち主が画面から書く操作（ほかのサイトからの要求の拒否を含む）・上限・再起動後も残ることを確かめます。一時フォルダは OS の一時フォルダ（`BOARD_TEST_TEMP` で変えられます）に作り、終わると消します。

## 本体（iris）

計画と許可、判断待ち、実行の状態、成果の根拠を一つの流れで確かめる、手元専用の本体です。起動の仕方・MCP・看板・状態の診断と復旧は [`iris/README.md`](iris/README.md) にまとめています。試験は `iris/` で `cargo test --locked` を実行します。

## ライセンス

[MIT](LICENSE)
