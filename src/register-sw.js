if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  if (navigator.serviceWorker.controller) {
    let isReloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (isReloading) return;
      isReloading = true;
      location.reload();
    });
  }

  navigator.serviceWorker.register('./sw.js').catch((error) => {
    console.error('Service Worker の登録に失敗しました:', error);
  });
}
