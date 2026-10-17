// api/modul.js — Membongkar PDF (Gemini) dan Membuat 6 Misi Latihan (Groq)
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'mading-cf676';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyDpUWUIzPXIZN6rrNtsIqcL6VfOE2RLVl0';

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;

const MAKS_PDF = 14 * 1024 * 1024; // Maksimal 14MB

const galat = (pesan, status) => Object.assign(new Error(pesan), { status });
const bersih = (t, n = 800) => String(t ?? '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const jepit = (v, [a, b]) => Math.max(a, Math.min(b, Math.round(Number(v)) || a));
const acak = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const TINGKAT = ['mudah', 'sedang', 'sulit', 'hots'];
const HURUF = ['A', 'B', 'C', 'D'];

/* ---------- FUNGSI BANTUAN ---------- */
async function unduhPdf(url) {
    const r = await fetch(url);
    if (!r.ok) throw galat('File PDF tidak bisa diunduh oleh server (HTTP ' + r.status + ').', 502);
    const ab = await r.arrayBuffer();
    if (ab.byteLength > MAKS_PDF) throw galat('File PDF melebihi kapasitas memori analisis.', 413);
    return Buffer.from(ab).toString('base64');
}

/* ---------- 1. EKSTRAK MATERI DENGAN GEMINI 2.5 ---------- */
async function ekstrakGemini(pdfUrl) {
    if (!GEMINI_KEY) throw galat('GEMINI_API_KEY belum dikonfigurasi.', 500);
    const pdfB64 = await unduhPdf(pdfUrl);

    const prompt = `Kamu adalah ahli kurikulum. Analisis dokumen PDF materi argumentasi ini. 
Ekstrak dan kembalikan HANYA objek JSON yang valid dan lengkap dengan format persis berikut:
{
  "materiInti": "Ringkasan konsep dan teori utama teks argumentasi dari dokumen",
  "ciriTeks": "Ciri-ciri, unsur kebahasaan, atau karakteristik teks dari dokumen",
  "strukturTeks": "Struktur teks (tesis, argumen, simpulan) beserta penjelasannya dari dokumen",
  "contohTeks": "Ekstrak minimal 2 contoh teks argumentasi utuh yang ada di dalam dokumen. Pisahkan dengan garis baru."
}
Pastikan teks menggunakan bahasa Indonesia baku, tanpa format markdown, dan format JSON valid.`;

    const model = 'gemini-3.8-flash';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [ { text: prompt }, { inlineData: { mimeType: 'application/pdf', data: pdfB64 } } ] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
        })
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw galat('Gagal mengekstrak dari Gemini: ' + ((j.error && j.error.message) || r.status), 502);

    const teks = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map(p => p.text || '').join('');
    if (!teks) throw galat('Gemini mengembalikan teks kosong.', 502);

    const s = teks.indexOf('{'), e = teks.lastIndexOf('}');
    if (s === -1 || e === -1) throw galat('Format ekstrak bukan JSON.', 502);

    return JSON.parse(teks.slice(s, e + 1));
}

/* ---------- 2. BUAT 6 MISI DENGAN GROQ (Llama 3.3 70B) ---------- */
async function buatLatihanGroq(data) {
    if (!GROQ_KEY) throw galat('GROQ_API_KEY belum dikonfigurasi.', 500);

    const prompt = `Kamu adalah AI Master Education. Berdasarkan referensi materi argumentasi, CP, dan TP berikut:

MATERI INTI: ${data.materiInti}
CIRI TEKS: ${data.ciriTeks}
STRUKTUR: ${data.strukturTeks}
CONTOH TEKS: ${data.contohTeks}
CAPAIAN (CP): ${data.cp}
TUJUAN (TP): ${data.tp}

Susun SATU paket lengkap 6 Misi Latihan harian.
Gunakan HANYA format JSON berikut tanpa tambahan teks apapun:
{
 "ringkasan": "2 kalimat ringkasan materi",
 "pilgan": [ 15 soal: {"p": "pertanyaan pilgan", "opsi": ["A","B","C","D"], "j": 0, "tingkat": "mudah|sedang|sulit|hots", "waktu": 45, "bahas": "penjelasan"} ],
 "struktur": { "judul": "Judul Wacana", "waktu": 300, "teks": [ 7 kalimat urut membentuk paragraf padu: {"t": "kalimat", "label": "tesis|argumen|kesimpulan", "alasan": "alasan label"} ] },
 "esai": [ 6 soal: {"p": "pertanyaan esai terbuka (HOTS)", "tingkat": "sedang|sulit|hots", "waktu": 300, "bahas": "poin ekspektasi jawaban"} ],
 "kritis": [ 8 soal: {"konsep": "logika/fakta/sesat pikir", "kasus": "cerita/pernyataan pemicu", "p": "pertanyaan analisis", "opsi": ["A","B","C","D"], "j": 0, "tingkat": "sulit|hots", "waktu": 75, "bahas": "penjelasan logis"} ],
 "peta": [ 5 soal: {"p": "sebuah paragraf argumen pendek dimana 1 kalimat argumen hilang dan diganti persis dengan teks [.......]", "opsi": ["kalimat argumen benar", "kalimat pengecoh 1", "kalimat pengecoh 2", "kalimat pengecoh 3"], "j": 0, "tingkat": "sedang|sulit", "waktu": 90, "bahas": "mengapa kalimat tersebut paling logis melengkapi paragraf"} ],
 "ilmiah": [ 10 soal: {"p": "sebuah kalimat argumentasi dimana 1 kata konjungsi/kata ilmiah hilang dan diganti persis dengan teks [.......]", "opsi": ["kata benar", "pengecoh 1", "pengecoh 2", "pengecoh 3"], "j": 0, "tingkat": "mudah|sedang", "waktu": 40, "bahas": "arti kata dan fungsinya"} ]
}

ATURAN WAJIB:
1. Pastikan tag rumpang pada "peta" dan "ilmiah" memakai format tepat: [.......]
2. Semua array "opsi" WAJIB berisi tepat 4 item.
3. Kunci jawaban "j" adalah index integer (0 sampai 3).
4. JSON harus valid, jangan sampai terpotong.`;

    const model = 'openai/gpt-oss-120b';
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
            temperature: 0.5,
            max_tokens: 8000
        })
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw galat('Gagal generate dari Groq: ' + ((j.error && j.error.message) || r.status), 502);

    const teks = j.choices[0]?.message?.content || '';
    if (!teks) throw galat('Groq mengembalikan respons kosong.', 502);

    const s = teks.indexOf('{'), e = teks.lastIndexOf('}');
    if (s === -1 || e === -1) throw galat('Format bukan JSON dari Groq.', 502);

    return { paket: JSON.parse(teks.slice(s, e + 1)), model: `groq/${model}` };
}

/* ---------- NORMALISASI & VALIDASI DATA ---------- */
function rapikan(o) {
    const validasiOpsi = (arr) => Array.isArray(arr) && arr.length >= 4 ? arr.slice(0,4) : ['A','B','C','D'];
    const vJ = (j) => Number.isInteger(j) && j >= 0 && j <= 3 ? j : 0;

    const mapPg = (x, w) => ({ p: bersih(x.p, 900), opsi: validasiOpsi(x.opsi), j: vJ(x.j), tingkat: x.tingkat || 'sedang', waktu: x.waktu || w, bahas: bersih(x.bahas, 500) });
    const mapKritis = (x) => ({ konsep: bersih(x.konsep, 60), kasus: bersih(x.kasus, 500), p: bersih(x.p, 900), opsi: validasiOpsi(x.opsi), j: vJ(x.j), tingkat: x.tingkat || 'sulit', waktu: x.waktu || 75, bahas: bersih(x.bahas, 500) });

    const pilgan = (o.pilgan || []).map(x => mapPg(x, 45)).slice(0, 15);
    const kritis = (o.kritis || []).map(mapKritis).slice(0, 8);
    const peta = (o.peta || []).map(x => mapPg(x, 90)).slice(0, 5);
    const ilmiah = (o.ilmiah || []).map(x => mapPg(x, 40)).slice(0, 10);
    const esai = (o.esai || []).map(x => ({ p: bersih(x.p, 900), tingkat: x.tingkat || 'sedang', waktu: x.waktu || 300, bahas: bersih(x.bahas, 1000) })).slice(0, 6);
    
    const teksStr = ((o.struktur && o.struktur.teks) || []).map(k => ({ t: bersih(k.t, 500), label: String(k.label || '').toLowerCase().trim(), alasan: bersih(k.alasan, 300) })).slice(0, 9);
    const waktuStr = o.struktur?.waktu || (teksStr.length * 40);

    const jumlah = a => a.reduce((t, s) => t + s.waktu, 0);

    return {
        ringkasan: bersih(o.ringkasan, 500),
        pilgan: { soal: pilgan, total: jumlah(pilgan) },
        struktur: { judul: bersih(o.struktur?.judul, 150) || 'Teks Argumentasi', teks: teksStr, waktu: waktuStr },
        esai: { soal: esai, total: jumlah(esai) },
        kritis: { soal: kritis, total: jumlah(kritis) },
        peta: { soal: peta, total: jumlah(peta) },
        ilmiah: { soal: ilmiah, total: jumlah(ilmiah) }
    };
}

const HANDLERS = {
    async extract({ url }) {
        if (!url) throw galat('URL PDF tidak diberikan.', 400);
        return await ekstrakGemini(url);
    },
    async buat({ materi }) {
        if (!materi || !materi.materiInti || !materi.cp) throw galat('Data materi atau kurikulum tidak lengkap.', 400);
        const hasil = await buatLatihanGroq(materi);
        return { model: hasil.model, dibuat: Date.now(), ...rapikan(hasil.paket) };
    }
};

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const fn = HANDLERS[body.action];
        if (!fn) throw galat('Action tidak valid. Gunakan extract atau buat.', 400);
        return res.status(200).json(await fn(body));
    } catch (e) {
        console.error('modul error:', e.message);
        return res.status(e.status || 500).json({ error: 'Gagal', detail_error: e.message });
    }
};

module.exports.config = { maxDuration: 120 };
