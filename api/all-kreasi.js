// api/all-kreasi.js — satu endpoint AI untuk seluruh halaman Ruang Kreasi.
// Tambah fitur baru: tulis handler di HANDLERS lalu panggil dari halaman: K.api('namaAction', {...})
let Groq;
try { Groq = require('groq-sdk'); } catch (err) { console.error("Gagal load groq-sdk:", err); }

const MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];

const sys = level => `Kamu adalah Mentor Menulis Teks Argumentasi untuk siswa ${level === 'sma' ? 'SMA (analitis, diksi kaya, argumen berbobot)' : 'SMP (bahasa sederhana, santun, contoh dekat kehidupan sehari-hari)'} di Indonesia.
Struktur teks argumentasi: Tesis (pendapat/posisi), Argumen (alasan logis + fakta/bukti pendukung), Penegasan ulang/Kesimpulan.
Tujuan akhir: siswa mampu menulis sendiri teks argumentasi yang utuh berdasarkan informasi yang diberikan. Kamu MEMANDU (pertanyaan, petunjuk, umpan balik), BUKAN menuliskan naskah untuk siswa.
Gaya: bahasa Indonesia baku yang hangat dan memotivasi. TEKS POLOS: dilarang memakai simbol markdown (* _ # \`). Keluaran HANYA objek JSON valid.`;

async function callAI(level, user, maxTokens = 1300) {
    if (!Groq) throw new Error("Modul 'groq-sdk' tidak ditemukan. Pastikan package.json ada di root dan di-deploy ulang.");
    if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY tidak ditemukan di Vercel Environment Variables.");
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const errors = [];
    for (const model of MODELS) {
        try {
            const params = { model, temperature: 0.5, max_completion_tokens: maxTokens, response_format: { type: "json_object" },
                messages: [{ role: 'system', content: sys(level) }, { role: 'user', content: user }] };
            if (model.startsWith('openai/')) params.reasoning_effort = 'low';
            const c = await groq.chat.completions.create(params);
            const text = (c.choices[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, '');
            const s = text.indexOf('{'), e = text.lastIndexOf('}');
            if (s === -1 || e === -1) throw new Error("Respons bukan JSON");
            return JSON.parse(text.slice(s, e + 1));
        } catch (err) { console.error(`Model ${model} gagal:`, err.message); errors.push(`${model}: ${err.message}`); }
    }
    throw new Error("Semua model gagal. " + errors.join(' | '));
}

const cl = t => String(t ?? '').replace(/[*_#`]/g, '').trim();
const arr = (a, n) => (Array.isArray(a) ? a : []).map(cl).filter(Boolean).slice(0, n);
const lim = (t, n = 3000) => String(t ?? '').slice(0, n);
const num = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
const words = t => String(t).trim().split(/\s+/).filter(Boolean).length;
const CONN = /karena|sebab|oleh karena itu|oleh sebab itu|misalnya|contohnya|sehingga|dengan demikian|selain itu|namun|artinya|terbukti/gi;

const BAGIAN = {
    tesis: 'Tesis: pernyataan posisi/pendapat yang jelas, spesifik, dan dapat diperdebatkan.',
    argumen: 'Argumen: minimal 2 alasan logis, masing-masing didukung fakta/contoh/data, memakai kata penghubung sebab-akibat.',
    kesimpulan: 'Kesimpulan: menegaskan kembali tesis dengan kata-kata baru, merangkum alasan utama, dan menutup dengan saran/harapan.'
};
const infoTxt = info => arr(info, 6).map((x, i) => `${i + 1}. ${x}`).join('\n');

const HANDLERS = {
    // 3 ide topik + paket informasi untuk tiap ide
    async ideas({ tema, level }) {
        const out = await callAI(level, `Buat 3 ide topik teks argumentasi bertema "${cl(lim(tema, 60)) || 'bebas (pilih yang dekat dengan remaja)'}", beragam sudut pandang, memicu rasa ingin tahu.
Tiap ide berisi: "judul" (6-12 kata), "pertanyaan" (satu pertanyaan pemantik), "sudut" (satu kalimat posisi yang boleh diambil siswa), "info" (TEPAT 4 kalimat informasi/fakta singkat untuk bahan argumen).
ATURAN INFO: pengetahuan umum yang mapan dan bisa diverifikasi. Jangan mengarang statistik, angka persen, nama peneliti, atau tahun yang tidak pasti.
Format: {"ideas":[{"judul":"","pertanyaan":"","sudut":"","info":["","","",""]}]}`);
        const ideas = (out.ideas || []).slice(0, 3).map(i => ({ judul: cl(i.judul), pertanyaan: cl(i.pertanyaan), sudut: cl(i.sudut), info: arr(i.info, 4) })).filter(i => i.judul);
        if (!ideas.length) throw new Error("Ide kosong");
        return { ideas };
    },

    // paket informasi dari judul buatan siswa sendiri
    async infopack({ judul, level }) {
        const j = cl(lim(judul, 150));
        if (j.length < 5) throw new Error("Judul terlalu pendek.");
        const out = await callAI(level, `Siswa ingin menulis teks argumentasi berjudul "${j}".
Berikan: "pertanyaan" (pertanyaan pemantik), "sudut" (satu kalimat posisi yang bisa diambil), "info" (TEPAT 4 kalimat informasi/fakta singkat sebagai bahan argumen).
ATURAN INFO: pengetahuan umum yang mapan; jangan mengarang statistik, angka persen, nama peneliti, atau tahun yang tidak pasti.
Format: {"pertanyaan":"","sudut":"","info":["","","",""]}`);
        return { judul: j, pertanyaan: cl(out.pertanyaan), sudut: cl(out.sudut), info: arr(out.info, 4) };
    },

    // petunjuk pemandu (bukan jawaban jadi)
    async hint({ bagian, judul, sudut, info, teks, level }) {
        const b = BAGIAN[bagian] ? bagian : 'tesis';
        const out = await callAI(level, `Judul: "${cl(lim(judul, 150))}". Sudut yang dipilih: "${cl(lim(sudut, 300))}".
Bahan informasi:\n${infoTxt(info)}
Bagian yang sedang ditulis: ${BAGIAN[b]}
Tulisan siswa saat ini: "${cl(lim(teks, 1500)) || '(masih kosong)'}"
Beri petunjuk memandu: "tips" (TEPAT 3 pertanyaan/arahan singkat yang memancing siswa berpikir, jangan menuliskan jawabannya) dan "pembuka" (TEPAT 2 awal kalimat yang diakhiri "..." untuk dilanjutkan siswa).
Format: {"tips":["","",""],"pembuka":["",""]}`, 700);
        return { tips: arr(out.tips, 3), pembuka: arr(out.pembuka, 2) };
    },

    // umpan balik satu bagian
    async check({ bagian, judul, teks, tesis, level }) {
        const b = BAGIAN[bagian] ? bagian : 'tesis';
        const t = lim(teks, 2500);
        try {
            const out = await callAI(level, `Judul: "${cl(lim(judul, 150))}".${b !== 'tesis' && tesis ? ` Tesis siswa: "${cl(lim(tesis, 500))}".` : ''}
Nilai bagian berikut dengan jujur namun membangun. Kriteria: ${BAGIAN[b]}
Tulisan siswa: "${cl(t)}"
Beri: "skor" (0-100), "kuat" (maks 2 hal yang sudah baik), "perbaiki" (maks 2 hal spesifik yang perlu diperbaiki), "contoh" (satu contoh perbaikan untuk SATU kalimat terlemah, tampilkan versi barunya).
Format: {"skor":0,"kuat":[""],"perbaiki":[""],"contoh":""}`, 800);
            return { mode: 'ai', skor: num(out.skor, 100), kuat: arr(out.kuat, 2), perbaiki: arr(out.perbaiki, 2), contoh: cl(out.contoh) };
        } catch (e) {
            console.error("check offline:", e.message);
            const w = words(t), c = (t.match(CONN) || []).length;
            const target = b === 'argumen' ? 60 : 20;
            const skor = num(25 + Math.min(w, target) / target * 45 + Math.min(c, 3) * 10, 100);
            return { mode: 'offline', skor,
                kuat: [w >= target ? 'Panjang tulisan sudah memadai.' : 'Kamu sudah memulai menulis, bagus!'],
                perbaiki: [c < 2 ? 'Tambahkan kata penghubung seperti karena, misalnya, atau sehingga agar alasanmu lebih jelas.' : 'Tambahkan satu fakta/contoh untuk memperkuat alasan.'], contoh: '' };
        }
    },

    // evaluasi akhir (rubrik 5 x 20)
    async evaluate({ judul, tesis, argumen, kesimpulan, level, info }) {
        const T = { tesis: lim(tesis, 800), argumen: lim(argumen, 3000), kesimpulan: lim(kesimpulan, 800) };
        try {
            const out = await callAI(level, `Nilai teks argumentasi siswa berikut secara adil dan membangun.
Judul: "${cl(lim(judul, 150))}"
Bahan informasi yang diberikan:\n${infoTxt(info)}
TESIS: ${cl(T.tesis)}
ARGUMEN: ${cl(T.argumen)}
KESIMPULAN: ${cl(T.kesimpulan)}
Rubrik (masing-masing 0-20): "tesis" (jelas & dapat diperdebatkan), "argumen" (alasan + bukti, memanfaatkan bahan informasi), "logika" (urutan & hubungan sebab-akibat), "bahasa" (ejaan, kalimat efektif, kata penghubung), "kesimpulan" (menegaskan tesis & merangkum).
Beri juga "kekuatan" (TEPAT 3 hal baik), "perbaikan" (TEPAT 3 saran spesifik), "komentar" (2 kalimat memotivasi).
Format: {"rubrik":{"tesis":0,"argumen":0,"logika":0,"bahasa":0,"kesimpulan":0},"kekuatan":["","",""],"perbaikan":["","",""],"komentar":""}`, 1100);
            const r = out.rubrik || {};
            const rubrik = { tesis: num(r.tesis, 20), argumen: num(r.argumen, 20), logika: num(r.logika, 20), bahasa: num(r.bahasa, 20), kesimpulan: num(r.kesimpulan, 20) };
            return { mode: 'ai', rubrik, skor: Object.values(rubrik).reduce((a, b) => a + b, 0), kekuatan: arr(out.kekuatan, 3), perbaikan: arr(out.perbaikan, 3), komentar: cl(out.komentar) };
        } catch (e) {
            console.error("evaluate offline:", e.message);
            const f = (t, tg) => num(6 + Math.min(words(t), tg) / tg * 10 + Math.min((t.match(CONN) || []).length, 2), 20);
            const rubrik = { tesis: f(T.tesis, 20), argumen: f(T.argumen, 70), logika: f(T.argumen, 90), bahasa: f(T.argumen + ' ' + T.tesis, 90), kesimpulan: f(T.kesimpulan, 20) };
            return { mode: 'offline', rubrik, skor: Object.values(rubrik).reduce((a, b) => a + b, 0),
                kekuatan: ['Struktur tesis, argumen, dan kesimpulan sudah lengkap.', 'Kamu menyelesaikan seluruh bagian tulisan.', 'Terus berlatih, tulisanmu berkembang.'],
                perbaikan: ['Tambahkan fakta atau contoh di setiap alasan.', 'Gunakan kata penghubung agar alur lebih runtut.', 'Baca ulang dan perbaiki ejaan serta kalimat yang terlalu panjang.'],
                komentar: 'Penilaian otomatis sederhana dipakai karena AI sedang sibuk. Coba evaluasi ulang nanti untuk umpan balik yang lebih rinci.' };
        }
    }
};

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: "Method Not Allowed" });
    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const fn = HANDLERS[body.action];
        if (!fn) throw new Error("Action tidak valid. Tersedia: " + Object.keys(HANDLERS).join(', '));
        body.level = body.level === 'sma' ? 'sma' : 'smp';
        return res.status(200).json(await fn(body));
    } catch (error) {
        console.error("All-kreasi API error:", error);
        return res.status(500).json({ error: "Sistem AI Gagal Bekerja", detail_error: error.message });
    }
};
module.exports.config = { maxDuration: 30 };
