/* Service Worker - السلسبيل
   - لا يخزّن أي طلب API أو دفع أو فيديو (دائماً من الشبكة)
   - الصفحات: الشبكة أولاً، وعند انقطاع الإنترنت تظهر صفحة offline.html
   - ملفات الواجهة (css/js/صور): تُعرض من الكاش وتتحدّث بالخلفية
   عند أي تعديل كبير غيّر رقم VERSION لتحديث الكاش عند الجميع */
const VERSION = 'v1';
const CACHE = 'salsabil-' + VERSION;
const PRECACHE = ['/offline.html', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('salsabil-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // طرف ثالث (Tap, Bunny, Fonts...) يمر مباشرة
  if (url.pathname.startsWith('/api/')) return;              // API والدفع: دائماً من الشبكة
  if (url.pathname.startsWith('/uploads/')) return;          // الفيديوهات: لا تُخزَّن
  if (req.headers.has('range')) return;                      // طلبات الفيديو/الصوت الجزئية

  // التنقل بين الصفحات
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }

  // ملفات الواجهة الثابتة
  if (['style', 'script', 'image', 'font'].includes(req.destination)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const fresh = fetch(req)
          .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
          .catch(() => cached);
        return cached || fresh;
      })
    );
  }
});
