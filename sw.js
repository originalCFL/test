// ── 方位俯仰計算器 Service Worker v4.0 ──
// 負責離線快取所有必要資源，讓 App 在無網路時也能正常運作

const CACHE_NAME = 'bearing-calc-v4';
const ELEVATION_CACHE = 'bearing-elev-v1';  // 高度 API 回應獨立快取

// 核心資源：首次安裝時預先快取
const PRECACHE_URLS = [
  './index.html',
  './manifest.json',
  // Google Fonts CSS（若失敗則離線用系統字型）
  'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Share+Tech+Mono&display=swap'
];

// ── Install：預先快取核心資源 ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // 字型 CSS 允許失敗（離線安裝時可能無法取得）
      const fontUrl = 'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Share+Tech+Mono&display=swap';
      const coreUrls = ['./index.html', './manifest.json'];
      return Promise.all([
        cache.addAll(coreUrls),
        cache.add(fontUrl).catch(() => {
          console.info('[SW] 字型 CSS 快取失敗（可能離線安裝），將在首次上線時自動快取');
        })
      ]);
    }).then(() => self.skipWaiting())
  );
});

// ── Activate：清除舊快取 ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== ELEVATION_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch：攔截所有請求 ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. 高度 API（open-meteo）：網路優先，快取備援，離線時回傳特殊標記
  if (url.hostname === 'api.open-meteo.com') {
    event.respondWith(handleElevationRequest(event.request));
    return;
  }

  // 2. Google Fonts：快取優先（字型幾乎不變動）
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(event.request, CACHE_NAME));
    return;
  }

  // 3. 其他同源請求：快取優先（主要是 index.html / manifest.json）
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(event.request, CACHE_NAME));
    return;
  }

  // 4. 其他外部請求：直接走網路
  // （例如 Google Forms 連結等，不攔截）
});

// ── 高度 API 策略：網路優先 → 快取 → 離線回應 ──
async function handleElevationRequest(request) {
  const url = request.url;

  // 先試網路
  try {
    const networkRes = await fetch(request.clone(), { signal: AbortSignal.timeout(8000) });
    if (networkRes.ok) {
      // 快取成功的回應
      const cache = await caches.open(ELEVATION_CACHE);
      cache.put(request, networkRes.clone());
      return networkRes;
    }
  } catch (_) {
    // 網路失敗，繼續往下
  }

  // 試快取
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  // 完全無法取得：回傳 JSON 讓主程式知道是離線狀態
  return new Response(
    JSON.stringify({ elevation: null, _offline: true }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-SW-Offline': 'true' }
    }
  );
}

// ── 快取優先策略 ──
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const networkRes = await fetch(request);
    if (networkRes.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkRes.clone());
    }
    return networkRes;
  } catch (e) {
    // 若是 HTML 頁面，回傳快取的 index.html
    if (request.destination === 'document') {
      const fallback = await caches.match('./index.html');
      if (fallback) return fallback;
    }
    throw e;
  }
}
