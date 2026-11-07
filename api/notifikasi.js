// Vercel Serverless Function: api/notifikasi.js
// Mengelola siaran notifikasi dari admin dan sistem untuk siswa

// Penyimpanan in-memory global untuk deployment serverless
let globalBroadcasts = [
    {
        id: 'sys_update_v25',
        title: '🚀 Pembaruan Sistem Argumentasi Digital',
        body: 'Kartu Pelajar Digital kini telah aktif! Lengkapi identitas Anda di menu profil untuk mendapatkan kartu resmi.',
        category: 'sistem',
        url: 'profil.html',
        target: 'all',
        createdAt: new Date().toISOString(),
        createdBy: 'Admin Sistem'
    },
    {
        id: 'latihan_daily_default',
        title: '🎯 Tantangan Latihan 24 Jam Siap!',
        body: 'Soal penalaran kritis baru hari ini telah dibuka. Asah kemampuanmu dan kumpulkan poin XP!',
        category: 'latihan',
        url: 'latihan.html',
        target: 'all',
        createdAt: new Date().toISOString(),
        createdBy: 'Sistem Otomatis'
    }
];

export default async function handler(req, res) {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, Authorization'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        if (req.method === 'GET') {
            const { category, limit = 20 } = req.query;
            let results = [...globalBroadcasts];
            if (category && category !== 'all') {
                results = results.filter(n => n.category === category);
            }
            results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            return res.status(200).json({
                success: true,
                count: results.length,
                data: results.slice(0, parseInt(limit))
            });
        }

        if (req.method === 'POST') {
            const { title, body, category = 'pengumuman', url = 'index.html', target = 'all', createdBy = 'Admin' } = req.body || {};

            if (!title || !body) {
                return res.status(400).json({
                    success: false,
                    message: 'Judul dan isi pesan notifikasi wajib diisi'
                });
            }

            const newNotif = {
                id: 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                title: title.trim(),
                body: body.trim(),
                category,
                url,
                target,
                createdAt: new Date().toISOString(),
                createdBy
            };

            // Tambahkan ke daftar siaran di urutan pertama
            globalBroadcasts.unshift(newNotif);
            if (globalBroadcasts.length > 50) globalBroadcasts.pop();

            return res.status(201).json({
                success: true,
                message: 'Notifikasi berhasil diposting dan disiarkan ke semua pengguna',
                data: newNotif
            });
        }

        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (id) {
                globalBroadcasts = globalBroadcasts.filter(n => n.id !== id);
                return res.status(200).json({ success: true, message: 'Notifikasi berhasil dihapus' });
            }
            return res.status(400).json({ success: false, message: 'ID notifikasi diperlukan' });
        }

        return res.status(405).json({ success: false, message: 'Method tidak diizinkan' });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
