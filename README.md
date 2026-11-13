# Kakehashi

keys.openpgp.org の公開鍵と、紙に印刷された paperkey 形式の秘密部分（QR 分割）を組み合わせて GPG 秘密鍵を復元する、完全ローカル動作の PWA です。

## 目的

OpenPGP 秘密鍵を紙にバックアップし、災害や紛失時に keys.openpgp.org から公開鍵を取得して紙の秘密部分と組み合わせることで、秘密鍵を復元します。

## 使い方

1. **取得ページ (`fetch.html`)**: keys.openpgp.org からメールアドレスで公開鍵を検索し、ダウンロードします。
2. **印刷**: 秘密鍵の paperkey 形式の秘密部分を QR に分割して紙に印刷します（`@media print` で QR のみ出力）。
3. **復元ページ (`restore.html`)**: 公開鍵と QR を読み取り、紙に併記されたフィンガープリントと照合して秘密鍵を復元し、`.gpg` 相当のバイナリとしてダウンロードします。

## 対象範囲

- keys.openpgp.org の Verifying Keyserver REST API 専用です。他の鍵サーバーはサポートしません。
- paperkey 形式（`paperkey --output-type=base16` または `--output-type=raw`）の秘密部分に対応します。
- この PWA は paperkey 本体の代替ではありません。paperkey と連携して秘密鍵を復元するための補助ツールです。

## 制約

- 復元ページ (`restore.html`) は一切の外部通信を行いません（CSP: `connect-src 'none'`）。
- 取得ページ (`fetch.html`) のみ `connect-src https://keys.openpgp.org` を許可します。
- 秘密鍵・秘密部分・パスフレーズはローカルストレージに保存されません。
- Service Worker は静的アセットのみをキャッシュし、鍵サーバーのレスポンスはキャッシュ対象外です。

## 製品外

- このソフトウェアは paperkey プロジェクト（GPL v2+）のソースコードを Emscripten で WASM ビルドして同梱しています。`vendor/paperkey/` と `THIRD_PARTY.md` を参照してください。