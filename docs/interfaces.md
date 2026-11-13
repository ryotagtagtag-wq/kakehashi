# Kakehashi — モジュール間インターフェース定義

本ドキュメントはフェーズ 0 で確定するインターフェース定義である。
以降の変更は親エージェントのみが行う。

## 1. PK1 フォーマット

QR 分割された paperkey 秘密部分の単枚フォーマット：

```
PK1|<index>/<total>|<format>|<payload>
```

- `<index>`: 1 始まりの連番整数
- `<total>`: 総枚数
- `<format>`: `b16`（base16）または `b64`（base64）
- `<payload>`: 該当フォーマットでエンコードされた paperkey 秘密部分の断片

CRC チェックは独自に行わず、paperkey 本体の行ごとの検証に委ねる。

## 2. モジュール公開関数

### 2.1 src/chunk.js — PK1 分割・結合

```ts
// 秘密部分ペイロードを total 枚の PK1 チャンクに分割
function splitPK1(payload: string, total: number, format: 'b16' | 'b64'): Chunk[]

// 順不同で収集されたチャンクを検証・結合
// 戻り値: { complete: boolean, missing: number[], payload: string, format: string }
// complete=false なら missing に欠番が入る
function collectPK1(chunks: Chunk[], total: number): CollectionResult

// 欠番を列挙
function missingIndexes(chunks: Chunk[], total: number): number[]

interface Chunk {
  index: number;      // 1 始まり
  total: number;
  format: 'b16' | 'b64';
  payload: string;
}

interface CollectionResult {
  complete: boolean;
  missing: number[];
  payload: string;    // 結合後のペイロード（complete=true のみ）
  format: string;
}
```

**エラー型:**
- `DuplicateIndexConflictError`: 同一 index で内容が異なるチャンクが存在
- `MissingIndexesError`: 欠番があり結合不可
- `InvalidChunkError`: PK1 フォーマット不正

重複枚（同一 index・同一内容）は許容する。

---

### 2.2 src/fingerprint.js — OpenPGP フィンガープリント計算

```ts
// armored 公開鍵からフィンガープリント（40 桁 16 進数、v4 は 160bit/20 バイト）を計算
// v4 → RFC 4880 (SHA-1), v5/v6 → RFC 9580 (SHA-256)
function calculateFingerprint(armoredKey: string): string

// フィンガープリントの完全一致比較（大文字小文字を区別しない）
function verifyFingerprint(calculated: string, expected: string): boolean

// 内部用: armored 公開鍵のデコード、パケット読み取り（restore.js で使用）
function dearmor(armoredText: string): Uint8Array
function readFirstPacket(bytes: Uint8Array): { tag: number; body: Uint8Array }
function readPacketHeader(bytes: Uint8Array): { tag: number; bodyLen: number; bodyOffset: number }
```

**エラー型:**
- `UnsupportedKeyVersionError`: v4(4)/v5(5)/v6(6) 以外のバージョン
- `FingerprintMismatchError`: 計算値と期待値が不一致
- `InvalidArmoredKeyError`: armored 形式の解析失敗

---

### 2.3 src/paperkey.js — WASM 版 paperkey ラッパー

vendor/paperkey/ に同梱の paperkey (GPL v2) を Emscripten で WASM ビルドしたものをラップ。

```ts
// WASM モジュールの初期化（restore 実行前に必ず呼ぶ）
async function initPaperkeyWasm(): Promise<void>

// 公開鍵 + 秘密部分から秘密鍵を再構成
// secretPart: string (base16 テキスト / base64 テキスト) または Uint8Array (raw バイト列)
// inputType: 'auto' | 'base16' | 'raw'
// 戻り値: OpenPGP 秘密鍵パケットの Uint8Array（.gpg 相当）
async function restoreSecretKey(
  pubkeyArmored: string,
  secretPart: string | Uint8Array,
  inputType: 'auto' | 'base16' | 'raw'
): Promise<Uint8Array>
```

**エラー型:**
- `PaperkeyInitError`: WASM 初期化失敗
- `PaperkeyRestoreError`: 秘密鍵再構成失敗
- `PaperkeyFingerprintMismatchError`: 復元後のフィンガープリント不一致

**重要:** 再構成後、必ずフィンガープリントを再計算し、公開鍵のフィンガープリントと照合する。

---

### 2.4 src/qrcode.js — QR 入出力

```ts
// 文字列を QR コードにエンコード（data URL を返す）
function encodeQR(data: string, type: 'base16' | 'base64'): string

// ImageData から QR をデコード（jsQR 使用）
function decodeQR(imageData: ImageData): string | null
```

## 3. エラー型一覧

| エラー型 | 意味 | 発生箇所 |
|----------|------|----------|
| `InvalidChunkError` | PK1 フォーマット不正 | chunk.js |
| `DuplicateIndexConflictError` | 同一 index で内容が異なる | chunk.js |
| `MissingIndexesError` | 欠番があり結合不可 | chunk.js |
| `UnsupportedKeyVersionError` | v4/v5/v6 以外 | fingerprint.js |
| `FingerprintMismatchError` | フィンガープリント不一致 | fingerprint.js, paperkey.js |
| `InvalidArmoredKeyError` | armored 形式解析失敗 | fingerprint.js |
| `PaperkeyInitError` | WASM 初期化失敗 | paperkey.js |
| `PaperkeyRestoreError` | 秘密鍵再構成失敗 | paperkey.js |

## 4. ベンダー同梱ライブラリ

| ライブラリ | パス | バージョン | ライセンス | 用途 |
|------------|------|-----------|-----------|------|
| paperkey | `vendor/paperkey/` | 1.6 (dmshaw/paperkey) | GPL v2+ | 秘密鍵再構成 (WASM) |
| jsQR | `vendor/jsqr/jsqr.js` | 1.4.0 | MIT License | QR コードデコード |

**重要:** paperkey は GPL v2+ です。Kakehashi 本体を GPL 互換でないライセンスで配布する場合は、ライセンス上の影響について game_ryo に確認が必要です（`THIRD_PARTY.md` 参照）。