// Coba memuat modul Groq. Jika gagal, error akan ditangkap di bawah.
let Groq;
try {
    Groq = require('groq-sdk');
} catch (err) {
    console.error("Gagal load groq-sdk:", err);
}

module.exports = async function handler(req, res) {
    // 1. Tangani Preflight CORS
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // 2. Tolak method selain POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    try {
        // CEK 1: Apakah modul Groq terinstal?
        if (!Groq) {
            throw new Error("Modul 'groq-sdk' tidak ditemukan di server Vercel. Pastikan package.json ada di root folder.");
        }

        // CEK 2: Apakah API Key terbaca oleh Vercel?
        if (!process.env.GROQ_API_KEY) {
            throw new Error("GROQ_API_KEY tidak ditemukan di Vercel Environment Variables.");
        }

        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const { materiId, teksJudul, action } = req.body;

        if (action !== 'summarize') {
            throw new Error("Action payload tidak dikenali.");
        }

        const promptText = `Kamu adalah asisten akademik. Berikan 3 poin rangkuman dan 1 paragraf singkat yang menjelaskan makna dari topik berikut: "${teksJudul}".
        
ATURAN WAJIB: Keluarkan HANYA output format JSON yang valid.
Format JSON yang diwajibkan:
{
  "points": ["Poin 1...", "Poin 2...", "Poin 3..."],
  "meaning": "Makna teks..."
}`;

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: 'You are a helpful assistant that always outputs valid JSON.' },
                { role: 'user', content: promptText }
            ],
            model: 'qwen-2.5-32b-it',
            temperature: 0.3,
            response_format: { type: "json_object" } 
        });

        const aiResponse = chatCompletion.choices[0]?.message?.content || "{}";
        const resultJSON = JSON.parse(aiResponse);

        return res.status(200).json(resultJSON);

    } catch (error) {
        // INI BAGIAN PALING PENTING:
        // Jika gagal, server akan memberitahu halaman HTML Anda apa masalah aslinya secara spesifik!
        return res.status(500).json({ 
            error: "Sistem AI Gagal Bekerja", 
            detail_error: error.message,
            stack: error.stack
        });
    }
};
