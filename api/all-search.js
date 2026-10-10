// api/all-search.js
// Satu endpoint AI untuk banyak halaman. Setiap fitur = satu "action".
// Tambah fitur baru cukup: (1) tulis handler di HANDLERS, (2) panggil dari halaman dengan { action: 'nama' }.
let Groq;
try { Groq = require('groq-sdk'); } catch (err) { console.error("Gagal load groq-sdk:", err); }

/* =====================================================================
   BASIS PENGETAHUAN (sumber kebenaran AI untuk halaman Panduan)
   Tambah/ubah entri di sini bila ada fitur baru. Format: { id, q, a, tags }
   ===================================================================== */
const KB = [
    { id: 'siswa-persiapan', q: 'Apa yang harus dilakukan siswa sebelum mulai belajar?', tags: 'siswa persiapan profil nama papan prestasi mulai',
      a: 'Isi nama Anda di halaman "Profil Saya". Ini penting agar nama Anda tercatat di Papan Prestasi.' },
    { id: 'siswa-gabung-kelas', q: 'Bagaimana cara bergabung ke ruang kelas?', tags: 'gabung masuk kelas kode 6 digit qr scan pindai siswa',
      a: 'Klik menu "Aksi" > "Gabung Kelas" di pojok kanan atas beranda, lalu masukkan 6 digit angka unik atau scan QR Code yang diberikan guru Anda. Di beranda juga tersedia menu "Masuk Kelas" dan "Pindai Kode".' },
    { id: 'siswa-misi', q: 'Bagaimana cara mengerjakan misi latihan?', tags: 'misi latihan membaca menulis mesin pemroses nilai logika siswa',
      a: 'Di dalam Ruang Kelas Anda akan menemukan misi membaca dan menulis. Kerjakan dengan serius, karena Mesin Pemroses akan langsung menilai logika tulisan Anda.' },
    { id: 'siswa-rangkuman', q: 'Bagaimana cara melihat rangkuman otomatis sebuah artikel?', tags: 'rangkuman ekstrak galeri teks artikel inti makna',
      a: 'Saat membaca Galeri Teks atau Artikel, gulir hingga paling bawah lalu tekan tombol "Ekstrak Rangkuman" untuk melihat inti makna tulisan.' },
    { id: 'guru-daftar', q: 'Bagaimana cara guru mendaftar dan masuk ke Portal Guru?', tags: 'guru daftar pendaftaran login masuk portal email verifikasi',
      a: 'Daftar menggunakan alamat email aktif. Anda wajib memverifikasi email dengan mengklik tautan yang dikirim ke inbox sebelum bisa masuk ke Portal Guru.' },
    { id: 'guru-buat-kelas', q: 'Bagaimana cara guru membuat ruang kelas?', tags: 'guru buat membuka ruang kelas dashboard jenjang smp sma cp tp kurikulum kode',
      a: 'Di Dashboard Guru pilih "Buat Ruang Kelas". Anda wajib memilih jenjang pendidikan (SMP/SMA) dan menyematkan CP/TP Kurikulum sebelum sistem membuat kode kelas.' },
    { id: 'guru-modul', q: 'Bagaimana cara mengunggah modul ajar?', tags: 'guru unggah upload modul ajar pdf bahan ajar ekstraksi materi interaktif',
      a: 'Sistem mendukung ekstraksi dokumen PDF. Unggah bahan ajar Anda, lalu Mesin Ekstraksi akan memecahnya menjadi materi interaktif bagi siswa.' },
    { id: 'guru-autograding', q: 'Bagaimana cara menilai esai siswa secara otomatis?', tags: 'guru evaluasi massal autograding otomatis rubrik prestasi esai live',
      a: 'Saat mengontrol kelas secara live, tekan tombol "Evaluasi Massal" di tab Prestasi untuk menilai esai siswa secara otomatis menggunakan indikator rubrik.' },
    { id: 'faq-lupa-sandi', q: 'Bagaimana jika saya lupa kata sandi?', tags: 'lupa kata sandi password reset akun login',
      a: 'Klik tombol "Lupa?" di halaman Log In pada kolom kata sandi. Masukkan email Anda, lalu sistem mengirim tautan reset kata sandi ke kotak masuk email Anda.' },
    { id: 'faq-kode-invalid', q: 'Apa yang harus dilakukan jika kode kelas invalid?', tags: 'kode kelas invalid salah tidak valid gabung',
      a: 'Pastikan Anda mengetik 6 digit angka dengan benar. Jika masih invalid, kemungkinan guru telah menutup atau mengarsipkan ruang kelas tersebut. Hubungi guru Anda untuk meminta kode baru.' },
    { id: 'faq-penilaian-esai', q: 'Bagaimana cara sistem menilai esai saya?', tags: 'nilai penilaian esai evaluator xp poin struktur tesis argumen kesimpulan',
      a: 'Sistem Evaluator membedah struktur tulisan Anda (Tesis, Argumen, Kesimpulan) dan mengecek relevansi serta logika argumentasi berdasarkan kurikulum (CP/TP) yang diatur sebelumnya. Semakin terstruktur tulisan Anda, semakin tinggi Poin XP yang didapat.' },
    { id: 'faq-email-verifikasi', q: 'Bagaimana jika email verifikasi saya tidak masuk?', tags: 'email verifikasi tidak masuk spam junk kirim ulang akun',
      a: 'Periksa folder SPAM atau Junk. Jika tetap tidak ada, tekan tombol "Kirim Ulang Email" di halaman verifikasi. Tunggu 2 menit antar percobaan untuk menghindari spam sistem.' },
    { id: 'faq-kelas-ditutup', q: 'Apakah saya bisa masuk kembali ke kelas yang sudah ditutup?', tags: 'kelas ditutup arsip akhiri kunci nilai riwayat',
      a: 'Tidak bisa. Jika guru menekan "Akhiri & Arsipkan Kelas", ruang kelas dikunci permanen. Namun laporan nilai akhir dan riwayat pengerjaan tetap tersimpan di arsip guru.' },
    { id: 'app-menu', q: 'Apa saja menu yang ada di beranda?', tags: 'menu beranda fitur belajar mandiri teks argumen artikel berita latihan analisis handout ruang kreasi portal guru pindai kode masuk kelas',
      a: 'Menu "Belajar Mandiri" di beranda berisi: Teks Argumen, Artikel Berita, Latihan Analisis, Handout Buku, Ruang Kreasi, Portal Guru, Pindai Kode, dan Masuk Kelas.' },
    { id: 'app-cari', q: 'Bagaimana cara mencari materi atau artikel?', tags: 'cari pencarian search materi artikel kolom cari beranda',
      a: 'Ketik kata kunci di kolom "Cari materi, artikel..." pada bagian atas beranda lalu tekan Enter. Anda akan diarahkan ke halaman hasil pencarian.' },
    { id: 'app-profil', q: 'Bagaimana cara mengubah nama atau foto profil?', tags: 'profil nama foto edit ubah ganti akun saya',
      a: 'Di beranda, ketuk bagian nama Anda lalu pilih "Edit Profil Saya". Untuk melihat foto profil dalam ukuran besar, pilih "Lihat Foto Profil" di menu yang sama.' },
    { id: 'app-tim', q: 'Siapa tim pengembang platform ini?', tags: 'tim pengembang developer pembuat dosen mahasiswa',
      a: 'Daftar tim pengembang beserta jabatan dan identitasnya ditampilkan di bagian "Tim Pengembang" pada halaman beranda.' },
    { id: 'app-bantuan', q: 'Bagaimana cara menghubungi customer support?', tags: 'bantuan support hubungi kontak whatsapp wa admin kendala',
      a: 'Buka halaman Panduan, lalu tekan tombol "Chat Customer Support Sekarang" di bagian bawah. Anda akan diarahkan ke WhatsApp dengan template pesan yang tinggal diisi.' }
];
const KB_BY_ID = Object.fromEntries(KB.map(k => [k.id, k]));
const pub = k => ({ id: k.id, q: k.q, a: k.a });

/* ---------- Pencarian kata kunci (cadangan jika AI gagal) ---------- */
function tokenize(s) { return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2); }
function keywordSearch(query, limit = 4, excludeIds = []) {
    const words = tokenize(query);
    return KB.filter(k => !excludeIds.includes(k.id))
        .map(k => {
            const hay = (k.q + ' ' + k.tags + ' ' + k.a).toLowerCase();
            const score = words.reduce((s, w) => s + (hay.includes(w) ? (k.q.toLowerCase().includes(w) || k.tags.includes(w) ? 2 : 1) : 0), 0);
            return { k, score };
        })
        .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.k);
}

/* ---------- Pemanggil AI bersama (rantai model) ---------- */
const MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];

async function callAI(systemPrompt, userPrompt, maxTokens = 900) {
    if (!Groq) throw new Error("Modul 'groq-sdk' tidak ditemukan. Pastikan package.json ada di root dan di-deploy ulang.");
    if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY tidak ditemukan di Vercel Environment Variables.");
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const errors = [];
    for (const model of MODELS) {
        try {
            const params = {
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
                model, temperature: 0.2, max_completion_tokens: maxTokens,
                response_format: { type: "json_object" }
            };
            if (model.startsWith('openai/')) params.reasoning_effort = 'low';
            const completion = await groq.chat.completions.create(params);
            let text = (completion.choices[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, '');
            const s = text.indexOf('{'), e = text.lastIndexOf('}');
            if (s === -1 || e === -1) throw new Error("Respons model bukan JSON");
            return JSON.parse(text.slice(s, e + 1));
        } catch (err) {
            console.error(`Model ${model} gagal:`, err.message);
            errors.push(`${model}: ${err.message}`);
        }
    }
    throw new Error("Semua model gagal bekerja. " + errors.join(' | '));
}

const clean = t => String(t || '').replace(/[*_#`]/g, '').trim();

/* =====================================================================
   HANDLERS — satu fungsi per fitur/halaman
   ===================================================================== */
const HANDLERS = {

    // Daftar pertanyaan rekomendasi awal (tanpa AI, hemat kuota)
    async suggest() {
        const pilihan = ['siswa-gabung-kelas', 'guru-buat-kelas', 'faq-lupa-sandi', 'faq-penilaian-esai', 'app-menu', 'faq-email-verifikasi'];
        return { related: pilihan.map(id => pub(KB_BY_ID[id])) };
    },

    // Pencarian pintar di halaman Panduan
    async help({ query }) {
        const q = String(query || '').trim().slice(0, 200);
        if (q.length < 2) throw new Error("Pertanyaan terlalu pendek.");

        const kbText = KB.map(k => `[${k.id}] T: ${k.q}\nJ: ${k.a}`).join('\n\n');
        const system = `Kamu adalah Asisten Bantuan platform belajar "Platform Argumentasi" (bahasa Indonesia, untuk siswa dan guru SMP/SMA).
Jawab HANYA berdasarkan BASIS PENGETAHUAN di bawah. Jangan mengarang fitur, tombol, harga, atau langkah yang tidak tertulis.
Jika pertanyaan tidak tercakup, set "found": false, jelaskan singkat bahwa informasinya belum ada di panduan, lalu sarankan tombol "Chat Customer Support" di bagian bawah halaman Panduan.
Gaya: ramah, ringkas (maksimal 4 kalimat), teks polos tanpa simbol markdown (* _ # \`). Sapa langsung ke inti jawaban.

BASIS PENGETAHUAN:
${kbText}

KELUARAN: HANYA JSON valid:
{"found": true/false, "answer": "jawaban", "related": ["id-1","id-2","id-3"]}
"related" berisi 3 id dari basis pengetahuan yang paling relevan sebagai pertanyaan lanjutan (bukan id yang sudah menjadi jawaban utama jika bisa dihindari). Gunakan id persis seperti tertulis.`;

        try {
            const out = await callAI(system, `Pertanyaan pengguna: "${q}"`);
            const answer = clean(out.answer);
            if (!answer) throw new Error("Jawaban kosong");
            let related = (Array.isArray(out.related) ? out.related : []).map(id => KB_BY_ID[String(id)]).filter(Boolean);
            if (related.length < 3) {
                const extra = keywordSearch(q, 3, related.map(r => r.id)).concat(KB.filter(k => k.id.startsWith('app-')));
                for (const k of extra) { if (related.length >= 3) break; if (!related.find(r => r.id === k.id)) related.push(k); }
            }
            return { mode: 'ai', found: out.found !== false, answer, related: related.slice(0, 3).map(pub) };
        } catch (e) {
            // Cadangan: jawab dari basis pengetahuan tanpa AI
            console.error("help fallback:", e.message);
            const hits = keywordSearch(q, 4);
            if (!hits.length) {
                return { mode: 'fallback', found: false,
                    answer: 'Maaf, saya belum menemukan jawabannya di panduan. Silakan coba kata kunci lain atau hubungi Customer Support lewat tombol di bagian bawah halaman ini.',
                    related: (await HANDLERS.suggest()).related.slice(0, 3) };
            }
            return { mode: 'fallback', found: true, answer: hits[0].a, related: hits.slice(1, 4).map(pub) };
        }
    }

    // CONTOH menambah fitur untuk halaman lain:
    // async cariMateri({ query }) { const out = await callAI(systemPrompt, query); return out; }
};

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: "Method Not Allowed" });
    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const fn = HANDLERS[body.action];
        if (!fn) throw new Error("Action tidak valid. Tersedia: " + Object.keys(HANDLERS).join(', '));
        return res.status(200).json(await fn(body));
    } catch (error) {
        console.error("All-search API error:", error);
        return res.status(500).json({ error: "Sistem AI Gagal Bekerja", detail_error: error.message });
    }
};

module.exports.config = { maxDuration: 30 };
