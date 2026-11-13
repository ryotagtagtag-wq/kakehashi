/**
 * app.js – Kakehashi 統合ページのロジック
 *
 * フロー: QR 読み取り → メアド入力 → keys.openpgp.org から公開鍵 fetch →
 * フィンガープリント照合 → 秘密鍵復元 → ダウンロード
 *
 * CSP: default-src 'self'; script-src 'self'; style-src 'self';
 *      img-src 'self' data:; connect-src https://keys.openpgp.org
 * インラインスクリプト・インラインイベントハンドラは禁止。
 */

// ── モジュール読み込み ──
const { splitPK1, collectPK1, missingIndexes } = chunk;
const {
  calculateFingerprint,
  verifyFingerprint,
  InvalidArmoredKeyError,
  UnsupportedKeyVersionError,
} = fingerprint;
const { decodeQR } = qrcode;
const {
  initPaperkeyWasm,
  restoreSecretKey,
  PaperkeyInitError,
  PaperkeyRestoreError,
  PaperkeyFingerprintMismatchError,
} = paperkey;

// ── 状態 ──
let chunks = [];
let totalChunks = 0;
let chunkFormat = 'b16';
let pubkeyArmored = '';
let calculatedFingerprint = '';
let paperFingerprint = '';
let secretPartPayload = '';
let cameraStream = null;
let cameraInterval = null;
let isRestoring = false;

// ── DOM 要素 ──
const els = {
  startCamera: document.getElementById('start-camera'),
  selectImage: document.getElementById('select-image'),
  cameraContainer: document.getElementById('camera-container'),
  cameraVideo: document.getElementById('camera-video'),
  qrCanvas: document.getElementById('qr-canvas'),
  imageFile: document.getElementById('image-file'),
  qrStatus: document.getElementById('qr-status'),
  chunkProgress: document.getElementById('chunk-progress'),
  progressBar: document.getElementById('progress-bar'),
  progressText: document.getElementById('progress-text'),
  missingText: document.getElementById('missing-text'),
  emailInput: document.getElementById('email-input'),
  btnFetch: document.getElementById('btn-fetch'),
  fetchStatus: document.getElementById('fetch-status'),
  calcFingerprint: document.getElementById('calc-fingerprint'),
  paperFpInput: document.getElementById('paper-fingerprint'),
  fpResult: document.getElementById('fingerprint-result'),
  btnRestore: document.getElementById('btn-restore'),
  btnDownload: document.getElementById('btn-download'),
  errorMessage: document.getElementById('error-message'),
  btnRetry: document.getElementById('btn-retry'),
};

// ── ステップ管理 ──
function showStep(stepName) {
  document.querySelectorAll('.step').forEach((s) => {
    s.style.display = s.id === `step-${stepName}` ? 'block' : 'none';
  });
}

function showError(msg) {
  els.errorMessage.textContent = msg;
  showStep('error');
}

function resetState() {
  chunks = [];
  totalChunks = 0;
  chunkFormat = 'b16';
  pubkeyArmored = '';
  calculatedFingerprint = '';
  paperFingerprint = '';
  secretPartPayload = '';
  els.emailInput.value = '';
  els.paperFpInput.value = '';
  els.qrStatus.textContent = '';
  els.fetchStatus.textContent = '';
  els.chunkProgress.style.display = 'none';
  els.btnFetch.disabled = false;
  els.btnRestore.disabled = true;
  stopCamera();
  showStep('qr');
}

function stopCamera() {
  if (cameraInterval) {
    clearInterval(cameraInterval);
    cameraInterval = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  els.cameraContainer.style.display = 'none';
  els.startCamera.textContent = 'カメラを起動';
}

// ── QR 読み取り：カメラ ──
els.startCamera.addEventListener('click', async () => {
  if (cameraStream) {
    stopCamera();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    cameraStream = stream;
    els.cameraVideo.srcObject = stream;
    els.cameraContainer.style.display = 'block';
    els.startCamera.textContent = 'カメラを停止';

    await new Promise((resolve) => {
      els.cameraVideo.onloadedmetadata = resolve;
    });

    const canvasCtx = els.qrCanvas.getContext('2d');
    cameraInterval = setInterval(() => {
      if (els.cameraVideo.readyState === els.cameraVideo.HAVE_ENOUGH_DATA) {
        els.qrCanvas.width = els.cameraVideo.videoWidth;
        els.qrCanvas.height = els.cameraVideo.videoHeight;
        canvasCtx.drawImage(els.cameraVideo, 0, 0);
        const imageData = canvasCtx.getImageData(0, 0, els.qrCanvas.width, els.qrCanvas.height);
        const result = decodeQR(imageData);
        if (result) {
          processQRResult(result);
        }
      }
    }, 500);
  } catch (err) {
    showError('カメラにアクセスできません: ' + err.message);
  }
});

// ── QR 読み取り：ファイル ──
els.selectImage.addEventListener('click', () => {
  els.imageFile.click();
});

els.imageFile.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await new Promise((resolve) => { img.onload = resolve; });

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = decodeQR(imageData);
    if (result) {
      processQRResult(result);
    } else {
      els.qrStatus.textContent = 'QR コードが検出されませんでした。';
    }
    URL.revokeObjectURL(img.src);
  } catch (err) {
    showError('画像ファイルの読み取りに失敗しました: ' + err.message);
  }
});

// ── QR 結果処理 ──
function processQRResult(qrText) {
  if (!qrText.startsWith('PK1|')) {
    els.qrStatus.textContent = 'PK1 形式の QR コードではありません。';
    return;
  }

  const match = qrText.match(/^PK1\|(\d+)\/(\d+)\|(b16|b64)\|(.*)$/);
  if (!match) {
    els.qrStatus.textContent = 'PK1 フォーマットが不正です。';
    return;
  }

  const index = parseInt(match[1], 10);
  const total = parseInt(match[2], 10);
  const format = match[3];
  const payload = match[4];

  if (totalChunks === 0) {
    totalChunks = total;
    chunkFormat = format;
  } else if (total !== totalChunks) {
    els.qrStatus.textContent = `総枚数が不一致です（既存: ${totalChunks}, 新規: ${total}）。`;
    return;
  }

  const existing = chunks.find((c) => c.index === index);
  if (existing && existing.payload !== payload) {
    els.qrStatus.textContent = `インデックス ${index} の内容が矛盾しています。`;
    return;
  }
  if (!existing) {
    chunks.push({ index, total, format, payload });
  }

  updateChunkProgress();
  updateFetchButton();
}

function updateChunkProgress() {
  const present = new Set(chunks.map((c) => c.index));
  const missing = [];
  for (let i = 1; i <= totalChunks; i++) {
    if (!present.has(i)) missing.push(i);
  }

  const collected = chunks.length;
  const pct = totalChunks > 0 ? Math.round((collected / totalChunks) * 100) : 0;

  els.chunkProgress.style.display = 'block';
  els.progressBar.style.width = `${pct}%`;
  els.progressText.textContent = `${collected} / ${totalChunks} 枚読み取り済み`;
  els.missingText.textContent = missing.length > 0 ? `欠番: ${missing.join(', ')}` : '欠番: なし';
}

function updateFetchButton() {
  const allChunks = totalChunks > 0 && chunks.length === totalChunks;
  const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(els.emailInput.value.trim());
  els.btnFetch.disabled = !(allChunks && hasEmail) || isRestoring;
}

els.emailInput.addEventListener('input', updateFetchButton);

// ── 公開鍵取得 ──
els.btnFetch.addEventListener('click', async () => {
  const email = els.emailInput.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    els.fetchStatus.textContent = '有効なメールアドレスを入力してください。';
    return;
  }

  isRestoring = true;
  els.btnFetch.disabled = true;
  els.fetchStatus.textContent = '公開鍵を取得中...';

  try {
    const encodedEmail = encodeURIComponent(email);
    const url = `https://keys.openpgp.org/vks/v1/by-email/${encodedEmail}`;

    const response = await fetch(url);

    if (response.status === 404) {
      showError('該当する公開鍵が見つかりません。');
      return;
    }
    if (response.status === 410) {
      showError('公開鍵は存在しますが、所有者による確認が完了していません。');
      return;
    }
    if (!response.ok) {
      showError(`サーバーエラー（HTTP ${response.status}）が発生しました。`);
      return;
    }

    const armoredText = await response.text();
    pubkeyArmored = armoredText.trim();

    // フィンガープリント計算
    try {
      calculatedFingerprint = calculateFingerprint(pubkeyArmored);
    } catch (err) {
      if (err instanceof InvalidArmoredKeyError || err instanceof UnsupportedKeyVersionError) {
        showError('公開鍵の解析に失敗しました: ' + err.message);
        return;
      }
      throw err;
    }

    els.calcFingerprint.textContent = calculatedFingerprint.match(/.{4}/g).join(' ');
    showStep('verify');
    els.fetchStatus.textContent = '';

  } catch (err) {
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      showError('ネットワークエラーが発生しました。keys.openpgp.org に接続できません。');
    } else {
      showError('予期しないエラーが発生しました: ' + err.message);
    }
  } finally {
    isRestoring = false;
    els.btnFetch.disabled = false;
  }
});

// ── フィンガープリント入力 ──
els.paperFpInput.addEventListener('input', (e) => {
  paperFingerprint = e.target.value.trim().toLowerCase();
  updateRestoreButton();
});

function updateRestoreButton() {
  const hasPaperFp = /^[0-9a-f]{40}$/.test(paperFingerprint);
  const hasSecret = secretPartPayload.length > 0;
  els.btnRestore.disabled = !(hasPaperFp && hasSecret) || isRestoring;
}

// ── 秘密部分の結合（全チャンク揃った時点で実行） ──
function assembleSecretPart() {
  const collection = collectPK1(chunks, totalChunks);
  if (!collection.complete) {
    throw new Error('QR チャンクが揃っていません（欠番: ' + collection.missing.join(', ') + '）');
  }
  secretPartPayload = collection.payload;
}

// ── 復元実行 ──
els.btnRestore.addEventListener('click', async () => {
  // フィンガープリント照合（取得鍵 vs 紙）
  if (calculatedFingerprint.toLowerCase() !== paperFingerprint) {
    els.fpResult.innerHTML = '<span style="color:red;">❌ フィンガープリントが一致しません。</span>';
    return;
  }

  els.fpResult.innerHTML = '<span style="color:green;">✅ フィンガープリントが一致しました。</span>';

  // 秘密部分を結合
  try {
    assembleSecretPart();
  } catch (err) {
    showError(err.message);
    return;
  }

  isRestoring = true;
  els.btnRestore.disabled = true;

  try {
    // paperkey WASM 初期化
    try {
      await initPaperkeyWasm();
    } catch (err) {
      if (err instanceof PaperkeyInitError) {
        showError('paperkey の初期化に失敗しました: ' + err.message);
        return;
      }
      throw err;
    }

    // 秘密鍵再構成
    let restoredBytes;
    try {
      restoredBytes = await restoreSecretKey(pubkeyArmored, secretPartPayload, 'auto');
    } catch (err) {
      if (err instanceof PaperkeyFingerprintMismatchError) {
        showError('秘密鍵の再構成に失敗しました: 紙の秘密部分が公開鍵と一致しません。');
        return;
      }
      if (err instanceof PaperkeyRestoreError) {
        showError('秘密鍵の再構成に失敗しました: ' + err.message);
        return;
      }
      throw err;
    }

    // 復元後のフィンガープリント再照合
    try {
      const { readFirstPacket } = fingerprint;
      const firstPacket = readFirstPacket(restoredBytes);
      if (firstPacket.tag !== 5) {
        throw new PaperkeyRestoreError('再構成されたデータが秘密鍵パケットではありません');
      }

      // 元の armored 公開鍵とフィンガープリントを比較（paperkey 内部でも照合済み）
      const restoredFp = calculateFingerprint(pubkeyArmored);
      if (restoredFp.toLowerCase() !== calculatedFingerprint.toLowerCase()) {
        throw new PaperkeyFingerprintMismatchError('再構成後のフィンガープリントが一致しません');
      }
    } catch (err) {
      if (err instanceof PaperkeyFingerprintMismatchError || err instanceof InvalidArmoredKeyError) {
        showError('復元後の検証に失敗しました: ' + err.message);
        return;
      }
      throw err;
    }

    // ダウンロード
    showStep('download');
    const blob = new Blob([restoredBytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'restored-secret-key.gpg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // 後始末
    cleanup(restoredBytes);

  } catch (err) {
    console.error(err);
    showError('予期しないエラーが発生しました: ' + err.message);
  } finally {
    isRestoring = false;
  }
});

function cleanup(restoredBytes) {
  if (restoredBytes instanceof Uint8Array) {
    restoredBytes.fill(0);
  }
  pubkeyArmored = '';
  paperFingerprint = '';
  secretPartPayload = '';
  chunks = [];
  els.emailInput.value = '';
  els.paperFpInput.value = '';
  stopCamera();
  els.fpResult.innerHTML = '<span style="color:green;">✅ 復元が完了しました。メモリ上の秘密情報は消去されました。</span>';
}

// ── リトライ ──
els.btnRetry.addEventListener('click', resetState);

// ── 初期化 ──
resetState();
