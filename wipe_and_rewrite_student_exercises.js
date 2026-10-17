const fs = require('fs');

const files = ['latihan/pilgan.html', 'latihan/struktur.html', 'latihan/kritis.html', 'latihan/esai.html'];

for (const file of files) {
    let html = fs.readFileSync(file, 'utf8');

    // Remove legacy script tag for L
    html = html.replace(/<script>\n\/\* latihan-core[\s\S]*?window\.L = L;\n\}\)\(\);\n\s*<\/script>/, '');
    html = html.replace(/<script>[\s\n]*\/\* latihan-core[\s\S]*?window\.L = L;\n\}\)\(\);\n\s*<\/script>/, '');

    // Get NAV_BAGIAN
    const moduleNameMatch = html.match(/const NAV_BAGIAN[\s\S]*?\];/);
    const navBagian = moduleNameMatch ? moduleNameMatch[0] : '';

    // For struktur, get LBL
    const lblMatch = html.match(/const LBL[\s\S]*?URUT_LBL = \[.*?\];/);
    const lblConfig = lblMatch ? lblMatch[0] : '';

    const modKey = file.split('/')[1].replace('.html', '');

    const firebaseInit = `
<script type="module">
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const app = initializeApp({ apiKey: "AIzaSyDpUWUIzPXIZN6rrNtsIqcL6VfOE2RLVl0", projectId: "mading-cf676" });
const db = getFirestore(app);
window.db = db;

window.L = {
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    fmt: s => { s = Math.max(0, Math.round(s)); const pad = n => String(n).padStart(2, '0'); return pad(Math.floor(s / 60)) + ':' + pad(s % 60); },
    menit: s => Math.max(1, Math.round(s / 60)),
    nama: () => localStorage.getItem('namaSiswaCendekia') || 'Siswa',
    toast: (msg, err) => {
        let c = document.getElementById('lToast');
        if (!c) { c = document.createElement('div'); c.id = 'lToast'; c.className = 'fixed top-4 left-1/2 -translate-x-1/2 z-[100000] flex flex-col gap-2 w-11/12 max-w-sm pointer-events-none'; document.body.appendChild(c); }
        const t = document.createElement('div'); t.className = \`\${err ? 'bg-red-500' : 'bg-slate-800'} text-white px-4 py-2.5 rounded-xl shadow-lg text-xs font-semibold flex items-center gap-2 up\`;
        t.innerHTML = \`<i class="fas \${err ? 'fa-circle-exclamation' : 'fa-circle-check text-emerald-400'}"></i><span class="flex-1">\${window.L.esc(msg)}</span>\`; c.appendChild(t); setTimeout(() => t.remove(), 3000);
    },
    beep: () => {},
    pdf: async (el, namaBerkas) => {
        if (!window.html2pdf) await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js'; s.onload = ok; s.onerror = () => no(new Error('Pembuat PDF gagal dimuat')); document.head.appendChild(s); });
        const c = el.cloneNode(true); c.style.cssText = 'display:block;position:static;width:700px;background:#fff;color:#0f172a';
        await html2pdf().set({ margin: [10, 10, 12, 10], filename: namaBerkas, image: { type: 'jpeg', quality: .95 }, html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }, pagebreak: { mode: ['css', 'legacy'], avoid: '.nobreak' } }).from(c).save();
    },
    tambahXp: n => {
        let current = parseInt(localStorage.getItem('kelasPointsArg') || '0');
        localStorage.setItem('kelasPointsArg', current + n);
    }
};

const qs = new URLSearchParams(location.search);
const classId = qs.get('id');
const studentId = qs.get('sid') || localStorage.getItem('studentId') || localStorage.getItem('siswa_' + classId);

window.H = { hasil: {}, sesi: {}, pack: {}, spin: { ts: Date.now() } };
window.P = null;
window.soal = null;
window.totalWaktu = 0;
window.sesi = null;
window.timer = null;
window.aktif = false;
window.resolveM = null;
const TKT = { mudah: ['Mudah', 'emerald', 'fa-seedling'], sedang: ['Sedang', 'sky', 'fa-gauge'], sulit: ['Sulit', 'amber', 'fa-mountain'], hots: ['HOTS', 'rose', 'fa-fire'] };
const HURUF = ['A', 'B', 'C', 'D', 'E'];
const $ = id => document.getElementById(id), esc = window.L.esc;

${lblConfig}
${navBagian}

window.normSoal = function(arr) {
    if ('${modKey}' === 'struktur') {
        return (arr || []).map((s, i) => ({
            id: i,
            k: s.t || s.teks || '', j: String(s.label || '').toLowerCase(), bahas: s.alasan || ''
        }));
    } else {
        return (arr || []).map(s => {
            const tk = String(s.tingkat || 'sedang').toLowerCase();
            return {
                p: s.p ?? s.pertanyaan ?? s.pernyataan ?? s.rumpang ?? s.teks ?? 'Soal',
                konteks: s.tesis ?? s.klaim ?? s.konteks ?? s.kutipan ?? s.wacana ?? s.kasus ?? '',
                opsi: Array.isArray(s.opsi) ? s.opsi : (Array.isArray(s.pilihan) ? s.pilihan : []),
                j: typeof s.j === 'number' ? s.j : (HURUF.indexOf(String(s.j ?? '').trim().toUpperCase()) >= 0 ? HURUF.indexOf(String(s.j ?? '').trim().toUpperCase()) : (parseInt(s.j) || 0)),
                tingkat: TKT[tk] ? tk : 'sedang',
                fokus: s.fokus ?? s.jenis ?? '',
                waktu: s.waktu || 60,
                bahas: s.bahas ?? s.pembahasan ?? s.alasan ?? s.kunci ?? '',
                konsep: s.konsep || ''
            };
        });
    }
};

window.modal = (judul, ket, ok, batal, ikon) => new Promise(r => { window.resolveM = r; $('mJudul').textContent = judul; $('mKet').textContent = ket; $('mOk').textContent = ok || 'Lanjutkan'; $('mBatal').textContent = batal || 'Batal'; $('mIkon').innerHTML = \`<i class="fas \${ikon || 'fa-triangle-exclamation'}"></i>\`; $('modal').classList.replace('hidden', 'flex'); });
window.jawabModal = v => { $('modal').classList.replace('flex', 'hidden'); if (window.resolveM) { window.resolveM(v); window.resolveM = null; } };

if ('${modKey}' === 'struktur') {
    window.badge = t => { const [n, c, i] = LBL[t] || LBL.tesis; return \`<span class="inline-flex items-center gap-1 text-[9px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full bg-\${c}-100 text-\${c}-700"><i class="fas \${i}"></i>\${n}</span>\`; };
} else {
    window.badge = t => { const [n, c, i] = TKT[t] || TKT.sedang; return \`<span class="inline-flex items-center gap-1 text-[9px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full bg-\${c}-100 text-\${c}-700"><i class="fas \${i}"></i>\${n}</span>\`; };
}

async function initLatihan() {
    if (!classId) return location.replace('../index.html');

    const backUrl = \`../ruang_belajar_siswa.html?id=\${classId}\` + (studentId ? \`&sid=\${studentId}\` : '');
    $('btnBack').href = backUrl;

    try {
        const docSnap = await getDoc(doc(db, "classes", classId));
        if (!docSnap.exists() || !docSnap.data().aiPaket) throw new Error('Data kelas tidak valid');

        window.H.pack = docSnap.data().aiPaket;
        window.H.pack.judul = docSnap.data().namaKelas || 'Materi Kelas';
        if (!window.H.pack['${modKey}']) return location.replace(backUrl);

        window.P = window.H.pack['${modKey}'];
        const dataSource = '${modKey}' === 'struktur' ? window.P.teks : window.P.soal;
        window.soal = window.normSoal(dataSource);

        if ('${modKey}' === 'struktur') {
            window.totalWaktu = window.P.waktu || window.P.total || 300;
        } else {
            window.totalWaktu = window.P.total || window.P.waktu || window.soal.reduce((a, b) => a + (b.waktu || 60), 0) || 300;
        }

        if($('hSub')) $('hSub').textContent = window.H.pack.judul;

        if (studentId) {
            const studentSnap = await getDoc(doc(db, \`classes/\${classId}/students\`, studentId));
            if (studentSnap.exists()) {
                const sData = studentSnap.data();
                if (sData.latihan && sData.latihan['${modKey}']) {
                    window.H.hasil['${modKey}'] = sData.latihan['${modKey}'];
                }
            }
        }

        const localSesi = JSON.parse(localStorage.getItem('sesi_${modKey}_' + classId) || 'null');
        if (localSesi && !window.H.hasil['${modKey}']) {
            window.H.sesi['${modKey}'] = localSesi;
        }

        if (window.H.hasil['${modKey}']) return window.tampilHasil();
        if (window.H.sesi['${modKey}']) {
            window.sesi = window.H.sesi['${modKey}'];
            return Date.now() >= window.sesi.batas ? window.kumpulkan(true) : window.renderUjian();
        }

        window.tampilIntro();
    } catch(e) {
        console.error(e);
        $('main').innerHTML = \`<div class="bg-white rounded-2xl p-8 text-center border border-slate-200"><i class="fas fa-exclamation-triangle text-4xl text-slate-300 mb-3"></i><p class="text-sm font-bold text-slate-700">Gagal Memuat Latihan</p><p class="text-[11px] text-slate-500 mt-1">Latihan tidak ditemukan atau tidak tersedia.</p><a href="\${backUrl}" class="inline-block mt-4 bg-brand-green text-white text-xs font-bold px-5 py-2.5 rounded-full">Kembali</a></div>\`;
    }
}
`;

    // Replace <script> down to `L.siap().then(...)`
    html = html.replace(/<script>\s*const \$ = id => document\.getElementById[\s\S]*?L\.siap\(\)\.then\(\(\) => \{[\s\S]*?\}\);\n/, firebaseInit);

    // Polyfill functions
    const funcList = ['tampilIntro', 'renderUjian', 'hitungJawab', 'jalankanWaktu', 'kumpulkan', 'navLatihanHtml', 'tampilHasil', 'isiLaporan', 'unduhPdf', 'filterBahas', 'mulai', 'mintaKumpul'];
    for (const fn of funcList) {
        html = html.replace(new RegExp(`function ${fn}\\(`, 'g'), `window.${fn} = function(`);
        html = html.replace(new RegExp(`window\\.${fn}\\s*=\\s*async\\s*\\(\\)`, 'g'), `window.${fn} = async function()`);
    }

    // Update simpan
    html = html.replace(/L\.simpan\(\);/g, `localStorage.setItem('sesi_${modKey}_' + classId, JSON.stringify(window.sesi));`);

    // Globalize vars
    const vars = ['sesi\\.', 'soal\\.', 'soal\\[', 'H\\.', 'P\\.', 'totalWaktu', 'timer', 'aktif'];
    for(const v of vars) {
        html = html.replace(new RegExp(v, 'g'), `window.${v.replace('\\.', '.')}`);
    }
    html = html.replace(/window\.window\./g, 'window.');

    // Adjust Nav HTML
    const navRegex = /window\.navLatihanHtml = function\(\)\s*\{[\s\S]*?\}\s*;/;
    const newNav = `
window.navLatihanHtml = function() {
    const q = \`?id=\${classId}\` + (studentId ? \`&sid=\${studentId}\` : '');
    return \`<div class="bg-white rounded-2xl border border-slate-200 p-4 mt-3"><h3 class="font-bold text-slate-800 text-xs mb-2.5"><i class="fas fa-compass text-brand-green mr-1.5"></i>Latihan Lainnya pada Materi Ini</h3><div class="grid grid-cols-2 gap-2">\${NAV_BAGIAN.map(([k, n, url, ic, c]) => {
        const cur = k === '${modKey}';
        return \`<a href="\${url}\${q}" class="flex items-center gap-2.5 p-2.5 rounded-xl border \${cur ? 'border-brand-green bg-emerald-50/60' : 'border-slate-100 bg-slate-50 hover:border-slate-300'} transition"><div class="w-8 h-8 rounded-lg bg-\${c}-100 text-\${c}-600 flex items-center justify-center text-xs shrink-0"><i class="fas \${ic}"></i></div><div class="min-w-0 flex-1"><p class="font-bold text-[11px] text-slate-800 truncate">\${n}</p><p class="text-[9px] font-semibold text-slate-400">Pilih Latihan</p></div></a>\`;
    }).join('')}</div></div>\`;
};`;
    if(html.match(navRegex)) {
        html = html.replace(navRegex, newNav);
    } else {
        html = html.replace(/function navLatihanHtml\(\)\s*\{[\s\S]*?\}\n/, newNav + "\n");
    }

    // Replace Kumpulkan cleanly
    const kumpulRegex = /window\.kumpulkan = async function\([^\)]*\)\s*\{[\s\S]*?tampilHasil\(true\);\s*\}/;
    const kumpulRegex2 = /window\.kumpulkan = function\([^\)]*\)\s*\{[\s\S]*?tampilHasil\(true\);\s*\}/;
    let newKumpul = '';

    if (modKey === 'esai') {
        newKumpul = `
window.kumpulkan = async function(auto) {
    if (window.H.hasil['${modKey}']) return; window.aktif = false; clearInterval(window.timer);
    const jawab = window.sesi.jawab;
    const dijawab = Object.values(jawab).filter(v => typeof v === 'string' && v.trim().length > 10).length;
    const skor = Math.round(dijawab / window.soal.length * 100);
    const xp = dijawab * 5; window.L.tambahXp(xp);

    window.H.hasil['${modKey}'] = { skor, benar: dijawab, total: window.soal.length, jawab, durasi: Math.round((Math.min(Date.now(), window.sesi.batas) - window.sesi.mulai) / 1000), batas: window.totalWaktu, selesai: Date.now(), auto: !!auto, keluar: window.sesi.keluar || 0, xp };

    if (studentId && classId) {
        try {
            await setDoc(doc(db, \`classes/\${classId}/students\`, studentId), {
                latihan: { ['${modKey}']: window.H.hasil['${modKey}'] }
            }, { merge: true });
        } catch(e) { console.error("Gagal simpan ke DB", e); }
    }

    localStorage.removeItem('sesi_${modKey}_' + classId);

    $('hTimer').classList.add('hidden'); $('barWaktu').classList.add('hidden'); $('bar').classList.add('hidden'); $('btnBack').onclick = null;
    if (auto) window.L.toast('Waktu habis. Jawabanmu otomatis dikumpulkan.', true);
    window.tampilHasil(true);
}`;
    } else {
        newKumpul = `
window.kumpulkan = async function(auto) {
    if (window.H.hasil['${modKey}']) return; window.aktif = false; clearInterval(window.timer);
    const jawab = window.sesi.jawab;
    let benar = 0, skor = 0;

    if ('${modKey}' === 'struktur') {
        benar = window.soal.filter((s, i) => jawab[i] === s.j).length;
        skor = Math.round(benar / window.soal.length * 100);
    } else {
        benar = window.soal.filter((s, i) => jawab[i] === s.j).length;
        skor = Math.round(benar / window.soal.length * 100);
    }

    const xp = Math.round(skor / 4) + (skor >= 80 ? 10 : 0);
    window.L.tambahXp(xp);

    window.H.hasil['${modKey}'] = { skor, benar, total: window.soal.length, jawab, durasi: Math.round((Math.min(Date.now(), window.sesi.batas) - window.sesi.mulai) / 1000), batas: window.totalWaktu, selesai: Date.now(), auto: !!auto, keluar: window.sesi.keluar || 0, xp };

    if (studentId && classId) {
        try {
            await setDoc(doc(db, \`classes/\${classId}/students\`, studentId), {
                latihan: { ['${modKey}']: window.H.hasil['${modKey}'] }
            }, { merge: true });
        } catch(e) { console.error("Gagal simpan ke DB", e); }
    }

    localStorage.removeItem('sesi_${modKey}_' + classId);

    $('hTimer').classList.add('hidden'); $('barWaktu').classList.add('hidden'); $('bar').classList.add('hidden'); $('btnBack').onclick = null;
    if (auto) window.L.toast('Waktu habis. Jawabanmu otomatis dikumpulkan.', true);
    window.tampilHasil(true);
}`;
    }

    if (html.match(kumpulRegex)) {
        html = html.replace(kumpulRegex, newKumpul);
    } else if (html.match(kumpulRegex2)) {
         html = html.replace(kumpulRegex2, newKumpul);
    }

    // Fix tampilHasil scope issues
    const startStr = "window.tampilHasil = function(baru) {";
    const endStr = "window.filterBahas = function(f) {";
    const sIdx = html.indexOf(startStr);
    const eIdx = html.indexOf(endStr);

    if (sIdx !== -1 && eIdx !== -1 && modKey !== 'esai') {
        const R_REF = `window.H.hasil['${modKey}']`;
        let correctTampilHasil = `window.tampilHasil = function(baru) {
    const R = ${R_REF}; window.aktif = false; $('hTimer').classList.add('hidden'); $('barWaktu').classList.add('hidden'); $('bar').classList.add('hidden');

    let tk = {};`;

        if (modKey === 'struktur') {
            correctTampilHasil += `
    window.soal.forEach((s, i) => { const t = tk[s.j] = tk[s.j] || { n: 0, b: 0 }; t.n++; if (R.jawab[i] === s.j) t.b++; });
    const urut = ['tesis', 'argumen', 'kesimpulan'].filter(t => tk[t]);
    const lemah = urut.slice().sort((a, b) => tk[a].b / tk[a].n - tk[b].b / tk[b].n)[0], kuat = urut.slice().sort((a, b) => tk[b].b / tk[b].n - tk[a].b / tk[a].n)[0];`;
        } else {
            correctTampilHasil += `
    window.soal.forEach((s, i) => { const t = tk[s.tingkat] = tk[s.tingkat] || { n: 0, b: 0 }; t.n++; if (R.jawab[i] === s.j) t.b++; });
    const urut = ['mudah', 'sedang', 'sulit', 'hots'].filter(t => tk[t]);
    const lemah = urut.slice().sort((a, b) => tk[a].b / tk[a].n - tk[b].b / tk[b].n)[0], kuat = urut.slice().sort((a, b) => tk[b].b / tk[b].n - tk[a].b / tk[a].n)[0];`;
        }

        correctTampilHasil += `
    const pesan = R.skor >= 80 ? ['Luar biasa!', 'Kemampuanmu sangat kuat.'] : R.skor >= 60 ? ['Bagus!', 'Jawabanmu sudah cukup baik.'] : ['Tetap semangat!', 'Pelajari lagi materinya.'];
    const anim = R.skor >= 80 ? '<div class="tos"><i class="fas fa-hand h hl"></i><i class="fas fa-hand h hr"></i><div class="boom"></div><i class="fas fa-star sp" style="top:8px;left:42%"></i><i class="fas fa-star sp" style="top:24px;left:58%"></i><i class="fas fa-sparkles sp" style="top:70px;left:36%"></i><i class="fas fa-star sp" style="top:78px;left:60%"></i></div>'
        : R.skor >= 60 ? '<div class="tos"><i class="fas fa-thumbs-up goyang" style="font-size:66px;color:#fcd34d;filter:drop-shadow(0 4px 3px rgba(0,0,0,.3))"></i></div>' : '<div class="tos"><i class="fas fa-heart detak" style="font-size:60px;color:#fda4af;filter:drop-shadow(0 4px 3px rgba(0,0,0,.3))"></i></div>';
    const rek = R.skor === 100 ? 'Semua jawabanmu tepat! Pertahankan.' : \`Kamu paling kuat pada tingkat <b>\${kuat}</b> (\${tk[kuat].b}/\${tk[kuat].n}). \${lemah !== kuat || tk[lemah].b < tk[lemah].n ? \`Perkuat analisis tingkat <b>\${lemah}</b> (\${tk[lemah].b}/\${tk[lemah].n}) melalui pembahasan di bawah.\` : ''}\`;

    $('main').innerHTML = \`<div class="up rounded-3xl p-5 text-center text-white shadow-lg" style="background:linear-gradient(135deg,#064e3b,#059669 60%,#34d399)">\${anim}
            <p class="text-[10px] uppercase tracking-[.2em] text-white/70 font-semibold">Skor Akhir</p><div class="flex items-end justify-center gap-1"><span id="skorAngka" class="text-6xl font-extrabold leading-none">0</span><span class="text-xl font-bold text-white/70 mb-1">/100</span></div>
            <p class="font-extrabold text-base mt-2">\${pesan[0]}</p><p class="text-[11px] text-white/80">\${pesan[1]}</p>
            <span class="inline-block mt-3 bg-white/20 rounded-full px-3 py-1 text-[11px] font-bold"><i class="fas fa-star text-amber-300 mr-1"></i>+\${R.xp} XP</span>\${R.auto ? '<p class="text-[10px] text-amber-200 mt-2"><i class="fas fa-clock mr-1"></i>Dikumpulkan otomatis karena waktu habis</p>' : ''}</div>
        <div class="grid grid-cols-3 gap-2.5 mt-3"><div class="bg-white rounded-xl p-3 text-center border border-slate-200"><p class="text-lg font-extrabold text-emerald-600">\${R.benar}</p><p class="text-[9px] font-semibold text-slate-500">Benar</p></div><div class="bg-white rounded-xl p-3 text-center border border-slate-200"><p class="text-lg font-extrabold text-rose-500">\${R.total - R.benar}</p><p class="text-[9px] font-semibold text-slate-500">Salah/Kosong</p></div><div class="bg-white rounded-xl p-3 text-center border border-slate-200"><p class="text-lg font-extrabold text-slate-700">\${window.L.fmt(R.durasi)}</p><p class="text-[9px] font-semibold text-slate-500">dari \${window.L.fmt(R.batas)}</p></div></div>
        <div class="bg-white rounded-2xl border border-slate-200 p-4 mt-3"><h3 class="font-bold text-slate-800 text-sm mb-3">Analisis per Tingkat</h3><div class="space-y-3">\${urut.map(t => { const p = Math.round(tk[t].b / tk[t].n * 100); return \`<div><div class="flex justify-between items-center mb-1">\${window.badge(t)}<span class="text-[11px] font-bold text-slate-600">\${tk[t].b}/\${tk[t].n}</span></div><div class="h-2.5 bg-slate-100 rounded-full overflow-hidden"><div class="h-full bg-blue-500 rounded-full transition-all duration-1000" style="width:0" data-w="\${p}"></div></div></div>\`; }).join('')}</div>
            <div class="mt-4 bg-emerald-50 border border-emerald-100 rounded-xl p-3 text-[11px] text-emerald-900 leading-relaxed"><i class="fas fa-lightbulb text-amber-500 mr-1"></i>\${rek}</div>\${R.keluar ? \`<p class="text-[10px] text-slate-400 mt-2.5"><i class="fas fa-eye-slash mr-1"></i>Kamu meninggalkan halaman \${R.keluar}× saat ujian.</p>\` : ''}</div>
        <div class="grid grid-cols-2 gap-2 mt-3"><button id="btnPdf" onclick="window.unduhPdf()" class="bg-white border border-slate-200 text-slate-700 font-bold py-3 rounded-xl text-xs active:scale-95 transition"><i class="fas fa-file-pdf text-red-500 mr-1.5"></i>Unduh PDF</button><a href="../ruang_belajar_siswa.html?id=\${classId}" class="bg-brand-green text-white font-bold py-3 rounded-xl text-xs shadow-md text-center active:scale-95 transition"><i class="fas fa-house mr-1.5"></i>Ruang Kelas</a></div>
        \${window.navLatihanHtml()}
        <div class="flex items-center justify-between mt-6 mb-3"><h3 class="font-bold text-slate-800 text-sm">Pembahasan</h3><div id="filter" class="flex gap-1.5"></div></div><div id="bahas" class="space-y-3"></div>\`;
    window.scrollTo({ top: 0 });
    let c = 0; const st = Math.max(1, Math.round(R.skor / 40)), ti = setInterval(() => { c = Math.min(R.skor, c + st); $('skorAngka').textContent = c; if (c >= R.skor) clearInterval(ti); }, 30);
    setTimeout(() => document.querySelectorAll('[data-w]').forEach(e => e.style.width = e.dataset.w + '%'), 300);
    if (baru) { if (R.skor >= 80) { window.L.beep('ok'); setTimeout(() => window.confetti && confetti({ particleCount: 140, spread: 80, origin: { y: .4 }, zIndex: 100001 }), 700); } else window.L.beep(R.skor >= 60 ? 'ok' : 'err'); }

    // Only call filterBahas if it exists. (Struktur uses something else but lets abstract it for now)
    if (typeof window.filterBahas === 'function') window.filterBahas('semua');
};

window.isiLaporan = function() {
    const R = window.H.hasil['${modKey}'], tk = {}; window.soal.forEach((s, i) => { const t = tk[s.tingkat] = tk[s.tingkat] || { n: 0, b: 0 }; t.n++; if (R.jawab[i] === s.j) t.b++; });
    const tgls = new Date(window.H.spin.ts).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const A = i => R.jawab[i] === undefined ? '-' : HURUF[R.jawab[i]] + '. ' + window.L.esc(window.soal[i].opsi[R.jawab[i]]);
    $('laporan').innerHTML = \`<div style="padding:4px"><div style="border-bottom:3px solid #059669;padding-bottom:8px;margin-bottom:12px"><div style="font-size:17px;font-weight:800;color:#064e3b">LAPORAN LATIHAN</div><div style="color:#64748b;font-size:11px">Platform Argumentasi · Ruang Latihan</div></div>
        <table style="width:100%;font-size:12px;margin-bottom:12px"><tr><td style="width:90px;color:#64748b">Nama</td><td><b>\${window.L.esc(window.L.nama())}</b></td></tr><tr><td style="color:#64748b">Tanggal</td><td>\${tgls}</td></tr><tr><td style="color:#64748b">Materi</td><td>\${window.L.esc(window.H.pack.judul)}</td></tr><tr><td style="color:#64748b">Waktu</td><td>\${window.L.fmt(R.durasi)} dari \${window.L.fmt(R.batas)}\${R.auto ? ' (waktu habis)' : ''}</td></tr></table>
        <div class="nobreak" style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:10px 14px;margin-bottom:12px"><span style="font-size:30px;font-weight:800;color:#059669">\${R.skor}</span><span style="color:#64748b"> / 100</span> &nbsp;·&nbsp; Benar <b>\${R.benar}</b> dari <b>\${R.total}</b> soal</div>
        <div style="font-size:9px;color:#94a3b8;margin-top:10px;text-align:center">Dihasilkan otomatis oleh Platform Argumentasi · \${new Date(R.selesai).toLocaleString('id-ID')}</div></div>\`;
};

window.unduhPdf = async function() {
    const b = $('btnPdf'), isi = b.innerHTML; b.disabled = true; b.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-1.5"></i>Membuat PDF…';
    try { window.isiLaporan(); await window.L.pdf($('laporan'), \`Laporan-Latihan-\${new Date(window.H.spin.ts).toISOString().slice(0, 10)}.pdf\`); window.L.toast('PDF berhasil dibuat.'); }
    catch (e) { console.error(e); window.L.toast('Gagal membuat PDF. Memakai cetak browser…', true); setTimeout(() => window.print(), 600); }
    finally { b.disabled = false; b.innerHTML = isi; }
};

initLatihan();
`;
        html = html.substring(0, sIdx) + correctTampilHasil + "\n</script>\n</body>";
    }

    // Replace async arrow functions left over
    html = html.replace(/window\.mulai = async function\(\)\s*=>\s*\{/g, "window.mulai = async function() {");
    html = html.replace(/window\.unduhPdf = async function\(\)\s*=>\s*\{/g, "window.unduhPdf = async function() {");

    // Execute init
    if (!html.includes("initLatihan();")) {
         html = html.replace(/<\/script>\s*<\/body>/, 'initLatihan();\n</script>\n</body>');
    }

    // For esai, update logic again properly to use textareas instead of multiple choice
    if (modKey === 'esai') {
         html = html.replace(/const A = i => [\s\S]*?;/, '');
         html = html.replace(/<style>[\s\S]*?<\/style>/, `<style>
        body { font-family: 'Poppins', sans-serif; background: #e2e8f0; -webkit-tap-highlight-color: transparent; }
        .up { animation: up .35s ease-out both; } @keyframes up { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        .kertas { background: #fffdf8; background-image: repeating-linear-gradient(transparent 0 31px, rgba(148,163,184,.18) 31px 32px); border: 1px solid #e7e5e4; border-left: 3px solid #fca5a5; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
        textarea.esai-input { width: 100%; min-height: 120px; border: 2px solid #e2e8f0; border-radius: .8rem; padding: .75rem; font-size: 13px; color: #334155; background: #fff; transition: all .18s; resize: vertical; line-height: 1.6; }
        textarea.esai-input:focus { outline: none; border-color: #059669; box-shadow: 0 0 0 4px rgba(5, 150, 105, 0.1); }
        .waktu-kritis { animation: dk 1s infinite; } @keyframes dk { 50% { background: #dc2626; } }
        .tos { position: relative; height: 112px; display: flex; justify-content: center; align-items: center; }
        .tos .h { position: absolute; font-size: 66px; color: #fcd34d; filter: drop-shadow(0 4px 3px rgba(0,0,0,.3)); }
        .hl { animation: tosL 1.2s cubic-bezier(.2,.9,.3,1.15) .1s both; } .hr { animation: tosR 1.2s cubic-bezier(.2,.9,.3,1.15) .1s both; }
        @keyframes tosL { 0% { transform: translateX(-170px) rotate(-55deg); opacity: 0; } 50% { transform: translateX(-6px) rotate(-8deg); opacity: 1; } 62% { transform: translateX(-20px) rotate(-22deg); } 100% { transform: translateX(-12px) rotate(-14deg); opacity: 1; } }
        @keyframes tosR { 0% { transform: scaleX(-1) translateX(-170px) rotate(-55deg); opacity: 0; } 50% { transform: scaleX(-1) translateX(-6px) rotate(-8deg); opacity: 1; } 62% { transform: scaleX(-1) translateX(-20px) rotate(-22deg); } 100% { transform: scaleX(-1) translateX(-12px) rotate(-14deg); opacity: 1; } }
        .tos .boom { position: absolute; width: 20px; height: 20px; border-radius: 9999px; border: 4px solid #fde047; opacity: 0; animation: boom .7s ease-out .62s both; }
        @keyframes boom { 0% { transform: scale(.2); opacity: 1; } 100% { transform: scale(6); opacity: 0; } }
        .tos .sp { position: absolute; color: #fde047; font-size: 14px; opacity: 0; animation: sp .9s ease-out .65s both; }
        @keyframes sp { 0% { transform: scale(0) rotate(0); opacity: 0; } 40% { opacity: 1; } 100% { transform: scale(1.4) rotate(120deg); opacity: 0; } }
        .goyang { animation: goy 1.2s ease-in-out infinite; } @keyframes goy { 0%,100% { transform: translateY(0) rotate(-6deg); } 50% { transform: translateY(-12px) rotate(6deg); } }
        .detak { animation: dtk 1.2s ease-in-out infinite; } @keyframes dtk { 0%,100% { transform: scale(1); } 50% { transform: scale(1.18); } }
        .rpt { display: none; font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 1.5; }
        @media print { body > *:not(#laporan) { display: none !important; } #laporan { display: block !important; } body { background: #fff; } }
</style>`);

         const esaiTampilHasil = `window.tampilHasil = function(baru) {
    const R = window.H.hasil.esai; window.aktif = false; $('hTimer').classList.add('hidden'); $('barWaktu').classList.add('hidden'); $('bar').classList.add('hidden');

    const pesan = R.benar > 0 ? ['Luar biasa!', 'Kamu telah menyelesaikan latihan esai ini.'] : ['Tetap semangat!', 'Lain kali coba isi jawabanmu dengan lebih lengkap.'];
    const anim = R.benar > 0 ? '<div class="tos"><i class="fas fa-hand h hl"></i><i class="fas fa-hand h hr"></i><div class="boom"></div><i class="fas fa-star sp" style="top:8px;left:42%"></i><i class="fas fa-star sp" style="top:24px;left:58%"></i><i class="fas fa-sparkles sp" style="top:70px;left:36%"></i><i class="fas fa-star sp" style="top:78px;left:60%"></i></div>'
        : '<div class="tos"><i class="fas fa-heart detak" style="font-size:60px;color:#fda4af;filter:drop-shadow(0 4px 3px rgba(0,0,0,.3))"></i></div>';

    $('main').innerHTML = \`<div class="up rounded-3xl p-5 text-center text-white shadow-lg" style="background:linear-gradient(135deg,#064e3b,#059669 60%,#34d399)">\${anim}
            <p class="text-[10px] uppercase tracking-[.2em] text-white/70 font-semibold">Status Pengerjaan</p><div class="flex items-end justify-center gap-1"><span class="text-4xl font-extrabold leading-none mt-2">Selesai</span></div>
            <p class="font-extrabold text-base mt-4">\${pesan[0]}</p><p class="text-[11px] text-white/80">\${pesan[1]}</p>
            <span class="inline-block mt-3 bg-white/20 rounded-full px-3 py-1 text-[11px] font-bold"><i class="fas fa-star text-amber-300 mr-1"></i>+\${R.xp} XP Partisipasi</span>\${R.auto ? '<p class="text-[10px] text-amber-200 mt-2"><i class="fas fa-clock mr-1"></i>Dikumpulkan otomatis karena waktu habis</p>' : ''}</div>
        <div class="grid grid-cols-2 gap-2.5 mt-3"><div class="bg-white rounded-xl p-3 text-center border border-slate-200"><p class="text-lg font-extrabold text-emerald-600">\${R.benar}</p><p class="text-[9px] font-semibold text-slate-500">Soal Dijawab</p></div><div class="bg-white rounded-xl p-3 text-center border border-slate-200"><p class="text-lg font-extrabold text-slate-700">\${window.L.fmt(R.durasi)}</p><p class="text-[9px] font-semibold text-slate-500">dari \${window.L.fmt(R.batas)}</p></div></div>
        <div class="grid grid-cols-2 gap-2 mt-3"><button id="btnPdf" onclick="unduhPdf()" class="bg-white border border-slate-200 text-slate-700 font-bold py-3 rounded-xl text-xs active:scale-95 transition"><i class="fas fa-file-pdf text-red-500 mr-1.5"></i>Unduh PDF</button><a href="../ruang_belajar_siswa.html?id=\${classId}\${studentId ? \`&sid=\${studentId}\` : ''}" class="bg-brand-green text-white font-bold py-3 rounded-xl text-xs shadow-md text-center active:scale-95 transition"><i class="fas fa-house mr-1.5"></i>Ruang Kelas</a></div>
        \${window.navLatihanHtml()}
        <div class="flex items-center justify-between mt-6 mb-3"><h3 class="font-bold text-slate-800 text-sm">Review Jawabanmu</h3></div><div id="bahas" class="space-y-3"></div>\`;
    window.scrollTo({ top: 0 });
    if (baru) { if (R.benar > 0) { window.L.beep('ok'); setTimeout(() => window.confetti && confetti({ particleCount: 140, spread: 80, origin: { y: .4 }, zIndex: 100001 }), 700); } else window.L.beep('ok'); }

    $('bahas').innerHTML = window.soal.map((s, i) => {
        const u = R.jawab[i] || '';
        const diJawab = u.trim().length > 10;
        return \`<article class="bg-white rounded-2xl border border-slate-200 p-4"><div class="flex items-center gap-2 mb-2"><span class="w-6 h-6 rounded-full bg-slate-800 text-white text-[11px] font-extrabold flex items-center justify-center">\${i + 1}</span>\${window.badge(s.tingkat)}<span class="ml-auto text-[10px] font-bold \${diJawab ? 'text-emerald-600' : 'text-rose-500'}">\${diJawab ? 'Dijawab' : 'Tidak Valid/Kosong'}</span></div>
            <p class="font-reading text-[12px] text-slate-800 leading-[1.75] mb-2.5">\${window.L.esc(s.p)}</p>
            <div class="bg-slate-50 rounded-lg p-2.5 mb-2.5 border border-slate-100">
                <p class="text-[10px] font-bold text-slate-500 mb-1">Jawabanmu:</p>
                <p class="text-[11px] text-slate-700 whitespace-pre-wrap">\${u ? window.L.esc(u) : '<i class="text-slate-400">Kosong</i>'}</p>
            </div>
            \${s.bahas ? \`<div class="bg-emerald-50 rounded-lg p-2.5 text-[11px] text-emerald-900 leading-relaxed border border-emerald-100"><b class="text-emerald-700">Poin Penting (Ekspektasi AI):</b> \${window.L.esc(s.bahas)}</div>\` : ''}</article>\`;
    }).join('');
};
window.isiLaporan = function() {
    const R = window.H.hasil['esai'];
    const tgls = new Date(window.H.spin.ts).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    $('laporan').innerHTML = \`<div style="padding:4px"><div style="border-bottom:3px solid #059669;padding-bottom:8px;margin-bottom:12px"><div style="font-size:17px;font-weight:800;color:#064e3b">LAPORAN LATIHAN — ESAI</div><div style="color:#64748b;font-size:11px">Platform Argumentasi · Ruang Latihan</div></div>
        <table style="width:100%;font-size:12px;margin-bottom:12px"><tr><td style="width:90px;color:#64748b">Nama</td><td><b>\${window.L.esc(window.L.nama())}</b></td></tr><tr><td style="color:#64748b">Tanggal</td><td>\${tgls}</td></tr><tr><td style="color:#64748b">Materi</td><td>\${window.L.esc(window.H.pack.judul)}</td></tr><tr><td style="color:#64748b">Waktu</td><td>\${window.L.fmt(R.durasi)} dari \${window.L.fmt(R.batas)}\${R.auto ? ' (waktu habis)' : ''}</td></tr></table>
        <div class="nobreak" style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:10px 14px;margin-bottom:12px"><span style="font-size:30px;font-weight:800;color:#059669">\${R.skor}</span><span style="color:#64748b"> / 100</span> &nbsp;·&nbsp; Terjawab <b>\${R.benar}</b> dari <b>\${R.total}</b> soal</div>
        <div style="font-size:9px;color:#94a3b8;margin-top:10px;text-align:center">Dihasilkan otomatis oleh Platform Argumentasi · \${new Date(R.selesai).toLocaleString('id-ID')}</div></div>\`;
};
initLatihan();
</script>
</body>
</html>
`;
         if (html.includes("window.tampilHasil = function(baru) {")) {
             const esIdx = html.indexOf("window.tampilHasil = function(baru) {");
             if (esIdx !== -1) {
                 html = html.substring(0, esIdx) + esaiTampilHasil;
             }
         }

         const esaiIntro = `window.tampilIntro = function() {
    $('main').innerHTML = \`<div class="up bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
        <div class="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center text-2xl mx-auto"><i class="fas fa-pen-nib"></i></div>
        <h2 class="text-center font-extrabold text-slate-800 text-base mt-3">Esai Argumentasi</h2><p class="text-center text-[11px] text-slate-500 mt-1 leading-relaxed">Susun argumenmu sendiri berdasarkan materi <b>\${window.L.esc(window.H.pack.judul)}</b>. Gunakan logika dan bukti yang kuat.</p>
        <div class="grid grid-cols-2 gap-2.5 mt-5"><div class="bg-slate-50 rounded-xl p-3 text-center"><p class="text-2xl font-extrabold text-slate-800">\${window.soal.length}</p><p class="text-[10px] text-slate-500 font-semibold">Soal Esai</p></div><div class="bg-slate-50 rounded-xl p-3 text-center"><p class="text-2xl font-extrabold text-slate-800">\${window.L.menit(window.totalWaktu)}</p><p class="text-[10px] text-slate-500 font-semibold">Menit total</p></div></div>
        <ul class="mt-5 space-y-2 text-[11px] text-slate-600 leading-relaxed">
            <li class="flex gap-2"><i class="fas fa-quote-left text-emerald-500 mt-0.5"></i><span>Jawab setiap pertanyaan esai secara mendalam dan jelas.</span></li>
            <li class="flex gap-2"><i class="fas fa-lock text-rose-500 mt-0.5"></i><span><b>Hanya bisa dikerjakan 1 kali per sesi.</b> Setelah dimulai, waktu terus berjalan walau halaman ditutup.</span></li>
        </ul>
        <button onclick="window.mulai()" class="mt-6 w-full bg-brand-green text-white font-bold py-3.5 rounded-xl shadow-md text-sm active:scale-95 transition"><i class="fas fa-play mr-1.5"></i>Mulai Latihan</button></div>\`;
}`;
         const eiIdx = html.indexOf("window.tampilIntro = function() {");
         const emIdx = html.indexOf("window.mulai = async function() {");
         if (eiIdx !== -1 && emIdx !== -1) {
             html = html.substring(0, eiIdx) + esaiIntro + "\n" + html.substring(emIdx);
         }

         const esaiUjian = `window.renderUjian = function() {
    window.aktif = true; $('hTimer').classList.remove('hidden'); $('barWaktu').classList.remove('hidden'); $('bar').classList.remove('hidden'); $('btnBack').removeAttribute('href'); $('btnBack').onclick = e => { e.preventDefault(); window.L.toast('Ujian sedang berjalan. Selesaikan atau kumpulkan dulu.', true); };
    $('main').innerHTML = \`<div class="kertas up p-4 pl-5 mb-4"><p class="text-center text-[10px] font-extrabold tracking-[.25em] text-slate-500">LEMBAR SOAL</p><h2 class="text-center font-reading font-bold text-slate-800 text-[15px] mt-1">Esai Argumentasi</h2>
        <div class="mt-3 text-[11px] text-slate-600 space-y-0.5"><p><b class="inline-block w-14">Nama</b>: \${window.L.esc(window.L.nama())}</p><p><b class="inline-block w-14">Materi</b>: \${window.L.esc(window.H.pack.judul)}</p><p><b class="inline-block w-14">Petunjuk</b>: Tulis jawaban esaimu dengan argumen yang jelas dan kuat.</p></div></div>
        <div id="daftar" class="space-y-4">\${window.soal.map((s, i) => \`<article id="q\${i}" class="kertas p-4 pl-5">
            <div class="flex items-center gap-2 mb-2.5"><span class="w-7 h-7 rounded-full bg-slate-800 text-white text-xs font-extrabold flex items-center justify-center">\${i + 1}</span>\${window.badge(s.tingkat)}<span class="ml-auto text-[10px] font-semibold text-slate-400"><i class="far fa-clock"></i> \${window.L.fmt(s.waktu)}</span></div>
            <p class="font-reading text-[13px] text-slate-800 leading-[1.8] mb-3">\${window.L.esc(s.p)}</p>
            <textarea class="esai-input" data-i="\${i}" placeholder="Ketik jawabanmu di sini...">\${window.L.esc(window.sesi.jawab[i] || '')}</textarea></article>\`).join('')}</div><div class="h-6"></div>\`;
    $('daftar').addEventListener('input', e => {
        if (e.target.tagName.toLowerCase() === 'textarea' && window.aktif) {
            const i = +e.target.dataset.i;
            window.sesi.jawab[i] = e.target.value;
            localStorage.setItem('sesi_esai_' + classId, JSON.stringify(window.sesi));
            window.hitungJawab();
        }
    });
    window.hitungJawab(); window.jalankanWaktu();
}`;
         const euIdx = html.indexOf("window.renderUjian = function() {");
         const ecIdx = html.indexOf("window.hitungJawab = function() {");
         if (euIdx !== -1 && ecIdx !== -1) {
             html = html.substring(0, euIdx) + esaiUjian + "\n" + html.substring(ecIdx);
         }
    }

    fs.writeFileSync(file, html);
    console.log(file + " rebuilt perfectly.");
}
