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
        const { action, teksUtama, isiMateri, targetLevel } = body;

        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        let promptText = "";

        if (action === 'title') {
            const konteksIsi = isiMateri && isiMateri.trim().length > 10 
                ? `\n\nIsi Materi Acuan:\n"${isiMateri.slice(0, 4000)}"` 
                : "";

            promptText = `Kamu adalah editor bahasa dan kurator materi pembelajaran bahasa Indonesia untuk jenjang SMP dan SMA.

Topik/Kata Kunci Awal:
"${teksUtama || '-'}"${konteksIsi}

TUGAS UTAMA:
Buat 3 opsi rekomendasi judul artikel/materi teks argumentasi yang menarik, edukatif, dan memicu rasa ingin tahu siswa.
Jika kata kunci awal sangat singkat (hanya 1-2 kata), ekstrak gagasan pokok dari "Isi Materi Acuan" untuk dijadikan inti judul.

ATURAN KETAT DAN MUTLAK:
1. JUMLAH: Berikan TEPAT 3 judul dalam array string.
2. PANJANG JUDUL: Setiap judul WAJIB terdiri dari MINIMAL 5 KATA dan MAKSIMAL 10 KATA. Hitung jumlah kata dengan teliti.
3. LARANGAN SIMBOL: DILARANG KERAS menyertakan simbol Markdown seperti bintang ganda (**), bintang tunggal (*), tanda pagar (#), garis bawah (_), atau tanda kutip (") di dalam teks judul. Tulis hanya teks polos (plain text).
4. GAYA BAHASA: Bahasa Indonesia baku, segar, tidak kaku, langsung pada inti pesan, dan ramah untuk pemahaman kognitif siswa SMP/SMA.
5. FORMAT KELUARAN: HANYA keluarkan objek JSON valid tanpa penjelasan tambahan:
{
  "result": [
    "Contoh Judul Pertama Lima Sampai Sepuluh Kata",
    "Contoh Judul Kedua Lima Sampai Sepuluh Kata",
    "Contoh Judul Ketiga Lima Sampai Sepuluh Kata"
  ]
}`;

        } else if (action === 'paraphrase') {
            const isSmp = targetLevel === 'smp';
            const profilAudiens = isSmp
                ? "Siswa SMP (Sekolah Menengah Pertama): gunakan kosakata sehari-hari yang santun, kalimat lugas, alur logis yang runut, serta hindari istilah akademis yang berbelit-belit."
                : "Siswa SMA (Sekolah Menengah Atas): gunakan gaya analitis, kritis, diksi kaya yang tepat, argumen berbobot, namun tetap segar dan tidak monoton.";

            promptText = `Kamu adalah guru bahasa Indonesia ahli teknik parafrasa edukatif.

Teks Asli:
"${teksUtama}"

Target Pembaca:
${profilAudiens}

TUGAS UTAMA:
Tulis ulang (parafrasakan) teks asli di atas agar mudah dipahami, menarik, dan sesuai dengan target pembaca tanpa menghilangkan makna fakta maupun esensi argumen aslinya.

ATURAN KETAT DAN MUTLAK:
1. TEKS POLOS (PLAIN TEXT): DILARANG KERAS menyematkan simbol pemformatan seperti tanda bintang ganda (**kata**), tanda bintang tunggal (*kata*), garis bawah (_), tanda pagar (#), atau tag HTML apapun. Seluruh kata tebal, miring, atau penekanan harus dihilangkan simbolnya menjadi teks biasa.
2. KEASLIAN MAKNA: Pertahankan seluruh data, fakta, dan gagasan utama dari teks asli. Perbaiki kalimat yang ambigu atau rancu.
3. KELUARAN HANYA JSON: Format keluaran WAJIB berupa JSON valid berikut tanpa teks lain di luar kurung kurawal:
{
  "result": "Teks hasil parafrasa murni tanpa simbol pemformatan markdown"
}`;

        } else {
            throw new Error("Action tidak valid. Gunakan 'title' atau 'paraphrase'.");
        }

        const MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];
        const errors = [];

        for (const model of MODELS) {
            try {
                const params = {
                    messages: [
                        { 
                            role: 'system', 
                            content: 'You are an educational text formatter that returns pure clean text strictly inside a JSON object. You NEVER use markdown formatting like asterisks (**) or formatting tags inside JSON strings.' 
                        },
                        { role: 'user', content: promptText }
                    ],
                    model,
                    temperature: 0.3,
                    max_completion_tokens: 800,
                    response_format: { type: "json_object" }
                };

                if (model.startsWith('openai/')) params.reasoning_effort = 'low';

                const completion = await groq.chat.completions.create(params);
                let text = completion.choices[0]?.message?.content || "";

                text = text.replace(/<think>[\s\S]*?<\/think>/g, '');

                const start = text.indexOf('{');
                const end = text.lastIndexOf('}');
                if (start === -1 || end === -1) throw new Error("Respons model bukan JSON");

                const result = JSON.parse(text.slice(start, end + 1));
                if (!result.result) throw new Error("Key 'result' tidak ditemukan dalam respons JSON");

                // Pembersihan lapis kedua: membersihkan karakter markdown yang lolos
                if (action === 'title' && Array.isArray(result.result)) {
                    result.result = result.result.map(item => 
                        String(item)
                            .replace(/[*_#`"']/g, '')
                            .replace(/^\d+[\).\s-]+/, '')
                            .trim()
                    );
                } else if (action === 'paraphrase' && typeof result.result === 'string') {
                    result.result = result.result
                        .replace(/[*_#`]/g, '')
                        .trim();
                }

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

module.exports.config = { maxDuration: 30 };
