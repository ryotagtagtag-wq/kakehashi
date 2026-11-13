# Kakehashi 実装計画

## 1. 全体構成

### ページ
- `fetch.html` + `src/fetch.js` — keys.openpgp.org から公開鍵を取得（通信ありページ）
- `restore.html` + `src/restore.js` — 紙の秘密部分と公開鍵から秘密鍵を復元（通信なしページ）
- `index.html` — 両ページへの導線（任意）

### 基盤モジュール（src/）
- `src/paperkey.js` — WASM 版 paperkey のラッパー（`vendor/paperkey/` 同梱）
- `src/fingerprint.js` — OpenPGP 公開鍵フィンガープリント計算（v4/v5/v6）
- `src/qrcode.js` — QR 入出力形式の切替（base16 / base64）
- `src/chunk.js` — PK1 フォーマットの分割・結合・欠番列挙
- `src/sw.js` — Service Worker（静的アセットキャッシュのみ）

### テスト（test/）
- `test/paperkey.test.js`
- `test/fingerprint.test.js`
- `test/qrcode.test.js`
- `test/chunk.test.js`

### 設定・ドキュメント
- `package.json`（`name: kakehashi`, `test: node --test`）
- `docs/interfaces.md` — モジュール間インターフェース定義
- `THIRD_PARTY.md` — vendor ライブラリのバージョン・ライセンス・ビルド手順
- `README.md`、`SECURITY.md`、`docs/verify-offline.md`
- `.gitignore`、`LICENSE`（未確定ならプレースホルダー）

### vendor/
- `vendor/paperkey/` — paperkey ソース＋WASM ビルド成果物（GPL 系確認要）
- `vendor/jsqr/` — jsQR（MIT 等、確認済み）

## 2. 実装順序と依存関係

```
Phase A: リポジトリ作成・初回 push（親のみ）
Phase B: docs/interfaces.md 作成（親のみ）
Phase C: 基盤モジュール（並列可）
   - src/chunk.js          ← fingerprint, paperkey に依存しない
   - src/qrcode.js         ← 他モジュールに依存しない
   - src/fingerprint.js    ← 他モジュールに依存しない
   - src/paperkey.js       ← vendor/paperkey WASM が必要（Emscripten インストールが前提）
Phase D: 復元ページ restore.html + src/restore.js（Phase C 完了後）
Phase E: 取得ページ fetch.html + src/fetch.js（Phase C 完了後、Phase D と並列可）
Phase F: sw.js、オフライン動作確認、CSP 確認
Phase G: README/SECURITY/verify-offline.md、テスト全件通過確認
Phase H: コミット・push（親のみ、直列）
```

Phase C の 4 モジュールは相互に依存しないため並列実装可能。
Phase D（復元ページ）は paperkey（WASM）と fingerprint、chunk に依存するため Phase C 完了後。
Phase E（取得ページ）は fingerprint にのみ依存し、Phase D と並列可能。

## 3. 並列化できる作業と順序を守るべき作業

### 並列可能
- `src/chunk.js` の実装とテスト
- `src/qrcode.js` の実装とテスト
- `src/fingerprint.js` の実装とテスト
- `vendor/paperkey/` の WASM ビルド（Emscripten インストール後に並列実行可）
- `docs/verify-offline.md` の下書き（実装後）

### 順序を守るべき
- Emscripten インストール → paperkey WASM ビルド → `src/paperkey.js` ラッパー実装
- 基盤モジュール完了 → 復元ページ実装（paperkey / fingerprint / chunk に依存）
- 基盤モジュール完了 → 取得ページ実装（fingerprint に依存）
- 全実装完了 → テスト全件実行 → コミット・push

## 4. サブエージェントの分担案

### 使うかどうか：使う
理由：基盤モジュール 4 つと復元ページ・取得ページを並列に進めることで工期を短縮できる。ただし `docs/interfaces.md` は親が先に確定し、インターフェース変更は親のみ行う。

### 分担
| 担当 | ファイル範囲（書き込み可） | 担当外（読みのみ） | 判断理由 |
|------|------------------------|------------------|----------|
| @explorer（基盤A） | `src/chunk.js`, `test/chunk.test.js` | 他の src/ 完全 | 分割・結合ロジックは独立 |
| @explorer（基盤B） | `src/qrcode.js`, `test/qrcode.test.js` | 他の src/ 完全 | QR 形式切替は独立 |
| @explorer（基盤C） | `src/fingerprint.js`, `test/fingerprint.test.js` | 他の src/ 完全 | フィンガープリント計算は独立 |
| @coder（paperkey） | `src/paperkey.js`, `vendor/paperkey/`, `test/paperkey.test.js`, `THIRD_PARTY.md` | `src/restore.js` 変更不可 | WASM ラッパーは秘密情報処理の核心 |
| @designer（復元UI） | `restore.html`, `src/restore.js`（UI 骨格・表示関連） | `src/paperkey.js` の秘密処理部分を見ない | 復元ページは通信なしだが、UI 設計が必要 |
| @coder（取得UI） | `fetch.html`, `src/fetch.js` | `src/restore.js` 完全（秘密情報処理を見せない） | 取得ページと復元ページを厳密に分離 |

### サブエージェントへ渡す制約（全文）
「絶対遵守のルール」の全文を渡す。ルールを省略して委任しない。

## 5. paperkey WASM ビルド手順とライセンス確認

### Emscripten インストール（前提）
環境に `emcc` が未インストール。以下をインストールする必要がある：
```
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh
```

### paperkey WASM ビルド
paperkey ソースを `vendor/paperkey/` に配置し、Emscripten で C → WASM に変換。ビルド手順とコマンドを `THIRD_PARTY.md` に記載。

### ライセンス確認（必須）
paperkey は GPL 系ライセンスの可能性が高い。GPL だった場合、本 PWA（GPL 互換でない可能性がある）への同梱・配布がライセンス上問題になる可能性があるため、ビルド前に `vendor/paperkey/` の `LICENSE` / `COPYING` を確認し、結果を報告する。配布形態に影響する場合は game_ryo に確認する。

## 6. リスクと未解決事項

| 項目 | 状況 | 対応方針 |
|------|------|----------|
| Emscripten 未インストール | `emcc` 未検出 | インストールが必要。困難な場合は JS 再実装の検討を game_ryo に相談 |
| paperkey ライセンス | 未確認（GPL 系の可能性） | `vendor/paperkey/` のライセンスを確認し、報告 |
| LICENSE 未確定 | 未決定 | プレースホルダーを残し、game_ryo に確認 |
| 公開範囲 | `--private`（デフォルト） | 公開にする場合は game_ryo の明示的指示待ち |
| keys.openpgp.org CORS | 未確認 | `fetch.html` 実装前に公式ドキュメントで CORS 対応を検証。不可なら報告して停止 |
| base16 大文字化 | 未確認 | QR 英数字モードへの載せ可否を実機テストで確認。不可なら既定のまま報告 |
| 配布方法 | GitHub Pages 想定 | ロード後完全ローカル動作を前提。未決定 |

## 7. 承認待ち

本計画に基づき、フェーズ A（リポジトリ作成・初回 push）から実装を開始する。計画変更が生じた場合は変更内容を報告して承認を得る。