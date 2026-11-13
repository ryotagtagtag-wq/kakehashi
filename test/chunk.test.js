import { test } from 'node:test';
import assert from 'node:assert';
import {
  splitPK1,
  collectPK1,
  missingIndexes,
  InvalidChunkError,
  DuplicateIndexConflictError,
  MissingIndexesError,
} from '../src/chunk.js';

function makePayload(length) {
  return Array.from({ length }, (_, i) => i.toString(36)).join('');
}

// 1. splitPK1 basic split
test('splitPK1 basic split', () => {
  const payload = makePayload(10);
  const total = 3;
  const chunks = splitPK1(payload, total, 'b16');
  assert.strictEqual(chunks.length, total);
  for (const c of chunks) {
    assert.strictEqual(c.index, chunks.find((x) => x.index === c.index).index);
    assert.strictEqual(c.total, total);
    assert.strictEqual(c.format, 'b16');
  }
  // verify concatenation
  let combined = '';
  for (const c of chunks) combined += c.payload;
  assert.strictEqual(combined, payload);
  // verify lengths
  const baseLen = Math.floor(payload.length / total);
  const extra = payload.length % total;
  let expectedStart = 0;
  for (let i = 1; i <= total; i++) {
    const expectedLen = baseLen + (i <= extra ? 1 : 0);
    assert.strictEqual(chunks[i - 1].payload.length, expectedLen);
    expectedStart += expectedLen;
  }
});

// 2. splitPK1 b64 format
test('splitPK1 b64 format', () => {
  const payload = makePayload(8);
  const total = 4;
  const chunks = splitPK1(payload, total, 'b64');
  assert.strictEqual(chunks.length, total);
  for (const c of chunks) {
    assert.strictEqual(c.format, 'b64');
  }
  let combined = '';
  for (const c of chunks) combined += c.payload;
  assert.strictEqual(combined, payload);
});

// 3. splitPK1 error cases
test('splitPK1 invalid format throws', () => {
  const payload = makePayload(5);
  assert.throws(() => splitPK1(payload, 2, 'b32'), InvalidChunkError);
});

test('splitPK1 invalid total throws', () => {
  const payload = makePayload(5);
  assert.throws(() => splitPK1(payload, 0, 'b16'), InvalidChunkError);
  assert.throws(() => splitPK1(payload, -1, 'b16'), InvalidChunkError);
});

test('splitPK1 payload too short throws', () => {
  const payload = 'a';
  assert.throws(() => splitPK1(payload, 2, 'b16'), InvalidChunkError);
});

// 4. collectPK1 order independence
test('collectPK1 order independent', () => {
  const payload = makePayload(12);
  const total = 4;
  const chunks = splitPK1(payload, total, 'b16');
  // shuffle order
  const shuffled = [...chunks];
  for (let i = 0; i < shuffled.length; i++) {
    const j = Math.floor(Math.random() * shuffled.length);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const result = collectPK1(shuffled, total);
  assert.strictEqual(result.complete, true);
  assert.strictEqual(result.missing.length, 0);
  // reconstruct original payload
  let reconstructed = '';
  for (const c of chunks) reconstructed += c.payload;
  assert.strictEqual(result.payload, reconstructed);
});

// 5. collectPK1 duplicate index same payload allowed
test('collectPK1 duplicate index same payload', () => {
  const payload = makePayload(6);
  const total = 3;
  const chunks = splitPK1(payload, total, 'b16');
  // add duplicate with same payload
  const extra = { index: 2, total, format: 'b16', payload: chunks[1].payload };
  const result = collectPK1([...chunks, extra], total);
  assert.strictEqual(result.complete, true);
  assert.strictEqual(result.missing.length, 0);
});

// 6. collectPK1 duplicate index different payload throws
test('collectPK1 duplicate index conflict throws', () => {
  const payload1 = makePayload(5);
  const payload2 = makePayload(5) + 'x';
  const total = 2;
  const chunk1 = { index: 1, total, format: 'b16', payload: payload1 };
  const chunk2 = { index: 1, total, format: 'b16', payload: payload2 };
  assert.throws(() => collectPK1([chunk1, chunk2], total), DuplicateIndexConflictError);
});

// 7. collectPK1 missing indexes
test('collectPK1 missing indexes', () => {
  const payload = makePayload(9);
  const total = 5;
  const chunks = splitPK1(payload, total, 'b16');
  // remove index 3 and 5
  const missingChunks = chunks.filter((c) => c.index !== 3 && c.index !== 5);
  const result = collectPK1(missingChunks, total);
  assert.strictEqual(result.complete, false);
  assert.deepStrictEqual(result.missing.sort(), [3, 5]);
  assert.strictEqual(result.payload, '');
});

// 8. missingIndexes function
test('missingIndexes function', () => {
  const payload = makePayload(7);
  const total = 4;
  const chunks = splitPK1(payload, total, 'b16');
  // remove index 2 and 4
  const missingChunks = chunks.filter((c) => c.index !== 2 && c.index !== 4);
  const missing = missingIndexes(missingChunks, total);
  assert.deepStrictEqual(missing.sort(), [2, 4]);
});

// 9. missingIndexes none missing
test('missingIndexes none missing', () => {
  const payload = makePayload(3);
  const total = 3;
  const chunks = splitPK1(payload, total, 'b16');
  const missing = missingIndexes(chunks, total);
  assert.deepStrictEqual(missing, []);
});

console.log('All chunk tests passed.');