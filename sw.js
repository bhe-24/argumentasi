const CACHE_NAME = 'arg-pwa-otomatis-v5';

const urlsToCache = [
    './',
    './manifest.json',
    './animasi-menarik.gif',
    './icon-192.png',
    './icon-512.png',
    './notifikasi.js'
];

// 1. Proses Install & Langsung Aktif (Skip Waiting)
self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return Promise.all(
                urlsToCache.map((u) =>
                    fetch(new Request(u, { cache: 'no-cache' }))
                        .then((res) => {
                            if (res && res.status === 200 && !res.redirected) {
                                return cache.put(u, res);
                            }
                        })
                        .catch(() => {})
                )
            );
        })
    );
});

// 2. Proses Aktivasi & Bersih-bersih Cache Lama
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// 3. Strategi "Network First, fallback to Cache" (Internet Dulu, Baru Memori)
// PENTING: Gunakan fetch(e.request) langsung agar request navigasi (redirect: 'manual')
// tidak pernah mengembalikan response dengan redirected === true pada Vercel cleanUrls (308),
// yang menyebabkan Chrome menggagalkan navigasi dengan ERR_FAILED.
self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;

    const url = new URL(e.request.url);
    if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.pathname.startsWith('/api/') ||
        url.hostname.includes('firestore.googleapis.com') ||
        url.pathname === '/admin' ||
        url.pathname.startsWith('/admin/')
    ) {
        return;
    }

    e.respondWith(
        fetch(e.request)
            .then((response) => {
                if (response && response.status === 200 && !response.redirected) {
                    const resClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        return cache.put(e.request, resClone);
                    }).catch(() => {});
                }
                return response;
            })
            .catch(async () => {
                const cached = await caches.match(e.request);
                if (cached && !cached.redirected) {
                    return cached;
                }

                if (e.request.mode === 'navigate' && url.origin === self.location.origin) {
                    if (url.pathname === '/index.html' || url.pathname.endsWith('/index.html')) {
                        const rootUrl = new URL('./', self.location.href);
                        const rootCached = await caches.match(rootUrl.href);
                        if (rootCached && !rootCached.redirected) return rootCached;
                    } else if (url.pathname.endsWith('.html')) {
                        const cleanUrl = new URL(url.href);
                        cleanUrl.pathname = cleanUrl.pathname.slice(0, -5);
                        const cleanCached = await caches.match(cleanUrl.href);
                        if (cleanCached && !cleanCached.redirected) return cleanCached;
                    }

                    const fallbackHome = await caches.match(new URL('./', self.location.href).href);
                    if (fallbackHome && !fallbackHome.redirected) return fallbackHome;
                }

                return (cached && !cached.redirected) ? cached : Response.error();
            })
    );
});

// 4. Penanganan Notifikasi Ponsel (PWA Push & Click Handler)
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url)
        ? event.notification.data.url
        : './';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if (client.url && 'focus' in client) {
                    client.focus();
                    if ('navigate' in client) {
                        return client.navigate(targetUrl);
                    }
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});

// 5. Listener Pesan dari Client untuk memicu notifikasi latar belakang
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
        const { title, options } = event.data;
        self.registration.showNotification(title, options);
    }
});
