const Groq = require('groq-sdk');

// Inisialisasi Groq (Otomatis membaca process.env.GROQ_API_KEY di Vercel)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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
    
ATURAN WAJIB: Keluarkan HANYA output format JSON yang valid.
Format JSON yang diwajibkan:
{
  "points": ["Poin 1...", "Poin 2...", "Poin 3..."],
  "meaning": "Makna teks..."
}`;

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: 'You are a helpful assistant that always outputs valid JSON.' },
                { role: 'user', content: promptText }
            ],
            // PENTING: Gunakan ID Model yang benar untuk Groq (ada tambahan -it)
            model: 'qwen-2.5-32b-it',
            temperature: 0.3,
            // PENTING: Memaksa Groq API agar HANYA mengeluarkan JSON murni
            response_format: { type: "json_object" } 
        });

        const aiResponse = chatCompletion.choices[0]?.message?.content || "{}";
        
        // Karena sudah dipaksa JSON oleh API Groq, kita bisa langsung parse
        const resultJSON = JSON.parse(aiResponse);

        return res.status(200).json(resultJSON);
    } catch (error) {
        // Log detail error ke Vercel agar mudah di-debug jika terjadi masalah
        console.error("Error Groq API Detail:", error);
        
        // Kirimkan pesan error ke HTML
        return res.status(500).json({ 
            error: "Gagal memproses data AI.", 
            detail: error.message 
        });
    }
};
