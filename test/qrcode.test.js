const { test, describe } = require('node:test');
const { strict: assert } = require('node:assert');
const { encodeQR, decodeQR } = require('../src/qrcode.js');

describe('encodeQR', () => {
  test('base16 type returns data URL', () => {
    const result = encodeQR('0123456789ABCDEF', 'base16');
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.startsWith('data:image/png;base64,'));
  });

  test('base64 type returns data URL', () => {
    const result = encodeQR('SGVsbG8gV29ybGQ=', 'base64');
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.startsWith('data:image/png;base64,'));
  });

  test('empty string throws', () => {
    assert.throws(() => encodeQR('', 'base16'), /non-empty/);
  });

  test('invalid type throws', () => {
    assert.throws(() => encodeQR('test', 'base32'), /base16/);
  });

  test('base16 with only 0-9A-F chars', () => {
    const result = encodeQR('DEADBEEFCAFEBABE', 'base16');
    assert.ok(result.startsWith('data:image/png;base64,'));
  });
});

describe('decodeQR', () => {
  test('decodeQR returns null when jsQR not available (Node.js)', () => {
    // Create minimal ImageData-like object
    const imageData = {
      width: 10,
      height: 10,
      data: new Uint8ClampedArray(10 * 10 * 4).fill(255),
    };
    const result = decodeQR(imageData);
    // In Node.js without a real QR code image, should return null
    assert.strictEqual(result, null);
  });

  test('decodeQR accepts ImageData with data property', () => {
    const imageData = {
      width: 10,
      height: 10,
      data: new Uint8ClampedArray(10 * 10 * 4).fill(0),
    };
    const result = decodeQR(imageData);
    assert.strictEqual(result, null);
  });
});
