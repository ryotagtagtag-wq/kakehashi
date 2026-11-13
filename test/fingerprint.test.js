const { test, describe } = require('node:test');
const { strict: assert } = require('node:assert');
const {
  calculateFingerprint,
  verifyFingerprint,
  UnsupportedKeyVersionError,
  FingerprintMismatchError,
  InvalidArmoredKeyError,
} = require('../src/fingerprint.js');

/**
 * 旧形式 OpenPGP パケットヘッダを付与してアーマー化する。
 * 公開鍵パケット (tag 6)、1オクテット長形式。
 * @param {Buffer} body - パケットボディ（バージョンから始まる）
 * @returns {string} ASCII アーマー公開鍵
 */
function makeArmoredKey(body) {
  const tag = 6;
  const lengthType = 0; // 1オクテット長
  const firstOctet = 0x80 | (tag << 2) | lengthType; // 10TTLLLL
  const packet = Buffer.concat([
    Buffer.from([firstOctet, body.length]),
    body,
  ]);
  const b64 = packet.toString('base64');
  return `-----BEGIN PGP PUBLIC KEY BLOCK-----\nVersion: OpenPGP\n\n${b64}\n-----END PGP PUBLIC KEY BLOCK-----`;
}

describe('calculateFingerprint', () => {
  test('empty string throws InvalidArmoredKeyError', () => {
    assert.throws(() => calculateFingerprint(''), InvalidArmoredKeyError);
  });

  test('whitespace-only string throws InvalidArmoredKeyError', () => {
    assert.throws(() => calculateFingerprint('   \n  '), InvalidArmoredKeyError);
  });

  test('valid v4 packet returns 40-char hex fingerprint', () => {
    const body = Buffer.from([
      0x04, // version 4
      0x00, 0x00, 0x00, 0x00, // creation time
      0x01, // RSA
      0x00, 0x10, 0xaa, 0xbb, 0x00, 0x10, 0xcc, 0xdd, // dummy MPI
    ]);
    const armoredKey = makeArmoredKey(body);
    const fp = calculateFingerprint(armoredKey);
    assert.strictEqual(typeof fp, 'string');
    assert.strictEqual(fp.length, 40);
    assert.ok(/^[0-9a-f]{40}$/.test(fp), `fingerprint should be 40 hex chars, got: ${fp}`);
  });

  test('same key produces same fingerprint', () => {
    const body = Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x10, 0xaa, 0xbb]);
    const armoredKey = makeArmoredKey(body);
    assert.strictEqual(calculateFingerprint(armoredKey), calculateFingerprint(armoredKey));
  });

  test('different keys produce different fingerprints', () => {
    const body1 = Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x10, 0xaa, 0xbb]);
    const body2 = Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x10, 0xcc, 0xdd]);
    const k1 = makeArmoredKey(body1);
    const k2 = makeArmoredKey(body2);
    assert.notStrictEqual(calculateFingerprint(k1), calculateFingerprint(k2));
  });

  test('unsupported version throws UnsupportedKeyVersionError', () => {
    const body = Buffer.from([0x07, 0x00, 0x00, 0x00, 0x00, 0x01]); // version 7
    const armoredKey = makeArmoredKey(body);
    assert.throws(() => calculateFingerprint(armoredKey), UnsupportedKeyVersionError);
  });

  test('non-public-key packet tag throws InvalidArmoredKeyError', () => {
    // tag 1 = symmetric-key encrypted session key packet, not public key (tag 6)
    const body = Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00]);
    const tag = 1;
    const lengthType = 0;
    const firstOctet = 0x80 | (tag << 2) | lengthType;
    const packet = Buffer.concat([
      Buffer.from([firstOctet, body.length]),
      body,
    ]);
    const b64 = packet.toString('base64');
    const armoredKey = `-----BEGIN PGP PUBLIC KEY BLOCK-----\nVersion: OpenPGP\n\n${b64}\n-----END PGP PUBLIC KEY BLOCK-----`;
    assert.throws(() => calculateFingerprint(armoredKey), InvalidArmoredKeyError);
  });
});

describe('verifyFingerprint', () => {
  test('identical fingerprints return true', () => {
    const body = Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x10, 0xaa, 0xbb]);
    const armoredKey = makeArmoredKey(body);
    const fp = calculateFingerprint(armoredKey);
    assert.strictEqual(verifyFingerprint(fp, fp), true);
  });

  test('different fingerprints throw FingerprintMismatchError', () => {
    const body1 = Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x10, 0xaa, 0xbb]);
    const body2 = Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x10, 0xcc, 0xdd]);
    const k1 = makeArmoredKey(body1);
    const k2 = makeArmoredKey(body2);
    const fp1 = calculateFingerprint(k1);
    const fp2 = calculateFingerprint(k2);
    assert.notStrictEqual(fp1, fp2);
    assert.throws(() => verifyFingerprint(fp1, fp2), FingerprintMismatchError);
  });

  test('case-insensitive comparison', () => {
    const body = Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x10, 0xaa, 0xbb]);
    const armoredKey = makeArmoredKey(body);
    const fp = calculateFingerprint(armoredKey);
    assert.strictEqual(verifyFingerprint(fp, fp.toUpperCase()), true);
  });
});
