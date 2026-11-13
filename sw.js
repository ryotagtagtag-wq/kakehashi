// sw.js – Kakehashi Service Worker
//
// 静的アセットのみをキャッシュし、オフライン動作を可能にする。
// 鍵サーバー（keys.openpgp.org）へのレスポンスはキャッシュ対象外。

const CACHE_NAME = 'kakehashi-v1';
const STATIC_ASSETS = [
  './',
  './app.html',
  './style.css',
  './src/chunk.js',
  './src/fingerprint.js',
  './src/qrcode.js',
  './src/paperkey.js',
  './src/restore.js',
  './src/fetch.js',
  './vendor/jsqr/jsqr.js',
  './vendor/paperkey/paperkey.js',
  './vendor/paperkey/paperkey.wasm',
];

// インストール: 静的アセットをキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

// アクティベーション: 古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      );
    })
  );
});

// フェッチ: キャッシュ優先、ネットワークフォールバック
// keys.openpgp.org へのリクエストはキャッシュせず、常にネットワークへ
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 鍵サーバーへのリクエストはキャッシュしない
  if (url.hostname === 'keys.openpgp.org') {
    event.respondWith(fetch(event.request));
    return;
  }

  // 静的アセットはキャッシュ優先
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(event.request).then((response) => {
        // ナビゲーションリクエストや非 GET はキャッシュしない
        if (event.request.method !== 'GET' || !response.ok) {
          return response;
        }
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });
        return response;
      }).catch(() => {
        // オフライン時、キャッシュにないリソースは失敗
        return new Response('オフラインです', { status: 503, statusText: 'Service Unavailable' });
      });
    })
  );
});
