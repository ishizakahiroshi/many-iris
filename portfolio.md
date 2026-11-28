---
schemaVersion: 1
color: "#456c84"
initials: "MI"
cat: { ja: "開発ツール / 進捗管理", en: "Developer tools / Progress tracking" }
tagline: { ja: "自分の開発とAIの作業を一つの看板で", en: "One board for your development work and AI tasks" }
short:
  ja: "自分の案件とAIに任せた作業を一つの看板に並べ、日付ごとの記録から、何が進んでどの仕事が待っているかを確かめられます。"
  en: "Track your projects and AI tasks together, with a dated history for each item."
tech: ["Cloudflare Workers", "Durable Objects", "SQLite", "MCP"]
features:
  - icon: "▦"
    title: { ja: "仕事ごとの記録", en: "History by task" }
    desc: { ja: "案件、計画、Issue、PRを並べ、開始や完了、メモを各項目に書き足せます。", en: "Keep plans, issues and pull requests on the board and record starts, completions and notes against each item." }
  - icon: "▤"
    title: { ja: "日付から振り返る", en: "Review a week of work" }
    desc: { ja: "一覧から記録のある日を選んだり、実績ガントで各作業が動いていた期間を見渡したりできます。", en: "Find days with activity in the list or switch to the timeline to see when each task was active." }
  - icon: "◇"
    title: { ja: "ブラウザとMCP", en: "Browser and MCP access" }
    desc: { ja: "人はブラウザで看板を開き、対応するAIはMCPから同じ作業の状態を確認できます。", en: "Open the board in a browser or let a compatible AI client check the same work items through MCP." }
---

## ja

Many Iris は、開発者自身の仕事と AI に依頼した仕事の経過を記録する個人向け OSS です。たとえば昨日の作業を振り返るとき、一覧で記録のある日を選ぶと、各案件にどんな進展があったかを確認できます。現在の看板は Cloudflare Workers 上で動作し、出来事を SQLite 型の Durable Object に保存します。

## en

Many Iris is an open-source board for tracking a developer’s own projects alongside tasks assigned to AI. To review yesterday’s work, select a day with recorded activity and inspect the events for each item. The board runs on Cloudflare Workers and stores its history in a SQLite-backed Durable Object.
