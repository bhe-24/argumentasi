// api/handout-ai.js — Analisis sampul & isi PDF dengan Gemini (khusus halaman unggah handout).
// Env di Vercel: GEMINI_API_KEY (wajib), GEMINI_MODEL (opsional, default gemini-3.5-flash)
// Hanya admin/guru yang sudah login yang boleh memanggil (token Firebase diperiksa).
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'mading-cf676';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyDpUWUIzPXIZN6rrNtsIqcL6VfOE2RLVl0'; // kunci web publik Firebase
const ALLOWED_ROLES = ['admin', 'teacher'];
const KATEGORI = ['Modul Ajar', 'Buku Referensi', 'Bahan Ajar'];

const MODELS = [...new Set([process.env.GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-2.5-flash'].filter(Boolean))];
const bersih = (t, n) => String(t ?? '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

async function periksaPengguna(token) {
    if (!token) throw Object.assign(new Error('Belum login.'), { status: 401 });
    const l = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${WEB_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }) });
    const lj = await l.json().catch(() => ({}));
    const uid = lj.users && lj.users[0] && lj.users[0].localId;
    if (!l.ok || !uid) throw Object.assign(new Error('Sesi login tidak valid. Muat ulang halaman lalu login lagi.'), { status: 401 });
    const d = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}`, { headers: { Authorization: 'Bearer ' + token } });
    const dj = await d.json().catch(() => ({}));
    const role = dj.fields && dj.fields.role && dj.fields.role.stringValue;
    if (!ALLOWED_ROLES.includes(role)) throw Object.assign(new Error('Akses khusus admin atau guru.'), { status: 403 });
    return { uid, role };
}

async function tanyaGemini(prompt, gambar) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY belum diisi di Vercel Environment Variables.');
    const galat = [];
    for (const model of MODELS) {
        const ac = new AbortController(), t = setTimeout(() => ac.abort(), 25000);
        try {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
                method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: gambar } }] }],
                    generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 1200 }
                }) });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
            const teks = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map(p => p.text || '').join('');
            const s = teks.indexOf('{'), e = teks.lastIndexOf('}');
            if (s === -1 || e === -1) throw new Error('Respons bukan JSON');
            return JSON.parse(teks.slice(s, e + 1));
        } catch (err) { console.error(`Gemini ${model} gagal:`, err.message); galat.push(`${model}: ${err.message}`); }
        finally { clearTimeout(t); }
    }
    throw new Error('Semua model Gemini gagal. ' + galat.join(' | '));
}

const HANDLERS = {
    async analisis({ gambar, teks, namaFile }) {
        const g = String(gambar || '').replace(/^data:image\/\w+;base64,/, '');
        if (g.length < 500) throw Object.assign(new Error('Gambar halaman pertama tidak ada.'), { status: 400 });
        if (g.length > 3_200_000) throw Object.assign(new Error('Gambar terlalu besar.'), { status: 413 });
        const prompt = `Kamu membantu pustakawan sekolah mendata dokumen PDF yang diunggah guru. Gambar terlampir adalah HALAMAN PERTAMA (sampul) dokumen.
Nama file: "${bersih(namaFile, 120)}"
Cuplikan teks dari beberapa halaman awal (bisa kosong bila PDF hasil pindai):
"""${bersih(teks, 3500)}"""

Tugas:
1. "judul": judul dokumen sebagaimana tertulis di sampul (rapikan huruf kapital dan spasi; jangan mengarang; bila tidak terbaca, simpulkan dari teks; bila tetap tidak yakin, pakai nama file yang dirapikan). Maksimal 120 karakter.
2. "kategori": tepat salah satu dari "Modul Ajar" (ada tujuan/capaian pembelajaran, modul ajar, LKPD, RPP), "Buku Referensi" (buku, penerbit, ISBN, bab), atau "Bahan Ajar" (materi/handout lain).
3. "deskripsi": ringkasan 2-3 kalimat bahasa Indonesia tentang isi dan manfaatnya bagi siswa/guru. Hanya berdasarkan yang terlihat; jangan mengarang isi.
4. "kata_kunci": 3-5 kata kunci.
5. "yakin": true bila judul jelas terbaca, selain itu false.
Teks polos tanpa markdown. Keluaran HANYA JSON: {"judul":"","kategori":"","deskripsi":"","kata_kunci":[""],"yakin":true}`;
        const out = await tanyaGemini(prompt, g);
        const kat = KATEGORI.find(k => k.toLowerCase() === String(out.kategori || '').trim().toLowerCase()) || 'Bahan Ajar';
        return { judul: bersih(out.judul, 120), kategori: kat, deskripsi: bersih(out.deskripsi, 500),
                 kata_kunci: (Array.isArray(out.kata_kunci) ? out.kata_kunci : []).map(k => bersih(k, 30)).filter(Boolean).slice(0, 5), yakin: out.yakin !== false };
    }
};

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const auth = String(req.headers.authorization || ''); 
        await periksaPengguna(auth.startsWith('Bearer ') ? auth.slice(7) : '');
        const fn = HANDLERS[body.action];
        if (!fn) throw Object.assign(new Error('Action tidak valid. Tersedia: ' + Object.keys(HANDLERS).join(', ')), { status: 400 });
        return res.status(200).json(await fn(body));
    } catch (e) {
        console.error('handout-ai error:', e.message);
        return res.status(e.status || 500).json({ error: 'Analisis AI gagal', detail_error: e.message });
    }
};
module.exports.config = { maxDuration: 30 };
