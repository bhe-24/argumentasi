/**
 * SISTEM NOTIFIKASI PWA ARGUMENTASI (notifikasi.js)
 * Menghubungkan notifikasi otomatis (latihan 24 jam & pembaruan sistem)
 * serta notifikasi siaran dari Admin langsung ke ponsel masing-masing pengguna.
 */

const NotifikasiApp = (function() {
    // Versi sistem saat ini untuk pelacakan pembaruan otomatis
    const CURRENT_SYSTEM_VERSION = 'v2.5.2';

    // Kunci-kunci penyimpanan lokal
    const STORAGE_KEYS = {
        LIST: 'arg_notifications_list_v1',
        DELIVERED: 'arg_delivered_notifs_v1',
        LAST_VERSION: 'arg_last_seen_version_v1',
        LAST_LATIHAN_CHECK: 'arg_last_latihan_notif_ts_v1',
        LAST_PERSONAL_REMINDER: 'arg_last_reminder_ts_v1',
        SETTINGS: 'arg_notif_settings_v1'
    };

    // Suara notifikasi (Chime audio sintetis menggunakan Web Audio API tanpa perlu file eksternal)
    function putarNadaNotifikasi() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            const ctx = new AudioContext();
            
            // Nada pertama (tinggi lembut)
            const osc1 = ctx.createOscillator();
            const gain1 = ctx.createGain();
            osc1.type = 'sine';
            osc1.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
            osc1.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15); // A5
            gain1.gain.setValueAtTime(0.2, ctx.currentTime);
            gain1.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
            osc1.connect(gain1);
            gain1.connect(ctx.destination);
            osc1.start(ctx.currentTime);
            osc1.stop(ctx.currentTime + 0.35);

            // Nada kedua (harmonis)
            const osc2 = ctx.createOscillator();
            const gain2 = ctx.createGain();
            osc2.type = 'sine';
            osc2.frequency.setValueAtTime(880, ctx.currentTime + 0.12);
            osc2.frequency.exponentialRampToValueAtTime(1174.66, ctx.currentTime + 0.3); // D6
            gain2.gain.setValueAtTime(0.25, ctx.currentTime + 0.12);
            gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
            osc2.connect(gain2);
            gain2.connect(ctx.destination);
            osc2.start(ctx.currentTime + 0.12);
            osc2.stop(ctx.currentTime + 0.5);
        } catch(e) {
            // Audio context mungkin diblokir browser sebelum ada interaksi pengguna
        }
    }

    // Ambil Pengaturan
    function getSettings() {
        try {
            const s = localStorage.getItem(STORAGE_KEYS.SETTINGS);
            return s ? JSON.parse(s) : { enabled: true, sound: true, vibrate: true, latihan: true, sistem: true, admin: true };
        } catch(e) {
            return { enabled: true, sound: true, vibrate: true, latihan: true, sistem: true, admin: true };
        }
    }

    function saveSettings(settings) {
        localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    }

    // Ambil Daftar Notifikasi di In-App Center
    function getNotifications() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.LIST);
            return raw ? JSON.parse(raw) : [];
        } catch(e) {
            return [];
        }
    }

    function saveNotifications(list) {
        localStorage.setItem(STORAGE_KEYS.LIST, JSON.stringify(list));
        updateBadgeUI();
    }

    // Ambil Daftar ID Notifikasi yang Pernah Muncul di Ponsel (mencegah duplikasi pop-up)
    function getDeliveredIds() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.DELIVERED);
            return raw ? JSON.parse(raw) : {};
        } catch(e) {
            return {};
        }
    }

    function markDelivered(id) {
        const delivered = getDeliveredIds();
        delivered[id] = Date.now();
        localStorage.setItem(STORAGE_KEYS.DELIVERED, JSON.stringify(delivered));
    }

    // TOAST NOTIFIKASI GLOBAL
    function tampilkanToast(msg, isError = false) {
        let container = document.getElementById('toastContainer');
        if (!container) {
            container = document.getElementById('argGlobalToastContainer');
            if (!container) {
                container = document.createElement('div');
                container.id = 'argGlobalToastContainer';
                container.className = 'fixed top-5 left-1/2 transform -translate-x-1/2 z-[100000] flex flex-col gap-2 w-11/12 max-w-sm pointer-events-none';
                document.body.appendChild(container);
            }
        }

        const toast = document.createElement('div');
        const bgClass = isError ? 'bg-rose-600' : 'bg-slate-900';
        const iconClass = isError ? 'fa-exclamation-circle text-rose-300' : 'fa-check-circle text-emerald-400';
        
        toast.className = `${bgClass} text-white px-4 py-3 rounded-2xl shadow-2xl text-xs font-semibold flex items-center gap-3 transform translate-y-[-20px] opacity-0 transition-all duration-300 pointer-events-auto border border-white/10`;
        toast.innerHTML = `<i class="fas ${iconClass} text-base shrink-0"></i> <span class="flex-1 leading-snug">${msg}</span>`;
        
        container.appendChild(toast);
        requestAnimationFrame(() => toast.classList.remove('translate-y-[-20px]', 'opacity-0'));
        setTimeout(() => {
            toast.classList.add('translate-y-[-20px]', 'opacity-0');
            setTimeout(() => toast.remove(), 350);
        }, 3800);
    }

    // MODAL PANDUAN AKTIFKAN / BUKA BLOKIR IZIN NOTIFIKASI PONSEL
    function pastikanModalPanduanIzinAda() {
        let modal = document.getElementById('modalPanduanIzinPonsel');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'modalPanduanIzinPonsel';
        modal.className = 'fixed inset-0 bg-slate-900/80 backdrop-blur-xs z-[999999] flex items-center justify-center p-4 transition-all duration-300 hidden opacity-0';
        modal.innerHTML = `
        <div class="bg-white rounded-3xl max-w-sm w-full p-5 shadow-2xl border border-slate-100 flex flex-col relative transform transition-all duration-300 scale-95">
            <div class="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
                <div class="flex items-center gap-2.5">
                    <div class="w-9 h-9 rounded-2xl bg-amber-50 text-amber-500 flex items-center justify-center text-base border border-amber-200">
                        <i class="fas fa-bell"></i>
                    </div>
                    <div>
                        <h3 class="text-sm font-extrabold text-slate-800 leading-tight">Izin Notifikasi Ponsel</h3>
                        <p class="text-[10px] text-slate-400">Pengaturan akses sistem perangkat</p>
                    </div>
                </div>
                <button type="button" onclick="NotifikasiApp.tutupModalPanduanIzin()" class="w-7 h-7 rounded-full bg-slate-100 text-slate-400 hover:text-slate-600 flex items-center justify-center text-xs">
                    <i class="fas fa-times"></i>
                </button>
            </div>

            <div class="space-y-3.5 mb-5">
                <div class="p-3 bg-amber-50 rounded-2xl border border-amber-200 text-amber-900 text-xs">
                    <p class="font-bold flex items-center gap-1.5 text-amber-800 mb-1">
                        <i class="fas fa-lock text-xs"></i> Izin Belum Aktif di Ponsel
                    </p>
                    <p class="text-[11px] leading-relaxed text-amber-700">
                        Peramban ponsel Anda memerlukan izin resmi untuk menampilkan notifikasi latihan dan info sistem di bilah status layar HP.
                    </p>
                </div>

                <div class="space-y-2">
                    <p class="text-[10px] font-extrabold uppercase text-slate-400 tracking-wider">Langkah Mudah Mengaktifkan di HP:</p>
                    
                    <div class="flex items-start gap-3 p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                        <span class="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-extrabold shrink-0 mt-0.5">1</span>
                        <div class="text-[11px] text-slate-700">
                            Ketuk ikon <strong>Gembok (🔒)</strong> atau <strong>Setelan Situs</strong> di bilah alamat atas peramban HP Anda.
                        </div>
                    </div>

                    <div class="flex items-start gap-3 p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                        <span class="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-extrabold shrink-0 mt-0.5">2</span>
                        <div class="text-[11px] text-slate-700">
                            Pilih menu <strong>Izin (Permissions)</strong> &rarr; pilih <strong>Notifikasi</strong>.
                        </div>
                    </div>

                    <div class="flex items-start gap-3 p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                        <span class="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-extrabold shrink-0 mt-0.5">3</span>
                        <div class="text-[11px] text-slate-700">
                            Ubah menjadi <strong>Izinkan (Allow)</strong>, lalu kembali ke halaman ini.
                        </div>
                    </div>
                </div>
            </div>

            <div class="flex flex-col gap-2">
                <button type="button" onclick="NotifikasiApp.periksaDanTesIzin()" class="w-full bg-brand-green hover:bg-emerald-700 text-white py-3 rounded-2xl text-xs font-extrabold shadow-md active:scale-95 transition-all flex items-center justify-center gap-2">
                    <i class="fas fa-circle-check text-sm"></i>
                    <span>Saya Sudah Izinkan, Uji Sekarang!</span>
                </button>
                <button type="button" onclick="NotifikasiApp.tutupModalPanduanIzin()" class="w-full bg-slate-100 hover:bg-slate-200 text-slate-600 py-2.5 rounded-2xl text-xs font-bold transition-all">
                    Tutup
                </button>
            </div>
        </div>`;

        document.body.appendChild(modal);
        return modal;
    }

    function bukaModalPanduanIzin() {
        const modal = pastikanModalPanduanIzinAda();
        modal.classList.remove('hidden');
        requestAnimationFrame(() => {
            modal.classList.remove('opacity-0');
            const box = modal.querySelector('div');
            if (box) box.classList.replace('scale-95', 'scale-100');
        });
    }

    function tutupModalPanduanIzin() {
        const modal = document.getElementById('modalPanduanIzinPonsel');
        if (!modal) return;
        modal.classList.add('opacity-0');
        const box = modal.querySelector('div');
        if (box) box.classList.replace('scale-100', 'scale-95');
        setTimeout(() => modal.classList.add('hidden'), 300);
    }

    // Tanya izin ke browser dengan fallback Promise & Callback universal
    function tanyaIzinPeramban() {
        return new Promise((resolve) => {
            if (!('Notification' in window)) return resolve('unsupported');
            let resolved = false;
            try {
                const res = Notification.requestPermission(function(perm) {
                    if (!resolved) {
                        resolved = true;
                        resolve(perm);
                    }
                });
                if (res && typeof res.then === 'function') {
                    res.then(function(perm) {
                        if (!resolved) {
                            resolved = true;
                            resolve(perm);
                        }
                    }).catch(function() {
                        if (!resolved) {
                            resolved = true;
                            resolve(Notification.permission || 'denied');
                        }
                    });
                }
            } catch(e) {
                if (!resolved) {
                    resolved = true;
                    resolve(Notification.permission || 'denied');
                }
            }
        });
    }

    // MINTA IZIN NOTIFIKASI PONSEL (Dengan respon getar haptic & panduan lengkap)
    async function requestPermission(triggerBtn = null) {
        // 1. Respon haptic instan di ponsel saat tombol disentuh
        if ('vibrate' in navigator) {
            try { navigator.vibrate([40, 30, 40]); } catch(e){}
        }

        // Simpan teks tombol jika ada
        let originalBtnHtml = '';
        if (triggerBtn && triggerBtn.innerHTML) {
            originalBtnHtml = triggerBtn.innerHTML;
            triggerBtn.disabled = true;
            triggerBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menghubungkan HP...';
        }

        const pulihkanTombol = () => {
            if (triggerBtn && originalBtnHtml) {
                triggerBtn.disabled = false;
                triggerBtn.innerHTML = originalBtnHtml;
            }
        };

        // 2. Periksa dukungan peramban
        if (!('Notification' in window)) {
            pulihkanTombol();
            tampilkanToast('Peramban ponsel ini belum mendukung Web Notification API', true);
            bukaModalPanduanIzin();
            return false;
        }

        // 3. Pastikan Service Worker terdaftar dan aktif
        if ('serviceWorker' in navigator) {
            try {
                let reg = await navigator.serviceWorker.getRegistration();
                if (!reg) {
                    reg = await navigator.serviceWorker.register('./sw.js');
                }
            } catch(swErr) {
                console.log('SW register check err:', swErr);
            }
        }

        const statusSaatIni = Notification.permission;

        // KASUS A: SUDAH DISETUJUI SEBELUMNYA
        if (statusSaatIni === 'granted') {
            pulihkanTombol();
            tampilkanToast('🎉 Izin notifikasi ponsel Anda sudah aktif!');
            updatePermissionBannerUI();
            
            // Tembakkan notifikasi uji coba langsung ke status bar HP
            await kirimNotifikasiKePonsel({
                id: 'notif_pwa_ready_' + Date.now(),
                title: '🎉 Notifikasi Ponsel Terhubung!',
                body: 'Sistem notifikasi ponsel Argumentasi berfungsi sempurna di perangkat Anda.',
                category: 'sistem',
                url: 'index.html'
            });
            return true;
        }

        // KASUS B: STATUS DIBLOKIR / DENIED (Browser HP tidak akan memunculkan dialog lagi secara otomatis)
        if (statusSaatIni === 'denied') {
            pulihkanTombol();
            tampilkanToast('Izin notifikasi diblokir oleh peramban HP. Buka gembok 🔒 di atas untuk mengizinkan.', true);
            bukaModalPanduanIzin();
            return false;
        }

        // KASUS C: STATUS DEFAULT (Minta izin ke peramban HP)
        try {
            tampilkanToast('Silakan pilih "Izinkan" / "Allow" pada pop-up layar HP Anda...');
            const hasil = await tanyaIzinPeramban();
            pulihkanTombol();

            if (hasil === 'granted') {
                tampilkanToast('🎉 Selamat! Notifikasi ponsel berhasil diaktifkan.');
                updatePermissionBannerUI();

                // Putar suara dering & tembakkan notifikasi ke status bar HP
                putarNadaNotifikasi();
                if ('vibrate' in navigator) {
                    try { navigator.vibrate([100, 50, 150]); } catch(e){}
                }

                await kirimNotifikasiKePonsel({
                    id: 'notif_welcome_granted_' + Date.now(),
                    title: '🎉 Notifikasi Ponsel Aktif!',
                    body: 'Ponsel Anda kini terhubung resmi. Pembaruan latihan 24 jam dan info penting akan masuk ke sini.',
                    category: 'sistem',
                    url: 'index.html'
                });
                return true;
            } else {
                updatePermissionBannerUI();
                tampilkanToast('Izin notifikasi belum diaktifkan.', true);
                bukaModalPanduanIzin();
                return false;
            }
        } catch(err) {
            pulihkanTombol();
            console.error('Error requestPermission:', err);
            bukaModalPanduanIzin();
            return false;
        }
    }

    // FUNGSI CEK ULANG DARI MODAL PANDUAN
    async function periksaDanTesIzin() {
        if (!('Notification' in window)) {
            tampilkanToast('Peramban ini tidak mendukung notifikasi', true);
            return;
        }

        const perm = Notification.permission;
        if (perm === 'granted') {
            tutupModalPanduanIzin();
            tampilkanToast('✓ Izin terverifikasi! Mengirim notifikasi ke HP...');
            updatePermissionBannerUI();
            
            putarNadaNotifikasi();
            if ('vibrate' in navigator) {
                try { navigator.vibrate([100, 50, 150]); } catch(e){}
            }

            await kirimNotifikasiKePonsel({
                id: 'notif_verified_success_' + Date.now(),
                title: '🔔 Notifikasi Ponsel Aktif!',
                body: 'Luar biasa! Sistem kini dapat mengirimkan pemberitahuan latihan dan materi ke ponsel Anda.',
                category: 'sistem',
                url: 'index.html'
            });
        } else {
            // Coba minta izin sekali lagi jika status belum granted
            const hasil = await tanyaIzinPeramban();
            if (hasil === 'granted') {
                tutupModalPanduanIzin();
                tampilkanToast('🎉 Izin berhasil diaktifkan!');
                updatePermissionBannerUI();
                kirimNotifikasiKePonsel({
                    id: 'notif_granted_retry_' + Date.now(),
                    title: '🎉 Notifikasi Ponsel Aktif!',
                    body: 'Perangkat Anda telah tersambung sempurna.',
                    category: 'sistem',
                    url: 'index.html'
                });
            } else {
                tampilkanToast('Peramban masih memblokir notifikasi. Pastikan Anda sudah mengubah setelan di ikon gembok 🔒 di atas.', true);
            }
        }
    }

    // KIRIM NOTIFIKASI KE STATUS BAR / LOCK SCREEN PONSEL
    function kirimNotifikasiKePonsel(options) {
        const settings = getSettings();
        if (!settings.enabled) return Promise.resolve();

        const { id, title, body, category = 'pengumuman', url = 'index.html', icon = 'icon-192.png' } = options;

        // 1. Simpan ke daftar Pusat Notifikasi In-App
        const list = getNotifications();
        const existingIdx = list.findIndex(n => n.id === id);
        const notifItem = {
            id: id || ('notif_' + Date.now()),
            title,
            body,
            category,
            url,
            read: false,
            createdAt: new Date().toISOString()
        };

        if (existingIdx >= 0) {
            list[existingIdx] = notifItem;
        } else {
            list.unshift(notifItem);
        }
        if (list.length > 50) list.pop(); // Batasi 50 riwayat
        saveNotifications(list);

        // 2. Mainkan getar dan audio sintetis
        if (settings.vibrate && 'vibrate' in navigator) {
            try { navigator.vibrate([100, 60, 100]); } catch(e){}
        }
        if (settings.sound) {
            putarNadaNotifikasi();
        }

        // 3. Tampilkan ke Bilah Status / Layar Kunci Ponsel jika diizinkan
        if ('Notification' in window && Notification.permission === 'granted') {
            const notifOpts = {
                body,
                icon: icon.startsWith('http') ? icon : ('./' + icon),
                badge: './icon-192.png',
                vibrate: [100, 50, 100],
                data: { url: url || './index.html', id: notifItem.id },
                tag: notifItem.id,
                renotify: true
            };

            // Selalu utamakan Service Worker Registration di perangkat mobile Android / iOS
            if ('serviceWorker' in navigator) {
                return navigator.serviceWorker.ready.then(reg => {
                    return reg.showNotification(title, notifOpts);
                }).catch(err => {
                    console.log('SW showNotification fallback:', err);
                    try {
                        new Notification(title, notifOpts);
                    } catch(e){}
                });
            } else {
                try {
                    new Notification(title, notifOpts);
                } catch(e) {
                    console.log('Fallback Notification error:', e);
                }
            }
        }
        return Promise.resolve();
    }

    // =========================================================================
    // 1. NOTIFIKASI OTOMATIS 1: PEMBARUAN SIKLUS LATIHAN 24 JAM
    // =========================================================================
    function cekNotifikasiLatihanOtomatis() {
        const settings = getSettings();
        if (!settings.latihan) return;

        try {
            const lastCheck = Number(localStorage.getItem(STORAGE_KEYS.LAST_LATIHAN_CHECK)) || 0;
            const now = Date.now();

            // Cek status latihan hari ini dari storage 'lat_v1_data'
            const rawLat = localStorage.getItem('lat_v1_data');
            let isExpiredOrNew = false;

            if (rawLat) {
                const latData = JSON.parse(rawLat);
                const activeKey = latData.aktif;
                if (activeKey && latData.hari && latData.hari[activeKey]) {
                    const spin = latData.hari[activeKey].spin;
                    if (spin && spin.ts) {
                        const sisaWaktu = (spin.ts + 864e5) - now;
                        // Jika 24 jam sudah berlalu
                        if (sisaWaktu <= 0) {
                            isExpiredOrNew = true;
                        }
                    }
                } else {
                    isExpiredOrNew = true;
                }
            } else {
                isExpiredOrNew = true;
            }

            // Jika ada latihan baru / siklus 24 jam reset, dan belum diberi notif dalam 12 jam terakhir
            if (isExpiredOrNew && (now - lastCheck > 12 * 3600 * 1000)) {
                localStorage.setItem(STORAGE_KEYS.LAST_LATIHAN_CHECK, now.toString());
                
                const nama = localStorage.getItem('namaSiswaCendekia') || 'Siswa Cendekia';
                const notifId = 'lat_reset_auto_' + new Date().toISOString().slice(0, 10);

                kirimNotifikasiKePonsel({
                    id: notifId,
                    title: '🎯 Tantangan Latihan 24 Jam Siap!',
                    body: `Halo ${nama}, materi baru dan soal penalaran argumentasi hari ini sudah dibuka. Ayo kumpulkan XP Anda!`,
                    category: 'latihan',
                    url: 'latihan.html'
                });
            }
        } catch(e) {
            console.error('Error cekNotifikasiLatihanOtomatis:', e);
        }
    }

    // =========================================================================
    // 2. NOTIFIKASI OTOMATIS 2: PEMBARUAN SISTEM
    // =========================================================================
    function cekNotifikasiPembaruanSistem() {
        const settings = getSettings();
        if (!settings.sistem) return;

        try {
            const lastSeenVersion = localStorage.getItem(STORAGE_KEYS.LAST_VERSION);
            if (lastSeenVersion !== CURRENT_SYSTEM_VERSION) {
                localStorage.setItem(STORAGE_KEYS.LAST_VERSION, CURRENT_SYSTEM_VERSION);

                const notifId = 'sys_update_' + CURRENT_SYSTEM_VERSION;
                kirimNotifikasiKePonsel({
                    id: notifId,
                    title: '🚀 Pembaruan Sistem Argumentasi ' + CURRENT_SYSTEM_VERSION,
                    body: 'Fitur Kartu Pelajar Digital, notifikasi real-time ke ponsel, dan performa baru kini siap digunakan!',
                    category: 'sistem',
                    url: 'index.html'
                });
            }
        } catch(e) {
            console.error('Error cekNotifikasiPembaruanSistem:', e);
        }
    }

    // =========================================================================
    // 3. NOTIFIKASI OTOMATIS 3: PENGINGAT PERSONAL BELAJAR SISWA
    // =========================================================================
    function cekPengingatBelajarSiswa() {
        const settings = getSettings();
        if (!settings.enabled) return;

        try {
            const lastReminder = Number(localStorage.getItem(STORAGE_KEYS.LAST_PERSONAL_REMINDER)) || 0;
            const now = Date.now();

            // Batasi pengingat minimal 18 jam sekali
            if (now - lastReminder > 18 * 3600 * 1000) {
                const nama = localStorage.getItem('namaSiswaCendekia');
                if (nama) {
                    const todayStr = new Date().toISOString().slice(0, 10);
                    localStorage.setItem(STORAGE_KEYS.LAST_PERSONAL_REMINDER, now.toString());
                    
                    kirimNotifikasiKePonsel({
                        id: 'reminder_daily_' + todayStr,
                        title: `Semangat Belajar, ${nama}! 💡`,
                        body: 'Sedikit latihan setiap hari membawa kemajuan besar. Lanjutkan perjalanan belajarmu hari ini!',
                        category: 'motivasi',
                        url: 'latihan.html'
                    });
                }
            }
        } catch(e) {
            console.error('Error cekPengingatBelajarSiswa:', e);
        }
    }

    // =========================================================================
    // 4. NOTIFIKASI DARI ADMIN (POST SIARAN ADMIN VIA API / FIRESTORE)
    // =========================================================================
    async function sinkronisasiNotifikasiAdmin() {
        const settings = getSettings();
        if (!settings.admin) return;

        try {
            // Ambil dari endpoint API Vercel
            const resp = await fetch('/api/notifikasi?limit=15', { cache: 'no-store' });
            if (resp.ok) {
                const json = await resp.json();
                if (json.success && Array.isArray(json.data)) {
                    json.data.forEach(item => {
                        // Tembakkan ke ponsel jika belum pernah tampil
                        kirimNotifikasiKePonsel({
                            id: item.id,
                            title: item.title,
                            body: item.body,
                            category: item.category || 'pengumuman',
                            url: item.url || 'index.html'
                        });
                    });
                }
            }
        } catch(e) {
            // Jika offline atau server belum siap, tetap aman dengan data lokal
        }
    }

    // UPDATE UI BADGE DI HEADER BELL
    function updateBadgeUI() {
        const badge = document.getElementById('notifBadgeCount');
        if (!badge) return;

        const list = getNotifications();
        const unreadCount = list.filter(n => !n.read).length;

        if (unreadCount > 0) {
            badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    // UPDATE BANNER IZIN NOTIFIKASI
    function updatePermissionBannerUI() {
        const banner = document.getElementById('notifPermissionBanner');
        if (!banner) return;

        if ('Notification' in window && Notification.permission === 'default') {
            banner.classList.remove('hidden');
        } else {
            banner.classList.add('hidden');
        }
    }

    // RENDER DAFTAR PADA PUSAT NOTIFIKASI
    function renderNotificationCenter(filterCategory = 'all') {
        const container = document.getElementById('notifListContainer');
        const emptyState = document.getElementById('notifEmptyState');
        if (!container) return;

        let list = getNotifications();
        if (filterCategory !== 'all') {
            list = list.filter(n => n.category === filterCategory);
        }

        if (list.length === 0) {
            container.innerHTML = '';
            if (emptyState) emptyState.classList.remove('hidden');
            return;
        }

        if (emptyState) emptyState.classList.add('hidden');

        function formatWaktu(isoStr) {
            if (!isoStr) return '';
            const diff = Date.now() - new Date(isoStr).getTime();
            const menit = Math.floor(diff / 60000);
            if (menit < 1) return 'Baru saja';
            if (menit < 60) return `${menit} mnt lalu`;
            const jam = Math.floor(menit / 60);
            if (jam < 24) return `${jam} jam lalu`;
            const hari = Math.floor(jam / 24);
            return `${hari} hari lalu`;
        }

        function getCategoryMeta(cat) {
            switch(cat) {
                case 'latihan':
                    return { icon: 'fa-bullseye', bg: 'bg-emerald-50 text-emerald-600 border-emerald-200', label: 'Latihan' };
                case 'sistem':
                    return { icon: 'fa-rocket', bg: 'bg-blue-50 text-blue-600 border-blue-200', label: 'Sistem' };
                case 'motivasi':
                    return { icon: 'fa-lightbulb', bg: 'bg-amber-50 text-amber-600 border-amber-200', label: 'Motivasi' };
                default:
                    return { icon: 'fa-bullhorn', bg: 'bg-purple-50 text-purple-600 border-purple-200', label: 'Pengumuman' };
            }
        }

        let html = '';
        list.forEach(n => {
            const meta = getCategoryMeta(n.category);
            const isUnread = !n.read;
            html += `
            <div onclick="NotifikasiApp.bukaAksiNotifikasi('${n.id}', '${n.url || 'index.html'}')" 
                 class="p-3.5 rounded-2xl border transition-all cursor-pointer flex gap-3 relative ${isUnread ? 'bg-emerald-50/40 border-emerald-200/80 shadow-xs' : 'bg-white border-slate-100 hover:bg-slate-50'}">
                <div class="w-10 h-10 rounded-xl ${meta.bg} border flex items-center justify-center shrink-0 text-base shadow-2xs">
                    <i class="fas ${meta.icon}"></i>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between gap-1 mb-0.5">
                        <span class="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md ${meta.bg}">
                            ${meta.label}
                        </span>
                        <span class="text-[9.5px] text-slate-400 font-medium">${formatWaktu(n.createdAt)}</span>
                    </div>
                    <h4 class="text-xs font-bold ${isUnread ? 'text-slate-900' : 'text-slate-700'} line-clamp-1 leading-snug">
                        ${n.title}
                    </h4>
                    <p class="text-[11px] text-slate-500 line-clamp-2 mt-0.5 leading-relaxed">
                        ${n.body}
                    </p>
                </div>
                ${isUnread ? '<span class="w-2 h-2 rounded-full bg-emerald-500 absolute top-3 right-3 shadow-xs"></span>' : ''}
            </div>`;
        });

        container.innerHTML = html;
    }

    // BUKA PUSAT NOTIFIKASI (MODAL DRAWER)
    function bukaPusatNotifikasi() {
        const modal = document.getElementById('modalPusatNotifikasi');
        if (!modal) return;

        renderNotificationCenter('all');
        updatePermissionBannerUI();

        modal.classList.remove('hidden');
        requestAnimationFrame(() => {
            modal.classList.remove('opacity-0');
            const box = modal.querySelector('#notifDrawerBox');
            if (box) {
                box.classList.remove('translate-y-full');
                box.classList.add('translate-y-0');
            }
        });
    }

    function tutupPusatNotifikasi() {
        const modal = document.getElementById('modalPusatNotifikasi');
        if (!modal) return;

        modal.classList.add('opacity-0');
        const box = modal.querySelector('#notifDrawerBox');
        if (box) {
            box.classList.remove('translate-y-0');
            box.classList.add('translate-y-full');
        }
        setTimeout(() => modal.classList.add('hidden'), 300);
    }

    function tandaiSemuaDibaca() {
        const list = getNotifications().map(n => ({ ...n, read: true }));
        saveNotifications(list);
        renderNotificationCenter();
        updateBadgeUI();
    }

    function bersihkanSemuaNotifikasi() {
        if (confirm('Hapus seluruh riwayat notifikasi di perangkat ini?')) {
            saveNotifications([]);
            renderNotificationCenter();
            updateBadgeUI();
        }
    }

    function bukaAksiNotifikasi(id, url) {
        // Tandai item ini sudah dibaca
        const list = getNotifications();
        const item = list.find(n => n.id === id);
        if (item) item.read = true;
        saveNotifications(list);

        tutupPusatNotifikasi();

        // Navigasi ke URL tujuan
        if (url && url !== '#') {
            setTimeout(() => {
                window.location.href = url;
            }, 200);
        }
    }

    // INISIALISASI OTOMATIS
    function init() {
        updateBadgeUI();
        updatePermissionBannerUI();

        // Jalankan pengecekan notifikasi otomatis saat aplikasi dibuka
        setTimeout(() => {
            cekNotifikasiPembaruanSistem();
            cekNotifikasiLatihanOtomatis();
            cekPengingatBelajarSiswa();
            sinkronisasiNotifikasiAdmin();
        }, 1500);

        // Pasang listener jika Service Worker menerima event
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', (event) => {
                if (event.data && event.data.type === 'NOTIF_RECEIVED') {
                    updateBadgeUI();
                }
            });
        }
    }

    // Auto-init saat DOM siap
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return {
        init,
        requestPermission,
        kirimNotifikasiKePonsel,
        bukaPusatNotifikasi,
        tutupPusatNotifikasi,
        bukaModalPanduanIzin,
        tutupModalPanduanIzin,
        periksaDanTesIzin,
        tampilkanToast,
        tandaiSemuaDibaca,
        bersihkanSemuaNotifikasi,
        bukaAksiNotifikasi,
        renderNotificationCenter,
        getNotifications,
        getSettings,
        saveSettings
    };
})();

// Ekspos ke global window
window.NotifikasiApp = NotifikasiApp;
