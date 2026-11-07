(function () {
'use strict';

/**
 * WASM 版 paperkey（vendor/paperkey/、GPL v2+）のラッパー。
 *
 * 役割は「公開鍵 + 紙の秘密部分 → OpenPGP 秘密鍵」の再構成だけである。
 * 秘密鍵・秘密部分はこのモジュールの外に保存しない（localStorage 等は一切使わない）。
 * 復元後のフィンガープリント照合までここで完結させ、外部に検証を委ねない。
 */

const fingerprintApi = typeof require === 'function'
  ? require('./fingerprint.js')
  : globalThis.fingerprint;
const { calculateFingerprint, verifyFingerprint } = fingerprintApi;

// vendor/paperkey/paperkey.js は Emscripten の classic build。
// CommonJS では require の戻り値が Module、ブラウザでは <script> が globalThis.Module を作る。
const VENDOR_GLUE_PATH = '../vendor/paperkey/paperkey.js';

// vendor/paperkey/output.h の enum data_type と一致させる。
const INPUT_TYPE_CODES = { auto: 0, base16: 1, raw: 2 };

// paperkey はプロセス内グローバル状態を持つ C プログラムなので、作業ファイルのパスを固定し
// 呼び出しを直列化する。同時実行すると互いの作業ファイルを壊す。
const PUBRING_PATH = '/kakehashi-pubring.gpg';
const SECRETS_PATH = '/kakehashi-secrets';
const RESTORED_PATH = '/kakehashi-restored.gpg';
const FILE_MODE_READ = 'rb';

// 旧形式パケットヘッダ（1 オクテット目 0x80 | tag << 2 | length-type）。
const OLD_FORMAT_PACKET = 0x80;
const PUBLIC_KEY_PACKET_TAG = 6;
const SECRET_KEY_PACKET_TAG = 5;
const TWO_OCTET_LENGTH = 1;
const FOUR_OCTET_LENGTH = 2;
const TWO_OCTET_LENGTH_LIMIT = 0xffff;

const INIT_TIMEOUT_MS = 20_000;

class PaperkeyInitError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PaperkeyInitError';
  }
}

class PaperkeyRestoreError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PaperkeyRestoreError';
  }
}

class PaperkeyFingerprintMismatchError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PaperkeyFingerprintMismatchError';
  }
}

let runtimePromise = null;
let initPromise = null;
let invocationChain = Promise.resolve();

/**
 * WASM モジュールを初期化する。restoreSecretKey の前に必ず呼ぶ。
 * 失敗しても再試行できるよう、失敗した Promise はキャッシュしない。
 * @returns {Promise<void>}
 */
function initPaperkeyWasm() {
  if (!initPromise) {
    initPromise = getRuntime().then(() => undefined).catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

/**
 * @returns {Promise<object>} 初期化済みの Emscripten Module
 */
function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = initializeRuntime().catch((error) => {
      runtimePromise = null;
      throw error instanceof PaperkeyInitError
        ? error
        : new PaperkeyInitError('paperkey の WASM モジュールを初期化できませんでした', { cause: error });
    });
  }
  return runtimePromise;
}

async function initializeRuntime() {
  const module = acquireVendorModule();
  await waitForRuntimeReady(module);
  requireRuntimeBindings(module);
  return module;
}

function acquireVendorModule() {
  if (globalThis.Module) {
    return globalThis.Module;
  }
  if (typeof require !== 'function') {
    throw new PaperkeyInitError('vendor/paperkey/paperkey.js が読み込まれていません');
  }
  try {
    return require(VENDOR_GLUE_PATH);
  } catch (error) {
    throw new PaperkeyInitError(
      'vendor/paperkey/paperkey.js を読み込めませんでした。vendor/paperkey/ が同梱されているか確認してください。',
      { cause: error }
    );
  }
}

function isRuntimeReady(module) {
  return Boolean(module.FS && module.FS.initialized) && typeof module._restore === 'function';
}

async function waitForRuntimeReady(module) {
  if (isRuntimeReady(module)) return;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PaperkeyInitError('paperkey の WASM 初期化がタイムアウトしました'));
    }, INIT_TIMEOUT_MS);

    const previousHandler = module.onRuntimeInitialized;
    module.onRuntimeInitialized = () => {
      clearTimeout(timer);
      if (typeof previousHandler === 'function') previousHandler();
      resolve();
    };
  });
}

/**
 * 再構成に必要なバインディングが WASM ビルドに含まれているか検証する。
 * 欠けている場合は「何をすれば直るか」まで書いたエラーで止める。
 */
function requireRuntimeBindings(module) {
  const missing = [];
  for (const name of ['_restore', '_fopen', '_fclose', '_fflush', '_malloc', '_free']) {
    if (typeof module[name] !== 'function') missing.push(name);
  }
  if (!module.HEAPU8) missing.push('HEAPU8');
  if (!module.FS) {
    missing.push('FS');
  } else {
    for (const name of ['writeFile', 'readFile', 'unlink']) {
      if (typeof module.FS[name] !== 'function') missing.push(`FS.${name}`);
    }
  }

  if (missing.length > 0) {
    throw new PaperkeyInitError(
      `vendor/paperkey の WASM ビルドに必要なバインディングがありません（${missing.join(', ')}）。` +
        'THIRD_PARTY.md の再ビルド手順で paperkey.js / paperkey.wasm を作り直してください。'
    );
  }
}

/**
 * 公開鍵（armored）と紙の秘密部分から秘密鍵を再構成する。
 *
 * @param {string} pubkeyArmored - armored 形式の公開鍵
 * @param {string|Uint8Array} secretPart - 紙の秘密部分（base16 テキスト、または raw のバイト列／base64 テキスト）
 * @param {'auto'|'base16'|'raw'} inputType - paperkey の --input-type 相当
 * @returns {Promise<Uint8Array>} 再構成された OpenPGP 秘密鍵（.gpg 相当）
 */
async function restoreSecretKey(pubkeyArmored, secretPart, inputType) {
  const inputTypeCode = resolveInputType(inputType);
  const publicKeyBody = readPublicKeyBody(pubkeyArmored);
  const secretBytes = encodeSecretPart(secretPart, inputType);
  const module = await getRuntime();

  return enqueueInvocation(async () => {
    const restoredBytes = restoreWithPaperkey(module, publicKeyBody, secretBytes, inputTypeCode);
    verifyRestoredKey({ publicKeyBody, restoredBytes, pubkeyArmored });
    return restoredBytes;
  });
}

function resolveInputType(inputType) {
  const code = INPUT_TYPE_CODES[inputType];
  if (code === undefined) {
    throw new PaperkeyRestoreError(
      `inputType は 'auto' | 'base16' | 'raw' のいずれかです（受け取った値: ${String(inputType)}）`
    );
  }
  return code;
}

/**
 * 紙の秘密部分を paperkey に渡すバイト列へ変換する。
 * base16 / auto は paperkey 自身がテキストとして解釈する。raw はバイナリが必要なので、
 * 文字列で渡された場合は base64 として復号する（QR チャンクの b64 形式をそのまま渡せる）。
 */
function encodeSecretPart(secretPart, inputType) {
  if (typeof secretPart === 'string') {
    const text = secretPart.trim();
    if (text === '') {
      throw new PaperkeyRestoreError('紙の秘密部分が空です');
    }
    return inputType === 'raw'
      ? decodeBase64(text)
      : encodeUtf8(text);
  }

  if (secretPart instanceof Uint8Array) {
    if (secretPart.length === 0) {
      throw new PaperkeyRestoreError('紙の秘密部分が空です');
    }
    return new Uint8Array(secretPart);
  }

  throw new PaperkeyRestoreError('紙の秘密部分は文字列または Uint8Array で渡してください');
}

/**
 * armored 公開鍵から、先頭の公開鍵パケットの本体（ヘッダを除いた部分）を取り出す。
 */
function readPublicKeyBody(pubkeyArmored) {
  if (typeof pubkeyArmored !== 'string' || pubkeyArmored.trim() === '') {
    throw new PaperkeyRestoreError('公開鍵が空です');
  }
  const packet = readFirstPacket(dearmor(pubkeyArmored));
  if (packet.tag !== PUBLIC_KEY_PACKET_TAG) {
    throw new PaperkeyRestoreError(
      `公開鍵パケット（tag ${PUBLIC_KEY_PACKET_TAG}）を期待しましたが tag ${packet.tag} が見つかりました`
    );
  }
  if (packet.body.length === 0) {
    throw new PaperkeyRestoreError('公開鍵パケットの本体が空です');
  }
  return packet.body;
}

function dearmor(armoredText) {
  const beginMarker = '-----BEGIN PGP PUBLIC KEY BLOCK-----';
  const endMarker = '-----END PGP PUBLIC KEY BLOCK-----';
  const lines = armoredText.split(/\r?\n/);
  const beginIndex = lines.findIndex((line) => line.trim() === beginMarker);
  if (beginIndex === -1) {
    throw new PaperkeyRestoreError('armored 公開鍵（BEGIN PGP PUBLIC KEY BLOCK）が見つかりません');
  }

  const base64Lines = [];
  let isInsideArmorHeader = true;
  for (const line of lines.slice(beginIndex + 1)) {
    const trimmed = line.trim();
    if (trimmed === endMarker) break;
    if (trimmed === '') {
      isInsideArmorHeader = false;
      continue;
    }
    // 本文前の "Version:" などの armor ヘッダ行と、末尾の "=CRC" チェックサム行は捨てる。
    if (isInsideArmorHeader && trimmed.includes(':')) continue;
    if (trimmed.startsWith('=')) continue;
    isInsideArmorHeader = false;
    base64Lines.push(trimmed);
  }

  if (base64Lines.length === 0) {
    throw new PaperkeyRestoreError('armored 公開鍵に base64 本体がありません');
  }
  const decoded = decodeBase64(base64Lines.join(''));
  if (decoded.length === 0) {
    throw new PaperkeyRestoreError('armored 公開鍵の base64 を復号できませんでした');
  }
  return new Uint8Array(decoded);
}

/**
 * バイト列の先頭 1 パケットを読み、tag と本体を返す。
 * 鍵パケットに partial body length は現れないため、それはエラーにする（RFC 4880 4.2.2.4）。
 */
function readFirstPacket(bytes) {
  if (bytes.length < 2) {
    throw new PaperkeyRestoreError('OpenPGP パケットとして短すぎます');
  }
  const firstOctet = bytes[0];
  if ((firstOctet & OLD_FORMAT_PACKET) === 0) {
    throw new PaperkeyRestoreError('OpenPGP パケットの先頭オクテットが不正です（armor を復号できていない可能性）');
  }

  const isNewFormat = (firstOctet & 0x40) !== 0;
  const tag = isNewFormat ? firstOctet & 0x3f : (firstOctet >> 2) & 0x0f;
  const lengthType = firstOctet & 0x03;

  if (isNewFormat) {
    const lengthOctet = bytes[1];
    if (lengthOctet < 192) return slicePacketBody(bytes, tag, lengthOctet, 2);
    if (lengthOctet < 224) return slicePacketBody(bytes, tag, ((lengthOctet - 192) << 8) + bytes[2] + 192, 3);
    if (lengthOctet === 255) return slicePacketBody(bytes, tag, readUint32(bytes, 2), 6);
    throw new PaperkeyRestoreError('鍵パケットに partial body length は使えません');
  }

  if (lengthType === 0) return slicePacketBody(bytes, tag, bytes[1], 2);
  if (lengthType === TWO_OCTET_LENGTH) return slicePacketBody(bytes, tag, (bytes[1] << 8) | bytes[2], 3);
  if (lengthType === FOUR_OCTET_LENGTH) return slicePacketBody(bytes, tag, readUint32(bytes, 2), 6);
  throw new PaperkeyRestoreError('不定長パケット長は鍵パケットでは使えません');
}

function slicePacketBody(bytes, tag, length, bodyOffset) {
  const bodyEnd = bodyOffset + length;
  if (bodyOffset + 1 > bytes.length || bodyEnd > bytes.length) {
    throw new PaperkeyRestoreError('OpenPGP パケットの長さが実データより大きいです');
  }
  return { tag, body: bytes.subarray(bodyOffset, bodyEnd) };
}

function readUint32(bytes, offset) {
  if (offset + 4 > bytes.length) {
    throw new PaperkeyRestoreError('OpenPGP パケットの長さフィールドが途中で切れています');
  }
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/**
 * paperkey を呼び出して秘密鍵を再構成する。
 * 作業ファイルは呼び出しごとに消し、秘密部分はゼロで上書きしてから削除する。
 */
function restoreWithPaperkey(module, publicKeyBody, secretBytes, inputTypeCode) {
  const FS = module.FS;
  const allocatedPointers = [];

  const toCString = (text) => {
    const encoded = encodeUtf8(`${text}\0`);
    const pointer = module._malloc(encoded.length);
    if (pointer === 0) {
      throw new PaperkeyRestoreError('paperkey の作業メモリを確保できませんでした');
    }
    module.HEAPU8.set(encoded, pointer);
    allocatedPointers.push(pointer);
    return pointer;
  };

  let pubringStream = 0;
  let secretsStream = 0;

  try {
    FS.writeFile(PUBRING_PATH, buildPublicKeyPacket(publicKeyBody));
    FS.writeFile(SECRETS_PATH, secretBytes);

    pubringStream = module._fopen(toCString(PUBRING_PATH), toCString(FILE_MODE_READ));
    secretsStream = module._fopen(toCString(SECRETS_PATH), toCString(FILE_MODE_READ));
    if (pubringStream === 0 || secretsStream === 0) {
      throw new PaperkeyRestoreError('paperkey が作業ファイルを開けませんでした');
    }

    const exitCode = module._restore(pubringStream, secretsStream, inputTypeCode, toCString(RESTORED_PATH));
    // paperkey は出力ストリームを閉じないため、明示的にフラッシュしないと内容が欠ける。
    module._fflush(0);

    if (exitCode !== 0) {
      throw new PaperkeyRestoreError(`paperkey が秘密鍵の再構成に失敗しました（終了コード ${exitCode}）`);
    }

    const restoredBytes = FS.readFile(RESTORED_PATH);
    if (restoredBytes.length === 0) {
      throw new PaperkeyFingerprintMismatchError(
        '紙の秘密部分が公開鍵のフィンガープリントと一致しませんでした（秘密鍵を再構成できません）'
      );
    }
    return new Uint8Array(restoredBytes);
  } finally {
    if (pubringStream !== 0) module._fclose(pubringStream);
    if (secretsStream !== 0) module._fclose(secretsStream);
    for (const pointer of allocatedPointers) module._free(pointer);
    secretBytes.fill(0);
    eraseWorkFiles(FS);
  }
}

function buildPublicKeyPacket(publicKeyBody) {
  if (publicKeyBody.length > TWO_OCTET_LENGTH_LIMIT) {
    throw new PaperkeyRestoreError('公開鍵パケットが大きすぎます（65535 バイト超）');
  }
  const header = Uint8Array.from([
    OLD_FORMAT_PACKET | (PUBLIC_KEY_PACKET_TAG << 2) | TWO_OCTET_LENGTH,
    (publicKeyBody.length >> 8) & 0xff,
    publicKeyBody.length & 0xff,
  ]);
  const packet = new Uint8Array(header.length + publicKeyBody.length);
  packet.set(header, 0);
  packet.set(publicKeyBody, header.length);
  return packet;
}

function eraseWorkFiles(FS) {
  for (const path of [SECRETS_PATH, RESTORED_PATH]) {
    overwriteWithZeros(FS, path);
  }
  for (const path of [PUBRING_PATH, SECRETS_PATH, RESTORED_PATH]) {
    try {
      FS.unlink(path);
    } catch {
      // 作業ファイルが無い場合もあり、後始末の失敗は再構成の成否に影響しない。
    }
  }
}

function overwriteWithZeros(FS, path) {
  try {
    const { size } = FS.stat(path);
    FS.writeFile(path, new Uint8Array(size));
  } catch {
    // ファイルが無ければ上書きの必要もない。
  }
}

/**
 * 再構成された秘密鍵が、取得した公開鍵のものかを検証する。
 * 1. 秘密鍵パケットの公開部分が公開鍵の本体とバイト一致すること
 * 2. 再計算したフィンガープリントが公開鍵のフィンガープリントと一致すること
 */
function verifyRestoredKey({ publicKeyBody, restoredBytes, pubkeyArmored }) {
  const restoredPacket = readFirstPacket(restoredBytes);
  if (restoredPacket.tag !== SECRET_KEY_PACKET_TAG) {
    throw new PaperkeyRestoreError(
      `秘密鍵パケット（tag ${SECRET_KEY_PACKET_TAG}）を期待しましたが tag ${restoredPacket.tag} が見つかりました`
    );
  }
  if (restoredPacket.body.length < publicKeyBody.length) {
    throw new PaperkeyFingerprintMismatchError('再構成された秘密鍵が公開鍵より短いため検証できません');
  }

  const restoredPublicKeyBody = restoredPacket.body.subarray(0, publicKeyBody.length);
  if (!bytesEqual(restoredPublicKeyBody, publicKeyBody)) {
    throw new PaperkeyFingerprintMismatchError('再構成された秘密鍵の公開部分が、取得した公開鍵と一致しません');
  }

  const expectedFingerprint = calculateFingerprint(pubkeyArmored);
  const actualFingerprint = calculateFingerprint(armorPublicKeyBody(restoredPublicKeyBody));
  try {
    verifyFingerprint(actualFingerprint, expectedFingerprint);
  } catch (error) {
    throw new PaperkeyFingerprintMismatchError('再構成後のフィンガープリントが公開鍵と一致しません', { cause: error });
  }
}

function armorPublicKeyBody(publicKeyBody) {
  const packet = buildPublicKeyPacket(publicKeyBody);
  const base64 = encodeBase64(packet).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${base64}\n-----END PGP PUBLIC KEY BLOCK-----\n`;
}

function decodeBase64(text) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'));
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

function encodeBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function encodeUtf8(text) {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8');
  return new TextEncoder().encode(text);
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * WASM モジュールは 1 つしかなく作業ファイルも共有なので、呼び出しを直列化する。
 */
function enqueueInvocation(task) {
  const result = invocationChain.then(task, task);
  invocationChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

const paperkeyApi = {
  initPaperkeyWasm,
  restoreSecretKey,
  PaperkeyInitError,
  PaperkeyRestoreError,
  PaperkeyFingerprintMismatchError,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = paperkeyApi;
}
if (typeof globalThis !== 'undefined') {
  globalThis.paperkey = paperkeyApi;
}
})();
