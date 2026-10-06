# カードAI対戦ゲーム Online v3.4

## v3.4 修正
- カード詳細表示を修正。`openCardDetail()` からオンラインIIFE内の `onlineMode` を参照しないよう変更し、タップ/長押し時のReferenceErrorを解消。
- カード一覧・デッキ編成は従来どおり単押しで詳細表示。
- 戦闘中は単押しを行動選択に使用し、長押しで詳細表示する既存方式を維持。
- カード画像の長押しによるブラウザ標準メニュー抑止はカード上だけに限定。
- `client/index.html` のプロジェクト構成は変更しない。

## 構成
- `client/index.html`
- `server.js`
- `package.json`
- `render.yaml`
