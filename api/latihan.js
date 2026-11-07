// api/latihan.js — ekstraksi teks PDF langsung + penyusunan soal dengan Groq (Primary) / Gemini (Fallback)
const zlib = require('zlib');
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'mading-cf676';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyDpUWUIzPXIZN6rrNtsIqcL6VfOE2RLVl0';

// Inisialisasi library pdf-parse jika tersedia di lingkungan Vercel
let pdfParse;
try {
    pdfParse = require('pdf-parse');
} catch (e) {
    console.warn('pdf-parse tidak ditemukan, menggunakan built-in stream extractor');
}

// Inisialisasi Groq SDK
let Groq;
try {
    Groq = require('groq-sdk');
} catch (err) {
    console.error('Gagal memuat groq-sdk:', err.message);
}

// Model Groq terverifikasi sesuai konsol Groq pengguna
const MODELS_GROQ = [...new Set([
    process.env.GROQ_MODEL,
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.8-27b'
].filter(Boolean))];

// Model Gemini (Fallback jika Groq bermasalah)
const MODELS = [...new Set([
    process.env.GEMINI_MODEL,
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.5-pro'
].filter(Boolean))];

const MAKS_PDF = 14 * 1024 * 1024;
const galat = (pesan, status) => Object.assign(new Error(pesan), { status });
const bersih = (t, n = 600) => String(t ?? '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

const TINGKAT = ['mudah', 'sedang', 'sulit', 'hots'];
const RENTANG = { mudah: [30, 60], sedang: [45, 90], sulit: [60, 120], hots: [90, 180] };
const jepit = (v, [a, b]) => Math.max(a, Math.min(b, Math.round(Number(v)) || a));
const acak = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/* ---------- Pembersihan Teks Hasil Ekstraksi ---------- */
function bersihkanTeksPdf(t) {
    if (!t) return '';
    return String(t)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/* ---------- Ekstraktor Fallback Bawaan Node.js (zlib) ---------- */
function ekstrakTeksDariStreamPdf(buffer) {
    try {
        const str = buffer.toString('binary');
        const teksHasil = [];
        const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
        let match;

        while ((match = streamRegex.exec(str)) !== null) {
            const dataChunk = Buffer.from(match[1], 'binary');
            let decoded = null;

            try {
                decoded = zlib.inflateSync(dataChunk).toString('utf-8');
            } catch (e) {
                try {
                    decoded = zlib.inflateRawSync(dataChunk).toString('utf-8');
                } catch (e2) {
                    decoded = dataChunk.toString('utf-8');
                }
            }

            if (decoded) {
                const tjMatches = decoded.match(/\((.*?)\)\s*Tj/g);
                if (tjMatches) {
                    tjMatches.forEach(m => {
                        const sub = m.replace(/^\(/, '').replace(/\)\s*Tj$/, '');
                        if (sub.trim().length > 1) teksHasil.push(sub);
                    });
                }
                const tJMatches = decoded.match(/\[(.*?)\]\s*TJ/g);
                if (tJMatches) {
                    tJMatches.forEach(m => {
                        const parts = m.match(/\((.*?)\)/g);
                        if (parts) {
                            const gabung = parts.map(p => p.slice(1, -1)).join('');
                            if (gabung.trim().length > 1) teksHasil.push(gabung);
                        }
                    });
                }
            }
        }

        return bersihkanTeksPdf(teksHasil.join(' '));
    } catch (e) {
        return '';
    }
}

/* ---------- Ekstraksi Teks PDF Utama ---------- */
async function ekstrakTeksPdf(buffer) {
    if (!buffer || buffer.length === 0) return '';

    // 1. Prioritas: pdf-parse (Mozilla PDF.js engine)
    if (typeof pdfParse === 'function') {
        try {
            const data = await pdfParse(buffer);
            if (data && data.text && data.text.trim().length >= 40) {
                return bersihkanTeksPdf(data.text);
            }
        } catch (err) {
            console.warn('pdf-parse error, beralih ke stream extractor:', err.message);
        }
    }

    // 2. Fallback: Ekstraksi stream PDF bawaan Node.js
    const teksStream = ekstrakTeksDariStreamPdf(buffer);
    if (teksStream && teksStream.length >= 40) {
        return teksStream;
    }

    return '';
}

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

async function ambilPdfBuffer(url) {
    const r = await fetch(url);
    if (!r.ok) throw galat('File PDF tidak bisa dibuka (HTTP ' + r.status + ').', 502);
    const ab = await r.arrayBuffer();
    if (ab.byteLength > MAKS_PDF) throw galat('File PDF terlalu besar untuk dianalisis.', 413);
    return Buffer.from(ab);
}

/* ---------- Prompt Pembuatan Soal ---------- */
function buatPrompt(judul, teksMateri) {
    const materiContext = teksMateri && teksMateri.length > 50
        ? `Berikut adalah TEKS ASLI DARI MATERI PDF "${judul}":\n"""\n${teksMateri.slice(0, 45000)}\n"""`
        : `Materi bertema "${judul}".`;

    return `Kamu adalah guru Bahasa Indonesia yang ahli menyusun asesmen penalaran dan teks argumentasi untuk siswa SMP/SMA.
${materiContext}

TUGAS:
Baca dengan cermat teks materi di atas, lalu susun SATU paket latihan harian yang seluruh soalnya WAJIB didasarkan pada isi materi tersebut (jangan mengarang fakta di luar dokumen).

Gunakan Bahasa Indonesia baku, teks polos (tanpa markdown). Keluarkan HANYA satu objek JSON valid dengan struktur persis berikut:

{
 "ringkasan": "2-3 kalimat inti ringkasan materi",
 "pilgan": [
   15 soal pilihan ganda, urut dari mudah ke sulit:
   {
     "p": "pertanyaan berdasarkan isi materi",
     "opsi": ["Pilihan A", "Pilihan B", "Pilihan C", "Pilihan D"],
     "j": 0,
     "tingkat": "mudah|sedang|sulit|hots",
     "waktu": 45,
     "bahas": "penjelasan mengapa jawaban ini benar berdasarkan teks materi (1-2 kalimat)"
   }
 ],
 "struktur": {
   "judul": "judul teks argumentasi dari materi",
   "waktu": 300,
   "teks": [
     7 kalimat berurutan yang membentuk struktur teks argumentasi utuh:
     {
       "t": "kalimat",
       "label": "tesis|argumen|kesimpulan",
       "alasan": "mengapa kalimat ini berlabel demikian"
     }
   ]
 },
 "esai": [
   6 soal esai terbuka (mengapa/bagaimana):
   {
     "p": "pertanyaan esai analitis tentang isi materi",
     "tingkat": "sedang|sulit|hots",
     "waktu": 300,
     "bahas": "poin-poin kunci jawaban ideal yang diharapkan"
   }
 ],
 "kritis": [
   8 soal uji berpikir (teori penalaran: fakta vs opini, sebab-akibat, asumsi, sesat pikir, kredibilitas sumber):
   {
     "konsep": "nama konsep (misal: Fakta vs Opini, Sebab-Akibat, Asumsi Tersirat)",
     "p": "skenario/pernyataan dari teks materi + pertanyaan",
     "opsi": ["Pilihan A", "Pilihan B", "Pilihan C", "Pilihan D"],
     "j": 0,
     "tingkat": "sedang|sulit|hots",
     "waktu": 75,
     "bahas": "penjelasan penalaran logis"
   }
 ]
}

ATURAN PENTING:
- Pilgan: komposisi 4 mudah, 5 sedang, 3 sulit, 3 hots. "j" adalah angka indeks 0-3 dari pilihan yang benar.
- Larang opsi "Semua benar" atau "Semua salah".
- "waktu" dalam detik per soal.
- Pastikan JSON valid dan LENGKAP tanpa terpotong.`;
}

/* ---------- Integrasi Groq (PRIMARY - Teks Hasil Ekstraksi PDF) ---------- */
async function tanyaGroq(judul, teksMateri) {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw galat('GROQ_API_KEY belum diisi di Vercel Environment Variables.', 500);
    if (!Groq) throw galat('groq-sdk belum terinstall di project.', 500);

    const groqClient = new Groq({ apiKey: key });
    const promptGroq = buatPrompt(judul, teksMateri);
    const catatan = [];

    for (const model of MODELS_GROQ) {
        const ac = new AbortController(), t = setTimeout(() => ac.abort(), 95000);
        try {
            const completion = await groqClient.chat.completions.create({
                model: model,
                messages: [{ role: 'user', content: promptGroq }],
                temperature: 0.5,
                // Model openai/gpt-oss-120b dan 20b memiliki batas output 8K token
                max_tokens: 7500,
                response_format: { type: 'json_object' }
            }, { signal: ac.signal });

            const teks = completion.choices[0]?.message?.content || '';
            if (!teks) throw new Error('Respons kosong');
            const s = teks.indexOf('{'), e = teks.lastIndexOf('}');
            if (s === -1 || e === -1) throw new Error('Respons bukan JSON');
            return { paket: rapikan(JSON.parse(teks.slice(s, e + 1))), model: `groq/${model}` };
        } catch (err) {
            console.error(`Groq ${model} gagal:`, err.message);
            catatan.push(`${model}: ${err.message}`);
        } finally { clearTimeout(t); }
    }
    throw galat('Groq belum berhasil menyusun soal. ' + catatan.join(' | '), 502);
}

/* ---------- Integrasi Gemini (FALLBACK jika Groq berhalangan) ---------- */
async function tanyaGemini(judul, pdfB64) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw galat('GEMINI_API_KEY belum diisi di Vercel Environment Variables.', 500);
    const catatan = [];

    for (const model of MODELS) {
        const ac = new AbortController(), t = setTimeout(() => ac.abort(), 110000);
        try {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
                method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [
                        { text: buatPrompt(judul, '') },
                        { inlineData: { mimeType: 'application/pdf', data: pdfB64 } }
                    ]}],
                    generationConfig: {
                        responseMimeType: 'application/json',
                        temperature: 0.5,
                        maxOutputTokens: 16384
                    }
                })
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
            const teks = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map(p => p.text || '').join('');
            if (!teks) throw new Error('Respons kosong');
            const s = teks.indexOf('{'), e = teks.lastIndexOf('}');
            if (s === -1 || e === -1) throw new Error('Respons bukan JSON');
            return { paket: rapikan(JSON.parse(teks.slice(s, e + 1))), model };
        } catch (err) {
            console.error(`Gemini ${model} gagal:`, err.message);
            catatan.push(`${model}: ${err.message}`);
        } finally { clearTimeout(t); }
    }
    throw galat('Gemini belum berhasil menyusun soal. ' + catatan.join(' | '), 502);
}

/* ---------- Normalisasi dan Validasi Data Soal ---------- */
function soalPg(x, tingkatDefault) {
    const opsi = (Array.isArray(x.opsi) ? x.opsi : []).map(o => bersih(o, 300)).filter(Boolean);
    const j = Number(x.j), p = bersih(x.p || x.tesis, 900);
    if (!p || opsi.length !== 4 || new Set(opsi).size !== 4 || !Number.isInteger(j) || j < 0 || j > 3) return null;
    const benar = opsi[j], baru = acak(opsi);
    let tingkat = String(x.tingkat || '').toLowerCase(); if (!TINGKAT.includes(tingkat)) tingkat = tingkatDefault;
    const o = { p, opsi: baru, j: baru.indexOf(benar), tingkat, waktu: jepit(x.waktu, RENTANG[tingkat]), bahas: bersih(x.bahas, 500) };
    if (x.tesis) { o.tesis = bersih(x.tesis, 500); o.p = o.tesis; }
    if (x.konsep) o.konsep = bersih(x.konsep, 60);
    return o;
}

function soalEsai(x, tingkatDefault) {
    const p = bersih(x.p || x.tesis || x.pertanyaan, 900);
    if (!p) return null;
    let tingkat = String(x.tingkat || '').toLowerCase(); if (!TINGKAT.includes(tingkat)) tingkat = tingkatDefault;
    return { p, tingkat, waktu: jepit(x.waktu, [120, 600]), bahas: bersih(x.bahas || x.kunci, 1000) };
}

function urutTingkat(a) { return a.map((s, i) => [s, i]).sort((x, y) => TINGKAT.indexOf(x[0].tingkat) - TINGKAT.indexOf(y[0].tingkat) || x[1] - y[1]).map(x => x[0]); }
const jumlah = a => a.reduce((t, s) => t + s.waktu, 0);

function rapikan(o) {
    const pilgan = urutTingkat((o.pilgan || []).map(x => soalPg(x, 'sedang')).filter(Boolean)).slice(0, 15);
    if (pilgan.length < 10) throw new Error('Soal pilihan ganda kurang dari 10 (didapat ' + pilgan.length + ')');
    const LAB = ['tesis', 'argumen', 'kesimpulan'];
    const teks = ((o.struktur && o.struktur.teks) || []).map(k => ({ t: bersih(k.t, 500), label: String(k.label || '').toLowerCase().trim(), alasan: bersih(k.alasan, 300) })).filter(k => k.t && LAB.includes(k.label)).slice(0, 9);
    if (teks.length < 5 || !LAB.every(l => teks.some(k => k.label === l))) throw new Error('Bagian struktur tidak lengkap');
    const esai = urutTingkat((o.esai || []).map(x => soalEsai(x, 'sulit')).filter(Boolean)).slice(0, 6);
    if (esai.length < 2) throw new Error('Soal esai kurang dari 2 (didapat ' + esai.length + ')');
    const kritis = urutTingkat((o.kritis || []).map(x => soalPg(x, 'sulit')).filter(Boolean)).slice(0, 8);
    if (kritis.length < 5) throw new Error('Soal uji berpikir kurang dari 5 (didapat ' + kritis.length + ')');
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
        const pdfBuffer = await ambilPdfBuffer(h.url);

        // Ekstraksi teks dari PDF sebelum dikirim ke Groq
        const teksMateri = await ekstrakTeksPdf(pdfBuffer);

        let hasil;
        const provider = String(ai || 'auto').toLowerCase();

        if (provider === 'gemini') {
            hasil = await tanyaGemini(h.judul, pdfBuffer.toString('base64'));
        } else if (provider === 'groq') {
            hasil = await tanyaGroq(h.judul, teksMateri);
        } else {
            // Mode Default (auto): Groq sebagai PRIMARY (hemat kuota & super cepat)
            // Fallback ke Gemini hanya jika Groq mengalami kendala
            try {
                hasil = await tanyaGroq(h.judul, teksMateri);
            } catch (errGroq) {
                console.warn('Groq gagal, mencoba fallback ke Gemini:', errGroq.message);
                try {
                    hasil = await tanyaGemini(h.judul, pdfBuffer.toString('base64'));
                } catch (errGemini) {
                    throw galat(`Gagal membuat soal dari Groq dan Gemini. Groq: [${errGroq.message}] | Gemini: [${errGemini.message}]`, 502);
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

// Vercel Serverless Function Max Duration
module.exports.config = { maxDuration: 120 };
