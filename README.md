# カードAIバトル Online v3

## v3 修正
- カード詳細：PCタップ、スマホタップ、スマホ長押しで詳細を開けるように修正
- スマホ長押し時のブラウザ画像メニューを抑止しつつ、通常タップを殺さないよう修正
- WebSocket接続前に押した「部屋を作成」「入室」「観戦」等を送信キューに保持
- オンライン画面を開いた直後でも room_create が確実に送信されるよう修正
- オンラインセッションIDを未作成でも自動生成
- server.js の client/index.html パスをルート構成に修正
- Render用の package.json をルート server.js 起動に修正
- オンライン対戦の「部屋 → オンライン専用デッキ選択 → 準備完了」フローを維持

## Render
- Build: `npm install`
- Start: `node server.js`
- Root Directory: 空欄


## v3.1 修正
- カード詳細表示時に `onlineMode is not defined` で処理が停止するスコープ不具合を修正。
- オンライン状態変数をグローバル `var` として共有し、カード一覧側の `openCardDetail()` からも正しく参照可能に修正。
- サーバーバージョンと package.json を 3.1.0 に更新。
