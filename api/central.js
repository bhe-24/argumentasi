// api/central.js — Sentral Gerbang AI Argumentasi App
// Mengonsolidasi seluruh panggilan AI: Penilaian Esai (grade_essay), Evaluasi Esai, Rangkuman, Ruang Kreasi, Handout, dan Modul Kelas.

const zlib = require('zlib');
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch (e) { /* fallback to built-in stream parser */ }

let Groq;
try { Groq = require('groq-sdk'); } catch (err) { console.warn("Groq SDK belum dimuat:", err.message); }

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'mading-cf676';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyDpUWUIzPXIZN6rrNtsIqcL6VfOE2RLVl0';
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;

const MODELS_GROQ = [
    process.env.GROQ_MODEL,
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.8-27b',
    'qwen-2.5-32b'
].filter(Boolean);

const MODELS_GEMINI = [
    process.env.GEMINI_MODEL,
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.5-pro'
].filter(Boolean);

/* ---------- FUNGSI BANTU UMUM ---------- */
const cl = t => String(t ?? '').replace(/[*_#`]/g, '').trim();
const clBlank = t => String(t ?? '').replace(/[*#`]/g, '').replace(/_{2,}|\.{4,}|…{2,}|\[\s*\.{2,}\s*\]|\(\s*\.{2,}\s*\)/g, '___').replace(/\s+/g, ' ').trim();
const arr = (a, n) => (Array.isArray(a) ? a : []).map(cl).filter(Boolean).slice(0, n);
const lim = (t, n = 3000) => String(t ?? '').slice(0, n);
const num = (v, max = 100, min = 0) => Math.max(min, Math.min(max, Math.round(Number(v)) || 0));
const words = t => String(t || '').trim().split(/\s+/).filter(Boolean).length;
const CONN = /karena|sebab|oleh karena itu|oleh sebab itu|misalnya|contohnya|sehingga|dengan demikian|selain itu|namun|tetapi|artinya|terbukti|faktanya/gi;

function extractJSON(text) {
    if (!text) throw new Error("Output AI kosong");
    let clean = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) {
        // Coba cari array jika bentuknya [ ... ]
        const sArr = clean.indexOf('['), eArr = clean.lastIndexOf(']');
        if (sArr !== -1 && eArr !== -1) {
            return JSON.parse(clean.slice(sArr, eArr + 1));
        }
        throw new Error("Respons AI bukan JSON valid");
    }
    return JSON.parse(clean.slice(start, end + 1));
}

/* ---------- CALL GROQ MULTI-MODEL ---------- */
async function callGroq({ systemPrompt, userPrompt, temperature = 0.3, maxTokens = 1500, jsonMode = true }) {
    if (!GROQ_KEY) throw new Error("GROQ_API_KEY tidak ditemukan di environment variables.");
    if (!Groq) throw new Error("groq-sdk tidak terpasang.");

    const groq = new Groq({ apiKey: GROQ_KEY });
    const errors = [];

    for (const model of MODELS_GROQ) {
        try {
            const params = {
                model,
                temperature,
                max_completion_tokens: maxTokens,
                messages: [
                    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
                    { role: 'user', content: userPrompt }
                ]
            };
            if (jsonMode) params.response_format = { type: "json_object" };
            if (model.startsWith('openai/')) params.reasoning_effort = 'low';

            const completion = await groq.chat.completions.create(params);
            const content = completion.choices[0]?.message?.content || "";
            return jsonMode ? extractJSON(content) : content;
        } catch (err) {
            console.warn(`Groq [${model}] error:`, err.message);
            errors.push(`${model}: ${err.message}`);
        }
    }
    throw new Error("Semua model Groq gagal: " + errors.join(" | "));
}

/* ---------- CALL GEMINI API (Text / Multimodal) ---------- */
async function callGemini({ prompt, base64Data = null, mimeType = 'application/pdf', temperature = 0.2, maxTokens = 1500 }) {
    if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY tidak ditemukan di environment variables.");

    const errors = [];
    for (const model of MODELS_GEMINI) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 35000);
        try {
            const parts = [{ text: prompt }];
            if (base64Data) {
                parts.push({ inlineData: { mimeType, data: base64Data } });
            }

            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts }],
                    generationConfig: { responseMimeType: 'application/json', temperature, maxOutputTokens: maxTokens }
                })
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error((data.error && data.error.message) || 'HTTP ' + response.status);

            const text = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map(p => p.text || '').join('');
            return extractJSON(text);
        } catch (err) {
            console.warn(`Gemini [${model}] error:`, err.message);
            errors.push(`${model}: ${err.message}`);
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error("Semua model Gemini gagal: " + errors.join(" | "));
}

/* =========================================================================
   1. HANDLER: PENILAIAN ESAI SISWA (grade_essay)
   Menilai akurasi jawaban siswa terhadap kunci jawaban / pembahasan materi
   menggunakan rubrik guru atau rubrik standar sistem.
   ========================================================================= */
function offlineGradeEssay(soalList, jawabMap) {
    let totalSkor = 0;
    const nilaiPerSoal = soalList.map((s, idx) => {
        const rawJawab = jawabMap[idx] || '';
        const teks = String(rawJawab).trim();
        const wCount = words(teks);
        const kunci = String(s.bahas || s.kunci || '').toLowerCase();
        const keywords = kunci.split(/[\s,.;:!?\-—()]+/).filter(k => k.length > 4);
        
        let matchCount = 0;
        const teksLower = teks.toLowerCase();
        keywords.forEach(kw => { if (teksLower.includes(kw)) matchCount++; });
        const kwRatio = keywords.length > 0 ? Math.min(1, matchCount / Math.max(3, Math.min(8, keywords.length))) : 0.5;

        const connCount = (teks.match(CONN) || []).length;
        let skor = 0;
        let status = "Perlu Ditingkatkan";
        let feedback = "";

        if (wCount < 5) {
            skor = 10;
            status = "Perlu Ditingkatkan";
            feedback = "Jawaban terlalu singkat atau belum dijawab secara lengkap. Kemukakan argumenmu secara lebih rinci.";
        } else {
            // Komponen: panjang kata (maks 30), kecocokan kata kunci esensial (maks 50), kata hubung logis (maks 20)
            const skorKata = Math.min(30, Math.round((wCount / 35) * 30));
            const skorKw = Math.round(kwRatio * 50);
            const skorConn = Math.min(20, connCount * 10);
            skor = num(skorKata + skorKw + skorConn, 98, 30);

            if (skor >= 85) {
                status = "Sangat Tepat";
                feedback = "Argumenmu sangat baik, memuat poin inti materi dan memiliki penalaran sebab-akibat yang jelas.";
            } else if (skor >= 65) {
                status = "Cukup Tepat";
                feedback = "Gagasanmu sudah mengarah pada jawaban yang tepat, namun dapat diperkuat dengan contoh bukti dan penegasan argumen.";
            } else {
                status = "Perlu Ditingkatkan";
                feedback = "Argumen masih perlu diperjelas agar lebih relevan dengan pokok pertanyaan dan materi pembelajaran.";
            }
        }

        totalSkor += skor;
        return { no: idx + 1, skor, status, feedback };
    });

    const skorRata = Math.round(totalSkor / Math.max(1, soalList.length));
    return {
        mode: 'offline',
        skorTotal: skorRata,
        ringkasanEvaluasi: skorRata >= 80 
            ? "Kerja bagus! Argumenmu terstruktur dengan baik dan mencakup sebagian besar konsep inti."
            : "Latihan yang baik. Perhatikan lagi keterkaitan antara bukti dan kesimpulan pada materi esai.",
        nilaiPerSoal
    };
}

async function handleGradeEssay({ soal, jawab, rubrik, materiJudul }) {
    const soalList = Array.isArray(soal) ? soal : [];
    const jawabMap = typeof jawab === 'object' && jawab !== null ? jawab : {};

    if (!soalList.length) {
        throw new Error("Daftar soal kosong untuk dinilai.");
    }

    // Persiapkan data soal dan jawaban untuk prompt AI
    const dataFormatted = soalList.map((s, idx) => ({
        nomor: idx + 1,
        pertanyaan: cl(s.p || s.pertanyaan || s.teks),
        kunci_pembahasan: cl(s.bahas || s.kunci || '(Analisis kelogisan penalaran argumentasi)'),
        jawaban_siswa: cl(jawabMap[idx] || '(Kosong / Tidak dijawab)')
    }));

    const panduanRubrik = rubrik && rubrik.trim()
        ? `RUBRIK PENILAIAN DARI GURU (WAJIB DITERAPKAN):\n"${cl(rubrik.trim())}"`
        : `RUBRIK PENILAIAN STANDAR SISTEM ARGUMENTASI:\n1. Akurasi & Relevansi terhadap Konsep/Kunci Pembahasan (Bobot 40%)\n2. Kelogisan Penalaran & Bukti Pendukung (Bobot 40%)\n3. Kerapian Bahasa, Diksi, & Kata Hubung Logis (Bobot 20%)`;

    const promptUser = `Kamu adalah Penilai Akademik & Pakar Bahasa Indonesia Teks Argumentasi.
Tugasmu adalah menilai dan memberikan evaluasi akurat untuk lembar jawaban esai siswa berikut.

Materi / Judul: "${cl(materiJudul || 'Teks Argumentasi')}"
${panduanRubrik}

DAFTAR SOAL DAN JAWABAN SISWA:
${JSON.stringify(dataFormatted, null, 2)}

INSTRUKSI PENILAIAN:
1. Periksa setiap butir soal: bandingkan jawaban siswa terhadap pertanyaan dan kunci pembahasan/ekspektasi konsep.
2. Berikan skor (0-100) per nomor secara adil dan realistis:
   - Jika jawaban kosong/hanya kata acak: skor 0 - 20.
   - Jika jawaban melenceng atau kurang bukti: skor 25 - 60.
   - Jika jawaban memuat sebagian besar konsep kunci & cukup logis: skor 65 - 84.
   - Jika jawaban mendalam, runtut, argumen kuat selaras kunci materi: skor 85 - 100.
3. Tentukan status per nomor: "Sangat Tepat" (skor >= 85), "Cukup Tepat" (skor 65-84), atau "Perlu Ditingkatkan" (skor < 65).
4. Tulis feedback konstruktif 1-3 kalimat per nomor yang membimbing siswa.
5. Hitung "skorTotal" (rata-rata dari nilai semua butir soal, bilangan bulat 0-100).
6. Tulis "ringkasanEvaluasi" 2-3 kalimat memotivasi tentang performa siswa secara keseluruhan.

ATURAN WAJIB: Balas HANYA format JSON valid berikut tanpa markdown:
{
  "skorTotal": 85,
  "ringkasanEvaluasi": "Teks ringkasan motivasi...",
  "nilaiPerSoal": [
    {
      "no": 1,
      "skor": 85,
      "status": "Sangat Tepat",
      "feedback": "Umpan balik nomor 1..."
    }
  ]
}`;

    try {
        const result = await callGroq({
            systemPrompt: "Kamu adalah asisten penilai esai akademik yang objektif, teliti, dan selalu merespons dalam format JSON murni.",
            userPrompt: promptUser,
            temperature: 0.2,
            maxTokens: 2000,
            jsonMode: true
        });

        if (typeof result.skorTotal !== 'number' || !Array.isArray(result.nilaiPerSoal)) {
            throw new Error("Format respons AI grade_essay tidak sesuai spesifikasi");
        }

        return {
            mode: 'ai',
            skorTotal: num(result.skorTotal, 100, 0),
            ringkasanEvaluasi: cl(result.ringkasanEvaluasi) || "Evaluasi esai selesai.",
            nilaiPerSoal: result.nilaiPerSoal.map((item, i) => ({
                no: Number(item.no) || (i + 1),
                skor: num(item.skor, 100, 0),
                status: ['Sangat Tepat', 'Cukup Tepat', 'Perlu Ditingkatkan'].includes(item.status) ? item.status : (item.skor >= 85 ? 'Sangat Tepat' : item.skor >= 65 ? 'Cukup Tepat' : 'Perlu Ditingkatkan'),
                feedback: cl(item.feedback)
            }))
        };
    } catch (err) {
        console.warn("AI grading gagal, beralih ke offline rule-based grading:", err.message);
        return offlineGradeEssay(soalList, jawabMap);
    }
}

/* =========================================================================
   2. HANDLER: EVALUASI STRUKTUR ESAI (evaluate_essay)
   Konsolidasi dari api/evaluate.js
   ========================================================================= */
async function handleEvaluateEssay({ essayData }) {
    if (!essayData) throw new Error("essayData wajib disediakan.");
    const { judul, tesis, argumen, kesimpulan } = essayData;

    const promptText = `Kamu adalah guru Bahasa Indonesia yang kritis. Evaluasi esai argumentasi siswa berikut ini:
- Judul: ${judul}
- Tesis: ${tesis}
- Argumen: ${argumen}
- Kesimpulan: ${kesimpulan}

Berikan evaluasi kritis tentang kepaduan logika antara tesis, argumen, dan kesimpulan. Berikan juga skor dari 10 hingga 100.
Keluaran HANYA format JSON valid:
{
  "feedback": "Tuliskan 2-3 kalimat evaluasi konstruktif...",
  "score": 85
}`;

    const res = await callGroq({
        systemPrompt: "You are a helpful essay evaluator that always outputs valid JSON.",
        userPrompt: promptText,
        temperature: 0.4,
        maxTokens: 800,
        jsonMode: true
    });

    return {
        feedback: cl(res.feedback),
        score: num(res.score, 100, 10)
    };
}

/* =========================================================================
   3. HANDLER: RINGKASAN BACAAN (summarize)
   Konsolidasi dari api/summarize.js
   ========================================================================= */
async function handleSummarize({ teksJudul, teksIsi }) {
    const sumber = teksIsi && teksIsi.trim()
        ? `Judul: "${teksJudul}"\n\nIsi teks:\n${teksIsi.slice(0, 6000)}`
        : `Topik: "${teksJudul}"`;

    const promptText = `Kamu adalah guru akademik yang ahli dalam bidang teks argumentasi. Berdasarkan teks berikut, berikan minimal 4 poin rangkuman yang menjelaskan apa isi dari teks tersebut, dan mengapa teks tersebut bisa dikatakan teks argumentasi atau artikel dan minimal 2 paragraf singkat yang menjelaskan makna bacaan. Gunakan Bahasa Indonesia yang mudah dipahami bagi siswa jenjang SMP dan SMA.

${sumber}

Keluaran HANYA JSON valid:
{
  "points": ["Poin 1...", "Poin 2...", "Poin 3..."],
  "meaning": "Makna teks..."
}`;

    const res = await callGroq({
        systemPrompt: "You are a helpful assistant that always outputs valid JSON.",
        userPrompt: promptText,
        temperature: 0.3,
        maxTokens: 1200,
        jsonMode: true
    });

    return {
        points: arr(res.points, 6),
        meaning: cl(res.meaning)
    };
}

/* =========================================================================
   4. HANDLER: RUANG KREASI (all-kreasi)
   Konsolidasi dari api/all-kreasi.js
   ========================================================================= */
const BAGIAN_KREASI = {
    tesis: 'Tesis: pernyataan posisi/pendapat yang jelas, spesifik, dan dapat diperdebatkan.',
    argumen: 'Argumen: minimal 2 alasan logis, masing-masing didukung fakta/contoh/data, memakai kata penghubung sebab-akibat.',
    kesimpulan: 'Kesimpulan: menegaskan kembali tesis dengan kata-kata baru, merangkum alasan utama, dan menutup dengan saran/harapan.'
};
const infoTxt = info => arr(info, 6).map((x, i) => `${i + 1}. ${x}`).join('\n');

const KREASI_HANDLERS = {
    async ideas({ tema, level }) {
        const out = await callGroq({
            userPrompt: `Buat 3 ide topik teks argumentasi bertema "${cl(lim(tema, 60)) || 'bebas (pilih yang dekat dengan remaja)'}" untuk jenjang ${level === 'sma' ? 'SMA' : 'SMP'}.
Tiap ide berisi: "judul" (6-12 kata), "pertanyaan", "sudut", "info" (TEPAT 4 kalimat fakta singkat).
Format: {"ideas":[{"judul":"","pertanyaan":"","sudut":"","info":["","","",""]}]}`
        });
        const ideas = (out.ideas || []).slice(0, 3).map(i => ({ judul: cl(i.judul), pertanyaan: cl(i.pertanyaan), sudut: cl(i.sudut), info: arr(i.info, 4) })).filter(i => i.judul);
        return { ideas };
    },
    async infopack({ judul, level }) {
        const j = cl(lim(judul, 150));
        const out = await callGroq({
            userPrompt: `Siswa ${level === 'sma' ? 'SMA' : 'SMP'} ingin menulis teks argumentasi berjudul "${j}".
Berikan "pertanyaan" (pemantik), "sudut" (posisi), "info" (TEPAT 4 kalimat fakta singkat).
Format: {"pertanyaan":"","sudut":"","info":["","","",""]}`
        });
        return { judul: j, pertanyaan: cl(out.pertanyaan), sudut: cl(out.sudut), info: arr(out.info, 4) };
    },
    async hint({ bagian, judul, sudut, info, teks, level }) {
        const b = BAGIAN_KREASI[bagian] ? bagian : 'tesis';
        const out = await callGroq({
            userPrompt: `Judul: "${cl(lim(judul, 150))}". Sudut: "${cl(lim(sudut, 300))}".
Bahan informasi:\n${infoTxt(info)}
Bagian yang sedang ditulis: ${BAGIAN_KREASI[b]}
Tulisan siswa: "${cl(lim(teks, 1500)) || '(masih kosong)'}"
Beri petunjuk memandu: "tips" (TEPAT 3 pertanyaan/arahan singkat) dan "pembuka" (TEPAT 2 awal kalimat berakhiran "...").
Format: {"tips":["","",""],"pembuka":["",""]}`
        });
        return { tips: arr(out.tips, 3), pembuka: arr(out.pembuka, 2) };
    },
    async check({ bagian, judul, teks, tesis, level }) {
        const b = BAGIAN_KREASI[bagian] ? bagian : 'tesis';
        const t = lim(teks, 2500);
        try {
            const out = await callGroq({
                userPrompt: `Judul: "${cl(lim(judul, 150))}".${b !== 'tesis' && tesis ? ` Tesis: "${cl(lim(tesis, 500))}".` : ''}
Kriteria: ${BAGIAN_KREASI[b]}
Tulisan siswa: "${cl(t)}"
Beri: "skor" (0-100), "kuat" (maks 2), "perbaiki" (maks 2), "contoh" (satu contoh perbaikan untuk 1 kalimat terlemah).
Format: {"skor":0,"kuat":[""],"perbaiki":[""],"contoh":""}`
            });
            return { mode: 'ai', skor: num(out.skor, 100), kuat: arr(out.kuat, 2), perbaiki: arr(out.perbaiki, 2), contoh: cl(out.contoh) };
        } catch (e) {
            const w = words(t), c = (t.match(CONN) || []).length;
            const target = b === 'argumen' ? 60 : 20;
            const skor = num(25 + Math.min(w, target) / target * 45 + Math.min(c, 3) * 10, 100);
            return { mode: 'offline', skor, kuat: ['Kamu sudah mulai menulis.'], perbaiki: ['Gunakan kata penghubung dan contoh konkret.'], contoh: '' };
        }
    },
    async evaluate({ judul, tesis, argumen, kesimpulan, level, info }) {
        const T = { tesis: lim(tesis, 800), argumen: lim(argumen, 3000), kesimpulan: lim(kesimpulan, 800) };
        try {
            const out = await callGroq({
                userPrompt: `Nilai teks argumentasi siswa ${level === 'sma' ? 'SMA' : 'SMP'}:
Judul: "${cl(lim(judul, 150))}"
Info:\n${infoTxt(info)}
TESIS: ${cl(T.tesis)}
ARGUMEN: ${cl(T.argumen)}
KESIMPULAN: ${cl(T.kesimpulan)}
Rubrik (0-20 per item): "tesis", "argumen", "logika", "bahasa", "kesimpulan".
Beri juga "kekuatan" (3 hal), "perbaikan" (3 saran), "komentar" (2 kalimat).
Format: {"rubrik":{"tesis":0,"argumen":0,"logika":0,"bahasa":0,"kesimpulan":0},"kekuatan":["","",""],"perbaikan":["","",""],"komentar":""}`
            });
            const r = out.rubrik || {};
            const rubrik = { tesis: num(r.tesis, 20), argumen: num(r.argumen, 20), logika: num(r.logika, 20), bahasa: num(r.bahasa, 20), kesimpulan: num(r.kesimpulan, 20) };
            return { mode: 'ai', rubrik, skor: Object.values(rubrik).reduce((a, b) => a + b, 0), kekuatan: arr(out.kekuatan, 3), perbaikan: arr(out.perbaikan, 3), komentar: cl(out.komentar) };
        } catch (e) {
            const f = (t, tg) => num(6 + Math.min(words(t), tg) / tg * 10 + Math.min((t.match(CONN) || []).length, 2), 20);
            const rubrik = { tesis: f(T.tesis, 20), argumen: f(T.argumen, 70), logika: f(T.argumen, 90), bahasa: f(T.argumen + ' ' + T.tesis, 90), kesimpulan: f(T.kesimpulan, 20) };
            return { mode: 'offline', rubrik, skor: Object.values(rubrik).reduce((a, b) => a + b, 0), kekuatan: ['Struktur tulisan lengkap.'], perbaikan: ['Perbanyak data dan kata penghubung.'], komentar: 'Evaluasi sederhana dipakai karena server sibuk.' };
        }
    },
    async bedah({ tema, level }) {
        const out = await callGroq({
            userPrompt: `Buat 1 teks argumentasi pendek (5-6 kalimat) bertema "${cl(lim(tema, 60)) || 'bebas'}" untuk siswa ${level === 'sma' ? 'SMA' : 'SMP'}.
Kalimat pertama = tesis, kalimat tengah = argumen, kalimat akhir = kesimpulan.
Beri "judul", dan tiap kalimat: "teks", "label" (tesis/argumen/kesimpulan), "alasan".
Format: {"judul":"","kalimat":[{"teks":"","label":"tesis","alasan":""}]}`
        });
        const ok = ['tesis', 'argumen', 'kesimpulan'];
        const kalimat = (out.kalimat || []).map(k => ({ teks: cl(k.teks), label: cl(k.label).toLowerCase(), alasan: cl(k.alasan) })).filter(k => k.teks && ok.includes(k.label)).slice(0, 7);
        return { judul: cl(out.judul) || 'Teks Argumentasi', kalimat };
    },
    async penghubung({ level }) {
        const out = await callGroq({
            userPrompt: `Buat 5 soal isian kata penghubung teks argumentasi untuk siswa ${level === 'sma' ? 'SMA' : 'SMP'}. Tiap soal memuat tanda kosong: ___
Opsi 4 pilihan (jawaban indeks 0-3), dan "penjelasan".
Format: {"soal":[{"kalimat":"","opsi":["","","",""],"jawaban":0,"penjelasan":""}]}`
        });
        const soal = (out.soal || []).map(x => ({
            kalimat: clBlank(x.kalimat),
            opsi: arr(x.opsi, 4),
            jawaban: num(x.jawaban, 3, 0),
            penjelasan: cl(x.penjelasan)
        })).filter(x => x.kalimat.includes('___') && x.opsi.length === 4);
        return { soal };
    },
    async lawan({ tesis, level }) {
        const out = await callGroq({
            userPrompt: `Tesis siswa: "${cl(lim(tesis, 400))}". Beri "pandangan" lawan (TEPAT 2 kalimat) dan "pancingan" bantahan.
Format: {"pandangan":["",""],"pancingan":""}`
        });
        return { pandangan: arr(out.pandangan, 2), pancingan: cl(out.pancingan) };
    },
    async tandingan({ tesis, lawan, bantahan, level }) {
        const out = await callGroq({
            userPrompt: `Siswa membantah pandangan lawan.
Tesis: "${cl(lim(tesis, 500))}". Lawan: "${cl(lim(lawan, 600))}". Bantahan: "${cl(lim(bantahan, 1500))}".
Beri "skor" (0-100), "kuat" (maks 2), "perbaiki" (maks 2), "contoh" (satu teladan kalimat).
Format: {"skor":0,"kuat":[""],"perbaiki":[""],"contoh":""}`
        });
        return { mode: 'ai', skor: num(out.skor, 100), kuat: arr(out.kuat, 2), perbaiki: arr(out.perbaiki, 2), contoh: cl(out.contoh) };
    }
};

/* =========================================================================
   5. HANDLER: FORM ASSISTANT (title & paraphrase)
   Konsolidasi dari api/form.js
   ========================================================================= */
async function handleForm({ action, teksUtama, isiMateri, targetLevel }) {
    if (action === 'title') {
        const konteks = isiMateri && isiMateri.trim().length > 10 ? `\nIsi Acuan:\n"${isiMateri.slice(0, 3000)}"` : '';
        const prompt = `Buat 3 opsi rekomendasi judul artikel/materi teks argumentasi menarik (5-10 kata per judul). Teks polos tanpa tanda bintang atau kutip.\nTopik: "${teksUtama || '-'}"${konteks}\nFormat: {"result":["Judul Satu...","Judul Dua...","Judul Tiga..."]}`;
        const out = await callGroq({ userPrompt: prompt, maxTokens: 400, jsonMode: true });
        return { result: arr(out.result, 3) };
    } else if (action === 'paraphrase') {
        const prompt = `Parafrasakan teks argumentasi berikut untuk jenjang ${targetLevel === 'smp' ? 'SMP (bahasa santun, lugas, mudah dipahami)' : 'SMA (analitis, kritis, diksi kaya)'}. Teks polos tanpa format markdown.\nTeks: "${teksUtama}"\nFormat: {"result":"Teks parafrasa..."}`;
        const out = await callGroq({ userPrompt: prompt, maxTokens: 1000, jsonMode: true });
        return { result: cl(out.result) };
    }
    throw new Error("Action form tidak dikenal.");
}

/* =========================================================================
   6. MAIN ROUTER HANDLER
   ========================================================================= */
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST,GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const action = body.action || body.type;

        if (!action) {
            return res.status(400).json({ error: "Action tidak disertakan dalam permintaan." });
        }

        // 1. Penilaian Esai AI
        if (action === 'grade_essay') {
            const hasil = await handleGradeEssay(body);
            return res.status(200).json(hasil);
        }

        // 2. Evaluasi Struktur Esai (dari evaluate.js)
        if (action === 'evaluate_essay') {
            const hasil = await handleEvaluateEssay(body);
            return res.status(200).json(hasil);
        }

        // 3. Ringkasan Teks (dari summarize.js)
        if (action === 'summarize') {
            const hasil = await handleSummarize(body);
            return res.status(200).json(hasil);
        }

        // 4. Form Helper (dari form.js)
        if (action === 'title' || action === 'paraphrase' || action === 'form') {
            const hasil = await handleForm(body);
            return res.status(200).json(hasil);
        }

        // 5. Ruang Kreasi (dari all-kreasi.js)
        if (KREASI_HANDLERS[action]) {
            body.level = body.level === 'sma' ? 'sma' : 'smp';
            const hasil = await KREASI_HANDLERS[action](body);
            return res.status(200).json(hasil);
        }

        // 6. Delegasi Handout AI
        if (action === 'handout_ai' || action === 'analisis') {
            const handoutHandler = require('./handout-ai');
            return handoutHandler(req, res);
        }

        // 7. Delegasi Pembuatan Latihan dari PDF Handout
        if (action === 'latihan' || action === 'buat_latihan') {
            const latihanHandler = require('./latihan');
            req.body.action = 'buat';
            return latihanHandler(req, res);
        }

        // 8. Delegasi Modul Kelas
        if (action === 'modul' || action === 'buat_modul' || action === 'ekstrak_modul') {
            const modulHandler = require('./modul');
            if (body.type) req.body.action = body.type;
            else if (action === 'buat_modul') req.body.action = 'buat';
            else if (action === 'ekstrak_modul') req.body.action = 'extract';
            return modulHandler(req, res);
        }

        return res.status(400).json({
            error: `Action '${action}' tidak dikenali.`,
            actions_tersedia: ['grade_essay', 'evaluate_essay', 'summarize', 'title', 'paraphrase', ...Object.keys(KREASI_HANDLERS), 'handout_ai', 'latihan', 'modul']
        });

    } catch (error) {
        console.error("Central AI API error:", error);
        return res.status(500).json({
            error: "Sistem AI Gagal Bekerja",
            detail_error: error.message
        });
    }
};

module.exports.config = { maxDuration: 60 };
