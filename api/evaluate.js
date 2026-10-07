const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function extractJSON(text) {
    try {
        const cleanText = text.replace(/```json/gi, '').replace(/```/gi, '').trim();
        return JSON.parse(cleanText);
    } catch (e) {
        throw new Error("Gagal parsing output AI");
    }
}

module.exports = async function handler(req, res) {
    // Penanganan CORS untuk Vercel
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    const { action, essayData } = req.body;

    if (action !== 'evaluate_essay' || !essayData) {
        return res.status(400).json({ error: "Payload tidak valid." });
    }

    const { judul, tesis, argumen, kesimpulan } = essayData;

    const promptText = `Kamu adalah guru Bahasa Indonesia yang kritis. Evaluasi esai argumentasi siswa berikut ini:
    - Judul: ${judul}
    - Tesis: ${tesis}
    - Argumen: ${argumen}
    - Kesimpulan: ${kesimpulan}

Berikan evaluasi kritis tentang kepaduan logika antara tesis, argumen, dan kesimpulan. Berikan juga skor dari 10 hingga 100.

ATURAN WAJIB: Balas HANYA dengan format JSON murni tanpa tambahan teks apapun.
Format JSON yang diwajibkan:
{
  "feedback": "Tuliskan 2-3 kalimat evaluasi konstruktif...",
  "score": 85
}`;

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: 'user', content: promptText }],
            model: 'qwen-2.5-32b',
            temperature: 0.5,
        });

        const aiResponse = chatCompletion.choices[0]?.message?.content || "{}";
        const resultJSON = extractJSON(aiResponse);

        return res.status(200).json(resultJSON);
    } catch (error) {
        console.error("Error evaluate:", error.message);
        return res.status(500).json({ error: "Gagal mengevaluasi teks. AI sibuk." });
    }
};
