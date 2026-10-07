const Groq = require('groq-sdk');

// Inisialisasi Groq (Otomatis membaca process.env.GROQ_API_KEY di Vercel)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Helper Ekstrak JSON
function extractJSON(text) {
    try {
        const cleanText = text.replace(/```json/gi, '').replace(/```/gi, '').trim();
        return JSON.parse(cleanText);
    } catch (e) {
        throw new Error("Gagal parsing output AI");
    }
}

// Handler Vercel Serverless
module.exports = async function handler(req, res) {
    // Penanganan CORS untuk Vercel
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Tangani preflight request dari browser
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Pastikan hanya POST yang diizinkan
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    const { materiId, teksJudul, action } = req.body;

    if (action !== 'summarize') {
        return res.status(400).json({ error: "Action tidak valid." });
    }

    const promptText = `Kamu adalah asisten akademik. Berikan 3 poin rangkuman dan 1 paragraf singkat yang menjelaskan makna dari topik berikut: "${teksJudul}".
    
ATURAN WAJIB: Balas HANYA dengan format JSON murni tanpa tambahan teks apapun di awal atau akhir.
Format JSON yang diwajibkan:
{
  "points": ["Poin 1...", "Poin 2...", "Poin 3..."],
  "meaning": "Makna teks..."
}`;

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: 'user', content: promptText }],
            model: 'qwen-2.5-32b',
            temperature: 0.3, 
        });

        const aiResponse = chatCompletion.choices[0]?.message?.content || "{}";
        const resultJSON = extractJSON(aiResponse);

        return res.status(200).json(resultJSON);
    } catch (error) {
        console.error("Error summarize:", error.message);
        return res.status(500).json({ error: "Gagal menghubungi server AI." });
    }
};
