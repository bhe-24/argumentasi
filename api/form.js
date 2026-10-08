// api/form.js
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
        if (!Groq) throw new Error("Modul 'groq-sdk' tidak ditemukan. Pastikan package.json ada di root dan di-deploy ulang.");
        if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY tidak ditemukan di Vercel Environment Variables.");

        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        
        // teksUtama bisa berisi ide judul (saat action title) atau teks yang diblok (saat action paraphrase)
        // isiMateri berisi teks keseluruhan dari editor untuk mengambil intisari (opsional)
        const { action, teksUtama, isiMateri, targetLevel } = body;

        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        let promptText = "";

        if (action === 'title') {
            // PROMPT UNTUK REKOMENDASI JUDUL
            const konteksIsi = isiMateri && isiMateri.trim().length > 10 
                ? `\n\nIsi Materi Acuan:\n"${isiMateri.slice(0, 4000)}"` 
                : "";

            promptText = `Kamu adalah ahli bahasa dan pendidik pembuat materi teks argumentasi/artikel pendidikan.
Pengguna memberikan ide dasar/topik judul: "${teksUtama}".${konteksIsi}
                
Tugasmu adalah membuat 3 rekomendasi judul alternatif yang sangat menarik, memancing rasa ingin tahu, dan menggunakan gaya bahasa yang ringan untuk memikat siswa SMP dan SMA. Jika ada "Isi Materi Acuan", ekstrak intisarinya agar judulnya sangat akurat menggambarkan teks.

ATURAN WAJIB:
1. Berikan TEPAT 3 rekomendasi judul.
2. Setiap judul HARUS memiliki minimal 5 kata dan maksimal 10 kata.
3. Bahasa harus baku tapi tidak kaku, cocok untuk anak muda (SMP/SMA).
4. Keluarkan HANYA JSON yang valid dengan format:
{
  "result": ["Judul 1...", "Judul 2...", "Judul 3..."]
}`;

        } else if (action === 'paraphrase') {
            // PROMPT UNTUK PARAFRASA GAYA SMP / SMA
            const levelText = targetLevel === 'smp' ? 'Siswa SMP (Sekolah Menengah Pertama)' : 'Siswa SMA (Sekolah Menengah Atas)';
            
            promptText = `Kamu adalah guru inspiratif yang sedang menyederhanakan teks materi.
Tugasmu memparafrasakan (menulis ulang) kalimat berikut agar sangat mudah dan asyik dipahami oleh ${levelText}.

Teks Asli yang diblok pengguna:
"${teksUtama}"

ATURAN WAJIB:
1. Sesuaikan gaya bahasa dengan target ${levelText}. Jika SMP: gunakan bahasa yang santai, lugas, dan sangat mudah dicerna. Jika SMA: buat lebih kritis, analitis, namun tetap mengalir dan tidak membosankan.
2. JANGAN ubah makna asli atau membuang gagasan utamanya.
3. Perbaiki tata bahasa atau ejaan jika ada yang salah di teks aslinya.
4. Keluarkan HANYA JSON yang valid dengan format:
{
  "result": "Teks hasil parafrasa yang sudah diperbaiki..."
}`;

        } else {
            throw new Error("Action tidak dikenali. Gunakan 'title' atau 'paraphrase'.");
        }

        // Urutan model: utama -> cadangan (Sesuai dengan contoh yang diberikan)
        const MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];
        const errors = [];

        for (const model of MODELS) {
            try {
                const params = {
                    messages: [
                        { role: 'system', content: 'You are a helpful educational assistant that always outputs valid JSON.' },
                        { role: 'user', content: promptText }
                    ],
                    model,
                    temperature: 0.4, // Sedikit kreatif tapi tetap terjaga
                    max_completion_tokens: 800,
                    response_format: { type: "json_object" }
                };
                
                if (model.startsWith('openai/')) params.reasoning_effort = 'low';

                const completion = await groq.chat.completions.create(params);
                let text = completion.choices[0]?.message?.content || "";
                
                // Buang blok <think> jika model menggunakan chain-of-thought
                text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
                
                const start = text.indexOf('{');
                const end = text.lastIndexOf('}');
                if (start === -1 || end === -1) throw new Error("Respons bukan JSON");
                
                const result = JSON.parse(text.slice(start, end + 1));
                if (!result.result) throw new Error("Format JSON tidak lengkap (tidak ada key 'result')");

                return res.status(200).json(result);
            } catch (e) {
                console.error(`Model ${model} gagal:`, e.message);
                errors.push(`${model}: ${e.message}`);
            }
        }
        
        throw new Error("Semua model gagal bekerja. " + errors.join(' | '));

    } catch (error) {
        console.error("Form API error:", error);
        return res.status(500).json({
            error: "Sistem AI Gagal Bekerja",
            detail_error: error.message
        });
    }
};

// Timeout handler sama seperti contoh
module.exports.config = { maxDuration: 30 };
