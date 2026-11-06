/**
 * Vercel Serverless Function: Verifikasi Google reCAPTCHA v2 / v3
 * Endpoint: POST /api/verify-captcha (dan GET untuk membaca Site Key publik)
 *
 * Environment Variable di Vercel:
 * - RECAPTCHA_SECRET_KEY (Wajib untuk validasi backend Google)
 * - RECAPTCHA_SITE_KEY (Opsional untuk diteruskan ke frontend)
 */

module.exports = async function handler(req, res) {
    // Penanganan CORS untuk lingkungan Vercel dan integrasi frontend
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Tangani preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Endpoint GET: Mengembalikan Site Key publik jika diatur di environment Vercel
    if (req.method === 'GET') {
        const siteKey = process.env.RECAPTCHA_SITE_KEY || 
                        process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY || 
                        "6LcOdRMuAAAAACqCUK60iheg_vzFdMZ811T5Xi5T";
        return res.status(200).json({
            success: true,
            siteKey: siteKey
        });
    }

    // Hanya izinkan method POST untuk verifikasi
    if (req.method !== 'POST') {
        return res.status(405).json({ 
            success: false, 
            message: "Method Not Allowed. Gunakan POST." 
        });
    }

    try {
        // Parsing body
        let body = req.body;
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            } catch (e) {}
        }
        body = body || {};

        // Ambil token dari berbagai kemungkinan nama parameter
        const token = body.token || body['g-recaptcha-response'] || body.response;

        if (!token) {
            return res.status(400).json({
                success: false,
                message: "Token verifikasi captcha tidak ditemukan dalam request."
            });
        }

        // Ambil secret key dari Environment Variables Vercel
        const secretKey = process.env.RECAPTCHA_SECRET_KEY || 
                          process.env.RECAPTCHA_SECRET || 
                          process.env.SECRET_KEY;

        if (!secretKey) {
            console.warn("[reCAPTCHA Notice] RECAPTCHA_SECRET_KEY belum diatur di Vercel. Meloloskan verifikasi sesi.");
            return res.status(200).json({
                success: true,
                message: "Verifikasi reCAPTCHA diterima (mode pengujian/konfigurasi).",
                warning: "Silakan tambahkan RECAPTCHA_SECRET_KEY di Vercel Dashboard jika ingin verifikasi penuh Google API."
            });
        }

        // Ambil IP klien jika tersedia
        const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 
                         req.socket?.remoteAddress || 
                         '';

        // Siapkan parameter form-urlencoded untuk dikirim ke Google API
        const params = new URLSearchParams();
        params.append('secret', secretKey.trim());
        params.append('response', String(token).trim());
        if (clientIp) {
            params.append('remoteip', clientIp);
        }

        // Kirim request verifikasi ke server Google reCAPTCHA
        const googleResponse = await fetch("https://www.google.com/recaptcha/api/siteverify", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: params.toString()
        });

        if (!googleResponse.ok) {
            throw new Error(`Google API mengembalikan status HTTP ${googleResponse.status}`);
        }

        const data = await googleResponse.json();

        // Evaluasi hasil verifikasi dari Google
        if (data.success === true) {
            return res.status(200).json({
                success: true,
                message: "Verifikasi reCAPTCHA berhasil.",
                challenge_ts: data.challenge_ts || null,
                hostname: data.hostname || null,
                score: data.score !== undefined ? data.score : null
            });
        } else {
            console.warn("[reCAPTCHA Warning] Verifikasi ditolak Google:", data['error-codes']);
            return res.status(400).json({
                success: false,
                message: "Verifikasi reCAPTCHA ditolak atau kedaluwarsa.",
                errorCodes: data['error-codes'] || ["invalid-input-response"]
            });
        }

    } catch (error) {
        console.error("[reCAPTCHA Exception]:", error);
        return res.status(500).json({
            success: false,
            message: "Terjadi gangguan saat memverifikasi reCAPTCHA ke server Google.",
            error: error.message
        });
    }
};
