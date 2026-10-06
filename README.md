# カードAIバトル Online v3.2

## v3.2 修正
- カード長押しを `touchstart / touchmove / touchend / touchcancel` で明示処理
- 長押し判定を450msに統一し、指の微小な揺れではキャンセルしないよう修正
- 長押し後に発生するブラウザ標準clickを抑止
- スマホの画像保存・コンテキストメニューを抑止
- 通常タップでもカード詳細を確実に開くよう統一
- バトル中のカードクリックによる対象選択は維持し、長押しだけ詳細表示に使用
- `onlineMode` のV3.1修正を維持

## 構成
- クライアント: `client/index.html`
- サーバー: `server.js`
- 起動: `npm start`
