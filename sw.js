const CACHE_NAME = 'arg-pwa-otomatis-v2';

const urlsToCache = [
    './',
    './index.html',
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
            return cache.addAll(urlsToCache);
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
self.addEventListener('fetch', (e) => {
    // Jangan cache request API serverless atau firebase
    if (e.request.url.includes('/api/') || e.request.url.includes('firestore.googleapis.com')) {
        return;
    }

    e.respondWith(
        fetch(e.request)
            .then((response) => {
                if (response && response.status === 200 && e.request.method === 'GET') {
                    const resClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(e.request, resClone);
                    });
                }
                return response;
            })
            .catch(() => {
                return caches.match(e.request);
            })
    );
});

// 4. Penanganan Notifikasi Ponsel (PWA Push & Click Handler)
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) 
        ? event.notification.data.url 
        : './index.html';
    
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
