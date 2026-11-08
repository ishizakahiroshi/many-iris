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

- 人は、ブラウザで `/board` を開いて読みます。入口は Cloudflare Access で、許可したメールアドレスの人だけが入れます。Worker も Access の署名を自分で確かめます。
- AI や道具は、`/board/mcp`（MCP）へ書き込み用の鍵で書きます。道具は `board_upsert_item`（項目の作成と更新）・`board_add_event`（出来事の追加）・`board_list`（読み取り）の 3 つです。
- 書いた人は鍵から決まり、本文で名乗ることはできません。項目や出来事を消す道具はありません。
- 項目と出来事の決まり（使える文字・長さ・状態の種類・親子）は、Rust 版の看板と同じです。[`iris/README.md`](iris/README.md) の「看板（board）」を見てください。

### 自分の Cloudflare に置く

Cloudflare のアカウントと、Cloudflare で管理しているドメインが要ります。以下は `board.example.com` に置く例です。

1. `board-worker/` で依存を入れます（`pnpm install`）。
2. `wrangler.toml` の `routes` の `pattern` を、自分のドメインに書き換えます。
3. Cloudflare Zero Trust で、Access のアプリを 2 つ作ります。
   - `board.example.com` 全体：自分のメールアドレスだけを許可する
   - `board.example.com/board/mcp` だけ：Bypass（ここは Worker が鍵で確かめるため）
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

`board-worker/` で `node test/board.test.mjs` を実行します。`wrangler dev`（手元の workerd）の上で、鍵の拒否・Access の署名の確認・項目と出来事の規則・上限・再起動後も残ることを確かめます。一時フォルダは OS の一時フォルダ（`BOARD_TEST_TEMP` で変えられます）に作り、終わると消します。

## 本体（iris）

計画と許可、判断待ち、実行の状態、成果の根拠を一つの流れで確かめる、手元専用の本体です。起動の仕方・MCP・看板・状態の診断と復旧は [`iris/README.md`](iris/README.md) にまとめています。試験は `iris/` で `cargo test --locked` を実行します。

## ライセンス

[MIT](LICENSE)
