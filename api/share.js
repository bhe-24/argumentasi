// api/share.js — pratinjau tautan (Open Graph) untuk WhatsApp/Telegram/dll.
// Bot WhatsApp tidak menjalankan JavaScript, jadi meta tag harus dibuat di server.
const PROJECT = 'mading-cf676';
const API_KEY = 'AIzaSyDpUWUIzPXIZN6rrNtsIqcL6VfOE2RLVl0';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const val = f => (f && (f.stringValue ?? '')) || '';

function ekstrakKandidatGambar(fields) {
    const cover = val(fields.coverImage);
    const b64 = val(fields.gambarBase64);
    const html = val(fields.isi) || val(fields.konten) || '';
    
    // Cari tag <img> pertama di dalam isi materi jika ada
    let imgInContent = '';
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m && m[1]) imgInContent = m[1].trim();

    const isHttp = s => /^https?:\/\//i.test(s);
    const isBase64 = s => typeof s === 'string' && (s.startsWith('data:image/') || s.length > 300);
    const isDefaultUnsplash = s => typeof s === 'string' && s.includes('images.unsplash.com/photo-1456513080510-7bf3a84b82f8');

    // Prioritas 1: coverImage berupa URL HTTP asli (bukan placeholder default)
    if (isHttp(cover) && !isDefaultUnsplash(cover)) {
        return { type: 'http', url: cover.replace('/upload/', '/upload/f_jpg,q_auto,w_1200,c_limit/'), rawBase64: null };
    }

    // Prioritas 2: Gambar di dalam isi teks berupa URL HTTP asli
    if (isHttp(imgInContent) && !isDefaultUnsplash(imgInContent)) {
        return { type: 'http', url: imgInContent.replace('/upload/', '/upload/f_jpg,q_auto,w_1200,c_limit/'), rawBase64: null };
    }

    // Prioritas 3: Base64 dari coverImage, gambarBase64, atau gambar di dalam isi teks
    const rawB64 = isBase64(cover) ? cover : isBase64(b64) ? b64 : isBase64(imgInContent) ? imgInContent : null;
    if (rawB64) {
        return { type: 'base64', url: null, rawBase64: rawB64 };
    }

    // Prioritas 4: coverImage default jika ada
    if (isHttp(cover)) {
        return { type: 'http', url: cover, rawBase64: null };
    }

    // Fallback default
    return {
        type: 'http',
        url: 'https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=1200',
        rawBase64: null
    };
}

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

    const gambarData = ekstrakKandidatGambar(fields);

    // Mode cek: buka /api/share?id=XXX&debug=1
    if (req.query.debug === '1') {
        return res.status(200).json({
            firestoreStatus: status,
            adaJudul: !!val(fields.judul),
            tipeGambar: gambarData.type,
            adaBase64: !!gambarData.rawBase64,
            panjangBase64: gambarData.rawBase64 ? gambarData.rawBase64.length : 0,
            imageUrl: gambarData.type === 'base64' ? `${origin}/api/share?id=${id}&img=1` : gambarData.url
        });
    }

    // Mode gambar: cover tersimpan base64 → sajikan sebagai file gambar langsung untuk WhatsApp
    if (req.query.img === '1') {
        let raw = gambarData.rawBase64;
        if (raw) {
            let mimeType = 'image/jpeg';
            let base64Payload = raw;
            const dataMatch = raw.match(/^data:(image\/[\w+.-]+);base64,(.+)$/s);
            if (dataMatch) {
                mimeType = dataMatch[1];
                base64Payload = dataMatch[2];
            } else {
                // Deteksi mime type dari signature byte base64
                if (raw.startsWith('/9j/')) mimeType = 'image/jpeg';
                else if (raw.startsWith('iVBORw0KGgo')) mimeType = 'image/png';
                else if (raw.startsWith('R0lGOD')) mimeType = 'image/gif';
                else if (raw.startsWith('UklGR')) mimeType = 'image/webp';
            }
            try {
                const buffer = Buffer.from(base64Payload, 'base64');
                res.setHeader('Content-Type', mimeType);
                res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate');
                return res.status(200).send(buffer);
            } catch (err) {}
        }

        // Jika bukan base64, redirect ke URL gambarnya
        if (gambarData.url) {
            return res.redirect(302, gambarData.url);
        }
        return res.redirect(302, 'https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=1200');
    }

    const judul = val(fields.judul) || 'Materi Pembelajaran';
    const isi = (val(fields.isi) || val(fields.konten)).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const desc = (isi.slice(0, 150) || 'Baca materi lengkapnya di Argumentasi.') + (isi.length > 150 ? '…' : '');
    
    // Tentukan URL gambar untuk Open Graph WhatsApp
    const image = gambarData.type === 'base64'
        ? `${origin}/api/share?id=${id}&img=1`
        : (gambarData.url || 'https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=1200');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate');
    res.status(200).send(`<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8">
<title>${esc(judul)} - Argumentasi</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:site_name" content="Argumentasi">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(judul)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image).replace(/&amp;/g, '&')}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${esc(target).replace(/&amp;/g, '&')}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(judul)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image).replace(/&amp;/g, '&')}">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
</head><body><script>location.replace(${JSON.stringify(target)})</script></body></html>`);
}
