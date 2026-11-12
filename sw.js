const CACHE_NAME = 'arg-pwa-otomatis-v6';
const LATIHAN_DB = 'latihan-db';
const LATIHAN_STORE = 'kv';
const BG_CHANNEL_NAME = 'arg_latihan_bg';

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
        }).then(() => self.clients.claim()).then(() => resumeLatihanQueueIfIdle())
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

    if (e.request.mode === 'navigate' && url.origin === self.location.origin) {
        e.waitUntil(resumeLatihanQueueIfIdle());
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

/* =========================================================================
   5. ANTREAN LATAR BELAKANG PEMBUATAN SOAL LATIHAN (IndexedDB 'latihan-db')
   Tetap berjalan lancar walaupun siswa berpindah ke halaman lain!
   ========================================================================= */
let activeQueuePromise = null;

function openLatDb() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    return new Promise((resolve) => {
        try {
            const req = indexedDB.open(LATIHAN_DB, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(LATIHAN_STORE)) {
                    req.result.createObjectStore(LATIHAN_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        } catch (e) {
            resolve(null);
        }
    });
}

async function idbRead(key) {
    const db = await openLatDb();
    if (!db) return null;
    return await new Promise((resolve) => {
        try {
            const tx = db.transaction(LATIHAN_STORE, 'readonly');
            const q = tx.objectStore(LATIHAN_STORE).get(key);
            q.onsuccess = () => resolve(q.result || null);
            q.onerror = () => resolve(null);
        } catch (e) {
            resolve(null);
        }
    });
}

async function idbWrite(key, val) {
    const db = await openLatDb();
    if (!db) return false;
    return await new Promise((resolve) => {
        try {
            const tx = db.transaction(LATIHAN_STORE, 'readwrite');
            tx.objectStore(LATIHAN_STORE).put(val, key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        } catch (e) {
            resolve(false);
        }
    });
}

async function mergePackAtomically(cycleKey, partial, fallbackSpin = null) {
    const db = await openLatDb();
    if (!db) return null;
    return await new Promise((resolve) => {
        try {
            const tx = db.transaction(LATIHAN_STORE, 'readwrite');
            const store = tx.objectStore(LATIHAN_STORE);
            const getReq = store.get('state');
            getReq.onsuccess = () => {
                const state = getReq.result && getReq.result.hari
                    ? getReq.result
                    : { v: 1, id: 'sw_' + Date.now(), u: Date.now(), hari: {} };
                if (!state.hari[cycleKey]) {
                    if (!fallbackSpin) return;
                    state.hari[cycleKey] = { spin: fallbackSpin, sesi: {}, hasil: {}, pack: {} };
                }
                const day = state.hari[cycleKey];
                day.pack = Object.assign({}, day.pack || {}, partial);
                state.u = Date.now();
                store.put(state, 'state');
            };
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        } catch (e) {
            resolve(false);
        }
    });
}

async function tryAcquireSwLock() {
    const db = await openLatDb();
    if (!db) return false;
    return await new Promise((resolve) => {
        let granted = false;
        try {
            const tx = db.transaction(LATIHAN_STORE, 'readwrite');
            const store = tx.objectStore(LATIHAN_STORE);
            const r = store.get('latihan_lock');
            r.onsuccess = () => {
                const cur = r.result;
                const now = Date.now();
                if (!cur || cur.owner === 'sw' || cur.expiresAt < now) {
                    granted = true;
                    store.put({ owner: 'sw', expiresAt: now + 26000 }, 'latihan_lock');
                }
            };
            tx.oncomplete = () => resolve(granted);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        } catch (e) {
            resolve(false);
        }
    });
}

async function releaseSwLock() {
    const cur = await idbRead('latihan_lock');
    if (cur && cur.owner === 'sw') {
        await idbWrite('latihan_lock', { owner: 'sw', expiresAt: 0 });
    }
}

async function broadcastLatihanEvent(type, payload) {
    const msg = Object.assign({ type }, payload);
    try {
        if (typeof BroadcastChannel !== 'undefined') {
            const ch = new BroadcastChannel(BG_CHANNEL_NAME);
            ch.postMessage(msg);
            ch.close();
        }
    } catch (e) {}
    try {
        if (self.clients && self.clients.matchAll) {
            const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            list.forEach((c) => c.postMessage(msg));
        }
    } catch (e) {}
}

const STAGE_META = {
    prep:     { pct: 12, label: 'Membaca & menyaring materi PDF…' },
    pilgan_a: { pct: 28, label: 'Pacu jalur 1/5: Soal Pilihan Ganda (bagian 1)…' },
    pilgan_b: { pct: 46, label: 'Pacu jalur 2/5: Soal Pilihan Ganda HOTS…' },
    struktur: { pct: 64, label: 'Pacu jalur 3/5: Merancang Bedah Struktur…' },
    esai:     { pct: 80, label: 'Pacu jalur 4/5: Menyusun Esai Analitis…' },
    kritis:   { pct: 94, label: 'Pacu jalur 5/5: Merakit Uji Berpikir Kritis…' }
};

function delayMs(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function normalizePgUrut(arr) {
    const rank = { mudah: 0, sedang: 1, sulit: 2, hots: 3 };
    return (arr || []).map((s, i) => [s, i])
        .sort((a, b) => ((rank[a[0].tingkat] ?? 1) - (rank[b[0].tingkat] ?? 1)) || a[1] - b[1])
        .map(x => x[0]);
}

async function callCentralApi(body, timeoutMs = 28000) {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    try {
        const endpoint = new URL('./api/central', self.location.href).href;
        const reqOpts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        };
        if (ac) reqOpts.signal = ac.signal;
        const resp = await fetch(endpoint, reqOpts);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            const raHdr = parseFloat(resp.headers.get('retry-after') || '0');
            const err = new Error(data.detail_error || data.error || ('HTTP ' + resp.status));
            err.status = resp.status;
            err.retryable = resp.status === 429 || resp.status === 503 || resp.status === 504 || resp.status === 502 || !!data.retryable;
            err.retryAfterMs = Number(data.retryAfterMs) || (Number.isFinite(raHdr) && raHdr > 0 ? raHdr * 1000 : 0);
            throw err;
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

async function runStageOnce(job) {
    const allowEmergencyFallback = (job.retryCount || 0) >= 5;
    const fallbackSpin = { hid: job.hid, judul: job.judul || 'Materi', cover: job.cover || '', ts: job.ts || Date.now() };
    const basePrep = job.prep ? {
        handoutId: job.hid,
        judul: job.prep.judul,
        ringkasan: job.prep.ringkasan,
        poinKunci: job.prep.poinKunci,
        segmen: job.prep.segmen
    } : { handoutId: job.hid };

    if (job.stage === 'prep') {
        const res = await callCentralApi({ action: 'latihan_prep', handoutId: job.hid, allowEmergencyFallback });
        job.prep = {
            judul: res.judul || job.judul,
            ringkasan: res.ringkasan || '',
            poinKunci: res.poinKunci || '',
            segmen: Array.isArray(res.segmen) ? res.segmen : []
        };
        await mergePackAtomically(job.cycleKey, { ringkasan: job.prep.ringkasan, judul: job.prep.judul, handoutId: job.hid }, fallbackSpin);
        job.stage = 'pilgan_a';
        return res.suggestedDelayMs || 350;
    }

    if (job.stage === 'pilgan_a') {
        const res = await callCentralApi({
            action: 'latihan_pilgan',
            part: 'a',
            ...basePrep,
            seed: job.seed,
            allowEmergencyFallback
        });
        job.pilganA = Array.isArray(res.soal) ? res.soal : [];
        job.stage = 'pilgan_b';
        return res.suggestedDelayMs || 350;
    }

    if (job.stage === 'pilgan_b') {
        const stems = (job.pilganA || []).map(x => x.p).filter(Boolean);
        const res = await callCentralApi({
            action: 'latihan_pilgan',
            part: 'b',
            ...basePrep,
            excludeStems: stems,
            seed: (job.seed || 0) + 1,
            allowEmergencyFallback
        });
        const merged = normalizePgUrut((job.pilganA || []).concat(res.soal || [])).slice(0, 15);
        const total = merged.reduce((t, s) => t + (s.waktu || 45), 0);
        await mergePackAtomically(job.cycleKey, {
            ringkasan: (job.prep && job.prep.ringkasan) || '',
            pilgan: { soal: merged, total }
        }, fallbackSpin);
        job.pilganA = null;
        job.stage = 'struktur';
        return res.suggestedDelayMs || 350;
    }

    if (job.stage === 'struktur') {
        const res = await callCentralApi({
            action: 'latihan_struktur',
            ...basePrep,
            seed: (job.seed || 0) + 2,
            allowEmergencyFallback
        });
        await mergePackAtomically(job.cycleKey, { struktur: res.struktur }, fallbackSpin);
        job.stage = 'esai';
        return res.suggestedDelayMs || 350;
    }

    if (job.stage === 'esai') {
        const res = await callCentralApi({
            action: 'latihan_esai',
            ...basePrep,
            seed: (job.seed || 0) + 3,
            allowEmergencyFallback
        });
        await mergePackAtomically(job.cycleKey, { esai: res.esai }, fallbackSpin);
        job.stage = 'kritis';
        return res.suggestedDelayMs || 350;
    }

    if (job.stage === 'kritis') {
        const res = await callCentralApi({
            action: 'latihan_kritis',
            ...basePrep,
            seed: (job.seed || 0) + 4,
            allowEmergencyFallback
        });
        await mergePackAtomically(job.cycleKey, {
            kritis: res.kritis,
            dibuat: Date.now(),
            model: res.model || 'hybrid'
        }, fallbackSpin);
        job.stage = 'done';
        job.status = 'done';
        job.pct = 100;
        job.label = 'Semua soal siap dikerjakan!';
        return 0;
    }

    job.stage = 'done';
    job.status = 'done';
    job.pct = 100;
    return 0;
}

async function processLatihanQueue() {
    try {
        const gotLock = await tryAcquireSwLock();
        if (!gotLock) return;

        let job = await idbRead('latihan_job');
        if (!job || job.status === 'done' || job.status === 'error') {
            await releaseSwLock();
            return;
        }

        // Sebar ledakan awal (50 siswa bersamaan -> jitter ringan agar antre tertib)
        if (job.stage === 'prep' && (job.retryCount || 0) === 0 && !job.initialJitterDone) {
            job.initialJitterDone = true;
            await idbWrite('latihan_job', job);
            await delayMs(120 + Math.floor(Math.random() * 850));
        }

        let steps = 0;
        while (job && job.status !== 'done' && job.status !== 'error' && steps < 28) {
            steps++;
            // Periksa apakah pengguna memutar gacha baru yang mengganti cycleKey
            const freshJob = await idbRead('latihan_job');
            if (!freshJob || freshJob.id !== job.id) {
                job = freshJob;
                if (!job || job.status === 'done' || job.status === 'error') break;
            }

            await tryAcquireSwLock();
            const meta = STAGE_META[job.stage] || { pct: 95, label: 'Menyiapkan soal…' };
            job.status = 'running';
            job.pct = meta.pct;
            job.label = meta.label;
            job.errorMsg = '';
            job.updatedAt = Date.now();
            await idbWrite('latihan_job', job);
            await broadcastLatihanEvent('LATIHAN_PROGRESS', { job });

            try {
                const nextWait = await runStageOnce(job);
                job.retryCount = 0;
                job.updatedAt = Date.now();
                await idbWrite('latihan_job', job);

                if (job.status === 'done') {
                    let osNotified = false;
                    if (self.Notification && Notification.permission === 'granted' && self.registration && self.registration.showNotification) {
                        const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
                        const sedangDiLatihan = clientsList.some(c => c.focused && /\/latihan(\.html)?$/i.test(String(c.url || '').split(/[?#]/)[0]));
                        if (!sedangDiLatihan) {
                            try {
                                await self.registration.showNotification('🎯 Soal Latihan Hari Ini Siap!', {
                                    body: `Semua paket soal untuk "${job.judul}" telah selesai disiapkan dan siap dikerjakan.`,
                                    icon: './icon-192.png',
                                    badge: './icon-192.png',
                                    tag: 'latihan_ready_' + job.cycleKey,
                                    data: { url: './latihan.html' }
                                });
                                osNotified = true;
                            } catch (e) {}
                        }
                    }
                    await broadcastLatihanEvent('LATIHAN_DONE', { job, osNotified });
                    break;
                } else {
                    await broadcastLatihanEvent('LATIHAN_PROGRESS', { job });
                    if (nextWait > 0) {
                        await delayMs(nextWait + Math.floor(Math.random() * 350));
                    }
                }
            } catch (err) {
                const retryable = err.name === 'AbortError' || err.retryable || err.status === 429 || err.status === 503 || err.status === 504 || err.status === 502 || /network|fetch/i.test(String(err.message || ''));
                if (!retryable && (err.status === 400 || err.status === 404 || err.status === 413)) {
                    job.status = 'error';
                    job.errorMsg = err.message || 'Materi tidak dapat diproses.';
                    job.updatedAt = Date.now();
                    await idbWrite('latihan_job', job);
                    await broadcastLatihanEvent('LATIHAN_ERROR', { job });
                    break;
                }

                job.retryCount = (job.retryCount || 0) + 1;
                if (job.retryCount > 9) {
                    job.status = 'error';
                    job.errorMsg = err.message || 'Antrean terlalu padat. Ketuk Coba Lagi.';
                    job.updatedAt = Date.now();
                    await idbWrite('latihan_job', job);
                    await broadcastLatihanEvent('LATIHAN_ERROR', { job });
                    break;
                }

                const expWait = Math.min(14000, Math.round(1800 * Math.pow(1.45, Math.min(job.retryCount, 5))));
                const waitMs = Math.max(1500, Math.min(18000, err.retryAfterMs || expWait)) + Math.floor(Math.random() * 1200);
                job.status = 'waiting';
                job.label = `Menunggu giliran antrean AI (${Math.ceil(waitMs / 1000)} dtk)…`;
                job.updatedAt = Date.now();
                await idbWrite('latihan_job', job);
                await broadcastLatihanEvent('LATIHAN_PROGRESS', { job });
                await delayMs(waitMs);
            }
        }
    } finally {
        await releaseSwLock();
        activeQueuePromise = null;
    }
}

function resumeLatihanQueueIfIdle() {
    if (activeQueuePromise) return activeQueuePromise;
    activeQueuePromise = (async () => {
        const job = await idbRead('latihan_job');
        if (job && job.status !== 'done' && job.status !== 'error') {
            await processLatihanQueue();
        }
    })().finally(() => {
        activeQueuePromise = null;
    });
    return activeQueuePromise;
}

// 6. Listener Pesan dari Client (notifikasi & antrean latihan latar belakang)
self.addEventListener('message', (event) => {
    const d = event.data;
    if (!d) return;
    if (d.type === 'SHOW_NOTIFICATION') {
        const { title, options } = d;
        self.registration.showNotification(title, options);
    } else if (d.type === 'LATIHAN_ENQUEUE' || d.type === 'LATIHAN_RESUME') {
        if (event.waitUntil) {
            event.waitUntil(resumeLatihanQueueIfIdle());
        } else {
            resumeLatihanQueueIfIdle();
        }
    }
});
