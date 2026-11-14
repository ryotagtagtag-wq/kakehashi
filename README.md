# Kakehashi

keys.openpgp.org の公開鍵と、紙に印刷された paperkey 形式の秘密部分（QR 分割）を組み合わせて GPG 秘密鍵を復元する、完全ローカル動作の PWA です。

## 目的

OpenPGP 秘密鍵を紙にバックアップし、災害や紛失時に keys.openpgp.org から公開鍵を取得して紙の秘密部分と組み合わせることで、秘密鍵を復元します。

## 使い方

1. **統合ページ (`app.html`)**: 紙の QR コードを読み取り、メールアドレスで keys.openpgp.org から公開鍵を取得します。
2. 紙に併記されたフィンガープリントを照合し、秘密鍵を復元して `.gpg` 相当のバイナリとしてダウンロードします。

## 対象範囲

- keys.openpgp.org の Verifying Keyserver REST API 専用です。他の鍵サーバーはサポートしません。
- paperkey 形式（`paperkey --output-type=base16` または `--output-type=raw`）の秘密部分に対応します。
- この PWA は paperkey 本体の代替ではありません。paperkey と連携して秘密鍵を復元するための補助ツールです。

## 制約

- 統合ページ (`app.html`) は keys.openpgp.org への公開鍵取得と、同一オリジンからの WASM 読み込みのみ接続を許可します（CSP: `connect-src 'self' https://keys.openpgp.org`）。
- 秘密鍵・秘密部分・パスフレーズはローカルストレージに保存されません。
- Service Worker は静的アセットのみをキャッシュし、鍵サーバーのレスポンスはキャッシュ対象外です。

## ライセンス

Kakehashi 本体は [GNU General Public License v2+ (GPL v2+)](LICENSE) の下で公開されています。

このプロジェクトには以下のサードパーティ製ソフトウェアが同梱されています：

- paperkey (GPL v2+): `vendor/paperkey/` を参照
- jsQR (MIT License): `vendor/jsqr/jsqr.js` を参照

## 製品外

- このソフトウェアは paperkey プロジェクト（GPL v2+）のソースコードを Emscripten で WASM ビルドして同梱しています。`vendor/paperkey/` と `THIRD_PARTY.md` を参照してください。