// Chunk.js – PK1 分割・結合ユーティリティ

// エラークラス
class InvalidChunkError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'InvalidChunkError';
  }
}
class DuplicateIndexConflictError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'DuplicateIndexConflictError';
  }
}
class MissingIndexesError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'MissingIndexesError';
  }
}

/**
 * PK1 チャンクのインターフェース
 * @typedef {Object} Chunk
 * @property {number} index  // 1 始まりの連番整数
 * @property {number} total  // 総枚数
 * @property {'b16'|'b64'} format
 * @property {string} payload
 */

/**
 * PK1 フォーマット文字列から total 枚のChunk に分割
 * @param {string} payload - エンコード済みペイロード (base16 または base64)
 * @param {number} total - 分割したい総枚数 (1 以上)
 * @param {'b16'|'b64'} format - エンコード形式
 * @returns {Chunk[]} 分割後のチャンク配列
 * @throws {InvalidChunkError} フォーマットや引数が不正な場合
 */
function splitPK1(payload, total, format) {
  // 引数検証
  if (typeof payload !== 'string') {
    throw new InvalidChunkError('payload must be a string');
  }
  if (!Number.isInteger(total) || total <= 0) {
    throw new InvalidChunkError('total must be a positive integer');
  }
  if (!['b16', 'b64'].includes(format)) {
    throw new InvalidChunkError('format must be "b16" or "b64"');
  }
  if (total > payload.length) {
    throw new InvalidChunkError('total cannot be greater than payload length');
  }

  const chunks = [];
  const baseLength = Math.floor(payload.length / total);
  const extra = payload.length % total; // 余分な文字は先頭から分配

  let start = 0;
  for (let i = 1; i <= total; i++) {
    const chunkSize = baseLength + (i <= extra ? 1 : 0);
    const slice = payload.slice(start, start + chunkSize);
    chunks.push({
      index: i,
      total,
      format,
      payload: slice,
    });
    start += chunkSize;
  }

  return chunks;
}

/**
 * 順不同のチャンクを検証・結合
 * @param {Chunk[]} chunks - 分割されたチャンクの配列 (順序不問)
 * @param {number} total - 総枚数 (must match)
 * @returns {CollectionResult}
 *          complete: true  => 全部揃っていて結合成功
 *          complete: false => 欠番がある (missing にインデックスが入る)
 */
function collectPK1(chunks, total) {
  if (!Array.isArray(chunks) || total <= 0) {
    throw new InvalidChunkError('chunks must be an array and total must be positive integer');
  }

  const map = new Map(); // index -> {payload, format}
  const formatFromFirst = chunks.length > 0 ? chunks[0].format : 'b16'; // default to b16 if empty

  // 検証と重複チェック
  for (const chunk of chunks) {
    if (typeof chunk.index !== 'number' || chunk.index < 1 || chunk.index > total) {
      throw new InvalidChunkError(`chunk index ${chunk.index} out of range 1..${total}`);
    }
    if (chunk.format !== formatFromFirst) {
      throw new InvalidChunkError(`chunk format ${chunk.format} does not match expected ${formatFromFirst}`);
    }
    if (map.has(chunk.index)) {
      const existing = map.get(chunk.index);
      if (existing.payload !== chunk.payload) {
        throw new DuplicateIndexConflictError(
          `index ${chunk.index} has conflicting payloads`
        );
      }
      // same payload, same format – ignore
    } else {
      map.set(chunk.index, { payload: chunk.payload, format: formatFromFirst });
    }
  }

  // 欠番チェック
  const missing = [];
  for (let i = 1; i <= total; i++) {
    if (!map.has(i)) missing.push(i);
  }

  // 結合 (complete が false の場合は payload を空にする)
  let payload = '';
  if (missing.length === 0) {
    // すべて揃っているので順に結合
    for (let i = 1; i <= total; i++) {
      const entry = map.get(i);
      payload += entry.payload;
    }
  }

  return {
    complete: missing.length === 0,
    missing,
    payload,
    format: formatFromFirst,
  };
}

/**
 * 欠番インデックスを列挙
 * @param {Chunk[]} chunks - 分割されたチャンクの配列
 * @param {number} total - 総枚数
 * @returns {number[]} 欠損しているインデックスのリスト (1 から total まで)
 */
function missingIndexes(chunks, total) {
  if (!Array.isArray(chunks) || total <= 0) {
    throw new InvalidChunkError('chunks must be an array and total must be positive integer');
  }

  const present = new Set();
  for (const chunk of chunks) {
    if (typeof chunk.index === 'number' && chunk.index >= 1 && chunk.index <= total) {
      present.add(chunk.index);
    }
  }

  const missing = [];
  for (let i = 1; i <= total; i++) {
    if (!present.has(i)) missing.push(i);
  }
  return missing;
}

// エクスポート (CommonJS)
module.exports = {
  splitPK1,
  collectPK1,
  missingIndexes,
  // エラークラスもエクスポートしておくと便利
  InvalidChunkError,
  DuplicateIndexConflictError,
  MissingIndexesError,
};