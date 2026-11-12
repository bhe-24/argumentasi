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

    // Deteksi apakah aplikasi berjalan dalam mode PWA Standalone (Layar Utama HP)
    function isAplikasiStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches ||
               window.navigator.standalone === true ||
               document.referrer.includes('android-app://');
    }

    // MODAL PANDUAN AKTIFKAN / BUKA BLOKIR IZIN NOTIFIKASI PONSEL (Khusus PWA & Browser)
    function pastikanModalPanduanIzinAda() {
        let modal = document.getElementById('modalPanduanIzinPonsel');
        if (modal) return modal;

        const isPWA = isAplikasiStandalone();

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
                        <h3 class="text-sm font-extrabold text-slate-800 leading-tight">Izin Notifikasi HP</h3>
                        <p class="text-[10px] text-slate-400">${isPWA ? 'Aplikasi Layar Utama (PWA)' : 'Setelan Akses Peramban'}</p>
                    </div>
                </div>
                <button type="button" onclick="NotifikasiApp.tutupModalPanduanIzin()" class="w-7 h-7 rounded-full bg-slate-100 text-slate-400 hover:text-slate-600 flex items-center justify-center text-xs">
                    <i class="fas fa-times"></i>
                </button>
            </div>

            <div class="space-y-3.5 mb-5">
                <div class="p-3 bg-amber-50 rounded-2xl border border-amber-200 text-amber-900 text-xs">
                    <p class="font-bold flex items-center gap-1.5 text-amber-800 mb-1">
                        <i class="fas fa-shield-halved text-xs"></i> Akses Perizinan Ponsel
                    </p>
                    <p class="text-[11px] leading-relaxed text-amber-700">
                        ${isPWA 
                            ? 'Karena aplikasi terpasang di Layar Utama HP, buka setelan izin aplikasi langsung dari ponsel Anda.'
                            : 'Peramban ponsel memblokir pop-up izin otomatis. Buka setelan izin situs untuk mengaktifkan notifikasi.'}
                    </p>
                </div>

                <div class="space-y-2">
                    <p class="text-[10px] font-extrabold uppercase text-slate-400 tracking-wider">
                        ${isPWA ? 'Langkah Mengaktifkan di Layar Utama HP:' : 'Langkah Mengaktifkan di Peramban HP:'}
                    </p>
                    
                    ${isPWA ? `
                    <div class="flex items-start gap-3 p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                        <span class="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-extrabold shrink-0 mt-0.5">1</span>
                        <div class="text-[11px] text-slate-700 leading-snug">
                            Buka Layar Utama HP, lalu <strong>Tekan & Tahan (Long Press)</strong> ikon aplikasi <strong>Argumentasi</strong>.
                        </div>
                    </div>
                    <div class="flex items-start gap-3 p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                        <span class="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-extrabold shrink-0 mt-0.5">2</span>
                        <div class="text-[11px] text-slate-700 leading-snug">
                            Pilih ikon <strong>Info Aplikasi (ℹ️)</strong> &rarr; ketuk menu <strong>Notifikasi</strong>.
                        </div>
                    </div>
                    <div class="flex items-start gap-3 p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                        <span class="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-extrabold shrink-0 mt-0.5">3</span>
                        <div class="text-[11px] text-slate-700 leading-snug">
                            Ubah menjadi <strong>Izinkan Notifikasi (Aktif)</strong>, lalu kembali ke aplikasi ini.
                        </div>
                    </div>
                    ` : `
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
                    `}
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

    // MINTA IZIN NOTIFIKASI PONSEL SECARA LANGSUNG PADA CLICK GESTURE PERTAMA (TANPA AWAIT SEBELUMNYA)
    function requestPermission(triggerBtn = null) {
        // Respon getar haptic instan di ponsel
        if ('vibrate' in navigator) {
            try { navigator.vibrate([40, 30, 40]); } catch(e){}
        }

        if (!('Notification' in window)) {
            tampilkanToast('Peramban ponsel ini belum mendukung Web Notification API', true);
            bukaModalPanduanIzin();
            return Promise.resolve(false);
        }

        const statusSaatIni = Notification.permission;

        // KASUS A: SUDAH DISETUJUI SEBELUMNYA
        if (statusSaatIni === 'granted') {
            tampilkanToast('🎉 Izin notifikasi ponsel Anda sudah aktif!');
            updatePermissionBannerUI();
            
            // Tembakkan notifikasi uji coba ke status bar HP
            kirimNotifikasiKePonsel({
                id: 'notif_pwa_ready_' + Date.now(),
                title: '🎉 Notifikasi Ponsel Terhubung!',
                body: 'Sistem notifikasi ponsel Argumentasi berfungsi sempurna di perangkat Anda.',
                category: 'sistem',
                url: 'index.html',
                forceAlert: true
            });
            return Promise.resolve(true);
        }

        // KASUS B: STATUS DIBLOKIR / DENIED
        if (statusSaatIni === 'denied') {
            tampilkanToast('Izin notifikasi diblokir di setelan HP. Silakan buka izin aplikasi.', true);
            bukaModalPanduanIzin();
            return Promise.resolve(false);
        }

        // KASUS C: STATUS DEFAULT - WAJIB PANGGIL SINKRON LANGSUNG TANPA AWAIT AGAR POP-UP ASLI HP MUNCUL!
        let originalBtnHtml = '';
        if (triggerBtn && triggerBtn.innerHTML) {
            originalBtnHtml = triggerBtn.innerHTML;
            triggerBtn.disabled = true;
            triggerBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Meminta Izin...';
        }

        const pulihkanTombol = () => {
            if (triggerBtn && originalBtnHtml) {
                triggerBtn.disabled = false;
                triggerBtn.innerHTML = originalBtnHtml;
            }
        };

        return new Promise((resolve) => {
            const handlePermResult = async (hasil) => {
                pulihkanTombol();
                if (hasil === 'granted') {
                    tampilkanToast('🎉 Selamat! Notifikasi ponsel berhasil diaktifkan.');
                    updatePermissionBannerUI();

                    putarNadaNotifikasi();
                    if ('vibrate' in navigator) {
                        try { navigator.vibrate([100, 50, 150]); } catch(e){}
                    }

                    await kirimNotifikasiKePonsel({
                        id: 'notif_welcome_granted_' + Date.now(),
                        title: '🎉 Notifikasi Ponsel Aktif!',
                        body: 'Ponsel Anda kini terhubung resmi. Pembaruan latihan 24 jam dan info penting akan masuk ke sini.',
                        category: 'sistem',
                        url: 'index.html',
                        forceAlert: true
                    });
                    resolve(true);
                } else {
                    updatePermissionBannerUI();
                    tampilkanToast('Izin notifikasi belum diaktifkan.', true);
                    bukaModalPanduanIzin();
                    resolve(false);
                }
            };

            // Panggilan langsung sinkron murni (Single call stack gesture)
            try {
                let res;
                res = Notification.requestPermission(function(perm) {
                    handlePermResult(perm);
                });
                if (res && typeof res.then === 'function') {
                    res.then(handlePermResult).catch(() => handlePermResult(Notification.permission));
                }
            } catch(e) {
                handlePermResult(Notification.permission || 'denied');
            }
        });
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
                url: 'index.html',
                forceAlert: true
            });
        } else {
            // Jika masih belum granted, coba panggil kembali
            const hasil = await requestPermission();
            if (!hasil) {
                tampilkanToast('Izin masih belum aktif di setelan HP. Silakan ikuti panduan langkah di atas.', true);
            }
        }
    }

    // KIRIM NOTIFIKASI KE STATUS BAR / LOCK SCREEN PONSEL (ANTI-SPAM: CUKUP SEKALI SAJA)
    function kirimNotifikasiKePonsel(options) {
        const settings = getSettings();
        if (!settings.enabled) return Promise.resolve();

        const { id, title, body, category = 'pengumuman', url = 'index.html', icon = 'icon-192.png', forceAlert = false, skipOsAlert = false } = options;
        const notifId = id || ('notif_' + Date.now());

        // Cek apakah notifikasi dengan ID ini SUDAH PERNAH DIKIRIM ke layar HP
        const deliveredMap = getDeliveredIds();
        const alreadyDelivered = !!deliveredMap[notifId];

        // 1. Simpan ke daftar Pusat Notifikasi In-App
        const list = getNotifications();
        const existingIdx = list.findIndex(n => n.id === notifId);
        const notifItem = {
            id: notifId,
            title,
            body,
            category,
            url,
            read: existingIdx >= 0 ? list[existingIdx].read : false,
            createdAt: existingIdx >= 0 ? list[existingIdx].createdAt : new Date().toISOString()
        };

        if (existingIdx >= 0) {
            list[existingIdx] = notifItem;
        } else {
            list.unshift(notifItem);
        }
        if (list.length > 50) list.pop(); // Batasi 50 riwayat
        saveNotifications(list);

        // ATURAN ANTI-SPAM: JIKA SUDAH PERNAH TERKIRIM DAN BUKAN UJI COBA MANUAL, CUKUP SEKALI SAJA!
        // Jangan bunyikan nada chime, jangan getarkan HP, dan jangan tampilkan pop-up ganda saat berpindah halaman!
        if (alreadyDelivered && !forceAlert) {
            return Promise.resolve();
        }

        // Tandai bahwa notifikasi ID ini SUDAH pernah ditampilkan ke HP
        markDelivered(notifId);

        if (skipOsAlert) {
            return Promise.resolve();
        }

        // 2. Mainkan getar dan audio sintetis HANYA SEKALI saat notifikasi pertama kali masuk
        if (settings.vibrate && 'vibrate' in navigator) {
            try { navigator.vibrate([100, 60, 100]); } catch(e){}
        }
        if (settings.sound) {
            putarNadaNotifikasi();
        }

        // 3. Tampilkan ke Bilah Status / Layar Kunci Ponsel jika diizinkan HANYA SEKALI
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

            // Cek status latihan hari ini dari storage utama 'lat_v1'
            const rawLat = localStorage.getItem('lat_v1') || localStorage.getItem('lat_v1_data');
            let isExpiredOrNew = false;

            if (rawLat) {
                const latData = JSON.parse(rawLat);
                const entries = Object.values((latData && latData.hari) || {}).filter(h => h && h.spin && h.spin.ts);
                const latest = entries.sort((a, b) => b.spin.ts - a.spin.ts)[0];
                if (latest && latest.spin && latest.spin.ts) {
                    const sisaWaktu = (latest.spin.ts + 864e5) - now;
                    // Jika 24 jam sudah berlalu
                    if (sisaWaktu <= 0) {
                        isExpiredOrNew = true;
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

    // =========================================================================
    // 5. KOORDINATOR LATAR BELAKANG PEMBUATAN SOAL LATIHAN (Lintas Halaman + Fallback SW)
    // =========================================================================
    const latihanBg = (function() {
        const DBN = 'latihan-db';
        const STORE = 'kv';
        const CHANNEL = 'arg_latihan_bg';
        const TAB_OWNER = 'tab_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        const STAGE_META = {
            prep:     { pct: 12, label: 'Membaca & menyaring materi PDF…' },
            pilgan_a: { pct: 28, label: 'Pacu jalur 1/5: Soal Pilihan Ganda (bagian 1)…' },
            pilgan_b: { pct: 46, label: 'Pacu jalur 2/5: Soal Pilihan Ganda HOTS…' },
            struktur: { pct: 64, label: 'Pacu jalur 3/5: Merancang Bedah Struktur…' },
            esai:     { pct: 80, label: 'Pacu jalur 4/5: Menyusun Esai Analitis…' },
            kritis:   { pct: 94, label: 'Pacu jalur 5/5: Merakit Uji Berpikir Kritis…' }
        };
        let activeTabRun = null;
        let bgChan = null;
        const doneSeen = new Set();

        function openDb() {
            if (typeof indexedDB === 'undefined') return Promise.resolve(null);
            return new Promise(ok => {
                try {
                    const r = indexedDB.open(DBN, 1);
                    r.onupgradeneeded = () => {
                        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
                    };
                    r.onsuccess = () => ok(r.result);
                    r.onerror = () => ok(null);
                } catch (e) { ok(null); }
            });
        }

        async function readKey(key) {
            const db = await openDb();
            if (!db) return null;
            return await new Promise(ok => {
                try {
                    const q = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
                    q.onsuccess = () => ok(q.result || null);
                    q.onerror = () => ok(null);
                } catch (e) { ok(null); }
            });
        }

        async function writeKey(key, val) {
            const db = await openDb();
            if (!db) return false;
            return await new Promise(ok => {
                try {
                    const tx = db.transaction(STORE, 'readwrite');
                    tx.objectStore(STORE).put(val, key);
                    tx.oncomplete = () => ok(true);
                    tx.onerror = () => ok(false);
                    tx.onabort = () => ok(false);
                } catch (e) { ok(false); }
            });
        }

        async function mergePack(cycleKey, partial, fallbackSpin) {
            const db = await openDb();
            if (!db) return false;
            let mergedState = null;
            const saved = await new Promise(ok => {
                try {
                    const tx = db.transaction(STORE, 'readwrite');
                    const store = tx.objectStore(STORE);
                    const g = store.get('state');
                    g.onsuccess = () => {
                        const st = g.result && g.result.hari ? g.result : { v: 1, id: TAB_OWNER, u: Date.now(), hari: {} };
                        if (!st.hari[cycleKey]) {
                            if (!fallbackSpin) return;
                            st.hari[cycleKey] = { spin: fallbackSpin, sesi: {}, hasil: {}, pack: {} };
                        }
                        const day = st.hari[cycleKey];
                        day.pack = Object.assign({}, day.pack || {}, partial);
                        st.u = Date.now();
                        mergedState = st;
                        store.put(st, 'state');
                    };
                    tx.oncomplete = () => ok(true);
                    tx.onerror = () => ok(false);
                    tx.onabort = () => ok(false);
                } catch (e) { ok(false); }
            });
            if (saved && mergedState) {
                try { localStorage.setItem('lat_v1', JSON.stringify(mergedState)); } catch (e) {}
            }
            return saved;
        }

        async function tryAcquireTabLock() {
            const db = await openDb();
            if (!db) return false;
            return await new Promise(ok => {
                let granted = false;
                try {
                    const tx = db.transaction(STORE, 'readwrite');
                    const store = tx.objectStore(STORE);
                    const r = store.get('latihan_lock');
                    r.onsuccess = () => {
                        const cur = r.result;
                        const now = Date.now();
                        if (!cur || cur.owner === TAB_OWNER || cur.expiresAt < now) {
                            granted = true;
                            store.put({ owner: TAB_OWNER, expiresAt: now + 26000 }, 'latihan_lock');
                        }
                    };
                    tx.oncomplete = () => ok(granted);
                    tx.onerror = () => ok(false);
                    tx.onabort = () => ok(false);
                } catch (e) { ok(false); }
            });
        }

        function releaseTabLockSyncBestEffort() {
            openDb().then(db => {
                if (!db) return;
                try {
                    const tx = db.transaction(STORE, 'readwrite');
                    const store = tx.objectStore(STORE);
                    const r = store.get('latihan_lock');
                    r.onsuccess = () => {
                        const cur = r.result;
                        if (cur && cur.owner === TAB_OWNER) {
                            store.put({ owner: TAB_OWNER, expiresAt: 0 }, 'latihan_lock');
                        }
                    };
                } catch (e) {}
            });
        }

        function emitLocalAndChannel(type, payload) {
            const msg = Object.assign({ type }, payload);
            try {
                if (typeof BroadcastChannel !== 'undefined') {
                    const ch = new BroadcastChannel(CHANNEL);
                    ch.postMessage(msg);
                    ch.close();
                }
            } catch (e) {}
            onBgEvent(msg);
        }

        function normalizePgUrut(arr) {
            const rank = { mudah: 0, sedang: 1, sulit: 2, hots: 3 };
            return (arr || []).map((s, i) => [s, i])
                .sort((a, b) => ((rank[a[0].tingkat] ?? 1) - (rank[b[0].tingkat] ?? 1)) || a[1] - b[1])
                .map(x => x[0]);
        }

        async function postCentral(body, timeoutMs = 28000) {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), timeoutMs);
            try {
                const resp = await fetch('/api/central', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: ac.signal
                });
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
                const res = await postCentral({ action: 'latihan_prep', handoutId: job.hid, allowEmergencyFallback });
                job.prep = { judul: res.judul || job.judul, ringkasan: res.ringkasan || '', poinKunci: res.poinKunci || '', segmen: Array.isArray(res.segmen) ? res.segmen : [] };
                await mergePack(job.cycleKey, { ringkasan: job.prep.ringkasan, judul: job.prep.judul, handoutId: job.hid }, fallbackSpin);
                job.stage = 'pilgan_a';
                return res.suggestedDelayMs || 350;
            }
            if (job.stage === 'pilgan_a') {
                const res = await postCentral({ action: 'latihan_pilgan', part: 'a', ...basePrep, seed: job.seed, allowEmergencyFallback });
                job.pilganA = Array.isArray(res.soal) ? res.soal : [];
                job.stage = 'pilgan_b';
                return res.suggestedDelayMs || 350;
            }
            if (job.stage === 'pilgan_b') {
                const stems = (job.pilganA || []).map(x => x.p).filter(Boolean);
                const res = await postCentral({ action: 'latihan_pilgan', part: 'b', ...basePrep, excludeStems: stems, seed: (job.seed || 0) + 1, allowEmergencyFallback });
                const merged = normalizePgUrut((job.pilganA || []).concat(res.soal || [])).slice(0, 15);
                const total = merged.reduce((t, s) => t + (s.waktu || 45), 0);
                await mergePack(job.cycleKey, { ringkasan: (job.prep && job.prep.ringkasan) || '', pilgan: { soal: merged, total } }, fallbackSpin);
                job.pilganA = null;
                job.stage = 'struktur';
                return res.suggestedDelayMs || 350;
            }
            if (job.stage === 'struktur') {
                const res = await postCentral({ action: 'latihan_struktur', ...basePrep, seed: (job.seed || 0) + 2, allowEmergencyFallback });
                await mergePack(job.cycleKey, { struktur: res.struktur }, fallbackSpin);
                job.stage = 'esai';
                return res.suggestedDelayMs || 350;
            }
            if (job.stage === 'esai') {
                const res = await postCentral({ action: 'latihan_esai', ...basePrep, seed: (job.seed || 0) + 3, allowEmergencyFallback });
                await mergePack(job.cycleKey, { esai: res.esai }, fallbackSpin);
                job.stage = 'kritis';
                return res.suggestedDelayMs || 350;
            }
            if (job.stage === 'kritis') {
                const res = await postCentral({ action: 'latihan_kritis', ...basePrep, seed: (job.seed || 0) + 4, allowEmergencyFallback });
                await mergePack(job.cycleKey, { kritis: res.kritis, dibuat: Date.now(), model: res.model || 'hybrid' }, fallbackSpin);
                job.stage = 'done';
                job.status = 'done';
                job.pct = 100;
                job.label = 'Semua soal siap dikerjakan!';
                return 0;
            }
            job.stage = 'done'; job.status = 'done'; job.pct = 100;
            return 0;
        }

        function runTabFallbackQueue() {
            if (activeTabRun) return activeTabRun;
            activeTabRun = (async () => {
                try {
                    const gotLock = await tryAcquireTabLock();
                    if (!gotLock) return;

                    let job = await readKey('latihan_job');
                    if (!job || job.status === 'done' || job.status === 'error') return;

                    if (job.stage === 'prep' && (job.retryCount || 0) === 0 && !job.initialJitterDone) {
                        job.initialJitterDone = true;
                        await writeKey('latihan_job', job);
                        await new Promise(r => setTimeout(r, 120 + Math.floor(Math.random() * 850)));
                    }

                    let steps = 0;
                    while (job && job.status !== 'done' && job.status !== 'error' && steps < 28) {
                        steps++;
                        const fresh = await readKey('latihan_job');
                        if (!fresh || fresh.id !== job.id) {
                            job = fresh;
                            if (!job || job.status === 'done' || job.status === 'error') break;
                        }
                        if (!(await tryAcquireTabLock())) break;

                        const meta = STAGE_META[job.stage] || { pct: 95, label: 'Menyiapkan soal…' };
                        job.status = 'running';
                        job.pct = meta.pct;
                        job.label = meta.label;
                        job.errorMsg = '';
                        job.updatedAt = Date.now();
                        await writeKey('latihan_job', job);
                        emitLocalAndChannel('LATIHAN_PROGRESS', { job });

                        try {
                            const waitNext = await runStageOnce(job);
                            job.retryCount = 0;
                            job.updatedAt = Date.now();
                            await writeKey('latihan_job', job);

                            if (job.status === 'done') {
                                emitLocalAndChannel('LATIHAN_DONE', { job, osNotified: false });
                                break;
                            } else {
                                emitLocalAndChannel('LATIHAN_PROGRESS', { job });
                                if (waitNext > 0) await new Promise(r => setTimeout(r, waitNext + Math.floor(Math.random() * 350)));
                            }
                        } catch (err) {
                            const retryable = err.name === 'AbortError' || err.retryable || err.status === 429 || err.status === 503 || err.status === 504 || err.status === 502 || /network|fetch/i.test(String(err.message || ''));
                            if (!retryable && (err.status === 400 || err.status === 404 || err.status === 413)) {
                                job.status = 'error';
                                job.errorMsg = err.message || 'Materi tidak dapat diproses.';
                                job.updatedAt = Date.now();
                                await writeKey('latihan_job', job);
                                emitLocalAndChannel('LATIHAN_ERROR', { job });
                                break;
                            }
                            job.retryCount = (job.retryCount || 0) + 1;
                            if (job.retryCount > 9) {
                                job.status = 'error';
                                job.errorMsg = err.message || 'Antrean terlalu padat. Ketuk Coba Lagi.';
                                job.updatedAt = Date.now();
                                await writeKey('latihan_job', job);
                                emitLocalAndChannel('LATIHAN_ERROR', { job });
                                break;
                            }
                            const expWait = Math.min(14000, Math.round(1800 * Math.pow(1.45, Math.min(job.retryCount, 5))));
                            const waitMs = Math.max(1500, Math.min(18000, err.retryAfterMs || expWait)) + Math.floor(Math.random() * 1200);
                            job.status = 'waiting';
                            job.label = `Menunggu giliran antrean AI (${Math.ceil(waitMs / 1000)} dtk)…`;
                            job.updatedAt = Date.now();
                            await writeKey('latihan_job', job);
                            emitLocalAndChannel('LATIHAN_PROGRESS', { job });
                            await new Promise(r => setTimeout(r, waitMs));
                        }
                    }
                } finally {
                    releaseTabLockSyncBestEffort();
                    activeTabRun = null;
                }
            })();
            return activeTabRun;
        }

        async function wakeSwQueue(type = 'LATIHAN_RESUME') {
            try {
                if (!('serviceWorker' in navigator)) return false;
                let sent = false;
                if (navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage({ type });
                    sent = true;
                }
                const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
                if (reg) {
                    const target = reg.active || reg.waiting || reg.installing;
                    if (target && target !== navigator.serviceWorker.controller) {
                        target.postMessage({ type });
                        sent = true;
                    }
                }
                return sent;
            } catch (e) {
                return false;
            }
        }

        function scheduleFallbackCheck(expectedJobId, waitMs = 2200) {
            setTimeout(async () => {
                const job = await readKey('latihan_job');
                if (!job || job.status === 'done' || job.status === 'error') return;
                if (expectedJobId && job.id !== expectedJobId) return;
                const lock = await readKey('latihan_lock');
                if (!lock || lock.expiresAt < Date.now()) {
                    await wakeSwQueue('LATIHAN_RESUME');
                    await new Promise(r => setTimeout(r, 400));
                    const lock2 = await readKey('latihan_lock');
                    if (!lock2 || lock2.expiresAt < Date.now()) {
                        runTabFallbackQueue();
                    }
                }
            }, waitMs);
        }

        function onBgEvent(msg) {
            if (!msg || !msg.type || !msg.job) return;
            const diHalamanLatihan = /\/latihan(\.html)?$/i.test(location.pathname);
            if (msg.type === 'LATIHAN_DONE') {
                const doneKey = msg.job.id || msg.job.cycleKey;
                if (doneSeen.has(doneKey)) return;
                doneSeen.add(doneKey);
                if (!diHalamanLatihan) {
                    tampilkanToast(`🎯 Soal latihan "${msg.job.judul}" telah siap dikerjakan!`);
                    kirimNotifikasiKePonsel({
                        id: 'latihan_ready_' + msg.job.cycleKey,
                        title: '🎯 Soal Latihan Hari Ini Siap!',
                        body: `Semua paket soal untuk "${msg.job.judul}" telah selesai disiapkan dan siap dikerjakan.`,
                        category: 'latihan',
                        url: 'latihan.html',
                        skipOsAlert: !!msg.osNotified
                    });
                }
            }
        }

        function startBridge() {
            window.addEventListener('pagehide', releaseTabLockSyncBestEffort);
            try {
                if (typeof BroadcastChannel !== 'undefined' && !bgChan) {
                    bgChan = new BroadcastChannel(CHANNEL);
                    bgChan.onmessage = (e) => onBgEvent(e.data);
                }
            } catch (e) {}
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.addEventListener('message', (e) => onBgEvent(e.data));
            }
            const diHalamanLatihan = /\/latihan(\.html)?$/i.test(location.pathname);
            if (!diHalamanLatihan) {
                setTimeout(async () => {
                    const job = await readKey('latihan_job');
                    if (job && job.status !== 'done' && job.status !== 'error') {
                        await wakeSwQueue('LATIHAN_RESUME');
                        scheduleFallbackCheck(job.id, 2800);
                    }
                }, 1800);
            }
        }

        return {
            readJob: () => readKey('latihan_job'),
            writeJob: (j) => writeKey('latihan_job', j),
            wakeSwQueue,
            scheduleFallbackCheck,
            runTabFallbackQueue,
            startBridge
        };
    })();

    // INISIALISASI OTOMATIS
    function init() {
        updateBadgeUI();
        updatePermissionBannerUI();
        latihanBg.startBridge();

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
        saveSettings,
        latihanBg
    };
})();

// Ekspos ke global window
window.NotifikasiApp = NotifikasiApp;
