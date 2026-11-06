const CACHE_NAME = 'arg-pwa-otomatis-v1';

const urlsToCache = [
    './',
    './index.html',
    './manifest.json',
    './animasi-menarik.gif',
    './icon-192.png',
    './icon-512.png'
];

// 1. Proses Install & Langsung Aktif (Skip Waiting)
self.addEventListener('install', (e) => {
    self.skipWaiting(); // Memaksa Service Worker baru langsung "menendang" yang lama
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
                    // Hapus cache yang namanya tidak sama dengan CACHE_NAME saat ini
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim()) // Langsung ambil alih kontrol halaman
    );
});

// 3. Strategi "Network First, fallback to Cache" (Internet Dulu, Baru Memori)
self.addEventListener('fetch', (e) => {
    e.respondWith(
        fetch(e.request)
            .then((response) => {
                // Jika berhasil dapat dari internet, simpan/perbarui salinannya di Cache
                if (response && response.status === 200) {
                    const resClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(e.request, resClone);
                    });
                }
                return response; // Tampilkan yang terbaru dari internet
            })
            .catch(() => {
                // Jika OFFLINE (tidak ada internet), ambil dari memori Cache
                return caches.match(e.request);
            })
    );
});
