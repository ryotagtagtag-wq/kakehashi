/*
 * Copyright (C) 2026 game_ryo
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, see <https://www.gnu.org/licenses/>.
 */

// OpenPGP packet parsing and key fingerprint utilities.
(function () {
const nodeCrypto = typeof require === 'function' ? require('crypto') : null;

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
  const encoded = base64Lines.join('');
  const decoded = typeof Buffer !== 'undefined'
    ? Buffer.from(encoded, 'base64')
    : Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
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

function digest(bytes, algorithm) {
  if (nodeCrypto) {
    return nodeCrypto.createHash(algorithm).update(Buffer.from(bytes)).digest();
  }
  return algorithm === 'sha1' ? sha1(bytes) : sha256(bytes);
}

function padForHash(bytes) {
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  return padded;
}

function rotateRight(value, count) {
  return (value >>> count) | (value << (32 - count));
}

function sha1(bytes) {
  const data = padForHash(bytes);
  const state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const words = new Uint32Array(80);
  const view = new DataView(data.buffer);

  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i += 1) {
      const value = words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16];
      words[i] = (value << 1) | (value >>> 31);
    }

    let [a, b, c, d, e] = state;
    for (let i = 0; i < 80; i += 1) {
      let fn;
      let constant;
      if (i < 20) {
        fn = (b & c) | (~b & d);
        constant = 0x5a827999;
      } else if (i < 40) {
        fn = b ^ c ^ d;
        constant = 0x6ed9eba1;
      } else if (i < 60) {
        fn = (b & c) | (b & d) | (c & d);
        constant = 0x8f1bbcdc;
      } else {
        fn = b ^ c ^ d;
        constant = 0xca62c1d6;
      }
      const sum = (((a << 5) | (a >>> 27)) + fn + e + constant + words[i]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = sum;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
  }

  const output = new Uint8Array(20);
  const outputView = new DataView(output.buffer);
  state.forEach((value, index) => outputView.setUint32(index * 4, value));
  return output;
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(bytes) {
  const data = padForHash(bytes);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const view = new DataView(data.buffer);

  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotateRight(words[i - 15], 7) ^ rotateRight(words[i - 15], 18) ^ (words[i - 15] >>> 3);
      const s1 = rotateRight(words[i - 2], 17) ^ rotateRight(words[i - 2], 19) ^ (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_CONSTANTS[i] + words[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    const values = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < state.length; i += 1) state[i] = (state[i] + values[i]) >>> 0;
  }

  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  state.forEach((value, index) => outputView.setUint32(index * 4, value));
  return output;
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
    const input = new Uint8Array(prefix.length + lenBytes.length + body.length);
    input.set(prefix);
    input.set(lenBytes, prefix.length);
    input.set(body, prefix.length + lenBytes.length);
    hash = digest(input, 'sha1');
  } else {
    // RFC 9580: SHA-256(0x99 | 4オクテット長 | パケットボディ)
    const lenBytes = new Uint8Array([
      (body.length >>> 24) & 0xff,
      (body.length >>> 16) & 0xff,
      (body.length >>> 8) & 0xff,
      body.length & 0xff,
    ]);
    const input = new Uint8Array(prefix.length + lenBytes.length + body.length);
    input.set(prefix);
    input.set(lenBytes, prefix.length);
    input.set(body, prefix.length + lenBytes.length);
    hash = digest(input, 'sha256');
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

const fingerprintApi = {
  calculateFingerprint,
  verifyFingerprint,
  UnsupportedKeyVersionError,
  FingerprintMismatchError,
  InvalidArmoredKeyError,
  dearmor,
  readFirstPacket,
  readPacketHeader,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = fingerprintApi;
}
if (typeof globalThis !== 'undefined') {
  globalThis.fingerprint = fingerprintApi;
}
})();
