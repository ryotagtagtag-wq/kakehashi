# セキュリティポリシー

## 脅威モデル

- 攻撃者が紙の QR 分割秘密部分を入手し、かつ keys.openpgp.org から公開鍵を取得できれば、秘密鍵を復元できます。
- 紙の盗難・紛失、カメラによる QR 読み取りの傍受、復元端末のマルウェア感染などは本 PWA で防げません。
- 復元ページは完全にオフライン動作（通信遮断）ですが、取得ページは keys.openpgp.org と通信します。

## 通信遮断の方針

- `restore.html`: `default-src 'none'; connect-src 'none'`。外部通信は 0 件。
- `fetch.html`: `connect-src https://keys.openpgp.org` のみ許可。メールアドレス以外の情報は送信しません。
- 外部 CDN は読み込まず、すべてのライブラリは `vendor/` に同梱します。

## 秘密情報の取り扱い

- 秘密鍵・秘密部分・パスフレーズ・QR 画像を localStorage / sessionStorage / IndexedDB / Cache API に保存しません。
- 復元後は変数をゼロ埋めまたは参照解除し、画面を離れた際に表示を消します。
- リポジトリ、テストフィクスチャ、ログに秘密情報を含みません。

## 脆弱性報告

脆弱性を発見した場合は、GitHub の「Security」タブまたはリポジトリの Issue にてご報告ください。

placeholder: info@ryopc.org
