// api/cloudinary.js — penyimpanan PDF handout di Cloudinary (paket gratis).
// Env di Vercel (wajib): CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// Rahasia API tidak pernah dikirim ke browser: server hanya membuat "tanda tangan" unggahan.
// Hanya admin/guru yang sudah login (token Firebase diperiksa) yang boleh memakai endpoint ini.
const crypto = require('crypto');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'mading-cf676';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyDpUWUIzPXIZN6rrNtsIqcL6VfOE2RLVl0'; // kunci web publik Firebase
const ALLOWED_ROLES = ['admin', 'teacher'];
const FOLDER = 'handouts';

const slug = s => String(s || 'handout').toLowerCase().replace(/\.pdf$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'handout';
const galat = (pesan, status) => Object.assign(new Error(pesan), { status });

function env() {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME, key = process.env.CLOUDINARY_API_KEY, secret = process.env.CLOUDINARY_API_SECRET;
    const kurang = [!cloud && 'CLOUDINARY_CLOUD_NAME', !key && 'CLOUDINARY_API_KEY', !secret && 'CLOUDINARY_API_SECRET'].filter(Boolean);
    if (kurang.length) throw galat('Variabel belum diisi di Vercel: ' + kurang.join(', ') + '. Isi lalu deploy ulang.', 500);
    return { cloud, key, secret };
}
// Tanda tangan Cloudinary: SHA-1 dari "k1=v1&k2=v2" (kunci diurutkan) + API secret
const tandatangani = (params, secret) => crypto.createHash('sha1').update(Object.keys(params).filter(k => params[k] !== undefined && params[k] !== '').sort().map(k => `${k}=${params[k]}`).join('&') + secret).digest('hex');

async function periksaPengguna(token) {
    if (!token) throw galat('Belum login.', 401);
    const l = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${WEB_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }) });
    const lj = await l.json().catch(() => ({})), uid = lj.users && lj.users[0] && lj.users[0].localId;
    if (!l.ok || !uid) throw galat('Sesi login tidak valid. Muat ulang halaman lalu login lagi.', 401);
    const d = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}`, { headers: { Authorization: 'Bearer ' + token } });
    const dj = await d.json().catch(() => ({})), role = dj.fields && dj.fields.role && dj.fields.role.stringValue;
    if (!ALLOWED_ROLES.includes(role)) throw galat('Akses khusus admin atau guru.', 403);
    return { uid, role };
}

const HANDLERS = {
    // Beri izin unggah satu file PDF (berlaku beberapa menit saja)
    async tanda({ namaFile }) {
        const { cloud, key, secret } = env();
        const public_id = `${FOLDER}/${Date.now()}_${slug(namaFile)}.pdf`, timestamp = Math.floor(Date.now() / 1000);
        return { cloud_name: cloud, api_key: key, timestamp, public_id, signature: tandatangani({ public_id, timestamp }, secret) };
    },
    // Hapus satu file
    async hapus({ publicId }) {
        const { cloud, key, secret } = env();
        if (!/^handouts\/[\w\-.]+$/.test(String(publicId || ''))) throw galat('ID file tidak valid.', 400);
        const timestamp = Math.floor(Date.now() / 1000), public_id = publicId;
        const body = new URLSearchParams({ public_id, timestamp: String(timestamp), api_key: key, signature: tandatangani({ public_id, timestamp }, secret) });
        const r = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/raw/destroy`, { method: 'POST', body });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw galat((j.error && j.error.message) || 'Gagal menghapus di Cloudinary.', 502);
        return { hasil: j.result || 'ok' };
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
        if (!fn) throw galat('Action tidak valid. Tersedia: ' + Object.keys(HANDLERS).join(', '), 400);
        return res.status(200).json(await fn(body));
    } catch (e) {
        console.error('cloudinary error:', e.message);
        return res.status(e.status || 500).json({ error: 'Penyimpanan gagal', detail_error: e.message });
    }
};
module.exports.config = { maxDuration: 15 };
