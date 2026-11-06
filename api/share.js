// api/share.js — pratinjau tautan (Open Graph) untuk WhatsApp/Telegram/dll.
// Bot WhatsApp tidak menjalankan JavaScript, jadi meta tag harus dibuat di server.
const PROJECT = 'mading-cf676';
const API_KEY = 'AIzaSyDpUWUIzPXIZN6rrNtsIqcL6VfOE2RLVl0';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const val = f => (f && (f.stringValue ?? '')) || '';

export default async function handler(req, res) {
    const id = String(req.query.id || '').replace(/[^\w-]/g, '');
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const origin = `${proto}://${req.headers.host}`;
    const target = `${origin}/baca.html?id=${id}`;
    if (!id) return res.redirect(302, '/');

    let fields = {}, status = 'belum';
    try {
        const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/materials/${id}?key=${API_KEY}`, {
            headers: { Referer: origin + '/', Origin: origin }
        });
        status = r.status;
        if (r.ok) fields = (await r.json()).fields || {};
        else status += ' ' + (await r.text()).slice(0, 200);
    } catch (e) { status = 'error: ' + e.message; }

    // Mode cek: buka /api/share?id=XXX&debug=1
    if (req.query.debug === '1') {
        return res.status(200).json({
            firestoreStatus: status,
            adaJudul: !!val(fields.judul),
            coverImage: val(fields.coverImage).slice(0, 120),
            adaBase64: !!val(fields.gambarBase64),
            panjangBase64: val(fields.gambarBase64).length
        });
    }

    // Mode gambar: cover tersimpan base64 → sajikan sebagai file gambar
    if (req.query.img === '1') {
        let raw = val(fields.gambarBase64);
        if (raw && !raw.startsWith('data:')) raw = 'data:image/jpeg;base64,' + raw;
        const m = raw.match(/^data:(image\/[\w+.-]+);base64,(.+)$/s);
        if (!m) return res.redirect(302, 'https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=1200');
        res.setHeader('Content-Type', m[1]);
        res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate');
        return res.status(200).send(Buffer.from(m[2], 'base64'));
    }

    const judul = val(fields.judul) || 'Materi Pembelajaran';
    const isi = (val(fields.isi) || val(fields.konten)).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const desc = (isi.slice(0, 150) || 'Baca materi lengkapnya di Argumentasi.') + (isi.length > 150 ? '…' : '');
    const cover = val(fields.coverImage);
    const coverUrl = cover.replace('/upload/', '/upload/f_jpg,q_auto,w_1200,c_limit/');
    const image = /^https?:\/\//.test(cover) ? coverUrl
        : val(fields.gambarBase64) ? `${origin}/api/share?id=${id}&img=1`
        : 'https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=1200';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate');
    res.status(200).send(`<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8">
<title>${esc(judul)} - Argumentasi</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:site_name" content="Argumentasi">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(judul)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(target)}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
</head><body><script>location.replace(${JSON.stringify(target)})</script></body></html>`);
}
