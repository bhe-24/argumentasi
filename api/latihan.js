// api/latihan.js — membaca PDF handout dengan Groq / Gemini SATU KALI jalan dan menghasilkan seluruh paket soal harian
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'mading-cf676';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyDpUWUIzPXIZN6rrNtsIqcL6VfOE2RLVl0'; 

// Model Gemini yang valid
const MODELS = [...new Set([process.env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-3.6-flash'].filter(Boolean))];

// Inisialisasi Groq SDK
let Groq; try { Groq = require('groq-sdk'); } catch (err) { console.error("Gagal load groq-sdk:", err); }
const MODELS_GROQ = [...new Set([process.env.GROQ_MODEL, 'openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'].filter(Boolean))];

const MAKS_PDF = 14 * 1024 * 1024;
const galat = (pesan, status) => Object.assign(new Error(pesan), { status });
const bersih = (t, n = 600) => String(t ?? '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

const TINGKAT = ['mudah', 'sedang', 'sulit', 'hots'];
const RENTANG = { mudah: [30, 60], sedang: [45, 90], sulit: [60, 120], hots: [90, 180] };
const jepit = (v, [a, b]) => Math.max(a, Math.min(b, Math.round(Number(v)) || a));
const acak = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/* ---------- Ambil data handout dari Firestore ---------- */
async function ambilHandout(id) {
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(String(id || ''))) throw galat('ID materi tidak valid.', 400);
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/handouts/${id}?key=${WEB_API_KEY}`);
    if (r.status === 404) throw galat('Materi tidak ditemukan.', 404);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw galat('Gagal membaca data materi: ' + ((j.error && j.error.message) || r.status), 502);
    const f = j.fields || {}, v = k => (f[k] && (f[k].stringValue ?? '')) || '';
    if (v('status') === 'draft' || v('status') === 'dihapus') throw galat('Materi ini tidak tersedia.', 404);
    const url = v('fileUrl');
    let host = ''; try { host = new URL(url).hostname; } catch (e) {}
    if (!/^https:\/\//.test(url) || !(host.endsWith('cloudinary.com') || host === 'firebasestorage.googleapis.com')) throw galat('Alamat file materi tidak diizinkan.', 400);
    return { judul: v('judul') || 'Materi', url };
}

async function ambilPdf(url) {
    const r = await fetch(url);
    if (!r.ok) throw galat('File PDF tidak bisa dibuka (HTTP ' + r.status + ').', 502);
    const ab = await r.arrayBuffer();
    if (ab.byteLength > MAKS_PDF) throw galat('File PDF terlalu besar untuk dianalisis.', 413);
    return Buffer.from(ab).toString('base64');
}

/* ---------- Prompt ---------- */
const PROMPT = judul => `Kamu adalah guru Bahasa Indonesia yang ahli menyusun asesmen penalaran dan teks argumentasi untuk siswa SMP/SMA.
Terlampir dokumen PDF materi berjudul "${judul}". Baca ISINYA, lalu susun SATU paket latihan harian yang seluruh soalnya didasarkan pada isi dokumen itu. Jangan mengarang fakta di luar dokumen.
Bahasa Indonesia baku, teks polos (tanpa markdown). Keluarkan HANYA satu objek JSON valid dengan struktur persis berikut:

{
 "ringkasan": "2-3 kalimat inti materi",
 "pilgan": [ 15 soal, urut dari mudah ke sulit:
  { "p": "pertanyaan", "opsi": ["A","B","C","D"], "j": 0, "tingkat": "mudah|sedang|sulit|hots", "waktu": 45, "bahas": "alasan jawaban benar (1-2 kalimat)" } ],
 "struktur": { "judul": "judul teks", "waktu": 300, "teks": [ 7 kalimat berurutan: { "t": "kalimat", "label": "tesis|argumen|kesimpulan", "alasan": "mengapa label itu" } ] },
 "esai": [ 6 soal "isi argumentasi": { "tesis": "pernyataan pendapat berdasar materi", "opsi": ["argumen A","argumen B","argumen C","argumen D"], "j": 0, "tingkat": "sedang|sulit|hots", "waktu": 90, "bahas": "mengapa argumen itu paling tepat dan yang lain lemah" } ],
 "kritis": [ 8 soal uji berpikir (teori penalaran: fakta vs opini, sebab-akibat, asumsi, sesat pikir, kredibilitas sumber, kesimpulan yang sah, dsb.) berbasis konteks materi:
  { "konsep": "nama konsep", "p": "skenario/pernyataan + pertanyaan", "opsi": ["A","B","C","D"], "j": 0, "tingkat": "sedang|sulit|hots", "waktu": 75, "bahas": "penjelasan" } ]
}

ATURAN:
- Pilgan: komposisi 4 mudah, 5 sedang, 3 sulit, 3 hots.
- "waktu" dalam detik per soal. "j" = indeks 0-3.
- Larang opsi "semua benar/salah".`;

/* ---------- Integrasi Gemini ---------- */
async function tanyaGemini(judul, pdfB64) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw galat('GEMINI_API_KEY belum diisi di Vercel Environment Variables.', 500);
    const catatan = [];
    for (const model of MODELS) {
        const ac = new AbortController(), t = setTimeout(() => ac.abort(), 55000);
        try {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
                method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
                body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROMPT(judul) }, { inlineData: { mimeType: 'application/pdf', data: pdfB64 } }] }],
                    generationConfig: { responseMimeType: 'application/json', temperature: 0.6, maxOutputTokens: 8192 } }) });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
            const teks = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map(p => p.text || '').join('');
            const s = teks.indexOf('{'), e = teks.lastIndexOf('}'); if (s === -1 || e === -1) throw new Error('Respons bukan JSON');
            return { paket: rapikan(JSON.parse(teks.slice(s, e + 1))), model };
        } catch (err) { console.error(`Gemini ${model} gagal:`, err.message); catatan.push(`${model}: ${err.message}`); }
        finally { clearTimeout(t); }
    }
    throw galat('Gemini belum berhasil menyusun soal. ' + catatan.join(' | '), 502);
}

/* ---------- Integrasi Groq ---------- */
async function tanyaGroq(judul, pdfB64) {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw galat('GROQ_API_KEY belum diisi di Vercel Environment Variables.', 500);
    if (!Groq) throw galat('groq-sdk belum terinstall di project.', 500);
    
    const groqClient = new Groq({ apiKey: key });
    const catatan = [];
    
    // Potong Base64 jika terlalu panjang agar tidak melebihi konteks pesan Groq
    const pdfB64Clipped = pdfB64.slice(0, 500000); 

    for (const model of MODELS_GROQ) {
        const ac = new AbortController(), t = setTimeout(() => ac.abort(), 50000);
        try {
            const completion = await groqClient.chat.completions.create({
                model: model,
                messages: [
                    { role: 'user', content: `${PROMPT(judul)}\n\n(Catatan: Sumber data PDF materi Base64):\n${pdfB64Clipped}` }
                ],
                temperature: 0.6,
                response_format: { type: 'json_object' }
            }, { signal: ac.signal });

            const teks = completion.choices[0]?.message?.content || '';
            const s = teks.indexOf('{'), e = teks.lastIndexOf('}'); if (s === -1 || e === -1) throw new Error('Respons bukan JSON');
            return { paket: rapikan(JSON.parse(teks.slice(s, e + 1))), model: `groq/${model}` };
        } catch (err) { 
            console.error(`Groq ${model} gagal:`, err.message); 
            catatan.push(`${model}: ${err.message}`); 
        } finally { clearTimeout(t); }
    }
    throw galat('Groq belum berhasil menyusun soal. ' + catatan.join(' | '), 502);
}

/* ---------- Normalisasi Data ---------- */
function soalPg(x, tingkatDefault) {
    const opsi = (Array.isArray(x.opsi) ? x.opsi : []).map(o => bersih(o, 300)).filter(Boolean);
    const j = Number(x.j), p = bersih(x.p || x.tesis, 900);
    if (!p || opsi.length !== 4 || new Set(opsi).size !== 4 || !Number.isInteger(j) || j < 0 || j > 3) return null;
    const benar = opsi[j], baru = acak(opsi);
    let tingkat = String(x.tingkat || '').toLowerCase(); if (!TINGKAT.includes(tingkat)) tingkat = tingkatDefault;
    const o = { p, opsi: baru, j: baru.indexOf(benar), tingkat, waktu: jepit(x.waktu, RENTANG[tingkat]), bahas: bersih(x.bahas, 500) };
    if (x.tesis) { o.tesis = bersih(x.tesis, 500); delete o.p; o.p = o.tesis; }
    if (x.konsep) o.konsep = bersih(x.konsep, 60);
    return o;
}
function urutTingkat(a) { return a.map((s, i) => [s, i]).sort((x, y) => TINGKAT.indexOf(x[0].tingkat) - TINGKAT.indexOf(y[0].tingkat) || x[1] - y[1]).map(x => x[0]); }
const jumlah = a => a.reduce((t, s) => t + s.waktu, 0);

function rapikan(o) {
    const pilgan = urutTingkat((o.pilgan || []).map(x => soalPg(x, 'sedang')).filter(Boolean)).slice(0, 15);
    if (pilgan.length < 10) throw new Error('Soal pilihan ganda kurang dari 10');
    const LAB = ['tesis', 'argumen', 'kesimpulan'];
    const teks = ((o.struktur && o.struktur.teks) || []).map(k => ({ t: bersih(k.t, 500), label: String(k.label || '').toLowerCase().trim(), alasan: bersih(k.alasan, 300) })).filter(k => k.t && LAB.includes(k.label)).slice(0, 9);
    if (teks.length < 5 || !LAB.every(l => teks.some(k => k.label === l))) throw new Error('Bagian struktur tidak lengkap');
    const esai = urutTingkat((o.esai || []).map(x => soalPg(x, 'sulit')).filter(Boolean)).slice(0, 6);
    if (esai.length < 4) throw new Error('Soal isi argumentasi kurang dari 4');
    const kritis = urutTingkat((o.kritis || []).map(x => soalPg(x, 'sulit')).filter(Boolean)).slice(0, 8);
    if (kritis.length < 5) throw new Error('Soal uji berpikir kurang dari 5');
    return {
        ringkasan: bersih(o.ringkasan, 500),
        pilgan: { soal: pilgan, total: jumlah(pilgan) },
        struktur: { judul: bersih(o.struktur.judul, 150) || 'Teks Argumentasi', teks, waktu: jepit(o.struktur.waktu || teks.length * 40, [teks.length * 30, Math.max(600, teks.length * 80)]) },
        esai: { soal: esai, total: jumlah(esai) },
        kritis: { soal: kritis, total: jumlah(kritis) }
    };
}

const HANDLERS = {
    async buat({ handoutId, ai }) {
        const h = await ambilHandout(handoutId);
        const pdfB64 = await ambilPdf(h.url);
        
        let hasil;
        const provider = String(ai || 'auto').toLowerCase();

        if (provider === 'gemini') {
            hasil = await tanyaGemini(h.judul, pdfB64);
        } else if (provider === 'groq') {
            hasil = await tanyaGroq(h.judul, pdfB64);
        } else {
            // Priority: Groq -> Fallback: Gemini
            try {
                hasil = await tanyaGroq(h.judul, pdfB64);
            } catch (errGroq) {
                console.warn('Groq gagal, mencoba Gemini:', errGroq.message);
                try {
                    hasil = await tanyaGemini(h.judul, pdfB64);
                } catch (errGemini) {
                    throw galat(`Gagal membuat soal dari kedua AI. Groq: [${errGroq.message}] | Gemini: [${errGemini.message}]`, 502);
                }
            }
        }

        return { judul: h.judul, handoutId, model: hasil.model, dibuat: Date.now(), ...hasil.paket };
    }
};

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const fn = HANDLERS[body.action];
        if (!fn) throw galat('Action tidak valid. Tersedia: ' + Object.keys(HANDLERS).join(', '), 400);
        return res.status(200).json(await fn(body));
    } catch (e) {
        console.error('latihan error:', e.message);
        return res.status(e.status || 500).json({ error: 'Gagal menyiapkan soal', detail_error: e.message });
    }
};
module.exports.config = { maxDuration: 60 };
