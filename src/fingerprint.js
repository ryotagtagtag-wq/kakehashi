const { createHash } = require('crypto');

class UnsupportedKeyVersionError extends Error {
  constructor(message) { super(message); this.name = 'UnsupportedKeyVersionError'; }
}
class FingerprintMismatchError extends Error {
  constructor(message) { super(message); this.name = 'FingerprintMismatchError'; }
}
class InvalidArmoredKeyError extends Error {
  constructor(message) { super(message); this.name = 'InvalidArmoredKeyError'; }
}

/**
 * ASCII アーマーをデコードしてバイト列を返す。
 * ヘッダ行 ("Version:" など)、空行、末尾の "=CRC" 行を除外する。
 * @param {string} armoredText
 * @returns {Uint8Array}
 */
function dearmor(armoredText) {
  const lines = armoredText.split(/\r?\n/);
  const beginMarker = '-----BEGIN PGP PUBLIC KEY BLOCK-----';
  const endMarker = '-----END PGP PUBLIC KEY BLOCK-----';
  const beginIndex = lines.findIndex((line) => line.trim() === beginMarker);
  if (beginIndex === -1) {
    throw new InvalidArmoredKeyError('armored 公開鍵（BEGIN PGP PUBLIC KEY BLOCK）が見つかりません');
  }

  const base64Lines = [];
  let inHeader = true;
  for (const line of lines.slice(beginIndex + 1)) {
    const trimmed = line.trim();
    if (trimmed === endMarker) break;
    if (trimmed === '') { inHeader = false; continue; }
    if (inHeader && trimmed.includes(':')) continue;      // アーマーヘッダ行
    if (trimmed.startsWith('=')) continue;               // チェックサム行
    inHeader = false;
    base64Lines.push(trimmed);
  }

  if (base64Lines.length === 0) {
    throw new InvalidArmoredKeyError('armored 公開鍵に base64 本体がありません');
  }
  const decoded = Buffer.from(base64Lines.join(''), 'base64');
  if (decoded.length === 0) {
    throw new InvalidArmoredKeyError('armored 公開鍵の base64 を復号できませんでした');
  }
  return new Uint8Array(decoded);
}

/**
 * OpenPGP パケットの先頭を解析し、{ tag, body, headerLen } を返す。
 * 旧形式・新形式の両方に対応。
 * @param {Uint8Array} bytes
 * @returns {Object}
 */
function readPacketHeader(bytes) {
  if (bytes.length < 1) {
    throw new InvalidArmoredKeyError('パケットが短すぎます');
  }
  const firstOctet = bytes[0];
  if ((firstOctet & 0x80) === 0) {
    throw new InvalidArmoredKeyError('OpenPGP パケットの先頭オクテットが不正です');
  }

  // 旧形式: 10TTLLLL
  if ((firstOctet & 0x40) === 0) {
    const tag = (firstOctet >> 2) & 0x0f;
    const lengthType = firstOctet & 0x03;
    let bodyLen, bodyOffset;
    if (lengthType === 0) {
      bodyLen = bytes[1];
      bodyOffset = 2;
    } else if (lengthType === 1) {
      if (bytes.length < 3) throw new InvalidArmoredKeyError('パケット長が不足');
      bodyLen = (bytes[1] << 8) | bytes[2];
      bodyOffset = 3;
    } else if (lengthType === 2) {
      if (bytes.length < 5) throw new InvalidArmoredKeyError('パケット長が不足');
      bodyLen = ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
      bodyOffset = 5;
    } else {
      throw new InvalidArmoredKeyError('不定長パケット長はサポート外');
    }
    return { tag, bodyLen, bodyOffset };
  }

  // 新形式: 11TTTTTT
  const tag = firstOctet & 0x3f;
  const lengthOctet = bytes[1];
  let bodyLen, bodyOffset;
  if (lengthOctet < 192) {
    bodyLen = lengthOctet;
    bodyOffset = 2;
  } else if (lengthOctet < 224) {
    if (bytes.length < 3) throw new InvalidArmoredKeyError('パケット長が不足');
    bodyLen = ((lengthOctet - 192) << 8) + bytes[2] + 192;
    bodyOffset = 3;
  } else if (lengthOctet === 255) {
    if (bytes.length < 5) throw new InvalidArmoredKeyError('パケット長が不足');
    bodyLen = ((bytes[2] << 24) | (bytes[3] << 16) | (bytes[4] << 8) | bytes[5]) >>> 0;
    bodyOffset = 6;
  } else {
    throw new InvalidArmoredKeyError('partial body length はサポート外');
  }
  return { tag, bodyLen, bodyOffset };
}

/**
 * 1 パケットを読み、{ tag, body } を返す。
 * @param {Uint8Array} bytes
 * @returns {Object}
 */
function readFirstPacket(bytes) {
  const { tag, bodyLen, bodyOffset } = readPacketHeader(bytes);
  if (bodyOffset + bodyLen > bytes.length) {
    throw new InvalidArmoredKeyError('パケット長がデータ長を超過');
  }
  return {
    tag,
    body: bytes.subarray(bodyOffset, bodyOffset + bodyLen),
  };
}

/**
 * armored 公開鍵からフィンガープリント（40 桁 16 進数）を計算する。
 * - v4 (RFC 4880): SHA-1(0x99 | 2オクテット長 | パケットボディ) の下位 160 ビット
 * - v5/v6 (RFC 9580): SHA-256(0x99 | 4オクテット長 | パケットボディ) の下位 160 ビット
 *
 * @param {string} armoredKey
 * @returns {string} 40 桁の 16 進数フィンガープリント
 * @throws {UnsupportedKeyVersionError}
 * @throws {InvalidArmoredKeyError}
 */
function calculateFingerprint(armoredKey) {
  if (typeof armoredKey !== 'string' || armoredKey.trim() === '') {
    throw new InvalidArmoredKeyError('公開鍵が空です');
  }
  const bytes = dearmor(armoredKey);
  const { tag, body } = readFirstPacket(bytes);
  if (tag !== 6) {
    throw new InvalidArmoredKeyError(`公開鍵パケット（tag 6）を期待しましたが tag ${tag} が見つかりました`);
  }

  if (body.length < 1) {
    throw new InvalidArmoredKeyError('公開鍵パケットのボディが空です');
  }
  const version = body[0];
  if (version !== 4 && version !== 5 && version !== 6) {
    throw new UnsupportedKeyVersionError(`サポート外の OpenPGP バージョン ${version}`);
  }

  // フィンガープリント計算用のプレフィクス: 0x99 + 長さ
  const prefix = new Uint8Array([0x99]);
  let hash;
  if (version === 4) {
    // RFC 4880: SHA-1(0x99 | 2オクテット長 | パケットボディ)
    const lenBytes = new Uint8Array([(body.length >> 8) & 0xff, body.length & 0xff]);
    const input = Buffer.concat([Buffer.from(prefix), Buffer.from(lenBytes), Buffer.from(body)]);
    hash = createHash('sha1').update(input).digest();
  } else {
    // RFC 9580: SHA-256(0x99 | 4オクテット長 | パケットボディ)
    const lenBytes = new Uint8Array([
      (body.length >>> 24) & 0xff,
      (body.length >>> 16) & 0xff,
      (body.length >>> 8) & 0xff,
      body.length & 0xff,
    ]);
    const input = Buffer.concat([Buffer.from(prefix), Buffer.from(lenBytes), Buffer.from(body)]);
    hash = createHash('sha256').update(input).digest();
  }

  const fingerprintBytes = hash.slice(0, 20); // 下位 160 ビット
  const hex = Array.from(fingerprintBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex;
}

/**
 * フィンガープリントの完全一致比較。
 * @param {string} calculated
 * @param {string} expected
 * @returns {boolean}
 * @throws {FingerprintMismatchError}
 */
function verifyFingerprint(calculated, expected) {
  if (typeof calculated !== 'string' || typeof expected !== 'string') {
    throw new FingerprintMismatchError('フィンガープリントは文字列である必要があります');
  }
  if (calculated.toLowerCase() !== expected.toLowerCase()) {
    throw new FingerprintMismatchError('フィンガープリントが一致しません');
  }
  return true;
}

module.exports = {
  calculateFingerprint,
  verifyFingerprint,
  UnsupportedKeyVersionError,
  FingerprintMismatchError,
  InvalidArmoredKeyError,
  dearmor,
  readFirstPacket,
  readPacketHeader,
};
