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

/**
 * fetch.js – Kakehashi 取得ページのロジック
 *
 * keys.openpgp.org の Verifying Keyserver REST API から公開鍵を取得。
 * CSP: connect-src https://keys.openpgp.org のみ許可。
 * 取得結果は保存しない。送信するのはメールアドレスのみ。
 */

const { calculateFingerprint, InvalidArmoredKeyError, UnsupportedKeyVersionError } = fingerprint;

// ── 状態 ──
let currentKeys = []; // Array of { armored: string, fingerprint: string }

// ── DOM 要素 ──
const els = {
  emailInput: document.getElementById('email-input'),
  btnSearch: document.getElementById('btn-search'),
  searchStatus: document.getElementById('search-status'),
  resultsCount: document.getElementById('results-count'),
  keyList: document.getElementById('key-list'),
  armoredKeyDisplay: document.getElementById('armored-key-display'),
  keyFingerprint: document.getElementById('key-fingerprint'),
  btnDownloadKey: document.getElementById('btn-download-key'),
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
  currentKeys = [];
  els.emailInput.value = '';
  els.armoredKeyDisplay.value = '';
  els.keyFingerprint.textContent = '';
  els.keyList.innerHTML = '';
  showStep('search');
}

// ── 検索 ──
els.btnSearch.addEventListener('click', async () => {
  const email = els.emailInput.value.trim();
  if (!email) {
    els.searchStatus.textContent = 'メールアドレスを入力してください。';
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    els.searchStatus.textContent = '有効なメールアドレスを入力してください。';
    return;
  }

  els.btnSearch.disabled = true;
  els.searchStatus.textContent = '検索中...';

  try {
    const encodedEmail = encodeURIComponent(email);
    const url = `https://keys.openpgp.org/vks/v1/by-email/${encodedEmail}`;

    const response = await fetch(url);

    if (response.status === 404) {
      showError('該当する公開鍵が見つかりません。');
      return;
    }
    if (response.status === 410) {
      showError('公開鍵は存在しますが、所有者による確認が完了していません（未確認キー）。');
      return;
    }
    if (!response.ok) {
      showError(`サーバーエラー（HTTP ${response.status}）が発生しました。`);
      return;
    }

    const armoredText = await response.text();
    parseAndShowKeys(armoredText);

  } catch (err) {
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      showError('ネットワークエラーが発生しました。keys.openpgp.org に接続できません。');
    } else {
      showError('予期しないエラーが発生しました: ' + err.message);
    }
  } finally {
    els.btnSearch.disabled = false;
  }
});

function parseAndShowKeys(armoredText) {
  // Split into multiple PGP blocks if present
  const blocks = splitPGPBlocks(armoredText);
  currentKeys = [];

  for (const block of blocks) {
    if (!block.trim()) continue;
    try {
      const fp = calculateFingerprint(block);
      currentKeys.push({ armored: block.trim(), fingerprint: fp });
    } catch (err) {
      // Skip blocks that can't be parsed
      continue;
    }
  }

  if (currentKeys.length === 0) {
    showError('有効な公開鍵が見つかりませんでした。');
    return;
  }

  showResults();
}

function splitPGPBlocks(text) {
  const blocks = [];
  const lines = text.split(/\r?\n/);
  let currentBlock = null;
  let inBlock = false;

  for (const line of lines) {
    if (line.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----')) {
      inBlock = true;
      currentBlock = [line];
    } else if (line.startsWith('-----END PGP PUBLIC KEY BLOCK-----')) {
      if (inBlock && currentBlock) {
        currentBlock.push(line);
        blocks.push(currentBlock.join('\n'));
        currentBlock = null;
        inBlock = false;
      }
    } else if (inBlock) {
      currentBlock.push(line);
    }
  }

  return blocks;
}

function showResults() {
  els.resultsCount.textContent = `${currentKeys.length} 件の公開鍵が見つかりました。`;
  els.keyList.innerHTML = '';

  currentKeys.forEach((key, idx) => {
    const div = document.createElement('div');
    div.style.padding = '10px';
    div.style.border = '1px solid #ced4da';
    div.style.borderRadius = '4px';
    div.style.marginBottom = '10px';
    div.style.background = idx === 0 ? '#e9ecef' : '#fff';
    div.style.cursor = 'pointer';

    const shortFp = key.fingerprint.match(/.{4}/g).join(' ');
    div.innerHTML = `
      <strong>キー ${idx + 1}</strong><br>
      <code style="font-size:0.85em; color:#495057;">${shortFp}</code>
    `;

    div.addEventListener('click', () => {
      // Highlight selected
      Array.from(els.keyList.children).forEach((c, i) => {
        c.style.background = i === idx ? '#e9ecef' : '#fff';
      });
      showKeyDetail(idx);
    });

    els.keyList.appendChild(div);
  });

  // Auto-select first key
  if (currentKeys.length === 1) {
    showKeyDetail(0);
  }

  showStep('results');
}

function showKeyDetail(index) {
  const key = currentKeys[index];
  els.armoredKeyDisplay.value = key.armored;
  els.keyFingerprint.textContent = key.fingerprint.match(/.{4}/g).join(' ');
  showStep('key');
}

// ── ダウンロード ──
els.btnDownloadKey.addEventListener('click', () => {
  // Find currently selected key (first one displayed)
  const key = currentKeys[0];
  if (!key) return;

  const blob = new Blob([key.armored], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `openpgp-key-${key.fingerprint.substring(0, 16)}.asc`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ── リトライ ──
els.btnRetry.addEventListener('click', resetState);

// ── 初期化 ──
resetState();
