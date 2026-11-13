# オフライン動作検証手順

Kakehashi の復元ページ（`restore.html`）が完全にオフラインで動作することを検証する手順です。

## 検証環境

- ブラウザ: Chrome / Edge / Safari 等（Service Worker に対応）
- デベロッパーツール: Network タブ

## 検証手順

### 1. Service Worker の登録確認

1. ブラウザで `restore.html` を開く
2. デベロッパーツール → Application → Service Workers を開く
3. `sw.js` が「activating」または「activated」状態になっていることを確認

### 2. 外部通信の遮断確認（Network タブ）

1. デベロッパーツール → Network タブを開く
2. 「Disable cache」のチェックを外す（キャッシュを有効にする）
3. ページをリロードする
4. Network タブに表示されるリクエストを確認する
   - `sw.js` のリクエスト（Service Worker 登録）が表示される
   - その他、外部ドメインへのリクエストが **0 件** であることを確認
   - `connect-src 'none'` により、キー取得などの外部通信はブラウザによってブロックされる

### 3. オフラインモードでの動作確認

1. デベロッパーツール → Network タブ → 「Offline」モードを有効にする
2. ページをリロードする
3. 以下が正常に動作することを確認:
   - ページが表示される（キャッシュから読み込み）
   - 公開鍵の貼り付け
   - QR コードの読み取り（カメラ使用時は `getUserMedia` が必要）
   - フィンガープリント計算
   - チャンク収集・結合
   - 秘密鍵の再構成（paperkey WASM）
   - `.gpg` ファイルのダウンロード

### 4. CSP の確認

1. デベロッパーツール → Console タブを開く
2. ページをリロードする
3. CSP 違反の警告が表示されないことを確認
4. `restore.html` の CSP ヘッダ:
   ```
   default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'
   ```

### 5. 取得ページ（fetch.html）との対比

1. `fetch.html` を開く
2. Network タブで `keys.openpgp.org` へのリクエストが表示されることを確認
3. これは正常な動作（取得ページのみ外部通信を許可）

## 期待結果

| 項目 | 期待値 |
|------|--------|
| restore.html の外部通信 | 0 件 |
| restore.html の CSP | `connect-src 'none'` |
| Service Worker キャッシュ | 静的アセットのみ |
| keys.openpgp.org のレスポンス | キャッシュ対象外 |
| オフラインでの復元 | 正常に動作 |