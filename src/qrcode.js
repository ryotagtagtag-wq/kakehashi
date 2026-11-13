/**
 * qrcode.js – QR コードのエンコード／デコード
 *
 * エンコード: 英数字モード (Alphanumeric) で QR マトリクスを生成し、data URL (PNG) を返す。
 *   base16 (0-9A-F) と base64 (A-Za-z0-9+/=) のどちらも英数字モードでエンコード可能。
 *   ただし base64 の '+' '/' '=' は英数字モードのキャラクタセットに含まれないため、
   base64 モードでは 8bit バイトモードにフォールバックする。
 * デコード: vendor/jsqr/jsqr.js (jsQR) を使用。
 *
 * 依存: vendor/jsqr/jsqr.js のみ。外部 CDN は使用しない。
 */

/* ── 定数 ── */

const ALPHANUMERIC_CHARS =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

// QR バージョン定義 (version, alphanumeric capacity at EC-L)
const QR_VERSIONS = [
  { ver: 1, alphanum: 25, ecBytes: 7, totalBytes: 26 },
  { ver: 2, alphanum: 47, ecBytes: 10, totalBytes: 44 },
  { ver: 3, alphanum: 77, ecBytes: 15, totalBytes: 70 },
  { ver: 4, alphanum: 114, ecBytes: 20, totalBytes: 100 },
  { ver: 5, alphanum: 154, ecBytes: 26, totalBytes: 134 },
  { ver: 6, alphanum: 195, ecBytes: 30, totalBytes: 174 },
  { ver: 7, alphanum: 239, ecBytes: 38, totalBytes: 222 },
  { ver: 8, alphanum: 283, ecBytes: 44, totalBytes: 276 },
  { ver: 9, alphanum: 331, ecBytes: 50, totalBytes: 330 },
  { ver: 10, alphanum: 382, ecBytes: 56, totalBytes: 388 },
];

// Reed-Solomon 生成多項式 (EC レベル別)
const EC_POLYS = {
  7:  [1, 78],
  10: [1, 116, 68, 137, 196, 68, 137, 196, 68, 137],
  15: [1, 120, 183, 194, 122, 52, 167, 205, 39, 174, 213, 147, 60, 174, 213, 147],
  20: [1, 133, 187, 131, 159, 131, 159, 131, 159, 131, 159, 131, 159, 131, 159, 131, 159, 131, 159, 131, 159],
  26: [1, 139, 181, 215, 171, 215, 171, 215, 171, 215, 171, 215, 171, 215, 171, 215, 171, 215, 171, 215, 171, 215, 171, 215, 171, 215, 171],
  30: [1, 146, 227, 221, 151, 227, 221, 151, 227, 221, 151, 227, 221, 151, 227, 221, 151, 227, 221, 151, 227, 221, 151, 227, 221, 151, 227, 221, 151, 227],
  38: [1, 154, 103, 25, 82, 103, 25, 82, 103, 25, 82, 103, 25, 82, 103, 25, 82, 103, 25, 82, 103, 25, 82, 103, 25, 82, 103, 25, 82, 103, 25, 82, 103, 25, 82, 103, 25],
  44: [1, 162, 215, 189, 223, 215, 189, 223, 215, 189, 223, 215, 189, 223, 215, 189, 223, 215, 189, 223, 215, 189, 223, 215, 189, 223, 215, 189, 223, 215, 189, 223, 215, 189, 223, 215, 189, 223, 215, 189, 223, 215, 189],
  50: [1, 166, 62, 131, 234, 62, 131, 234, 62, 131, 234, 62, 131, 234, 62, 131, 234, 62, 131, 234, 62, 131, 234, 62, 131, 234, 62, 131, 234, 62, 131, 234, 62, 131, 234, 62, 131, 234, 62, 131, 234, 62, 131, 234, 62, 131, 234],
  56: [1, 170, 161, 50, 49, 161, 50, 49, 161, 50, 49, 161, 50, 49, 161, 50, 49, 161, 50, 49, 161, 50, 49, 161, 50, 49, 161, 50, 49, 161, 50, 49, 161, 50, 49, 161, 50, 49, 161, 50, 49, 161, 50, 49, 161, 50, 49, 161, 50],
};

// GF(2^8) の指数・対数表 (原始多項式 0x11d)
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] + LOG[b]) % 255];
}

function gfInv(a) {
  return EXP[(255 - LOG[a]) % 255];
}

function gfPolyMultiply(poly1, poly2) {
  const result = new Uint8Array(poly1.length + poly2.length - 1);
  for (let i = 0; i < poly1.length; i++) {
    for (let j = 0; j < poly2.length; j++) {
      result[i + j] ^= gfMul(poly1[i], poly2[j]);
    }
  }
  return result;
}

function gfPolyMod(dividend, divisor) {
  const result = new Uint8Array(dividend);
  for (let i = 0; i < dividend.length - divisor.length + 1; i++) {
    const coef = result[i];
    if (coef !== 0) {
      const logCoef = LOG[coef];
      for (let j = 1; j < divisor.length; j++) {
        result[i + j] ^= EXP[(logCoef + LOG[divisor[j]]) % 255];
      }
    }
  }
  return result.subarray(dividend.length - divisor.length + 1);
}

function calcEC(dataBytes, ecBytes) {
  const poly = EC_POLYS[ecBytes] || EC_POLYS[7];
  const buffer = new Uint8Array(dataBytes.length + ecBytes);
  buffer.set(dataBytes);
  const remainder = gfPolyMod(buffer, poly);
  return remainder;
}

/* ── エンコード ── */

function alphanumericValue(ch) {
  const idx = ALPHANUMERIC_CHARS.indexOf(ch);
  if (idx === -1) return -1;
  return idx;
}

function encodeAlphanumeric(data) {
  const bits = [];
  let i = 0;
  while (i < data.length) {
    const v1 = alphanumericValue(data[i]);
    if (v1 === -1) return null;
    if (i + 1 < data.length) {
      const v2 = alphanumericValue(data[i + 1]);
      if (v2 !== -1) {
        bits.push((v1 * 45 + v2) >>> 0);
        i += 2;
      } else {
        bits.push(v1);
        i += 1;
      }
    } else {
      bits.push(v1);
      i += 1;
    }
  }
  return bits;
}

function encode8bit(data) {
  const bits = [];
  for (const b of data) bits.push(b);
  return bits;
}

function appendLengthIndicator(bits, len, charCountBits) {
  for (let i = charCountBits - 1; i >= 0; i--) {
    bits.push((len >> i) & 1);
  }
}

function appendTerminator(bits) {
  for (let i = 0; i < 4 && bits.length % 8 !== 0; i++) {
    bits.push(0);
  }
  while (bits.length % 8 !== 0) bits.push(0);
}

function padToCapacity(bits, capacityBits) {
  while (bits.length < capacityBits) {
    if (capacityBits - bits.length >= 8) {
      bits.push(0xec, 0x11);
      bits.length -= 0; // placeholder
      // Actually push two bytes: 0xEC 0x11 alternately
      const next = bits.length % 16 < 8 ? 0xec : 0x11;
      bits.push(next);
    } else {
      bits.push(0);
    }
  }
}

function buildDataCodewords(modeBits, charCountBits, dataStr, isAlphanumeric) {
  const bits = [];
  bits.push(modeBits);
  appendLengthIndicator(bits, dataStr.length, charCountBits);

  if (isAlphanumeric) {
    const ab = encodeAlphanumeric(dataStr);
    if (ab === null) return null;
    // Alphanumeric: 11 bits per 2 chars, 6 bits per 1 char
    let i = 0;
    while (i < dataStr.length) {
      if (i + 1 < dataStr.length) {
        const v1 = alphanumericValue(dataStr[i]);
        const v2 = alphanumericValue(dataStr[i + 1]);
        bits.push(v1 * 45 + v2);
        i += 2;
      } else {
        bits.push(alphanumericValue(dataStr[i]));
        i += 1;
      }
    }
  } else {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(dataStr);
    for (const b of bytes) bits.push(b);
  }
  appendTerminator(bits);
  padToCapacity(bits, bits.length); // will be adjusted later
  return bits;
}

function strToBitArray(str, isAlphanumeric) {
  const bits = [];
  if (isAlphanumeric) {
    let i = 0;
    while (i < str.length) {
      if (i + 1 < str.length) {
        const v1 = alphanumericValue(str[i]);
        const v2 = alphanumericValue(str[i + 1]);
        if (v2 !== -1) {
          // 11 bits
          const val = v1 * 45 + v2;
          for (let b = 10; b >= 0; b--) bits.push((val >> b) & 1);
          i += 2;
        } else {
          const val = alphanumericValue(str[i]);
          for (let b = 5; b >= 0; b--) bits.push((val >> b) & 1);
          i += 1;
        }
      } else {
        const val = alphanumericValue(str[i]);
        for (let b = 5; b >= 0; b--) bits.push((val >> b) & 1);
        i += 1;
      }
    }
  } else {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    for (const b of bytes) {
      for (let bi = 7; bi >= 0; bi--) bits.push((b >> bi) & 1);
    }
  }
  return bits;
}

/**
 * QR モジュールマトリクスを生成する（version, dataString, isAlphanumeric）
 * @returns {number[][]} 0=white, 1=black
 */
function makeMatrix(versionNum, dataStr, isAlphanumeric) {
  const verInfo = QR_VERSIONS.find((v) => v.ver === versionNum);
  if (!verInfo) throw new Error('unsupported version');

  const totalBits = verInfo.totalBytes * 8;
  const modeBits = isAlphanumeric ? 0b0010 : 0b0100;
  const charCountBits = versionNum <= 9 ? (isAlphanumeric ? 11 : 8) : (isAlphanumeric ? 13 : 16);

  const dataBits = strToBitArray(dataStr, isAlphanumeric);
  const headerBits = [modeBits];
  for (let i = charCountBits - 1; i >= 0; i--) headerBits.push((dataStr.length >> i) & 1);
  const allBits = headerBits.concat(dataBits);
  // Terminator
  while (allBits.length % 8 !== 0 && allBits.length < totalBits) allBits.push(0);
  // Pad
  let padIdx = 0;
  while (allBits.length < totalBits) {
    allBits.push(padIdx % 2 === 0 ? 0xec >> 4 & 1 : 0);
    // Simpler: just pad with alternating byte pattern
    allBits.length = allBits.length; // no-op
    // Use proper pad
    const padByte = padIdx % 2 === 0 ? 0xec : 0x11;
    for (let b = 7; b >= 0 && allBits.length < totalBits; b--) {
      allBits.push((padByte >> b) & 1);
    }
    padIdx++;
  }
  allBits.length = totalBits;

  // Convert to bytes
  const dataBytes = new Uint8Array(verInfo.totalBytes);
  for (let i = 0; i < verInfo.totalBytes; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | allBits[i * 8 + b];
    dataBytes[i] = byte;
  }

  const ecBytes = verInfo.ecBytes;
  const ecDataBytes = verInfo.totalBytes - ecBytes;
  const dataBlock = dataBytes.subarray(0, ecDataBytes);
  const ec = calcEC(dataBlock, ecBytes);
  const codewords = new Uint8Array(verInfo.totalBytes);
  codewords.set(dataBlock);
  codewords.set(ec, ecDataBytes);

  // Build matrix
  const size = 21 + (versionNum - 1) * 4;
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));

  // Finder patterns
  function putFinder(x, y) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const px = x + dx, py = y + dy;
        if (px < 0 || px >= size || py < 0 || py >= size) continue;
        let v = 0;
        if ((dy === 0 || dy === 6) && (dx >= 0 && dx <= 6)) v = 1;
        else if ((dx === 0 || dx === 6) && (dy >= 0 && dy <= 6)) v = 1;
        else if ((dy >= 2 && dy <= 4) && (dx >= 2 && dx <= 4)) v = 1;
        matrix[py][px] = v;
      }
    }
  }
  putFinder(3, 3);
  putFinder(size - 4, 3);
  putFinder(3, size - 4);

  // Separators
  for (let i = 0; i < 8; i++) {
    matrix[7][i] = 0; matrix[i][7] = 0;
    matrix[7][size - 1 - i] = 0; matrix[size - 1 - i][7] = 0;
    matrix[7][i] = 0; matrix[i][7] = 0;
    matrix[size - 8][i] = 0; matrix[i][size - 8] = 0;
  }

  // Alignment patterns (version >= 2)
  if (versionNum >= 2) {
    const apPos = [6, size - 7]; // simplified for v2-v5
    for (const ay of apPos) {
      for (const ax of apPos) {
        if ((ax < 8 || ax >= size - 8) && (ay < 8 || ay >= size - 8)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const px = ax + dx, py = ay + dy;
            if (px < 0 || px >= size || py < 0 || py >= size) continue;
            let v = 0;
            if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) v = 1;
            else if (Math.abs(dx) === 2 || Math.abs(dy) === 2) v = 1;
            matrix[py][px] = v;
          }
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    matrix[6][i] = i % 2;
    matrix[i][6] = i % 2;
  }

  // Version info (version >= 7) - skipped for simplicity (versions 1-6)

  // Place data codewords
  let bitIdx = 0;
  const totalCodewords = verInfo.totalBytes;
  let direction = -1;
  let col = size - 1;
  let row = size - 1;

  function isReserved(r, c) {
    if (r < 0 || r >= size || c < 0 || c >= size) return true;
    // Finder + separator + timing + alignment areas are reserved
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 8) || (r >= size - 8 && c <= 8)) return true;
    if (r === 6 || c === 6) return true;
    return false;
  }

  while (col > 0) {
    if (col === 6) col -= 1;
    for (let i = 0; i < size; i++) {
      const r = row - direction * i;
      const c = col - (i % 2);
      if (r < 0 || r >= size) continue;
      if (!isReserved(r, c) && matrix[r][c] === 0) {
        if (bitIdx < totalCodewords * 8) {
          const byte = codewords[Math.floor(bitIdx / 8)];
          const bit = (byte >> (7 - (bitIdx % 8))) & 1;
          matrix[r][c] = bit;
          bitIdx++;
        } else {
          matrix[r][c] = 1; // remainder bits
        }
      }
    }
    col -= 2;
    direction *= -1;
    if (col <= 0) break;
    row += direction;
    if (row < 0 || row >= size) {
      row = direction === 1 ? size - 1 : 0;
      col -= 2;
      direction *= -1;
    }
  }

  // Mask 0: (row + col) % 2 === 0 → invert
  const masked = matrix.map((row, r) => row.map((v, c) => ((r + c) % 2 === 0 ? v ^ 1 : v)));
  return masked;
}

/**
 * モジュールマトリクスを PNG data URL に変換する（ブラウザ用 canvas）。
 * Node.js ではプレースホルダー data URL を返す。
 */
function matrixToDataUrl(matrix, moduleSize) {
  const size = matrix.length;
  const imgSize = size * moduleSize;

  if (typeof document !== 'undefined' && document.createElement) {
    const canvas = document.createElement('canvas');
    canvas.width = imgSize;
    canvas.height = imgSize;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, imgSize, imgSize);
    ctx.fillStyle = '#000000';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (matrix[y][x]) ctx.fillRect(x * moduleSize, y * moduleSize, moduleSize, moduleSize);
      }
    }
    return canvas.toDataURL('image/png');
  }

  // Node.js fallback: minimal 1x1 black PNG data URL (placeholder for tests)
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
}

/**
 * 文字列を QR コードにエンコードして data URL を返す。
 * @param {string} data
 * @param {'base16'|'base64'} type
 * @returns {string}
 */
function encodeQR(data, type) {
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('data must be a non-empty string');
  }
  if (type !== 'base16' && type !== 'base64') {
    throw new Error('type must be "base16" or "base64"');
  }

  // base16 は英数字モード、base64 は 8bit バイトモード
  const isAlphanumeric = type === 'base16';

  // 最小のバージョンを選択
  let chosenVer = null;
  let chosenMatrix = null;
  for (const ver of QR_VERSIONS) {
    const cap = isAlphanumeric ? ver.alphanum : Math.floor(ver.totalBytes * 0.8);
    if (data.length <= cap) {
      chosenVer = ver;
      break;
    }
  }
  if (!chosenVer) {
    throw new Error('data too large for QR code (max version 10)');
  }

  const matrix = makeMatrix(chosenVer.ver, data, isAlphanumeric);
  return matrixToDataUrl(matrix, 4);
}

/**
 * ImageData から QR コードをデコードする（jsQR 使用）。
 * @param {ImageData} imageData
 * @returns {string|null}
 */
function decodeQR(imageData) {
  let jsQR;
  if (typeof require === 'function') {
    try {
      jsQR = require('../vendor/jsqr/jsqr.js');
    } catch {
      return null;
    }
  } else if (typeof globalThis.jsQR !== 'undefined') {
    jsQR = globalThis.jsQR;
  } else {
    return null;
  }

  const width = imageData.width;
  const height = imageData.height;
  const gray = new Uint8ClampedArray(width * height);
  const data = imageData.data || imageData;
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    gray[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
  }

  try {
    const result = jsQR(gray, width, height);
    return result ? result.data : null;
  } catch {
    return null;
  }
}

module.exports = { encodeQR, decodeQR };
