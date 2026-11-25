# MuseDev の最初の一往復（#58）
- チャット開始時だけ MuseDev を明示選択できます。短い本文をカードの題名にし、同じ項目・依頼番号で受理と結果を読みます。初回添付と MuseDev への追送は扱いません。既存の Claude / Devin の会話は従来の経路です。
- 未受理なら待つか、元の会話で相手を明示して切り替えます。受理・不明・完了後は切り替えず、受付見送りを別状態として表示します。MuseDev への自動振り分け・別の宛先への自動切り替えはありません。
- 既存のカード拾い手が `muse-dev` で `board_my_work` と fenced handoff tools を使う前提です。新しいセッション起動、権限拡張、実鍵・設定変更はありません。#55 の別の接続（`musedev`）には依存しません。
- 既存カード接続として Issue にある `b07bca6` は、このリポジトリからは解決できませんでした。実機の拾い手接続や回答は未検証です。合成 Store テストでは指定 actor の受理、完了ノートと同じ会話への表示、未受理の切替、再読時の同一性を検証します。

```sh
cd board-worker
node --experimental-transform-types --test test/musedev-chat.test.mjs
node test/route.test.mjs
node --check web/chat.js
```
