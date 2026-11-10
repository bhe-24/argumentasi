// api/central.js — Sentral Gerbang AI Argumentasi App
// Mengonsolidasi seluruh layanan AI: Penilaian Esai (grade_essay), Evaluasi Struktur Esai,
// Ringkasan Bacaan, Asisten Form (judul & parafrasa), Ruang Kreasi, Handout Cover AI,
// Pembuatan Paket Latihan PDF, Ekstraksi & Pembuatan Modul Kelas, serta Bantuan Panduan.

const zlib = require('zlib');

let pdfParse;
try {
    pdfParse = require('pdf-parse');
} catch (e) {
    console.warn('pdf-parse tidak ditemukan, menggunakan built-in stream extractor');
}

let Groq;
try {
    Groq = require('groq-sdk');
} catch (err) {
    console.warn('Groq SDK belum dimuat:', err.message);
}

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'mading-cf676';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyDpUWUIzPXIZN6rrNtsIqcL6VfOE2RLVl0';
const ALLOWED_ROLES = ['admin', 'teacher'];
const MAKS_PDF = 14 * 1024 * 1024;

const MODELS_GROQ = [...new Set([
    process.env.GROQ_MODEL,
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.8-27b',
    'qwen-2.5-32b'
].filter(Boolean))];

const MODELS_GROQ_FAST = [...new Set([
    'openai/gpt-oss-20b',
    process.env.GROQ_MODEL,
    'openai/gpt-oss-120b',
    'qwen/qwen3.8-27b'
].filter(Boolean))];

const MODELS_GEMINI = [...new Set([
    process.env.GEMINI_MODEL,
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.5-pro'
].filter(Boolean))];

/* ---------- FUNGSI BANTU UMUM ---------- */
const galat = (pesan, status = 500, errorTitle = '') => {
    const err = Object.assign(new Error(pesan), { status });
    if (errorTitle) err.errorTitle = errorTitle;
    return err;
};
const cl = t => String(t ?? '').replace(/[*_#`]/g, '').trim();
const clSpace = (t, n = 600) => String(t ?? '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const clBlank = t => String(t ?? '').replace(/[*#`]/g, '').replace(/_{2,}|\.{4,}|…{2,}|\[\s*\.{2,}\s*\]|\(\s*\.{2,}\s*\)/g, '___').replace(/\s+/g, ' ').trim();
const arr = (a, n) => (Array.isArray(a) ? a : []).map(cl).filter(Boolean).slice(0, n);
const lim = (t, n = 3000) => String(t ?? '').slice(0, n);
const num = (v, max = 100, min = 0) => Math.max(min, Math.min(max, Math.round(Number(v)) || 0));
const jepit = (v, [a, b]) => Math.max(a, Math.min(b, Math.round(Number(v)) || a));
const acak = a => {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};
const words = t => String(t || '').trim().split(/\s+/).filter(Boolean).length;
const CONN = /karena|sebab|oleh karena itu|oleh sebab itu|misalnya|contohnya|sehingga|dengan demikian|selain itu|namun|tetapi|artinya|terbukti|faktanya/gi;

function extractJSON(text) {
    if (!text) throw new Error('Output AI kosong');
    const clean = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
        const sArr = clean.indexOf('[');
        const eArr = clean.lastIndexOf(']');
        if (sArr !== -1 && eArr !== -1 && eArr > sArr) {
            return JSON.parse(clean.slice(sArr, eArr + 1));
        }
        throw new Error('Respons AI bukan JSON valid');
    }
    return JSON.parse(clean.slice(start, end + 1));
}

async function periksaPengguna(token) {
    if (!token) throw galat('Belum login.', 401);
    const l = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${WEB_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token })
    });
    const lj = await l.json().catch(() => ({}));
    const uid = lj.users && lj.users[0] && lj.users[0].localId;
    if (!l.ok || !uid) throw galat('Sesi login tidak valid. Muat ulang halaman lalu login lagi.', 401);

    const d = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}`, {
        headers: { Authorization: 'Bearer ' + token }
    });
    const dj = await d.json().catch(() => ({}));
    const role = dj.fields && dj.fields.role && dj.fields.role.stringValue;
    if (!ALLOWED_ROLES.includes(role)) throw galat('Akses khusus admin atau guru.', 403);
    return { uid, role };
}

/* ---------- CALL GROQ MULTI-MODEL ---------- */
async function callGroqWithMeta({ systemPrompt, userPrompt, temperature = 0.3, maxTokens = 1500, jsonMode = true, models = MODELS_GROQ, timeoutMs = 45000 }) {
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) throw new Error('GROQ_API_KEY tidak ditemukan di environment variables.');
    if (!Groq) throw new Error('groq-sdk tidak terpasang.');

    const groq = new Groq({ apiKey: groqKey });
    const errors = [];

    for (const model of models) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
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
            if (jsonMode) params.response_format = { type: 'json_object' };
            if (model.startsWith('openai/')) params.reasoning_effort = 'low';

            const completion = await groq.chat.completions.create(params, { signal: ac.signal });
            const content = completion.choices[0]?.message?.content || '';
            const data = jsonMode ? extractJSON(content) : content;
            return { data, model: `groq/${model}` };
        } catch (err) {
            console.warn(`Groq [${model}] error:`, err.message);
            errors.push(`${model}: ${err.message}`);
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error('Semua model Groq gagal: ' + errors.join(' | '));
}

async function callGroq(opts) {
    const { data } = await callGroqWithMeta(opts);
    return data;
}

/* ---------- CALL GEMINI API (Text / Multimodal) ---------- */
async function callGeminiWithMeta({ prompt, base64Data = null, mimeType = 'application/pdf', temperature = 0.2, maxTokens = 4096, timeoutMs = 40000 }) {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) throw new Error('GEMINI_API_KEY tidak ditemukan di environment variables.');

    const errors = [];
    for (const model of MODELS_GEMINI) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const parts = [{ text: prompt }];
            if (base64Data) {
                parts.push({ inlineData: { mimeType, data: base64Data } });
            }

            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts }],
                    generationConfig: { responseMimeType: 'application/json', temperature, maxOutputTokens: maxTokens }
                })
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error((data.error && data.error.message) || 'HTTP ' + response.status);

            const text = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map(p => p.text || '').join('');
            return { data: extractJSON(text), model };
        } catch (err) {
            console.warn(`Gemini [${model}] error:`, err.message);
            errors.push(`${model}: ${err.message}`);
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error('Semua model Gemini gagal: ' + errors.join(' | '));
}

async function callGemini(opts) {
    const { data } = await callGeminiWithMeta(opts);
    return data;
}

/* =========================================================================
   1. HANDLER: PENILAIAN ESAI SISWA (grade_essay)
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
        let status = 'Perlu Ditingkatkan';
        let feedback = '';

        if (wCount < 5) {
            skor = 10;
            status = 'Perlu Ditingkatkan';
            feedback = 'Jawaban terlalu singkat atau belum dijawab secara lengkap. Kemukakan argumenmu secara lebih rinci.';
        } else {
            const skorKata = Math.min(30, Math.round((wCount / 35) * 30));
            const skorKw = Math.round(kwRatio * 50);
            const skorConn = Math.min(20, connCount * 10);
            skor = num(skorKata + skorKw + skorConn, 98, 30);

            if (skor >= 85) {
                status = 'Sangat Tepat';
                feedback = 'Argumenmu sangat baik, memuat poin inti materi dan memiliki penalaran sebab-akibat yang jelas.';
            } else if (skor >= 65) {
                status = 'Cukup Tepat';
                feedback = 'Gagasanmu sudah mengarah pada jawaban yang tepat, namun dapat diperkuat dengan contoh bukti dan penegasan argumen.';
            } else {
                status = 'Perlu Ditingkatkan';
                feedback = 'Argumen masih perlu diperjelas agar lebih relevan dengan pokok pertanyaan dan materi pembelajaran.';
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
            ? 'Kerja bagus! Argumenmu terstruktur dengan baik dan mencakup sebagian besar konsep inti.'
            : 'Latihan yang baik. Perhatikan lagi keterkaitan antara bukti dan kesimpulan pada materi esai.',
        nilaiPerSoal
    };
}

async function handleGradeEssay({ soal, jawab, rubrik, materiJudul }) {
    const soalList = Array.isArray(soal) ? soal : [];
    const jawabMap = typeof jawab === 'object' && jawab !== null ? jawab : {};

    if (!soalList.length) {
        throw galat('Daftar soal kosong untuk dinilai.', 400);
    }

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
            systemPrompt: 'Kamu adalah asisten penilai esai akademik yang objektif, teliti, dan selalu merespons dalam format JSON murni.',
            userPrompt: promptUser,
            temperature: 0.2,
            maxTokens: 2000,
            jsonMode: true
        });

        if (typeof result.skorTotal !== 'number' || !Array.isArray(result.nilaiPerSoal)) {
            throw new Error('Format respons AI grade_essay tidak sesuai spesifikasi');
        }

        return {
            mode: 'ai',
            skorTotal: num(result.skorTotal, 100, 0),
            ringkasanEvaluasi: cl(result.ringkasanEvaluasi) || 'Evaluasi esai selesai.',
            nilaiPerSoal: result.nilaiPerSoal.map((item, i) => ({
                no: Number(item.no) || (i + 1),
                skor: num(item.skor, 100, 0),
                status: ['Sangat Tepat', 'Cukup Tepat', 'Perlu Ditingkatkan'].includes(item.status)
                    ? item.status
                    : (item.skor >= 85 ? 'Sangat Tepat' : item.skor >= 65 ? 'Cukup Tepat' : 'Perlu Ditingkatkan'),
                feedback: cl(item.feedback)
            }))
        };
    } catch (err) {
        console.warn('AI grading gagal, beralih ke offline rule-based grading:', err.message);
        return offlineGradeEssay(soalList, jawabMap);
    }
}

/* =========================================================================
   2. HANDLER: EVALUASI STRUKTUR ESAI (evaluate_essay)
   ========================================================================= */
async function handleEvaluateEssay({ essayData }) {
    if (!essayData) throw galat('essayData wajib disediakan.', 400);
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
        systemPrompt: 'You are a helpful essay evaluator that always outputs valid JSON.',
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
        systemPrompt: 'You are a helpful assistant that always outputs valid JSON.',
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
   4. HANDLER: RUANG KREASI (ideas, infopack, hint, check, evaluate, bedah, penghubung, lawan, tandingan)
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
        const ideas = (out.ideas || []).slice(0, 3).map(i => ({
            judul: cl(i.judul),
            pertanyaan: cl(i.pertanyaan),
            sudut: cl(i.sudut),
            info: arr(i.info, 4)
        })).filter(i => i.judul);
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
    async hint({ bagian, judul, sudut, info, teks }) {
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
    async check({ bagian, judul, teks, tesis }) {
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
            const w = words(t);
            const c = (t.match(CONN) || []).length;
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
            const rubrik = {
                tesis: num(r.tesis, 20),
                argumen: num(r.argumen, 20),
                logika: num(r.logika, 20),
                bahasa: num(r.bahasa, 20),
                kesimpulan: num(r.kesimpulan, 20)
            };
            return {
                mode: 'ai',
                rubrik,
                skor: Object.values(rubrik).reduce((a, b) => a + b, 0),
                kekuatan: arr(out.kekuatan, 3),
                perbaikan: arr(out.perbaikan, 3),
                komentar: cl(out.komentar)
            };
        } catch (e) {
            const f = (t, tg) => num(6 + Math.min(words(t), tg) / tg * 10 + Math.min((t.match(CONN) || []).length, 2), 20);
            const rubrik = {
                tesis: f(T.tesis, 20),
                argumen: f(T.argumen, 70),
                logika: f(T.argumen, 90),
                bahasa: f(T.argumen + ' ' + T.tesis, 90),
                kesimpulan: f(T.kesimpulan, 20)
            };
            return {
                mode: 'offline',
                rubrik,
                skor: Object.values(rubrik).reduce((a, b) => a + b, 0),
                kekuatan: ['Struktur tulisan lengkap.'],
                perbaikan: ['Perbanyak data dan kata penghubung.'],
                komentar: 'Evaluasi sederhana dipakai karena server sibuk.'
            };
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
        const kalimat = (out.kalimat || []).map(k => ({
            teks: cl(k.teks),
            label: cl(k.label).toLowerCase(),
            alasan: cl(k.alasan)
        })).filter(k => k.teks && ok.includes(k.label)).slice(0, 7);
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
    async lawan({ tesis }) {
        const out = await callGroq({
            userPrompt: `Tesis siswa: "${cl(lim(tesis, 400))}". Beri "pandangan" lawan (TEPAT 2 kalimat) dan "pancingan" bantahan.
Format: {"pandangan":["",""],"pancingan":""}`
        });
        return { pandangan: arr(out.pandangan, 2), pancingan: cl(out.pancingan) };
    },
    async tandingan({ tesis, lawan, bantahan }) {
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
   ========================================================================= */
async function handleForm({ action, type, teksUtama, isiMateri, targetLevel }) {
    const mode = action === 'form' ? type : action;
    if (mode === 'title') {
        const konteks = isiMateri && isiMateri.trim().length > 10 ? `\nIsi Acuan:\n"${isiMateri.slice(0, 3000)}"` : '';
        const prompt = `Buat 3 opsi rekomendasi judul artikel/materi teks argumentasi menarik (5-10 kata per judul). Teks polos tanpa tanda bintang atau kutip.\nTopik: "${teksUtama || '-'}"${konteks}\nFormat: {"result":["Judul Satu...","Judul Dua...","Judul Tiga..."]}`;
        const out = await callGroq({ userPrompt: prompt, maxTokens: 400, jsonMode: true });
        return { result: arr(out.result, 3) };
    }
    if (mode === 'paraphrase') {
        const prompt = `Parafrasakan teks argumentasi berikut untuk jenjang ${targetLevel === 'smp' ? 'SMP (bahasa santun, lugas, mudah dipahami)' : 'SMA (analitis, kritis, diksi kaya)'}. Teks polos tanpa format markdown.\nTeks: "${teksUtama}"\nFormat: {"result":"Teks parafrasa..."}`;
        const out = await callGroq({ userPrompt: prompt, maxTokens: 1000, jsonMode: true });
        return { result: cl(out.result) };
    }
    throw galat('Action form tidak dikenal.', 400);
}

/* =========================================================================
   6. HANDLER: HANDOUT COVER AI (ex api/handout-ai.js)
   ========================================================================= */
const KATEGORI_HANDOUT = ['Modul Ajar', 'Buku Referensi', 'Bahan Ajar'];

async function handleHandoutAI({ gambar, teks, namaFile }, token) {
    try {
        await periksaPengguna(token);
        const g = String(gambar || '').replace(/^data:image\/\w+;base64,/, '');
        if (g.length < 500) throw galat('Gambar halaman pertama tidak ada.', 400);
        if (g.length > 3_200_000) throw galat('Gambar terlalu besar.', 413);

        const prompt = `Kamu membantu pustakawan sekolah mendata dokumen PDF yang diunggah guru. Gambar terlampir adalah HALAMAN PERTAMA (sampul) dokumen.
Nama file: "${clSpace(namaFile, 120)}"
Cuplikan teks dari beberapa halaman awal (bisa kosong bila PDF hasil pindai):
"""${clSpace(teks, 3500)}"""

Tugas:
1. "judul": judul dokumen sebagaimana tertulis di sampul (rapikan huruf kapital dan spasi; jangan mengarang; bila tidak terbaca, simpulkan dari teks; bila tetap tidak yakin, pakai nama file yang dirapikan). Maksimal 120 karakter.
2. "kategori": tepat salah satu dari "Modul Ajar" (ada tujuan/capaian pembelajaran, modul ajar, LKPD, RPP), "Buku Referensi" (buku, penerbit, ISBN, bab), atau "Bahan Ajar" (materi/handout lain).
3. "deskripsi": ringkasan 2-3 kalimat bahasa Indonesia tentang isi dan manfaatnya bagi siswa/guru. Hanya berdasarkan yang terlihat; jangan mengarang isi.
4. "kata_kunci": 3-5 kata kunci.
5. "yakin": true bila judul jelas terbaca, selain itu false.
Teks polos tanpa markdown. Keluaran HANYA JSON: {"judul":"","kategori":"","deskripsi":"","kata_kunci":[""],"yakin":true}`;

        const out = await callGemini({ prompt, base64Data: g, mimeType: 'image/jpeg', temperature: 0.2, maxTokens: 1200, timeoutMs: 25000 });
        const kat = KATEGORI_HANDOUT.find(k => k.toLowerCase() === String(out.kategori || '').trim().toLowerCase()) || 'Bahan Ajar';
        return {
            judul: clSpace(out.judul, 120),
            kategori: kat,
            deskripsi: clSpace(out.deskripsi, 500),
            kata_kunci: (Array.isArray(out.kata_kunci) ? out.kata_kunci : []).map(k => clSpace(k, 30)).filter(Boolean).slice(0, 5),
            yakin: out.yakin !== false
        };
    } catch (e) {
        if (!e.errorTitle) e.errorTitle = 'Analisis AI gagal';
        throw e;
    }
}

/* =========================================================================
   7. HANDLER: PAKET LATIHAN HARIAN DARI PDF HANDOUT (ex api/latihan.js)
   ========================================================================= */
const TINGKAT_LAT = ['mudah', 'sedang', 'sulit', 'hots'];
const RENTANG_LAT = { mudah: [30, 60], sedang: [45, 90], sulit: [60, 120], hots: [90, 180] };

function bersihkanTeksPdf(t) {
    if (!t) return '';
    return String(t)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function ekstrakTeksDariStreamPdf(buffer) {
    try {
        const str = buffer.toString('binary');
        const teksHasil = [];
        const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
        let match;

        while ((match = streamRegex.exec(str)) !== null) {
            const dataChunk = Buffer.from(match[1], 'binary');
            let decoded = null;
            try {
                decoded = zlib.inflateSync(dataChunk).toString('utf-8');
            } catch (e) {
                try {
                    decoded = zlib.inflateRawSync(dataChunk).toString('utf-8');
                } catch (e2) {
                    decoded = dataChunk.toString('utf-8');
                }
            }

            if (decoded) {
                const tjMatches = decoded.match(/\((.*?)\)\s*Tj/g);
                if (tjMatches) {
                    tjMatches.forEach(m => {
                        const sub = m.replace(/^\(/, '').replace(/\)\s*Tj$/, '');
                        if (sub.trim().length > 1) teksHasil.push(sub);
                    });
                }
                const tJMatches = decoded.match(/\[(.*?)\]\s*TJ/g);
                if (tJMatches) {
                    tJMatches.forEach(m => {
                        const parts = m.match(/\((.*?)\)/g);
                        if (parts) {
                            const gabung = parts.map(p => p.slice(1, -1)).join('');
                            if (gabung.trim().length > 1) teksHasil.push(gabung);
                        }
                    });
                }
            }
        }
        return bersihkanTeksPdf(teksHasil.join(' '));
    } catch (e) {
        return '';
    }
}

async function ekstrakTeksPdf(buffer) {
    if (!buffer || buffer.length === 0) return '';
    if (typeof pdfParse === 'function') {
        try {
            const data = await pdfParse(buffer);
            if (data && data.text && data.text.trim().length >= 40) {
                return bersihkanTeksPdf(data.text);
            }
        } catch (err) {
            console.warn('pdf-parse error, beralih ke stream extractor:', err.message);
        }
    }
    const teksStream = ekstrakTeksDariStreamPdf(buffer);
    return teksStream && teksStream.length >= 40 ? teksStream : '';
}

async function ambilHandout(id) {
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(String(id || ''))) throw galat('ID materi tidak valid.', 400);
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/handouts/${id}?key=${WEB_API_KEY}`);
    if (r.status === 404) throw galat('Materi tidak ditemukan.', 404);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw galat('Gagal membaca data materi: ' + ((j.error && j.error.message) || r.status), 502);
    const f = j.fields || {};
    const v = k => (f[k] && (f[k].stringValue ?? '')) || '';
    if (v('status') === 'draft' || v('status') === 'dihapus') throw galat('Materi ini tidak tersedia.', 404);
    const url = v('fileUrl');
    let host = '';
    try { host = new URL(url).hostname; } catch (e) {}
    if (!/^https:\/\//.test(url) || !(host.endsWith('cloudinary.com') || host === 'firebasestorage.googleapis.com')) {
        throw galat('Alamat file materi tidak diizinkan.', 400);
    }
    return { judul: v('judul') || 'Materi', url };
}

async function ambilPdfBuffer(url) {
    const r = await fetch(url);
    if (!r.ok) throw galat('File PDF tidak bisa dibuka (HTTP ' + r.status + ').', 502);
    const ab = await r.arrayBuffer();
    if (ab.byteLength > MAKS_PDF) throw galat('File PDF terlalu besar untuk dianalisis.', 413);
    return Buffer.from(ab);
}

function buatPromptLatihan(judul, teksMateri) {
    const materiContext = teksMateri && teksMateri.length > 50
        ? `Berikut adalah TEKS ASLI DARI MATERI PDF "${judul}":\n"""\n${teksMateri.slice(0, 45000)}\n"""`
        : `Materi bertema "${judul}".`;

    return `Kamu adalah guru Bahasa Indonesia yang ahli menyusun asesmen penalaran dan teks argumentasi untuk siswa SMP/SMA.
${materiContext}

TUGAS:
Baca dengan cermat teks materi di atas, lalu susun SATU paket latihan harian yang seluruh soalnya WAJIB didasarkan pada isi materi tersebut (jangan mengarang fakta di luar dokumen).

Gunakan Bahasa Indonesia baku, teks polos (tanpa markdown). Keluarkan HANYA satu objek JSON valid dengan struktur persis berikut:

{
 "ringkasan": "2-3 kalimat inti ringkasan materi",
 "pilgan": [
   15 soal pilihan ganda, urut dari mudah ke sulit:
   {
     "p": "pertanyaan berdasarkan isi materi",
     "opsi": ["Pilihan A", "Pilihan B", "Pilihan C", "Pilihan D"],
     "j": 0,
     "tingkat": "mudah|sedang|sulit|hots",
     "waktu": 45,
     "bahas": "penjelasan mengapa jawaban ini benar berdasarkan teks materi (1-2 kalimat)"
   }
 ],
 "struktur": {
   "judul": "judul teks argumentasi dari materi",
   "waktu": 300,
   "teks": [
     7 kalimat berurutan yang membentuk struktur teks argumentasi utuh:
     {
       "t": "kalimat",
       "label": "tesis|argumen|kesimpulan",
       "alasan": "mengapa kalimat ini berlabel demikian"
     }
   ]
 },
 "esai": [
   6 soal esai terbuka (mengapa/bagaimana):
   {
     "p": "pertanyaan esai analitis tentang isi materi",
     "tingkat": "sedang|sulit|hots",
     "waktu": 300,
     "bahas": "poin-poin kunci jawaban ideal yang diharapkan"
   }
 ],
 "kritis": [
   8 soal uji berpikir (teori penalaran: fakta vs opini, sebab-akibat, asumsi, sesat pikir, kredibilitas sumber):
   {
     "konsep": "nama konsep (misal: Fakta vs Opini, Sebab-Akibat, Asumsi Tersirat)",
     "p": "skenario/pernyataan dari teks materi + pertanyaan",
     "opsi": ["Pilihan A", "Pilihan B", "Pilihan C", "Pilihan D"],
     "j": 0,
     "tingkat": "sedang|sulit|hots",
     "waktu": 75,
     "bahas": "penjelasan penalaran logis"
   }
 ]
}

ATURAN PENTING:
- Pilgan: komposisi 4 mudah, 5 sedang, 3 sulit, 3 hots. "j" adalah angka indeks 0-3 dari pilihan yang benar.
- Larang opsi "Semua benar" atau "Semua salah".
- "waktu" dalam detik per soal.
- Pastikan JSON valid dan LENGKAP tanpa terpotong.`;
}

function soalPgLatihan(x, tingkatDefault) {
    const opsi = (Array.isArray(x.opsi) ? x.opsi : []).map(o => clSpace(o, 300)).filter(Boolean);
    const j = Number(x.j);
    const p = clSpace(x.p || x.tesis, 900);
    if (!p || opsi.length !== 4 || new Set(opsi).size !== 4 || !Number.isInteger(j) || j < 0 || j > 3) return null;
    const benar = opsi[j];
    const baru = acak(opsi);
    let tingkat = String(x.tingkat || '').toLowerCase();
    if (!TINGKAT_LAT.includes(tingkat)) tingkat = tingkatDefault;
    const o = { p, opsi: baru, j: baru.indexOf(benar), tingkat, waktu: jepit(x.waktu, RENTANG_LAT[tingkat]), bahas: clSpace(x.bahas, 500) };
    if (x.tesis) {
        o.tesis = clSpace(x.tesis, 500);
        o.p = o.tesis;
    }
    if (x.konsep) o.konsep = clSpace(x.konsep, 60);
    return o;
}

function soalEsaiLatihan(x, tingkatDefault) {
    const p = clSpace(x.p || x.tesis || x.pertanyaan, 900);
    if (!p) return null;
    let tingkat = String(x.tingkat || '').toLowerCase();
    if (!TINGKAT_LAT.includes(tingkat)) tingkat = tingkatDefault;
    return { p, tingkat, waktu: jepit(x.waktu, [120, 600]), bahas: clSpace(x.bahas || x.kunci, 1000) };
}

function urutTingkatLatihan(a) {
    return a.map((s, i) => [s, i])
        .sort((x, y) => TINGKAT_LAT.indexOf(x[0].tingkat) - TINGKAT_LAT.indexOf(y[0].tingkat) || x[1] - y[1])
        .map(x => x[0]);
}

function rapikanLatihan(o) {
    const jumlah = a => a.reduce((t, s) => t + s.waktu, 0);
    const pilgan = urutTingkatLatihan((o.pilgan || []).map(x => soalPgLatihan(x, 'sedang')).filter(Boolean)).slice(0, 15);
    if (pilgan.length < 10) throw new Error('Soal pilihan ganda kurang dari 10 (didapat ' + pilgan.length + ')');
    const LAB = ['tesis', 'argumen', 'kesimpulan'];
    const teks = ((o.struktur && o.struktur.teks) || []).map(k => ({
        t: clSpace(k.t, 500),
        label: String(k.label || '').toLowerCase().trim(),
        alasan: clSpace(k.alasan, 300)
    })).filter(k => k.t && LAB.includes(k.label)).slice(0, 9);
    if (teks.length < 5 || !LAB.every(l => teks.some(k => k.label === l))) throw new Error('Bagian struktur tidak lengkap');
    const esai = urutTingkatLatihan((o.esai || []).map(x => soalEsaiLatihan(x, 'sulit')).filter(Boolean)).slice(0, 6);
    if (esai.length < 2) throw new Error('Soal esai kurang dari 2 (didapat ' + esai.length + ')');
    const kritis = urutTingkatLatihan((o.kritis || []).map(x => soalPgLatihan(x, 'sulit')).filter(Boolean)).slice(0, 8);
    if (kritis.length < 5) throw new Error('Soal uji berpikir kurang dari 5 (didapat ' + kritis.length + ')');

    return {
        ringkasan: clSpace(o.ringkasan, 500),
        pilgan: { soal: pilgan, total: jumlah(pilgan) },
        struktur: {
            judul: clSpace(o.struktur.judul, 150) || 'Teks Argumentasi',
            teks,
            waktu: jepit(o.struktur.waktu || teks.length * 40, [teks.length * 30, Math.max(600, teks.length * 80)])
        },
        esai: { soal: esai, total: jumlah(esai) },
        kritis: { soal: kritis, total: jumlah(kritis) }
    };
}

async function tanyaGroqLatihan(judul, teksMateri) {
    const { data, model } = await callGroqWithMeta({
        userPrompt: buatPromptLatihan(judul, teksMateri),
        temperature: 0.5,
        maxTokens: 7500,
        jsonMode: true,
        timeoutMs: 42000
    });
    return { paket: rapikanLatihan(data), model };
}

async function tanyaGeminiLatihan(judul, pdfB64, timeoutMs = 45000) {
    const { data, model } = await callGeminiWithMeta({
        prompt: buatPromptLatihan(judul, ''),
        base64Data: pdfB64,
        mimeType: 'application/pdf',
        temperature: 0.5,
        maxTokens: 16384,
        timeoutMs
    });
    return { paket: rapikanLatihan(data), model };
}

async function handleLatihan({ handoutId, ai }) {
    try {
        const startTs = Date.now();
        const h = await ambilHandout(handoutId);
        const pdfBuffer = await ambilPdfBuffer(h.url);
        const teksMateri = await ekstrakTeksPdf(pdfBuffer);

        let hasil;
        const provider = String(ai || 'auto').toLowerCase();

        if (provider === 'gemini') {
            hasil = await tanyaGeminiLatihan(h.judul, pdfBuffer.toString('base64'));
        } else if (provider === 'groq') {
            hasil = await tanyaGroqLatihan(h.judul, teksMateri);
        } else {
            try {
                hasil = await tanyaGroqLatihan(h.judul, teksMateri);
            } catch (errGroq) {
                console.warn('Groq latihan gagal, beralih ke Gemini:', errGroq.message);
                const sisaMs = Math.max(15000, 52000 - (Date.now() - startTs));
                try {
                    hasil = await tanyaGeminiLatihan(h.judul, pdfBuffer.toString('base64'), sisaMs);
                } catch (errGemini) {
                    throw galat(`Gagal membuat soal dari Groq dan Gemini. Groq: [${errGroq.message}] | Gemini: [${errGemini.message}]`, 502);
                }
            }
        }

        return { judul: h.judul, handoutId, model: hasil.model, dibuat: Date.now(), ...hasil.paket };
    } catch (e) {
        if (!e.errorTitle) e.errorTitle = 'Gagal menyiapkan soal';
        throw e;
    }
}

/* =========================================================================
   8. HANDLER: MODUL KELAS GURU (ex api/modul.js)
   ========================================================================= */
function rapikanModul(o) {
    const validasiOpsi = opts => Array.isArray(opts) && opts.length >= 4 ? opts.slice(0, 4) : ['A', 'B', 'C', 'D'];
    const vJ = j => Number.isInteger(j) && j >= 0 && j <= 3 ? j : 0;

    const mapPg = (x, w) => ({
        p: clSpace(x.p, 900),
        opsi: validasiOpsi(x.opsi),
        j: vJ(x.j),
        tingkat: x.tingkat || 'sedang',
        waktu: x.waktu || w,
        bahas: clSpace(x.bahas, 500)
    });
    const mapKritis = x => ({
        konsep: clSpace(x.konsep, 60),
        kasus: clSpace(x.kasus, 500),
        p: clSpace(x.p, 900),
        opsi: validasiOpsi(x.opsi),
        j: vJ(x.j),
        tingkat: x.tingkat || 'sulit',
        waktu: x.waktu || 75,
        bahas: clSpace(x.bahas, 500)
    });

    const pilgan = (o.pilgan || []).map(x => mapPg(x, 45)).slice(0, 15);
    const kritis = (o.kritis || []).map(mapKritis).slice(0, 8);
    const peta = (o.peta || []).map(x => mapPg(x, 90)).slice(0, 5);
    const ilmiah = (o.ilmiah || []).map(x => mapPg(x, 40)).slice(0, 10);
    const esai = (o.esai || []).map(x => ({
        p: clSpace(x.p, 900),
        tingkat: x.tingkat || 'sedang',
        waktu: x.waktu || 300,
        bahas: clSpace(x.bahas, 1000)
    })).slice(0, 6);

    const teksStr = ((o.struktur && o.struktur.teks) || []).map(k => ({
        t: clSpace(k.t, 500),
        label: String(k.label || '').toLowerCase().trim(),
        alasan: clSpace(k.alasan, 300)
    })).slice(0, 9);
    const waktuStr = (o.struktur && o.struktur.waktu) || (teksStr.length * 40);
    const jumlah = a => a.reduce((t, s) => t + s.waktu, 0);

    return {
        ringkasan: clSpace(o.ringkasan, 500),
        pilgan: { soal: pilgan, total: jumlah(pilgan) },
        struktur: { judul: clSpace(o.struktur?.judul, 150) || 'Teks Argumentasi', teks: teksStr, waktu: waktuStr },
        esai: { soal: esai, total: jumlah(esai) },
        kritis: { soal: kritis, total: jumlah(kritis) },
        peta: { soal: peta, total: jumlah(peta) },
        ilmiah: { soal: ilmiah, total: jumlah(ilmiah) }
    };
}

async function handleModul({ action, type, url, materi }) {
    const mode = type || (action === 'ekstrak_modul' || action === 'extract' ? 'extract' : action === 'buat_modul' || action === 'buat' ? 'buat' : '');

    if (mode === 'extract') {
        if (!url) throw galat('URL PDF tidak diberikan.', 400);
        if (!/^https:\/\//.test(String(url))) throw galat('URL PDF harus menggunakan HTTPS.', 400);
        const pdfB64 = (await ambilPdfBuffer(url)).toString('base64');

        const prompt = `Kamu adalah ahli kurikulum. Analisis dokumen PDF materi argumentasi ini.
Ekstrak dan kembalikan HANYA objek JSON yang valid dan lengkap dengan format persis berikut:
{
  "materiInti": "Ringkasan konsep dan teori utama teks argumentasi dari dokumen",
  "ciriTeks": "Ciri-ciri, unsur kebahasaan, atau karakteristik teks dari dokumen",
  "strukturTeks": "Struktur teks (tesis, argumen, simpulan) beserta penjelasannya dari dokumen",
  "contohTeks": "Ekstrak minimal 2 contoh teks argumentasi utuh yang ada di dalam dokumen. Pisahkan dengan garis baru."
}
Pastikan teks menggunakan bahasa Indonesia baku, tanpa format markdown, dan format JSON valid.`;

        return await callGemini({ prompt, base64Data: pdfB64, mimeType: 'application/pdf', temperature: 0.2, maxTokens: 8192, timeoutMs: 45000 });
    }

    if (mode === 'buat') {
        if (!materi || !materi.materiInti || !materi.cp) throw galat('Data materi atau kurikulum tidak lengkap.', 400);

        const prompt = `Kamu adalah AI Master Education. Berdasarkan referensi materi argumentasi, CP, dan TP berikut:

MATERI INTI: ${materi.materiInti}
CIRI TEKS: ${materi.ciriTeks}
STRUKTUR: ${materi.strukturTeks}
CONTOH TEKS: ${materi.contohTeks}
CAPAIAN (CP): ${materi.cp}
TUJUAN (TP): ${materi.tp}

Susun SATU paket lengkap 6 Misi Latihan harian.
Gunakan HANYA format JSON berikut tanpa tambahan teks apapun:
{
 "ringkasan": "2 kalimat ringkasan materi",
 "pilgan": [ 15 soal: {"p": "pertanyaan pilgan", "opsi": ["A","B","C","D"], "j": 0, "tingkat": "mudah|sedang|sulit|hots", "waktu": 45, "bahas": "penjelasan"} ],
 "struktur": { "judul": "Judul Wacana", "waktu": 300, "teks": [ 7 kalimat urut membentuk paragraf padu: {"t": "kalimat", "label": "tesis|argumen|kesimpulan", "alasan": "alasan label"} ] },
 "esai": [ 6 soal: {"p": "pertanyaan esai terbuka (HOTS)", "tingkat": "sedang|sulit|hots", "waktu": 300, "bahas": "poin ekspektasi jawaban"} ],
 "kritis": [ 8 soal: {"konsep": "logika/fakta/sesat pikir", "kasus": "cerita/pernyataan pemicu", "p": "pertanyaan analisis", "opsi": ["A","B","C","D"], "j": 0, "tingkat": "sulit|hots", "waktu": 75, "bahas": "penjelasan logis"} ],
 "peta": [ 5 soal: {"p": "sebuah paragraf argumen pendek dimana 1 kalimat argumen hilang dan diganti persis dengan teks [.......]", "opsi": ["kalimat argumen benar", "kalimat pengecoh 1", "kalimat pengecoh 2", "kalimat pengecoh 3"], "j": 0, "tingkat": "sedang|sulit", "waktu": 90, "bahas": "mengapa kalimat tersebut paling logis melengkapi paragraf"} ],
 "ilmiah": [ 10 soal: {"p": "sebuah kalimat argumentasi dimana 1 kata konjungsi/kata ilmiah hilang dan diganti persis dengan teks [.......]", "opsi": ["kata benar", "pengecoh 1", "pengecoh 2", "pengecoh 3"], "j": 0, "tingkat": "mudah|sedang", "waktu": 40, "bahas": "arti kata dan fungsinya"} ]
}

ATURAN WAJIB:
1. Pastikan tag rumpang pada "peta" dan "ilmiah" memakai format tepat: [.......]
2. Semua array "opsi" WAJIB berisi tepat 4 item.
3. Kunci jawaban "j" adalah index integer (0 sampai 3).
4. JSON harus valid, jangan sampai terpotong.`;

        const { data, model } = await callGroqWithMeta({
            userPrompt: prompt,
            temperature: 0.5,
            maxTokens: 7800,
            jsonMode: true,
            timeoutMs: 45000
        });
        return { model, dibuat: Date.now(), ...rapikanModul(data) };
    }

    throw galat('Action modul tidak valid. Gunakan extract atau buat.', 400);
}

/* =========================================================================
   9. HANDLER: PENCARIAN PANDUAN & FAQ (ex api/all-search.js)
   ========================================================================= */
const KB = [
    { id: 'siswa-persiapan', q: 'Apa yang harus dilakukan siswa sebelum mulai belajar?', tags: 'siswa persiapan profil nama papan prestasi mulai',
      a: 'Isi nama Anda di halaman "Profil Saya". Ini penting agar nama Anda tercatat di Papan Prestasi.' },
    { id: 'siswa-gabung-kelas', q: 'Bagaimana cara bergabung ke ruang kelas?', tags: 'gabung masuk kelas kode 6 digit qr scan pindai siswa',
      a: 'Klik menu "Aksi" > "Gabung Kelas" di pojok kanan atas beranda, lalu masukkan 6 digit angka unik atau scan QR Code yang diberikan guru Anda. Di beranda juga tersedia menu "Masuk Kelas" dan "Pindai Kode".' },
    { id: 'siswa-misi', q: 'Bagaimana cara mengerjakan misi latihan?', tags: 'misi latihan membaca menulis mesin pemroses nilai logika siswa',
      a: 'Di dalam Ruang Kelas Anda akan menemukan misi membaca dan menulis. Kerjakan dengan serius, karena Mesin Pemroses akan langsung menilai logika tulisan Anda.' },
    { id: 'siswa-rangkuman', q: 'Bagaimana cara melihat rangkuman otomatis sebuah artikel?', tags: 'rangkuman ekstrak galeri teks artikel inti makna',
      a: 'Saat membaca Galeri Teks atau Artikel, gulir hingga paling bawah lalu tekan tombol "Ekstrak Rangkuman" untuk melihat inti makna tulisan.' },
    { id: 'guru-daftar', q: 'Bagaimana cara guru mendaftar dan masuk ke Portal Guru?', tags: 'guru daftar pendaftaran login masuk portal email verifikasi',
      a: 'Daftar menggunakan alamat email aktif. Anda wajib memverifikasi email dengan mengklik tautan yang dikirim ke inbox sebelum bisa masuk ke Portal Guru.' },
    { id: 'guru-buat-kelas', q: 'Bagaimana cara guru membuat ruang kelas?', tags: 'guru buat membuka ruang kelas dashboard jenjang smp sma cp tp kurikulum kode',
      a: 'Di Dashboard Guru pilih "Buat Ruang Kelas". Anda wajib memilih jenjang pendidikan (SMP/SMA) dan menyematkan CP/TP Kurikulum sebelum sistem membuat kode kelas.' },
    { id: 'guru-modul', q: 'Bagaimana cara mengunggah modul ajar?', tags: 'guru unggah upload modul ajar pdf bahan ajar ekstraksi materi interaktif',
      a: 'Sistem mendukung ekstraksi dokumen PDF. Unggah bahan ajar Anda, lalu Mesin Ekstraksi akan memecahnya menjadi materi interaktif bagi siswa.' },
    { id: 'guru-autograding', q: 'Bagaimana cara menilai esai siswa secara otomatis?', tags: 'guru evaluasi massal autograding otomatis rubrik prestasi esai live',
      a: 'Saat mengontrol kelas secara live, tekan tombol "Evaluasi Massal" di tab Prestasi untuk menilai esai siswa secara otomatis menggunakan indikator rubrik.' },
    { id: 'faq-lupa-sandi', q: 'Bagaimana jika saya lupa kata sandi?', tags: 'lupa kata sandi password reset akun login',
      a: 'Klik tombol "Lupa?" di halaman Log In pada kolom kata sandi. Masukkan email Anda, lalu sistem mengirim tautan reset kata sandi ke kotak masuk email Anda.' },
    { id: 'faq-kode-invalid', q: 'Apa yang harus dilakukan jika kode kelas invalid?', tags: 'kode kelas invalid salah tidak valid gabung',
      a: 'Pastikan Anda mengetik 6 digit angka dengan benar. Jika masih invalid, kemungkinan guru telah menutup atau mengarsipkan ruang kelas tersebut. Hubungi guru Anda untuk meminta kode baru.' },
    { id: 'faq-penilaian-esai', q: 'Bagaimana cara sistem menilai esai saya?', tags: 'nilai penilaian esai evaluator xp poin struktur tesis argumen kesimpulan',
      a: 'Sistem Evaluator membedah struktur tulisan Anda (Tesis, Argumen, Kesimpulan) dan mengecek relevansi serta logika argumentasi berdasarkan kurikulum (CP/TP) yang diatur sebelumnya. Semakin terstruktur tulisan Anda, semakin tinggi Poin XP yang didapat.' },
    { id: 'faq-email-verifikasi', q: 'Bagaimana jika email verifikasi saya tidak masuk?', tags: 'email verifikasi tidak masuk spam junk kirim ulang akun',
      a: 'Periksa folder SPAM atau Junk. Jika tetap tidak ada, tekan tombol "Kirim Ulang Email" di halaman verifikasi. Tunggu 2 menit antar percobaan untuk menghindari spam sistem.' },
    { id: 'faq-kelas-ditutup', q: 'Apakah saya bisa masuk kembali ke kelas yang sudah ditutup?', tags: 'kelas ditutup arsip akhiri kunci nilai riwayat',
      a: 'Tidak bisa. Jika guru menekan "Akhiri & Arsipkan Kelas", ruang kelas dikunci permanen. Namun laporan nilai akhir dan riwayat pengerjaan tetap tersimpan di arsip guru.' },
    { id: 'app-menu', q: 'Apa saja menu yang ada di beranda?', tags: 'menu beranda fitur belajar mandiri teks argumen artikel berita latihan analisis handout ruang kreasi portal guru pindai kode masuk kelas',
      a: 'Menu "Belajar Mandiri" di beranda berisi: Teks Argumen, Artikel Berita, Latihan Analisis, Handout Buku, Ruang Kreasi, Portal Guru, Pindai Kode, dan Masuk Kelas.' },
    { id: 'app-cari', q: 'Bagaimana cara mencari materi atau artikel?', tags: 'cari pencarian search materi artikel kolom cari beranda',
      a: 'Ketik kata kunci di kolom "Cari materi, artikel..." pada bagian atas beranda lalu tekan Enter. Anda akan diarahkan ke halaman hasil pencarian.' },
    { id: 'app-profil', q: 'Bagaimana cara mengubah nama atau foto profil?', tags: 'profil nama foto edit ubah ganti akun saya',
      a: 'Di beranda, ketuk bagian nama Anda lalu pilih "Edit Profil Saya". Untuk melihat foto profil dalam ukuran besar, pilih "Lihat Foto Profil" di menu yang sama.' },
    { id: 'app-tim', q: 'Siapa tim pengembang platform ini?', tags: 'tim pengembang developer pembuat dosen mahasiswa',
      a: 'Daftar tim pengembang beserta jabatan dan identitasnya ditampilkan di bagian "Tim Pengembang" pada halaman beranda.' },
    { id: 'app-bantuan', q: 'Bagaimana cara menghubungi customer support?', tags: 'bantuan support hubungi kontak whatsapp wa admin kendala',
      a: 'Buka halaman Panduan, lalu tekan tombol "Chat Customer Support Sekarang" di bagian bawah. Anda akan diarahkan ke WhatsApp dengan template pesan yang tinggal diisi.' }
];
const KB_BY_ID = Object.fromEntries(KB.map(k => [k.id, k]));
const pubKb = k => ({ id: k.id, q: k.q, a: k.a });

function tokenizeKb(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
}

function keywordSearch(query, limit = 4, excludeIds = []) {
    const qWords = tokenizeKb(query);
    return KB.filter(k => !excludeIds.includes(k.id))
        .map(k => {
            const hay = (k.q + ' ' + k.tags + ' ' + k.a).toLowerCase();
            const score = qWords.reduce((s, w) => s + (hay.includes(w) ? (k.q.toLowerCase().includes(w) || k.tags.includes(w) ? 2 : 1) : 0), 0);
            return { k, score };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(x => x.k);
}

function handleSuggest() {
    const pilihan = ['siswa-gabung-kelas', 'guru-buat-kelas', 'faq-lupa-sandi', 'faq-penilaian-esai', 'app-menu', 'faq-email-verifikasi'];
    return { related: pilihan.map(id => pubKb(KB_BY_ID[id])) };
}

async function handleHelp({ query }) {
    const q = String(query || '').trim().slice(0, 200);
    if (q.length < 2) throw galat('Pertanyaan terlalu pendek.', 400);

    const kbText = KB.map(k => `[${k.id}] T: ${k.q}\nJ: ${k.a}`).join('\n\n');
    const systemPrompt = `Kamu adalah Asisten Bantuan platform belajar "Platform Argumentasi" (bahasa Indonesia, untuk siswa dan guru SMP/SMA).
Jawab HANYA berdasarkan BASIS PENGETAHUAN di bawah. Jangan mengarang fitur, tombol, harga, atau langkah yang tidak tertulis.
Jika pertanyaan tidak tercakup, set "found": false, jelaskan singkat bahwa informasinya belum ada di panduan, lalu sarankan tombol "Chat Customer Support" di bagian bawah halaman Panduan.
Gaya: ramah, ringkas (maksimal 4 kalimat), teks polos tanpa simbol markdown (* _ # \`). Sapa langsung ke inti jawaban.

BASIS PENGETAHUAN:
${kbText}

KELUARAN: HANYA JSON valid:
{"found": true/false, "answer": "jawaban", "related": ["id-1","id-2","id-3"]}
"related" berisi 3 id dari basis pengetahuan yang paling relevan sebagai pertanyaan lanjutan (bukan id yang sudah menjadi jawaban utama jika bisa dihindari). Gunakan id persis seperti tertulis.`;

    try {
        const out = await callGroq({
            systemPrompt,
            userPrompt: `Pertanyaan pengguna: "${q}"`,
            temperature: 0.2,
            maxTokens: 900,
            jsonMode: true,
            models: MODELS_GROQ_FAST,
            timeoutMs: 25000
        });
        const answer = cl(out.answer);
        if (!answer) throw new Error('Jawaban kosong');
        const related = (Array.isArray(out.related) ? out.related : []).map(id => KB_BY_ID[String(id)]).filter(Boolean);
        if (related.length < 3) {
            const extra = keywordSearch(q, 3, related.map(r => r.id)).concat(KB.filter(k => k.id.startsWith('app-')));
            for (const k of extra) {
                if (related.length >= 3) break;
                if (!related.find(r => r.id === k.id)) related.push(k);
            }
        }
        return { mode: 'ai', found: out.found !== false, answer, related: related.slice(0, 3).map(pubKb) };
    } catch (e) {
        console.error('help fallback:', e.message);
        const hits = keywordSearch(q, 4);
        if (!hits.length) {
            return {
                mode: 'fallback',
                found: false,
                answer: 'Maaf, saya belum menemukan jawabannya di panduan. Silakan coba kata kunci lain atau hubungi Customer Support lewat tombol di bagian bawah halaman ini.',
                related: handleSuggest().related.slice(0, 3)
            };
        }
        return { mode: 'fallback', found: true, answer: hits[0].a, related: hits.slice(1, 4).map(pubKb) };
    }
}

/* =========================================================================
   10. MAIN ROUTER HANDLER
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
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const action = body.action || body.type;
        const auth = String(req.headers.authorization || '');
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

        if (!action) {
            return res.status(400).json({ error: 'Action tidak disertakan dalam permintaan.' });
        }

        // 1. Penilaian Esai AI
        if (action === 'grade_essay') {
            return res.status(200).json(await handleGradeEssay(body));
        }

        // 2. Evaluasi Struktur Esai
        if (action === 'evaluate_essay') {
            return res.status(200).json(await handleEvaluateEssay(body));
        }

        // 3. Ringkasan Teks
        if (action === 'summarize') {
            return res.status(200).json(await handleSummarize(body));
        }

        // 4. Form Helper (title & paraphrase)
        if (action === 'title' || action === 'paraphrase' || action === 'form') {
            return res.status(200).json(await handleForm(body));
        }

        // 5. Ruang Kreasi
        if (KREASI_HANDLERS[action]) {
            body.level = body.level === 'sma' ? 'sma' : 'smp';
            return res.status(200).json(await KREASI_HANDLERS[action](body));
        }

        // 6. Handout Cover AI
        if (action === 'handout_ai' || action === 'analisis') {
            return res.status(200).json(await handleHandoutAI(body, token));
        }

        // 7. Pembuatan Paket Latihan dari PDF Handout
        if (action === 'latihan' || action === 'buat_latihan' || (action === 'buat' && body.handoutId)) {
            return res.status(200).json(await handleLatihan(body));
        }

        // 8. Modul Kelas (extract / buat)
        if (action === 'modul' || action === 'buat_modul' || action === 'ekstrak_modul' || action === 'extract' || (action === 'buat' && body.materi)) {
            return res.status(200).json(await handleModul(body));
        }

        // 9. Panduan Pintar (suggest / help)
        if (action === 'suggest') {
            return res.status(200).json(handleSuggest());
        }
        if (action === 'help') {
            return res.status(200).json(await handleHelp(body));
        }

        return res.status(400).json({
            error: `Action '${action}' tidak dikenali.`,
            actions_tersedia: [
                'grade_essay',
                'evaluate_essay',
                'summarize',
                'title',
                'paraphrase',
                ...Object.keys(KREASI_HANDLERS),
                'handout_ai',
                'latihan',
                'modul',
                'suggest',
                'help'
            ]
        });
    } catch (error) {
        console.error('Central AI API error:', error);
        return res.status(error.status || 500).json({
            error: error.errorTitle || 'Sistem AI Gagal Bekerja',
            detail_error: error.message
        });
    }
};

module.exports.config = { maxDuration: 60 };
