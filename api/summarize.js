// api/summarize.js
let Groq;
try {
    Groq = require('groq-sdk');
} catch (err) {
    console.error("Gagal load groq-sdk:", err);
}

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: "Method Not Allowed" });

    try {
        if (!Groq) throw new Error("Modul 'groq-sdk' tidak ditemukan. Pastikan package.json (dengan dependency groq-sdk) ada di root dan sudah di-deploy ulang.");
        if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY tidak ditemukan di Vercel Environment Variables (lalu Redeploy).");

        // Body bisa berupa string pada beberapa kondisi
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const { teksJudul, teksIsi, action } = body;

        if (action !== 'summarize') throw new Error("Action payload tidak dikenali.");

        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

        const sumber = teksIsi && teksIsi.trim()
            ? `Judul: "${teksJudul}"\n\nIsi teks:\n${teksIsi.slice(0, 6000)}`
            : `Topik: "${teksJudul}"`;

        const promptText = `Kamu adalah guru akademik yang ahli dalam bidang teks argumentasi. Berdasarkan teks berikut, berikan minimal 4 poin rangkuman yang menjelaskan apa isi dari teks tersebut, dan mengapa teks terseubut bisa dikatakan teks argumentasi atau artikel dan minimal 2 paragraf singkat yang menjelaskan makna bacaan. Gunakan Bahasa Indonesia yang mudah dipahami bagi siswa jenjang SMP dan SMA.

${sumber}

ATURAN WAJIB: Keluarkan HANYA JSON yang valid dengan format:
{
  "points": ["Poin 1...", "Poin 2...", "Poin 3..."],
  "meaning": "Makna teks..."
}`;

        // Urutan model: utama -> cadangan (semua dari daftar kuota Groq akun Anda)
        const MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];
        const errors = [];

        for (const model of MODELS) {
            try {
                const params = {
                    messages: [
                        { role: 'system', content: 'You are a helpful assistant that always outputs valid JSON.' },
                        { role: 'user', content: promptText }
                    ],
                    model,
                    temperature: 0.3,
                    max_completion_tokens: 1200,
                    response_format: { type: "json_object" }
                };
                // Model gpt-oss adalah model penalaran: batasi agar cepat & hemat token (limit 8K TPM)
                if (model.startsWith('openai/')) params.reasoning_effort = 'low';

                const completion = await groq.chat.completions.create(params);
                let text = completion.choices[0]?.message?.content || "";
                // Buang blok <think> (jika ada) dan ambil JSON-nya saja
                text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
                const start = text.indexOf('{'), end = text.lastIndexOf('}');
                if (start === -1 || end === -1) throw new Error("Respons bukan JSON");
                const result = JSON.parse(text.slice(start, end + 1));
                if (!Array.isArray(result.points) || !result.meaning) throw new Error("Format JSON tidak lengkap");

                return res.status(200).json(result);
            } catch (e) {
                console.error(`Model ${model} gagal:`, e.message);
                errors.push(`${model}: ${e.message}`);
            }
        }
        throw new Error("Semua model gagal. " + errors.join(' | '));

    } catch (error) {
        console.error("Summarize error:", error);
        return res.status(500).json({
            error: "Sistem AI Gagal Bekerja",
            detail_error: error.message
        });
    }
};

// Harus setelah module.exports di atas. Hobby maksimal ~10 dtk, Pro bisa lebih.
module.exports.config = { maxDuration: 30 };
