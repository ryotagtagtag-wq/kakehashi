'use strict';

/**
 * src/paperkey.js のテスト。
 *
 * 秘密鍵・秘密部分は実物を使わず、すべて明示的なダミー値で構成する。
 * （DUMMY_... という名前と、明らかに意味のない 0xDE 0xAD 系のバイト列で判別できる）
 * WASM の再構成テストは vendor/paperkey のビルドに必要なバインディングが
 * 揃っている場合のみ実行し、無い場合は理由付きで skip する。
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  initPaperkeyWasm,
  restoreSecretKey,
  PaperkeyInitError,
  PaperkeyRestoreError,
  PaperkeyFingerprintMismatchError,
} = require('../src/paperkey.js');

// v4 公開鍵パケット本体のダミー（version, timestamp=0, algo=1, 極小のダミー MPI 2 つ）
const DUMMY_PUBLIC_KEY_BODY = Uint8Array.from([
  0x04, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x10, 0xaa, 0xbb, 0x00, 0x10, 0xcc, 0xdd,
]);
const DUMMY_SECRET_PART = Uint8Array.from([0x00, 0xde, 0xad, 0xbe, 0xef]);
const DUMMY_OTHER_SECRET_PART = Uint8Array.from([0x00, 0xba, 0xad, 0xf0, 0x0d]);

const CRC24_INIT = 0xb704ce;
const CRC24_POLY = 0x864cfb;

let initFailure = null;

before(async () => {
  try {
    await initPaperkeyWasm();
  } catch (error) {
    initFailure = error;
  }
});

function skipUnlessWasmReady(t) {
  if (!initFailure) return false;
  t.skip(`vendor/paperkey の WASM を実行できないため skip: ${initFailure.message}`);
  return true;
}

function crc24(bytes) {
  let crc = CRC24_INIT;
  for (const byte of bytes) {
    crc ^= byte << 16;
    for (let bit = 0; bit < 8; bit += 1) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= CRC24_POLY;
    }
  }
  return crc & 0xffffff;
}

function packetBytes(tag, body) {
  const isTwoOctet = body.length > 0xff;
  const header = isTwoOctet
    ? Uint8Array.from([0x80 | (tag << 2) | 1, (body.length >> 8) & 0xff, body.length & 0xff])
    : Uint8Array.from([0x80 | (tag << 2), body.length]);
  const packet = new Uint8Array(header.length + body.length);
  packet.set(header, 0);
  packet.set(body, header.length);
  return packet;
}

function publicKeyFingerprint(body) {
  const packet = packetBytes(6, body);
  const head = Uint8Array.from([0x99, (body.length >> 8) & 0xff, body.length & 0xff]);
  return crypto.createHash('sha1').update(head).update(Buffer.from(body)).digest();
}

function armorPublicKey(body) {
  const base64 = Buffer.from(packetBytes(6, body)).toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${base64}\n-----END PGP PUBLIC KEY BLOCK-----\n`;
}

/**
 * paperkey の秘密部分（version 0 + 鍵エントリ）を組み立てる。
 * 構造: 0x00 | 0x04 | fingerprint(20) | length(2) | secret part
 */
function buildSecretsBlob(fingerprint, secretPart) {
  return Uint8Array.from([
    0x00,
    0x04,
    ...fingerprint,
    (secretPart.length >> 8) & 0xff,
    secretPart.length & 0xff,
    ...secretPart,
  ]);
}

function toRawSecrets(secretsBlob) {
  const crc = crc24(secretsBlob);
  return Uint8Array.from([...secretsBlob, (crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff]);
}

/**
 * paperkey の base16 出力形式（"%3u: " + "XX " の連続 + 行 CRC、最終行は全体 CRC）を再現する。
 * 22 バイト／行は paperkey の既定（--output-width 78）と同じ。
 */
function toBase16Secrets(secretsBlob, bytesPerLine = 22) {
  const lines = [];
  for (let offset = 0; offset < secretsBlob.length; offset += bytesPerLine) {
    const chunk = secretsBlob.subarray(offset, offset + bytesPerLine);
    const hexBytes = Array.from(chunk, (byte) => `${byte.toString(16).toUpperCase().padStart(2, '0')} `).join('');
    const lineNumber = String(offset / bytesPerLine + 1).padStart(3, ' ');
    lines.push(`${lineNumber}: ${hexBytes}${crc24(chunk).toString(16).toUpperCase().padStart(6, '0')}`);
  }
  const finalLineNumber = String(lines.length + 1).padStart(3, ' ');
  lines.push(`${finalLineNumber}: ${crc24(secretsBlob).toString(16).toUpperCase().padStart(6, '0')}`);
  return `${lines.join('\n')}\n`;
}

/** 先頭パケットの tag と本体を取り出す（旧形式・新形式の両方に対応）。 */
function readFirstPacket(bytes) {
  const firstOctet = bytes[0];
  const isNewFormat = (firstOctet & 0x40) !== 0;
  if (isNewFormat) {
    const tag = firstOctet & 0x3f;
    const lengthOctet = bytes[1];
    if (lengthOctet < 192) return { tag, body: bytes.subarray(2, 2 + lengthOctet) };
    const length = ((lengthOctet - 192) << 8) + bytes[2] + 192;
    return { tag, body: bytes.subarray(3, 3 + length) };
  }
  const tag = (firstOctet >> 2) & 0x0f;
  const lengthType = firstOctet & 0x03;
  const length = lengthType === 0 ? bytes[1] : (bytes[1] << 8) | bytes[2];
  const bodyOffset = lengthType === 0 ? 2 : 3;
  return { tag, body: bytes.subarray(bodyOffset, bodyOffset + length) };
}

test('エラー型は Error を継承し、name が一致する', () => {
  assert.ok(new PaperkeyInitError('x') instanceof Error);
  assert.ok(new PaperkeyRestoreError('x') instanceof Error);
  assert.ok(new PaperkeyFingerprintMismatchError('x') instanceof Error);
  assert.equal(new PaperkeyInitError('x').name, 'PaperkeyInitError');
  assert.equal(new PaperkeyRestoreError('x').name, 'PaperkeyRestoreError');
  assert.equal(new PaperkeyFingerprintMismatchError('x').name, 'PaperkeyFingerprintMismatchError');
});

test('initPaperkeyWasm は同じ Promise を返し、2 回目以降も解決する', async (t) => {
  if (skipUnlessWasmReady(t)) return;
  const first = initPaperkeyWasm();
  const second = initPaperkeyWasm();
  assert.equal(first, second);
  await first;
  await initPaperkeyWasm();
});

test('未知の inputType は PaperkeyRestoreError', async () => {
  await assert.rejects(
    () => restoreSecretKey(armorPublicKey(DUMMY_PUBLIC_KEY_BODY), 'dummy', 'base32'),
    (error) => error instanceof PaperkeyRestoreError && /inputType/.test(error.message)
  );
});

test('空の公開鍵は PaperkeyRestoreError', async () => {
  await assert.rejects(
    () => restoreSecretKey('   ', 'dummy', 'auto'),
    (error) => error instanceof PaperkeyRestoreError && /公開鍵が空/.test(error.message)
  );
});

test('armored でない公開鍵は PaperkeyRestoreError', async () => {
  await assert.rejects(
    () => restoreSecretKey('not an armored key', 'dummy', 'auto'),
    (error) => error instanceof PaperkeyRestoreError && /BEGIN PGP PUBLIC KEY BLOCK/.test(error.message)
  );
});

test('空の秘密部分は PaperkeyRestoreError', async () => {
  await assert.rejects(
    () => restoreSecretKey(armorPublicKey(DUMMY_PUBLIC_KEY_BODY), '   ', 'auto'),
    (error) => error instanceof PaperkeyRestoreError && /秘密部分が空/.test(error.message)
  );
});

test('文字列でも Uint8Array でもない秘密部分は PaperkeyRestoreError', async () => {
  await assert.rejects(
    () => restoreSecretKey(armorPublicKey(DUMMY_PUBLIC_KEY_BODY), 42, 'raw'),
    (error) => error instanceof PaperkeyRestoreError
  );
});

test('raw: ダミー公開鍵 + ダミー秘密部分から秘密鍵を再構成する', async (t) => {
  if (skipUnlessWasmReady(t)) return;
  const fingerprint = publicKeyFingerprint(DUMMY_PUBLIC_KEY_BODY);
  const rawSecrets = toRawSecrets(buildSecretsBlob(fingerprint, DUMMY_SECRET_PART));

  const restored = await restoreSecretKey(armorPublicKey(DUMMY_PUBLIC_KEY_BODY), rawSecrets, 'raw');

  const packet = readFirstPacket(restored);
  assert.equal(packet.tag, 5, '秘密鍵パケット（tag 5）が出力される');
  assert.deepEqual(Array.from(packet.body), [...DUMMY_PUBLIC_KEY_BODY, ...DUMMY_SECRET_PART]);
});

test('base16: テキスト形式の秘密部分からも同じ秘密鍵を再構成する', async (t) => {
  if (skipUnlessWasmReady(t)) return;
  const fingerprint = publicKeyFingerprint(DUMMY_PUBLIC_KEY_BODY);
  const secretsBlob = buildSecretsBlob(fingerprint, DUMMY_SECRET_PART);
  const base16Text = toBase16Secrets(secretsBlob);

  const fromBase16 = await restoreSecretKey(armorPublicKey(DUMMY_PUBLIC_KEY_BODY), base16Text, 'base16');
  const fromRaw = await restoreSecretKey(
    armorPublicKey(DUMMY_PUBLIC_KEY_BODY),
    toRawSecrets(secretsBlob),
    'raw'
  );

  assert.deepEqual(Array.from(fromBase16), Array.from(fromRaw));
});

test('auto: 先頭バイトから base16 を自動判別する', async (t) => {
  if (skipUnlessWasmReady(t)) return;
  const fingerprint = publicKeyFingerprint(DUMMY_PUBLIC_KEY_BODY);
  const base16Text = toBase16Secrets(buildSecretsBlob(fingerprint, DUMMY_SECRET_PART));

  const restored = await restoreSecretKey(armorPublicKey(DUMMY_PUBLIC_KEY_BODY), base16Text, 'auto');

  const packet = readFirstPacket(restored);
  assert.equal(packet.tag, 5);
  assert.deepEqual(Array.from(packet.body), [...DUMMY_PUBLIC_KEY_BODY, ...DUMMY_SECRET_PART]);
});

test('フィンガープリントが一致しない秘密部分は PaperkeyFingerprintMismatchError', async (t) => {
  if (skipUnlessWasmReady(t)) return;
  const otherFingerprint = publicKeyFingerprint(
    Uint8Array.from([...DUMMY_PUBLIC_KEY_BODY.slice(0, -1), 0xee])
  );
  const rawSecrets = toRawSecrets(buildSecretsBlob(otherFingerprint, DUMMY_OTHER_SECRET_PART));

  await assert.rejects(
    () => restoreSecretKey(armorPublicKey(DUMMY_PUBLIC_KEY_BODY), rawSecrets, 'raw'),
    (error) => error instanceof PaperkeyFingerprintMismatchError
  );
});

test('CRC が壊れた base16 は PaperkeyRestoreError', async (t) => {
  if (skipUnlessWasmReady(t)) return;
  const fingerprint = publicKeyFingerprint(DUMMY_PUBLIC_KEY_BODY);
  const base16Text = toBase16Secrets(buildSecretsBlob(fingerprint, DUMMY_SECRET_PART));
  // paperkey の行番号は "%3u: "（1 桁なら半角スペース 2 つ）なので、行頭の空白は 2 つ。
  const corrupted = base16Text.replace(/^ {2}1: (..) /, '  1: 7F ');

  await assert.rejects(
    () => restoreSecretKey(armorPublicKey(DUMMY_PUBLIC_KEY_BODY), corrupted, 'base16'),
    (error) => error instanceof PaperkeyRestoreError
  );
});

test('呼び出しを跨いでも作業ファイルが残らない', async (t) => {
  if (skipUnlessWasmReady(t)) return;
  const fingerprint = publicKeyFingerprint(DUMMY_PUBLIC_KEY_BODY);
  const rawSecrets = toRawSecrets(buildSecretsBlob(fingerprint, DUMMY_SECRET_PART));

  await restoreSecretKey(armorPublicKey(DUMMY_PUBLIC_KEY_BODY), rawSecrets, 'raw');
  await restoreSecretKey(armorPublicKey(DUMMY_PUBLIC_KEY_BODY), rawSecrets, 'raw');

  const module = require('../vendor/paperkey/paperkey.js');
  assert.deepEqual(module.FS.readdir('/').filter((name) => name.startsWith('kakehashi-')), []);
});
