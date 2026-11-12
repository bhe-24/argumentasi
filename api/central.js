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
    console.warn('Groq SDK opsional (menggunakan fetch langsung):', err.message);
}

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'mading-cf676';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyDpUWUIzPXIZN6rrNtsIqcL6VfOE2RLVl0';
const ALLOWED_ROLES = ['admin', 'teacher'];
const MAKS_PDF = 14 * 1024 * 1024;

// Model aktif Groq & Gemini terverifikasi + dukungan rotasi anti-rate-limit
const MODELS_GROQ = [...new Set([
    process.env.GROQ_MODEL,
    'openai/gpt-oss-20b',
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-120b',
    'llama-3.1-8b-instant',
    'meta-llama/llama-4-scout-17b-16e-instruct'
].filter(Boolean))];

const MODELS_GROQ_FAST = [...new Set([
    'openai/gpt-oss-20b',
    'llama-3.1-8b-instant',
    process.env.GROQ_MODEL,
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-120b'
].filter(Boolean))];

const MODELS_GEMINI = [...new Set([
    process.env.GEMINI_MODEL,
    'gemini-3.8-flash',
    'gemini-2.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.7-flash',
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
    'gemini-2.5-pro'
].filter(Boolean))];

// State global container hangat (cooldown model, cache PDF, bank soal, semaphore)
const AI_RUNTIME = globalThis.__argAiRuntime || (globalThis.__argAiRuntime = {
    cooldown: new Map(),     // key: `${provider}:${model}:${keyIdx}` -> timestamp bebas
    groqModelsCache: null,   // { ts, ids: Set<string> }
    activeCalls: 0,
    last429At: 0,
    waiters: []
});

const getEnvKeys = (prefix) => {
    const keys = [process.env[prefix], process.env[`${prefix}_2`], process.env[`${prefix}_3`], process.env[`${prefix}_BACKUP`]]
        .map(k => String(k || '').trim())
        .filter(Boolean);
    return [...new Set(keys)];
};

const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const setModelCooldown = (tag, ms) => {
    const until = Date.now() + Math.max(1000, ms);
    const prev = AI_RUNTIME.cooldown.get(tag) || 0;
    if (until > prev) AI_RUNTIME.cooldown.set(tag, until);
};
const isModelCooled = tag => (AI_RUNTIME.cooldown.get(tag) || 0) > Date.now();

async function withAiSlot(fn, maxConcurrent = 5, maxWaitMs = 14000) {
    if (AI_RUNTIME.activeCalls >= maxConcurrent) {
        await new Promise((resolve, reject) => {
            let done = false;
            const t = setTimeout(() => {
                if (done) return;
                done = true;
                const idx = AI_RUNTIME.waiters.indexOf(wake);
                if (idx >= 0) AI_RUNTIME.waiters.splice(idx, 1);
                reject(galat('Antrean server penuh sementara.', 429));
            }, maxWaitMs);
            const wake = () => {
                if (done) return;
                done = true;
                clearTimeout(t);
                resolve();
            };
            AI_RUNTIME.waiters.push(wake);
        });
    }
    AI_RUNTIME.activeCalls++;
    try {
        return await fn();
    } finally {
        AI_RUNTIME.activeCalls = Math.max(0, AI_RUNTIME.activeCalls - 1);
        const next = AI_RUNTIME.waiters.shift();
        if (next) next();
    }
}

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

function recoverPartialJson(clean) {
    // Pulihkan objek JSON berarray jika terpotong di tengah oleh batas token
    const mKey = clean.match(/"(soal|pilgan|teks|esai|kritis)"\s*:\s*\[/);
    if (!mKey) return null;
    const key = mKey[1];
    const arrStart = clean.indexOf('[', mKey.index);
    const items = [];
    let depth = 0, inStr = false, esc = false, itemStart = -1;
    for (let i = arrStart + 1; i < clean.length; i++) {
        const ch = clean[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') {
            if (depth === 0) itemStart = i;
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0 && itemStart !== -1) {
                try {
                    items.push(JSON.parse(clean.slice(itemStart, i + 1)));
                } catch (e) {}
                itemStart = -1;
            }
        }
    }
    if (!items.length) return null;
    if (key === 'teks') {
        const jm = clean.match(/"judul"\s*:\s*"([^"]{2,150})"/);
        return { judul: jm ? jm[1] : 'Teks Argumentasi', teks: items };
    }
    return { [key]: items, soal: items };
}

function extractJSON(text) {
    if (!text) throw new Error('Output AI kosong');
    let clean = String(text)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/i, '')
        .replace(/```(?:json)?\s*/gi, '')
        .replace(/```/g, '')
        .trim();

    const tryParse = s => {
        try { return JSON.parse(s); } catch (e) {}
        const fixed = s.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(fixed);
    };

    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
        try {
            return tryParse(clean.slice(start, end + 1));
        } catch (err) {
            const recovered = recoverPartialJson(clean.slice(start));
            if (recovered) return recovered;
        }
    }
    const sArr = clean.indexOf('[');
    const eArr = clean.lastIndexOf(']');
    if (sArr !== -1 && eArr !== -1 && eArr > sArr) {
        try {
            return tryParse(clean.slice(sArr, eArr + 1));
        } catch (err) {}
    }
    const recovered = recoverPartialJson(clean);
    if (recovered) return recovered;
    throw new Error('Respons AI bukan JSON valid');
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

async function getGroqAvailableModelSet(apiKey) {
    const cache = AI_RUNTIME.groqModelsCache;
    if (cache && Date.now() - cache.ts < 600000) return cache.ids;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2500);
    try {
        const r = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { Authorization: 'Bearer ' + apiKey },
            signal: ac.signal
        });
        if (!r.ok) return null;
        const j = await r.json().catch(() => ({}));
        const ids = new Set((j.data || []).map(m => m && m.id).filter(Boolean));
        if (ids.size) AI_RUNTIME.groqModelsCache = { ts: Date.now(), ids };
        return ids;
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/* ---------- CALL GROQ MULTI-MODEL (Direct REST + Cooldown + Retry-After) ---------- */
async function callGroqWithMeta({ systemPrompt, userPrompt, temperature = 0.3, maxTokens = 1500, jsonMode = true, models = MODELS_GROQ, timeoutMs = 18000, rotateSeed = -1 }) {
    const keys = getEnvKeys('GROQ_API_KEY');
    if (!keys.length) throw galat('GROQ_API_KEY tidak ditemukan di environment variables.', 500);

    const activeSet = await getGroqAvailableModelSet(keys[0]);
    let ordered = models.filter(m => !activeSet || activeSet.has(m));
    if (!ordered.length) ordered = models.slice();
    if (rotateSeed >= 0 && ordered.length > 1) {
        const shift = rotateSeed % ordered.length;
        ordered = ordered.slice(shift).concat(ordered.slice(0, shift));
    }

    const errors = [];
    let sawRateLimit = false;
    let maxRetryAfterMs = 0;

    for (let kIdx = 0; kIdx < keys.length; kIdx++) {
        const apiKey = keys[kIdx];
        for (const model of ordered) {
            const tag = `groq:${model}:${kIdx}`;
            if (isModelCooled(tag)) {
                errors.push(`${model}(cooled)`);
                continue;
            }

            let allowReasoning = model.startsWith('openai/');
            let allowJsonFmt = !!jsonMode;

            for (let subTry = 0; subTry < 2; subTry++) {
                const ac = new AbortController();
                const timer = setTimeout(() => ac.abort(), timeoutMs);
                try {
                    const body = {
                        model,
                        temperature,
                        max_completion_tokens: maxTokens,
                        messages: [
                            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
                            { role: 'user', content: userPrompt }
                        ]
                    };
                    if (allowJsonFmt) body.response_format = { type: 'json_object' };
                    if (allowReasoning) body.reasoning_effort = 'low';

                    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        signal: ac.signal,
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: 'Bearer ' + apiKey
                        },
                        body: JSON.stringify(body)
                    });

                    const payload = await resp.json().catch(() => ({}));
                    if (!resp.ok) {
                        const errMsg = (payload.error && payload.error.message) || ('HTTP ' + resp.status);
                        const errCode = (payload.error && payload.error.code) || '';

                        if (resp.status === 429) {
                            sawRateLimit = true;
                            AI_RUNTIME.last429At = Date.now();
                            const ra = parseFloat(resp.headers.get('retry-after') || '0');
                            const coolMs = Math.min(45000, Math.max(8000, (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 14000)));
                            maxRetryAfterMs = Math.max(maxRetryAfterMs, coolMs);
                            setModelCooldown(tag, coolMs);
                            throw Object.assign(new Error(errMsg), { status: 429 });
                        }
                        if (/decommissioned|not_found|does not exist|unsupported model/i.test(errMsg + ' ' + errCode) || resp.status === 404) {
                            setModelCooldown(tag, 30 * 60 * 1000);
                            throw Object.assign(new Error(errMsg), { status: resp.status });
                        }
                        if (resp.status === 413 || /too large|tokens per minute|request too large/i.test(errMsg)) {
                            setModelCooldown(tag, 12000);
                            throw Object.assign(new Error(errMsg), { status: 413 });
                        }
                        if (resp.status === 400 && subTry === 0 && (/reasoning_effort|response_format/i.test(errMsg))) {
                            if (/reasoning_effort/i.test(errMsg)) allowReasoning = false;
                            if (/response_format/i.test(errMsg)) allowJsonFmt = false;
                            continue;
                        }
                        if (resp.status >= 500) {
                            setModelCooldown(tag, 10000);
                        }
                        throw Object.assign(new Error(errMsg), { status: resp.status });
                    }

                    const content = (payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content) || '';
                    const data = jsonMode ? extractJSON(content) : content;
                    return { data, model: `groq/${model}` };
                } catch (err) {
                    const m = err.name === 'AbortError' ? `Timeout ${timeoutMs}ms` : err.message;
                    console.warn(`Groq [${model}] error:`, m);
                    errors.push(`${model}: ${m}`);
                    if (err.name === 'AbortError') setModelCooldown(tag, 9000);
                    break;
                } finally {
                    clearTimeout(timer);
                }
            }
        }
    }

    const outErr = new Error('Semua model Groq gagal: ' + errors.join(' | '));
    if (sawRateLimit) {
        outErr.status = 429;
        outErr.retryAfterMs = maxRetryAfterMs || 10000;
    }
    throw outErr;
}

async function callGroq(opts) {
    const { data } = await callGroqWithMeta(opts);
    return data;
}

/* ---------- CALL GEMINI API (Text / Multimodal + Cooldown) ---------- */
async function callGeminiWithMeta({ prompt, base64Data = null, mimeType = 'application/pdf', temperature = 0.2, maxTokens = 4096, timeoutMs = 24000, models = MODELS_GEMINI, rotateSeed = -1 }) {
    const keys = getEnvKeys('GEMINI_API_KEY');
    if (!keys.length) throw galat('GEMINI_API_KEY tidak ditemukan di environment variables.', 500);

    let ordered = models.slice();
    if (rotateSeed >= 0 && ordered.length > 1) {
        const shift = rotateSeed % ordered.length;
        ordered = ordered.slice(shift).concat(ordered.slice(0, shift));
    }

    const errors = [];
    let sawRateLimit = false;
    let maxRetryAfterMs = 0;

    for (let kIdx = 0; kIdx < keys.length; kIdx++) {
        const geminiKey = keys[kIdx];
        for (const model of ordered) {
            const tag = `gemini:${model}:${kIdx}`;
            if (isModelCooled(tag)) {
                errors.push(`${model}(cooled)`);
                continue;
            }
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
                if (!response.ok) {
                    const msg = (data.error && data.error.message) || ('HTTP ' + response.status);
                    if (response.status === 429 || /quota|resource_exhausted|rate/i.test(msg)) {
                        sawRateLimit = true;
                        AI_RUNTIME.last429At = Date.now();
                        const ra = parseFloat(response.headers.get('retry-after') || '0');
                        const coolMs = Math.min(45000, Math.max(8000, (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15000)));
                        maxRetryAfterMs = Math.max(maxRetryAfterMs, coolMs);
                        setModelCooldown(tag, coolMs);
                    } else if (response.status === 404 || /not found|no longer available|deprecated|shut down/i.test(msg)) {
                        setModelCooldown(tag, 30 * 60 * 1000);
                    } else if (response.status >= 500) {
                        setModelCooldown(tag, 10000);
                    }
                    throw Object.assign(new Error(msg), { status: response.status });
                }

                const text = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map(p => p.text || '').join('');
                return { data: extractJSON(text), model: `gemini/${model}` };
            } catch (err) {
                const m = err.name === 'AbortError' ? `Timeout ${timeoutMs}ms` : err.message;
                console.warn(`Gemini [${model}] error:`, m);
                errors.push(`${model}: ${m}`);
                if (err.name === 'AbortError') setModelCooldown(tag, 9000);
            } finally {
                clearTimeout(timer);
            }
        }
    }

    const outErr = new Error('Semua model Gemini gagal: ' + errors.join(' | '));
    if (sawRateLimit) {
        outErr.status = 429;
        outErr.retryAfterMs = maxRetryAfterMs || 12000;
    }
    throw outErr;
}

async function callGemini(opts) {
    const { data } = await callGeminiWithMeta(opts);
    return data;
}

/* ---------- ROUTER CERDAS MULTI-PROVIDER (Groq <-> Gemini + Load Spreading) ---------- */
async function callAIJsonSmart({ systemPrompt, userPrompt, temperature = 0.4, maxTokens = 2000, timeoutMs = 15000, provider = 'auto', seed = -1 }) {
    const rotate = seed >= 0 ? seed : Math.floor(Math.random() * 6);
    const hasGroq = getEnvKeys('GROQ_API_KEY').length > 0;
    const hasGemini = getEnvKeys('GEMINI_API_KEY').length > 0;
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;

    return await withAiSlot(async () => {
        const tryGroqFirst = provider === 'groq' || (provider === 'auto' && (!hasGemini || (hasGroq && rotate % 3 !== 2)));
        const order = provider === 'gemini' ? ['gemini'] : provider === 'groq' ? ['groq'] : (tryGroqFirst ? ['groq', 'gemini'] : ['gemini', 'groq']);

        const errs = [];
        let saw429 = false;
        let retryMs = 0;

        for (const p of order) {
            if (p === 'groq' && !hasGroq) continue;
            if (p === 'gemini' && !hasGemini) continue;
            try {
                if (p === 'groq') {
                    return await callGroqWithMeta({
                        systemPrompt,
                        userPrompt,
                        temperature,
                        maxTokens,
                        jsonMode: true,
                        models: maxTokens <= 2400 ? MODELS_GROQ_FAST : MODELS_GROQ,
                        timeoutMs,
                        rotateSeed: rotate
                    });
                }
                return await callGeminiWithMeta({
                    prompt: fullPrompt,
                    temperature,
                    maxTokens: Math.max(maxTokens, 2048),
                    timeoutMs: Math.max(timeoutMs, 18000),
                    rotateSeed: rotate
                });
            } catch (e) {
                errs.push(e.message);
                if (e.status === 429) saw429 = true;
                if (e.retryAfterMs) retryMs = Math.max(retryMs, e.retryAfterMs);
            }
        }

        const finalErr = galat(errs.join(' | ') || 'Provider AI tidak tersedia.', saw429 ? 429 : 502);
        if (retryMs) finalErr.retryAfterMs = retryMs;
        throw finalErr;
    });
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
   7. HANDLER: PAKET LATIHAN HARIAN DARI PDF HANDOUT (Pacu Jalur Per Bagian)
   ========================================================================= */
const TINGKAT_LAT = ['mudah', 'sedang', 'sulit', 'hots'];
const RENTANG_LAT = { mudah: [30, 60], sedang: [45, 90], sulit: [60, 120], hots: [90, 180] };

const LATIHAN_CACHE = globalThis.__argLatihanCache || (globalThis.__argLatihanCache = {
    prep: new Map(),         // handoutId -> { ts, data }
    inFlightPrep: new Map(), // handoutId -> Promise
    bank: new Map()          // handoutId -> { ts, pilgan: [], struktur: [], esai: [], kritis: [] }
});

function getBank(handoutId) {
    let b = LATIHAN_CACHE.bank.get(handoutId);
    if (!b || Date.now() - b.ts > 6 * 3600 * 1000) {
        b = { ts: Date.now(), pilgan: [], struktur: [], esai: [], kritis: [] };
        LATIHAN_CACHE.bank.set(handoutId, b);
        if (LATIHAN_CACHE.bank.size > 40) {
            const firstKey = LATIHAN_CACHE.bank.keys().next().value;
            LATIHAN_CACHE.bank.delete(firstKey);
        }
    }
    return b;
}

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
    return { judul: v('judul') || 'Materi', url, deskripsi: v('deskripsi') || '', kategori: v('kategori') || '' };
}

async function ambilPdfBuffer(url) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 22000);
    try {
        const r = await fetch(url, { signal: ac.signal });
        if (!r.ok) throw galat('File PDF tidak bisa dibuka (HTTP ' + r.status + ').', 502);
        const ab = await r.arrayBuffer();
        if (ab.byteLength > MAKS_PDF) throw galat('File PDF terlalu besar untuk dianalisis.', 413);
        return Buffer.from(ab);
    } finally {
        clearTimeout(timer);
    }
}

/* ---------- PEMECAHAN & PENYARINGAN TEKS PDF (Anti Token Overflow) ---------- */
const MARKER_RE = /\b(tesis|argumen|argumentasi|kesimpulan|simpulan|fakta|opini|bukti|data|riset|penelitian|karena|sebab|oleh karena itu|sehingga|dampak|manfaat|tujuan|definisi|pengertian|ciri|struktur|kaidah|konjungsi|sebaliknya|namun)\b/gi;

function pecahDanSaringMateri(rawText, judul = 'Materi', deskripsi = '') {
    const text = bersihkanTeksPdf(rawText);
    if (!text || text.length < 80) {
        const fallback = clSpace(`${judul}. ${deskripsi}`, 1200);
        return { segmen: fallback ? [fallback] : [], paragrafTop: [], rawChars: text.length };
    }

    const rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const freq = new Map();
    for (const l of rawLines) {
        if (l.length <= 75) {
            const k = l.toLowerCase().replace(/\d+/g, '#');
            freq.set(k, (freq.get(k) || 0) + 1);
        }
    }

    // Pecah baris kelewat panjang (misal hasil stream extractor tanpa \n) per kalimat agar tidak melebihi batas segmen
    const expandedLines = [];
    for (const l of rawLines) {
        if (/^(hal\.?|halaman|page|bab)?\s*\d+(\s*(\/|dari|of)\s*\d+)?$/i.test(l)) continue;
        if (/^https?:\/\/\S+$/i.test(l)) continue;
        if (/^(isbn|issn|daftar pustaka|daftar isi|kata pengantar|copyright)/i.test(l)) continue;
        const k = l.toLowerCase().replace(/\d+/g, '#');
        if (l.length <= 75 && (freq.get(k) || 0) >= 3) continue;
        if (l.replace(/[^a-zA-Z0-9]/g, '').length < 4) continue;

        if (l.length <= 420) {
            expandedLines.push(l);
        } else {
            const sents = l.split(/(?<=[.!?])\s+/);
            for (const s of sents) {
                const ts = s.trim();
                if (!ts) continue;
                if (ts.length <= 480) {
                    expandedLines.push(ts);
                } else {
                    for (let i = 0; i < ts.length; i += 420) {
                        expandedLines.push(ts.slice(i, i + 420).trim());
                    }
                }
            }
        }
    }

    // Rangkai baris menjadi paragraf bermakna (150-550 karakter)
    const paras = [];
    let buf = '';
    for (const l of expandedLines) {
        if (buf && buf.length + l.length + 1 > 520) {
            paras.push(buf.trim().slice(0, 560));
            buf = l;
            continue;
        }
        buf = buf ? `${buf} ${l}` : l;
        const akhirKalimat = /[.!?…]["')\]]?$/.test(l);
        if (buf.length >= 340 || (akhirKalimat && buf.length >= 160)) {
            paras.push(buf.trim().slice(0, 560));
            buf = '';
        }
    }
    if (buf.trim().length >= 60) paras.push(buf.trim().slice(0, 560));

    const uniqueParas = [];
    const seen = new Set();
    for (const p of paras) {
        const sig = p.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
        if (sig.length < 20 || seen.has(sig)) continue;
        seen.add(sig);
        const marks = (p.match(MARKER_RE) || []).length;
        const hasNum = /\d+/.test(p) ? 1.5 : 0;
        const lenScore = Math.min(3, p.length / 160);
        const alphaRatio = (p.match(/[a-zA-Z]/g) || []).length / Math.max(1, p.length);
        const noisePenalty = alphaRatio < 0.55 ? -4 : 0;
        const score = marks * 2 + hasNum + lenScore + noisePenalty;
        uniqueParas.push({ p, idx: uniqueParas.length, score });
    }

    if (!uniqueParas.length) {
        const fallback = clSpace(text, 2200);
        return { segmen: fallback ? [fallback] : [], paragrafTop: [], rawChars: text.length };
    }

    // Bagi dokumen merata ke 4 zona (Awal -> Tengah-1 -> Tengah-2 -> Akhir) agar teks >10.500 token terwakili adil tanpa melampaui batas token
    const total = uniqueParas.length;
    const bucketCount = Math.min(4, Math.max(1, Math.ceil(total / 3)));
    const segmen = [];
    const perSegMax = 2200; // ~550-650 token per segmen

    for (let b = 0; b < bucketCount; b++) {
        const lo = Math.floor((b / bucketCount) * total);
        const hi = Math.floor(((b + 1) / bucketCount) * total);
        const slice = uniqueParas.slice(lo, Math.max(lo + 1, hi));
        const ranked = slice.slice().sort((a, b2) => b2.score - a.score);
        const chosen = [];
        let charSum = 0;
        for (const item of ranked) {
            if (charSum + item.p.length + 2 > perSegMax && chosen.length > 0) continue;
            chosen.push(item);
            charSum += item.p.length + 2;
            if (charSum >= perSegMax - 120) break;
        }
        chosen.sort((a, b2) => a.idx - b2.idx);
        const gab = chosen.map(x => x.p).join('\n').slice(0, perSegMax);
        if (gab.trim().length >= 80) segmen.push(gab.trim());
    }

    const paragrafTop = uniqueParas.slice().sort((a, b) => b.score - a.score).slice(0, 8).map(x => x.p);
    return { segmen: segmen.length ? segmen : [text.slice(0, 2200)], paragrafTop, rawChars: text.length };
}

function ringkasEkstraktifFallback(judul, segmen = [], deskripsi = '') {
    const sents = segmen.join(' ').split(/(?<=[.!?])\s+/).map(s => clSpace(s, 220)).filter(s => s.length >= 35);
    const r = sents.slice(0, 2).join(' ') || clSpace(deskripsi || `Materi pembelajaran mengenai ${judul}.`, 350);
    const poin = sents.slice(0, 4).map(s => `- ${s.slice(0, 140)}`).join('\n');
    return { ringkasan: clSpace(r, 420), poinKunci: poin || `- Topik utama: ${judul}` };
}

function pilihKonteksStage(prep, slotIdx = 0, maxChars = 2500) {
    const segs = Array.isArray(prep.segmen) && prep.segmen.length ? prep.segmen : [];
    const primary = segs.length ? segs[Math.abs(slotIdx) % segs.length] : '';
    const secondary = segs.length > 1 ? segs[(Math.abs(slotIdx) + 1) % segs.length] : '';
    const head = prep.poinKunci ? `INTISARI:\n${String(prep.poinKunci).slice(0, 650)}\n\n` : '';
    const room = Math.max(800, maxChars - head.length);
    let kutip = primary.slice(0, room);
    if (secondary && kutip.length < room - 450) {
        kutip += '\n---\n' + secondary.slice(0, room - kutip.length - 5);
    }
    return `${head}KUTIPAN MATERI "${clSpace(prep.judul, 120)}":\n"""\n${kutip || clSpace(prep.ringkasan, 1200)}\n"""`;
}

/* ---------- VALIDASI, FILTER & DEDUPLIKASI SOAL ---------- */
const BAD_OPSI_RE = /^(semua\s+(jawaban\s+)?(benar|salah|tepat|di\s+atas|di\s+bawah)|tidak\s+ada\s+(yang|jawaban)\s+(benar|tepat|sesuai)|[a-d]\s*(dan|&)\s*[a-d]\s+(benar|salah)|bukan\s+salah\s+satu)/i;
const isBadOption = o => !o || o.length < 2 || BAD_OPSI_RE.test(o.trim());
const STEM_STOP = new Set(['yang', 'dan', 'atau', 'dari', 'dalam', 'pada', 'atas', 'untuk', 'dengan', 'oleh', 'sebagai', 'adalah', 'dapat', 'jika', 'bila', 'maka', 'akan', 'tersebut', 'berikut', 'manakah', 'apakah', 'mengapa', 'bagaimana', 'pernyataan', 'pertanyaan', 'berdasarkan', 'kutipan', 'wacana', 'materi', 'teks', 'argumentasi', 'paling', 'tepat', 'sesuai', 'benar', 'salah']);
const tokenizeStem = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => (w.length >= 2 || /\d/.test(w)) && !STEM_STOP.has(w)));
function isDupStem(stem, existingArr) {
    const norm = String(stem || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (norm.length < 10) return true;
    const tA = tokenizeStem(stem);
    for (const ex of existingArr) {
        const exNorm = String(ex || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!exNorm) continue;
        if (exNorm === norm) return true;
        const tB = tokenizeStem(ex);
        if (tA.size >= 4 && tB.size >= 4) {
            let inter = 0;
            tA.forEach(w => { if (tB.has(w)) inter++; });
            const jaccard = inter / (tA.size + tB.size - inter);
            if (jaccard >= 0.84) return true;
        }
    }
    return false;
}

function parseJIndex(rawJ, opsi) {
    if (Number.isInteger(rawJ) && rawJ >= 0 && rawJ <= 3) return rawJ;
    const s = String(rawJ ?? '').trim().toUpperCase();
    const abc = ['A', 'B', 'C', 'D'].indexOf(s);
    if (abc >= 0) return abc;
    const n = parseInt(s, 10);
    if (Number.isInteger(n) && n >= 0 && n <= 3) return n;
    if (opsi && s) {
        const idx = opsi.findIndex(o => o.toLowerCase() === s.toLowerCase());
        if (idx >= 0) return idx;
    }
    return -1;
}

function soalPgLatihan(x, tingkatDefault) {
    if (!x || typeof x !== 'object') return null;
    const rawOpsi = Array.isArray(x.opsi) ? x.opsi : (Array.isArray(x.pilihan) ? x.pilihan : []);
    const opsi = rawOpsi.map(o => clSpace(o, 280)).filter(Boolean);
    const j = parseJIndex(x.j ?? x.jawaban ?? x.kunci, opsi);
    const p = clSpace(x.p || x.pertanyaan || x.tesis, 800);
    if (!p || p.length < 15 || opsi.length !== 4) return null;
    const lowerSet = new Set(opsi.map(o => o.toLowerCase()));
    if (lowerSet.size !== 4 || opsi.some(isBadOption) || j < 0 || j > 3) return null;

    const benar = opsi[j];
    const baru = acak(opsi);
    let tingkat = String(x.tingkat || '').toLowerCase().trim();
    if (!TINGKAT_LAT.includes(tingkat)) tingkat = tingkatDefault;
    const o = {
        p,
        opsi: baru,
        j: baru.indexOf(benar),
        tingkat,
        waktu: jepit(x.waktu, RENTANG_LAT[tingkat]),
        bahas: clSpace(x.bahas || x.pembahasan || x.alasan, 450) || `Jawaban yang tepat adalah "${benar}" sesuai isi materi.`
    };
    if (x.tesis && !x.p) o.tesis = clSpace(x.tesis, 500);
    if (x.kasus) o.kasus = clSpace(x.kasus, 450);
    if (x.konsep || x.aspek) {
        const kLabel = clSpace(x.konsep || x.aspek, 60);
        o.konsep = kLabel;
        o.aspek = kLabel;
    }
    return o;
}

function soalEsaiLatihan(x, tingkatDefault) {
    if (!x || typeof x !== 'object') return null;
    const p = clSpace(x.p || x.pertanyaan || x.tesis, 800);
    if (!p || p.length < 18) return null;
    let tingkat = String(x.tingkat || '').toLowerCase().trim();
    if (!TINGKAT_LAT.includes(tingkat) || tingkat === 'mudah') tingkat = tingkatDefault;
    return {
        p,
        tingkat,
        waktu: jepit(x.waktu, [180, 540]),
        bahas: clSpace(x.bahas || x.kunci || x.pembahasan, 700) || 'Jelaskan gagasan utama secara logis disertai alasan dan bukti yang relevan dari teks materi.'
    };
}

function urutTingkatLatihan(a) {
    return a.map((s, i) => [s, i])
        .sort((x, y) => TINGKAT_LAT.indexOf(x[0].tingkat) - TINGKAT_LAT.indexOf(y[0].tingkat) || x[1] - y[1])
        .map(x => x[0]);
}

function filterPgList(rawList, existingStems = [], tingkatDefault = 'sedang') {
    const out = [];
    const seen = existingStems.slice();
    for (const raw of (Array.isArray(rawList) ? rawList : [])) {
        const clean = soalPgLatihan(raw, tingkatDefault);
        if (!clean || isDupStem(clean.p, seen)) continue;
        seen.push(clean.p);
        out.push(clean);
    }
    return out;
}

function normStrukturLabel(lbl) {
    const s = String(lbl || '').toLowerCase().trim();
    if (['tesis', 'pendapat', 'pernyataan umum', 'klaim', 'orientasi'].includes(s)) return 'tesis';
    if (['argumen', 'argumentasi', 'alasan', 'bukti', 'isi'].includes(s)) return 'argumen';
    if (['kesimpulan', 'simpulan', 'penegasan', 'penegasan ulang', 'penutup'].includes(s)) return 'kesimpulan';
    return '';
}

function filterStrukturPack(raw) {
    const src = raw && raw.struktur ? raw.struktur : (raw || {});
    const arrTeks = Array.isArray(src.teks) ? src.teks : (Array.isArray(src.kalimat) ? src.kalimat : (Array.isArray(src.soal) ? src.soal : []));
    const teks = arrTeks.map(k => ({
        t: clSpace(k && (k.t || k.teks || k.kalimat), 480),
        label: normStrukturLabel(k && k.label),
        alasan: clSpace(k && (k.alasan || k.bahas), 280)
    })).filter(k => k.t && k.t.length >= 15 && k.label).slice(0, 9);

    for (const k of teks) {
        if (!k.alasan) {
            k.alasan = k.label === 'tesis' ? 'Kalimat ini menyatakan posisi/gagasan utama penulis.'
                : k.label === 'kesimpulan' ? 'Kalimat ini menegaskan kembali inti argumen sebagai penutup.'
                : 'Kalimat ini menyajikan alasan atau bukti pendukung bagi tesis.';
        }
    }
    const LAB = ['tesis', 'argumen', 'kesimpulan'];
    if (teks.length < 5 || !LAB.every(l => teks.some(k => k.label === l))) return null;
    return {
        judul: clSpace(src.judul, 140) || 'Struktur Teks Argumentasi',
        teks,
        waktu: jepit(src.waktu || teks.length * 40, [teks.length * 30, Math.max(600, teks.length * 80)])
    };
}

/* ---------- SINTESIS CADANGAN EKSTRAKTIF (Hanya jaring pengaman terakhir jika semua kuota AI habis total) ---------- */
function potongKalimatMateri(prep) {
    const text = [prep.poinKunci || '', ...(prep.segmen || []), prep.ringkasan || ''].join(' ');
    const sents = text.split(/(?<=[.!?])\s+/).map(s => clSpace(s, 220)).filter(s => s.length >= 35 && /[a-zA-Z]{4,}/.test(s));
    return [...new Set(sents)];
}

function bangunSoalDarurat(section, prep, countNeeded = 8, excludeStems = []) {
    const sents = potongKalimatMateri(prep);
    const topik = clSpace(prep.judul, 100) || 'Materi Pembelajaran';
    const basePool = sents.length >= 3 ? sents : [
        `Teks "${topik}" menyampaikan gagasan utama yang didukung oleh alasan serta bukti yang logis.`,
        `Dalam menyusun argumentasi tentang "${topik}", penulis membedakan data faktual dan pendapat pribadi secara jelas.`,
        `Hubungan sebab-akibat digunakan agar argumen mengenai "${topik}" tersusun runtut menuju kesimpulan yang kuat.`,
        `Simpulan dalam pembahasan "${topik}" berfungsi menegaskan kembali posisi penulis berdasarkan rangkaian argumen sebelumnya.`
    ];

    if (section === 'pilgan') {
        const templates = [
            (s, alt) => ({ p: `Berdasarkan materi "${topik}", pernyataan manakah yang sesuai dengan gagasan berikut: "${s.slice(0, 120)}..."?`, opsi: [s.slice(0, 150), `Materi menegaskan bahwa ${topik} sama sekali tidak memerlukan bukti pendukung`, `Pembahasan menolak seluruh keterkaitan antara fakta dan simpulan pada ${topik}`, alt.slice(0, 140) + ' namun bertentangan dengan topik inti'], j: 0, tingkat: 'mudah', waktu: 45, bahas: `Pernyataan tersebut merujuk langsung pada isi materi "${topik}".` }),
            (s) => ({ p: `Apa fungsi utama informasi berikut dalam struktur teks argumentasi pada materi "${topik}": "${s.slice(0, 125)}"?`, opsi: ['Memperkuat posisi atau gagasan dengan dasar penalaran yang relevan', 'Sekadar hiburan naratif tanpa kaitan logis', 'Daftar istilah acak yang tidak berhubungan dengan argumen', 'Kalimat penolakan tanpa dasar alasan'], j: 0, tingkat: 'sedang', waktu: 60, bahas: 'Informasi faktual atau konseptual dipakai untuk menguatkan tesis dalam teks argumentasi.' }),
            (s) => ({ p: `Mengapa uraian "${s.slice(0, 110)}" penting dipertahankan dalam analisis materi "${topik}"?`, opsi: ['Karena menjaga kepaduan antara argumen, bukti pendukung, dan kesimpulan', 'Karena membuat paragraf lebih panjang tanpa menambah makna', 'Karena menggantikan kebutuhan data dengan asumsi bebas', 'Karena memutus alur logika pembaca'], j: 0, tingkat: 'sulit', waktu: 75, bahas: 'Argumen efektif menghubungkan konsep utama dan bukti secara padu.' }),
            (s) => ({ p: `Jika seorang pembaca mengevaluasi klaim terkait "${s.slice(0, 100)}", langkah berpikir HOTS manakah yang paling tepat?`, opsi: ['Menguji konsistensi antara klaim, relevansi bukti, dan kelogisan simpulan', 'Langsung menerima klaim tanpa memeriksa dukungan data', 'Mengabaikan konteks materi dan hanya melihat panjang kalimat', 'Menganggap setiap opini sebagai fakta mutlak'], j: 0, tingkat: 'hots', waktu: 100, bahas: 'Evaluasi tingkat tinggi menuntut pengujian bukti dan koherensi logika klaim.' })
        ];
        const out = [];
        for (let i = 0; i < countNeeded + 4 && out.length < countNeeded; i++) {
            const s = basePool[i % basePool.length];
            const alt = basePool[(i + 1) % basePool.length];
            const raw = templates[i % templates.length](s, alt);
            if (!isDupStem(raw.p, excludeStems)) {
                const c = soalPgLatihan(raw, 'sedang');
                if (c) { excludeStems.push(c.p); out.push(c); }
            }
        }
        return out;
    }

    if (section === 'struktur') {
        const s0 = basePool[0] || `Pembahasan mengenai ${topik} memiliki peran penting untuk dipahami secara menyeluruh.`;
        const s1 = basePool[1] || `Pertama, pemahaman konsep inti dalam ${topik} didasarkan pada data dan pengamatan yang terukur.`;
        const s2 = basePool[2] || `Kedua, hubungan sebab-akibat menunjukkan mengapa gagasan tersebut relevan dalam kehidupan nyata.`;
        const s3 = basePool[3] || `Selain itu, contoh konkret membuktikan bahwa penerapan prinsip ${topik} memberi hasil lebih baik.`;
        const s4 = basePool[Math.min(4, basePool.length - 1)] || `Faktor pendukung lainnya turut memperkuat validitas argumen yang dipaparkan penulis.`;
        const s5 = basePool[Math.min(5, basePool.length - 1)] || `Jika dikaji lebih mendalam, pendekatan yang sistematis menghindarkan kita dari kesalahan penalaran.`;
        return {
            judul: clSpace(topik, 120),
            waktu: 280,
            teks: [
                { t: clSpace(s0, 300), label: 'tesis', alasan: 'Memperkenalkan posisi atau gagasan awal mengenai topik.' },
                { t: clSpace(s1, 300), label: 'argumen', alasan: 'Menyajikan alasan/konsep pendukung pertama dari materi.' },
                { t: clSpace(s2, 300), label: 'argumen', alasan: 'Menjelaskan keterkaitan logis yang memperkuat argumen.' },
                { t: clSpace(s3, 300), label: 'argumen', alasan: 'Memberikan rincian bukti atau aspek penjelas tambahan.' },
                { t: clSpace(s4, 300), label: 'argumen', alasan: 'Melengkapi pemaparan sebab-akibat terhadap gagasan utama.' },
                { t: clSpace(s5, 300), label: 'argumen', alasan: 'Menunjukkan implikasi logis dari pembahasan materi.' },
                { t: clSpace(`Oleh karena itu, penguasaan gagasan utama pada materi "${topik}" menjadi kunci dalam menyusun argumen yang logis dan meyakinkan.`, 300), label: 'kesimpulan', alasan: 'Menegaskan kembali simpulan dari rangkaian argumen.' }
            ]
        };
    }

    if (section === 'esai') {
        const baseQs = [
            { p: `Jelaskan gagasan pokok atau tesis utama yang dikemukakan dalam materi "${topik}" beserta alasan pendukungnya!`, tingkat: 'sedang', waktu: 300, bahas: prep.ringkasan || basePool[0] },
            { p: `Mengapa bukti atau fakta dari "${basePool[0].slice(0, 90)}" penting dalam memperkuat keutuhan argumen materi?`, tingkat: 'sedang', waktu: 300, bahas: 'Bukti membuat klaim bersifat objektif, rasional, dan dapat dipertanggungjawabkan.' },
            { p: `Bagaimana hubungan sebab-akibat antarbagian pembahasan dalam materi "${topik}" membentuk kesimpulan yang logis?`, tingkat: 'sulit', waktu: 320, bahas: 'Setiap argumen mengarah secara konsisten pada penegasan simpulan akhir.' },
            { p: `Apa dampak atau implikasi praktis yang terjadi apabila konsep utama pada "${topik}" diabaikan? Jelaskan argumenmu!`, tingkat: 'sulit', waktu: 320, bahas: 'Mengabaikan konsep inti melemahkan validitas penalaran dan pemecahan masalah.' },
            { p: `Evaluasilah kekuatan penalaran dalam kutipan "${basePool[1 % basePool.length].slice(0, 95)}" dan berikan satu contoh pengembangan argumennya!`, tingkat: 'hots', waktu: 360, bahas: 'Penilaian mencakup kesesuaian klaim, kecukupan bukti, dan kejelasan contoh.' },
            { p: `Susunlah sebuah simpulan kritis versi kamu sendiri untuk materi "${topik}" yang memadukan gagasan utama dan solusi logis!`, tingkat: 'hots', waktu: 360, bahas: 'Simpulan menegaskan kembali posisi utama dan menawarkan tindak lanjut rasional.' }
        ];
        return baseQs.slice(0, countNeeded).map(x => soalEsaiLatihan(x, 'sulit')).filter(Boolean);
    }

    // kritis
    const kT = [
        { k: 'Fakta vs Opini', q: 'Ciri utama yang menandakan klaim pada kutipan materi di atas dapat diuji sebagai argumen faktual adalah…', a: 'Didukung alasan terukur, data kontekstual, atau rujukan yang jelas', d: ['Hanya mengulang emosi tanpa bukti', 'Berdasarkan desas-desus semata', 'Tidak berkaitan dengan topik'] },
        { k: 'Hubungan Sebab-Akibat', q: 'Jika dua gagasan dalam teks materi dihubungkan dengan pola kausalitas, syarat terkuat kelogisannya adalah…', a: 'Peristiwa sebab benar-benar relevan dan berkontribusi langsung pada akibat', d: ['Kedua kalimat kebetulan muncul di halaman yang sama', 'Menggunakan kata-kata rumit tanpa hubungan logis', 'Memaksa kesimpulan tanpa premis'] },
        { k: 'Asumsi Tersirat', q: 'Apa asumsi dasar yang perlu dipenuhi agar argumen dalam materi di atas dapat diterima pembaca secara kritis?', a: 'Premis yang digunakan selaras dengan konteks nyata dan tidak saling bertentangan', d: ['Pembaca dilarang mempertanyakan sumber data', 'Kesimpulan boleh menyimpang dari tesis', 'Semua pihak selalu memiliki pendapat identik'] },
        { k: 'Kekuatan Bukti', q: 'Mengapa suatu teks argumentasi menjadi lemah ketika hanya berisi klaim normatif tanpa uraian bukti pendukung?', a: 'Karena pembaca tidak memperoleh dasar verifikasi rasional untuk menyetujui tesis', d: ['Karena kalimat menjadi terlalu mudah dibaca', 'Karena teks tidak lagi memerlukan judul', 'Karena bukti hanya dipakai dalam teks puisi'] },
        { k: 'Evaluasi Klaim', q: 'Langkah pertama yang paling tepat untuk menilai keabsahan argumen pada kutipan di atas adalah…', a: 'Memeriksa kesesuaian antara bukti yang diajukan dengan simpulan yang ditarik', d: ['Mengikuti pendapat yang paling panjang tulisannya', 'Menghindari pengecekan data pembanding', 'Menyetujui gagasan hanya karena kata-katanya tegas'] },
        { k: 'Sesat Pikir', q: 'Kesalahan penalaran (fallacy) terjadi dalam pembahasan argumentasi seperti kutipan di atas apabila penulis…', a: 'Menarik generalisasi luas dari satu contoh terbatas tanpa bukti memadai', d: ['Menjelaskan sudut pandang tandingan secara objektif', 'Menyertakan definisi istilah kunci secara runtut', 'Menghubungkan data empiris dengan gagasan pokok'] },
        { k: 'Konsistensi Simpulan', q: 'Suatu penegasan ulang pada akhir teks argumentasi dinilai konsisten dengan uraian di atas jika…', a: 'Menguatkan tesis awal berdasarkan rangkuman bukti yang telah dipaparkan', d: ['Memperkenalkan topik baru yang sama sekali tidak dibahas', 'Membantah data faktual yang disusun sebelumnya', 'Mengubah tema tulisan di kalimat penutup'] },
        { k: 'Kredibilitas Sumber', q: 'Bukti tambahan apa yang paling relevan untuk semakin meyakinkan pembaca terhadap kasus pada materi tersebut?', a: 'Data pengamatan terverifikasi atau temuan studi yang relevan dengan isu', d: ['Dugaan pribadi tanpa pengukuran', 'Pernyataan emosional yang menyinggung pihak lain', 'Kalimat pengulangan tanpa informasi baru'] }
    ];
    const kOut = [];
    for (let i = 0; i < countNeeded; i++) {
        const s = basePool[i % basePool.length];
        const t = kT[i % kT.length];
        const stem = i >= kT.length ? `${t.q} (Telaah #${i + 1})` : t.q;
        if (isDupStem(stem, excludeStems)) continue;
        const c = soalPgLatihan({
            konsep: t.k,
            kasus: s,
            p: stem,
            opsi: [t.a, ...t.d],
            j: 0,
            tingkat: i >= 4 ? 'hots' : 'sulit',
            waktu: i >= 4 ? 95 : 75,
            bahas: `Pada analisis "${t.k}", argumen berkualitas harus berlandaskan bukti relevan dan alur premis-kesimpulan yang sah.`
        }, 'sulit');
        if (c) {
            excludeStems.push(c.p);
            kOut.push(c);
        }
    }
    return kOut;
}

/* ---------- STAGE 1: PERSIAPAN & PENYARINGAN MATERI PDF ---------- */
async function jalankanLatihanPrep(handoutId, { allowEmergencyFallback = false } = {}) {
    const cached = LATIHAN_CACHE.prep.get(handoutId);
    if (cached && Date.now() - cached.ts < 3 * 3600 * 1000) {
        return { ...cached.data, fromCache: true };
    }
    if (LATIHAN_CACHE.inFlightPrep.has(handoutId)) {
        return await LATIHAN_CACHE.inFlightPrep.get(handoutId);
    }

    const work = (async () => {
        const h = await ambilHandout(handoutId);
        const pdfBuffer = await ambilPdfBuffer(h.url);
        const teksMateri = await ekstrakTeksPdf(pdfBuffer);

        let result;
        if (!teksMateri || teksMateri.length < 120) {
            // PDF hasil pindai (gambar): Gemini Multimodal baca PDF sekali saja lalu ekstrak segmen teks bersih
            const promptScan = `Kamu adalah asisten kurikulum Bahasa Indonesia. Baca PDF berjudul "${clSpace(h.judul, 120)}".
Ekstrak isi pentingnya menjadi ringkas dan terstruktur ke dalam JSON VALID:
{
  "ringkasan": "2-3 kalimat inti isi dokumen",
  "poinKunci": "5 poin konsep penting dipisahkan baris baru (maksimal 600 karakter)",
  "segmen": [
    "kutipan padat isi bagian awal dokumen (sekitar 1200-1800 karakter)",
    "kutipan padat isi bagian tengah dokumen (sekitar 1200-1800 karakter)",
    "kutipan padat isi bagian akhir/simpulan dokumen (sekitar 1200-1800 karakter)"
  ]
}
Gunakan bahasa Indonesia baku tanpa markdown.`;
            try {
                const { data, model } = await withAiSlot(() => callGeminiWithMeta({
                    prompt: promptScan,
                    base64Data: pdfBuffer.toString('base64'),
                    mimeType: 'application/pdf',
                    temperature: 0.2,
                    maxTokens: 3200,
                    timeoutMs: 26000
                }));
                const segmen = (Array.isArray(data.segmen) ? data.segmen : []).map(s => clSpace(s, 2200)).filter(s => s.length >= 60);
                result = {
                    handoutId,
                    judul: h.judul,
                    ringkasan: clSpace(data.ringkasan, 450) || clSpace(h.deskripsi || `Ringkasan materi ${h.judul}.`, 400),
                    poinKunci: cl(String(data.poinKunci || '')).slice(0, 750),
                    segmen: segmen.length ? segmen : [clSpace(`${h.judul}. ${h.deskripsi}`, 1600)],
                    isScanned: true,
                    model
                };
            } catch (e) {
                if (!allowEmergencyFallback && !h.deskripsi) {
                    const err = galat(e.message || 'Server sibuk membaca PDF pindai.', e.status === 429 ? 429 : 503);
                    err.retryAfterMs = e.retryAfterMs || 5000;
                    throw err;
                }
                const fb = ringkasEkstraktifFallback(h.judul, [], h.deskripsi);
                result = {
                    handoutId,
                    judul: h.judul,
                    ringkasan: fb.ringkasan,
                    poinKunci: fb.poinKunci,
                    segmen: [clSpace(`${h.judul}. ${h.deskripsi}`, 1500)].filter(Boolean),
                    isScanned: true,
                    model: 'fallback/metadata'
                };
            }
        } else {
            const { segmen } = pecahDanSaringMateri(teksMateri, h.judul, h.deskripsi);
            const fb = ringkasEkstraktifFallback(h.judul, segmen, h.deskripsi);
            let ringkasan = fb.ringkasan;
            let poinKunci = fb.poinKunci;
            let modelUsed = 'extractor/lokal';

            // Panggilan AI mini (~850 token input, max 500 token output) untuk merangkum inti dari segmen awal & akhir
            try {
                const sampleSum = segmen.map((s, i) => `[Bagian ${i + 1}]\n${s.slice(0, 550)}`).join('\n\n').slice(0, 2200);
                const { data, model } = await callAIJsonSmart({
                    systemPrompt: 'Kamu menyaring inti materi pelajaran ke dalam JSON murni berbahasa Indonesia.',
                    userPrompt: `Judul: "${clSpace(h.judul, 120)}"\nSaring kutipan berikut menjadi intisari padat:\n"""\n${sampleSum}\n"""\nKeluaran HANYA JSON:\n{"ringkasan":"2-3 kalimat ringkasan inti","poinKunci":"4-5 poin konsep utama dipisah baris baru (maks 550 karakter)"}`,
                    temperature: 0.2,
                    maxTokens: 650,
                    timeoutMs: 11000
                });
                if (data.ringkasan) ringkasan = clSpace(data.ringkasan, 460);
                if (data.poinKunci) {
                    poinKunci = Array.isArray(data.poinKunci) ? arr(data.poinKunci, 6).join('\n') : String(data.poinKunci).trim().slice(0, 750);
                }
                modelUsed = model;
            } catch (e) {
                // Jangan gagal di prep bila ekstraksi teks sukses: intisari ekstraktif tetap akurat & cepat
                console.warn('Prep summary fallback ekstraktif:', e.message);
            }

            result = {
                handoutId,
                judul: h.judul,
                ringkasan,
                poinKunci,
                segmen,
                isScanned: false,
                rawChars: teksMateri.length,
                model: modelUsed
            };
        }

        LATIHAN_CACHE.prep.set(handoutId, { ts: Date.now(), data: result });
        if (LATIHAN_CACHE.prep.size > 40) {
            LATIHAN_CACHE.prep.delete(LATIHAN_CACHE.prep.keys().next().value);
        }
        return result;
    })();

    LATIHAN_CACHE.inFlightPrep.set(handoutId, work);
    try {
        return await work;
    } finally {
        LATIHAN_CACHE.inFlightPrep.delete(handoutId);
    }
}

async function resolvePrep(body) {
    if (body && body.handoutId && Array.isArray(body.segmen) && body.segmen.length) {
        return {
            handoutId: body.handoutId,
            judul: clSpace(body.judul, 140) || 'Materi',
            ringkasan: clSpace(body.ringkasan, 500),
            poinKunci: String(body.poinKunci || '').slice(0, 800),
            segmen: body.segmen.map(s => String(s || '').slice(0, 2400)).filter(Boolean).slice(0, 5)
        };
    }
    return await jalankanLatihanPrep(body.handoutId, { allowEmergencyFallback: !!body.allowEmergencyFallback });
}

/* ---------- STAGE 2..5: PACU JALUR PER SATU BAGIAN (Dipecah, Disaring, Top-Up) ---------- */
async function generatePilganBatch({ prep, targetCount, levelsSpec, excludeStems = [], slotOffset = 0, seed = 0, allowEmergencyFallback = false }) {
    const valid = [];
    const stems = excludeStems.slice();
    const models = [];
    let lastErr = null;
    const bank = getBank(prep.handoutId);

    for (let pass = 0; pass < 2 && valid.length < targetCount; pass++) {
        const needed = targetCount - valid.length;
        const askCount = Math.min(9, needed + 1);
        const konteks = pilihKonteksStage(prep, slotOffset + pass, 2500);
        const avoidTxt = stems.length ? `\nHindari mengulang topik pertanyaan ini:\n- ${stems.slice(-8).map(s => clSpace(s, 75)).join('\n- ')}` : '';
        const prompt = `Kamu guru Bahasa Indonesia penyusun soal HOTS Teks Argumentasi.
${konteks}
${avoidTxt}

TUGAS: Buat TEPAT ${askCount} soal pilihan ganda yang seluruhnya bersumber pada kutipan materi di atas.
Komposisi tingkat kesulitan: ${pass === 0 ? levelsSpec : `${askCount} soal beragam (sedang/sulit)`}.
Aturan wajib:
- Bahasa Indonesia baku, teks polos tanpa markdown.
- Opsi TEPAT 4 pilihan berbeda bermakna; DILARANG opsi "Semua benar" / "Semua salah".
- "j" adalah angka integer 0, 1, 2, atau 3 menunjuk indeks opsi benar.
- "bahas" = 1 kalimat alasan logis berdasar materi.

Keluaran HANYA JSON valid:
{"soal":[{"p":"","opsi":["","","",""],"j":0,"tingkat":"mudah|sedang|sulit|hots","waktu":45,"bahas":""}]}`;

        try {
            const { data, model } = await callAIJsonSmart({
                systemPrompt: 'Kamu generator soal asesmen terstruktur. Balas HANYA JSON valid murni.',
                userPrompt: prompt,
                temperature: 0.45,
                maxTokens: 2100,
                timeoutMs: 14500,
                seed: seed + pass
            });
            models.push(model);
            const rawArr = data.soal || data.pilgan || (Array.isArray(data) ? data : []);
            const cleaned = filterPgList(rawArr, stems, levelsSpec.includes('hots') ? 'sulit' : 'sedang');
            for (const q of cleaned) {
                if (valid.length >= targetCount) break;
                stems.push(q.p);
                valid.push(q);
                if (bank.pilgan.length < 45 && !isDupStem(q.p, bank.pilgan.map(x => x.p))) {
                    bank.pilgan.push(q);
                    bank.ts = Date.now();
                }
            }
        } catch (e) {
            lastErr = e;
            break;
        }
    }

    // Jika hasil kurang atau AI 429 sementara, saring & tarik dari bank handout yang sama (tetap anti-duplikat)
    if (valid.length < targetCount && bank.pilgan.length) {
        for (const q of acak(bank.pilgan)) {
            if (valid.length >= targetCount) break;
            if (!isDupStem(q.p, stems)) {
                const clone = soalPgLatihan(q, q.tingkat);
                if (clone) {
                    stems.push(clone.p);
                    valid.push(clone);
                }
            }
        }
    }

    if (valid.length < Math.min(4, targetCount)) {
        if (allowEmergencyFallback) {
            const extra = bangunSoalDarurat('pilgan', prep, targetCount - valid.length, stems);
            valid.push(...extra);
            return { soal: valid.slice(0, targetCount), model: models[0] || 'fallback/ekstraktif' };
        }
        if (lastErr) throw lastErr;
        throw galat('Soal pilihan ganda belum mencukupi setelah penyaringan.', 503);
    }

    return { soal: valid.slice(0, targetCount), model: models.join(', ') || 'pool/cache' };
}

async function handleLatihanStage(action, body) {
    const seed = Number.isFinite(Number(body.seed)) ? Number(body.seed) : Math.floor(Math.random() * 12);
    const allowFallback = !!body.allowEmergencyFallback;
    const isBusyDelay = () => (Date.now() - AI_RUNTIME.last429At < 8000 || AI_RUNTIME.activeCalls >= 4) ? 1600 : 350;

    if (action === 'latihan_prep') {
        if (!body.handoutId) throw galat('handoutId wajib disertakan.', 400);
        const prep = await jalankanLatihanPrep(body.handoutId, { allowEmergencyFallback: allowFallback });
        return { ...prep, suggestedDelayMs: isBusyDelay() };
    }

    const prep = await resolvePrep(body);
    const bank = getBank(prep.handoutId);

    if (action === 'latihan_pilgan') {
        const part = String(body.part || 'all').toLowerCase();
        const existing = Array.isArray(body.excludeStems) ? body.excludeStems.map(String) : [];

        if (part === 'a') {
            const r = await generatePilganBatch({ prep, targetCount: 8, levelsSpec: '4 mudah, 4 sedang', excludeStems: existing, slotOffset: 0, seed, allowEmergencyFallback: allowFallback });
            return { part: 'a', soal: r.soal, total: r.soal.reduce((a, b) => a + b.waktu, 0), model: r.model, suggestedDelayMs: isBusyDelay() };
        }
        if (part === 'b') {
            const r = await generatePilganBatch({ prep, targetCount: 7, levelsSpec: '4 sulit, 3 hots', excludeStems: existing, slotOffset: 2, seed: seed + 2, allowEmergencyFallback: allowFallback });
            return { part: 'b', soal: r.soal, total: r.soal.reduce((a, b) => a + b.waktu, 0), model: r.model, suggestedDelayMs: isBusyDelay() };
        }

        const r1 = await generatePilganBatch({ prep, targetCount: 8, levelsSpec: '4 mudah, 4 sedang', excludeStems: existing, slotOffset: 0, seed, allowEmergencyFallback: allowFallback });
        const stemsAll = existing.concat(r1.soal.map(x => x.p));
        const r2 = await generatePilganBatch({ prep, targetCount: 7, levelsSpec: '4 sulit, 3 hots', excludeStems: stemsAll, slotOffset: 2, seed: seed + 2, allowEmergencyFallback: allowFallback });
        const gabung = urutTingkatLatihan(r1.soal.concat(r2.soal)).slice(0, 15);
        return { pilgan: { soal: gabung, total: gabung.reduce((a, b) => a + b.waktu, 0) }, model: `${r1.model}`, suggestedDelayMs: isBusyDelay() };
    }

    if (action === 'latihan_struktur') {
        let lastErr = null;
        for (let pass = 0; pass < 2; pass++) {
            const konteks = pilihKonteksStage(prep, 1 + pass, 2300);
            const prompt = `Kamu guru Bahasa Indonesia. Dari materi berikut:
${konteks}

Susun 1 teks argumentasi singkat padu (TEPAT 7 kalimat berurutan) berdasarkan isi materi di atas untuk latihan pelabelan struktur siswa.
Susunan: 1-2 kalimat awal berlabel "tesis", 4-5 kalimat tengah berlabel "argumen", 1 kalimat akhir berlabel "kesimpulan". Ketiga label WAJIB ada.
Keluaran HANYA JSON valid:
{"judul":"Judul singkat","waktu":280,"teks":[{"t":"kalimat lengkap","label":"tesis|argumen|kesimpulan","alasan":"alasan singkat 1 kalimat"}]}`;
            try {
                const { data, model } = await callAIJsonSmart({
                    systemPrompt: 'Balas HANYA format JSON valid tanpa markdown.',
                    userPrompt: prompt,
                    temperature: pass === 0 ? 0.35 : 0.2,
                    maxTokens: 1450,
                    timeoutMs: 13500,
                    seed: seed + pass + 1
                });
                const clean = filterStrukturPack(data);
                if (clean) {
                    if (bank.struktur.length < 4) { bank.struktur.push(clean); bank.ts = Date.now(); }
                    return { struktur: clean, model, suggestedDelayMs: isBusyDelay() };
                }
            } catch (e) {
                lastErr = e;
                if (e.status === 429) break;
            }
        }
        if (bank.struktur.length) {
            return { struktur: acak(bank.struktur)[0], model: 'pool/cache', suggestedDelayMs: isBusyDelay() };
        }
        if (allowFallback) {
            return { struktur: bangunSoalDarurat('struktur', prep), model: 'fallback/ekstraktif', suggestedDelayMs: isBusyDelay() };
        }
        throw lastErr || galat('Struktur belum memenuhi kriteria label lengkap.', 503);
    }

    if (action === 'latihan_esai') {
        const out = [];
        const stems = Array.isArray(body.excludeStems) ? body.excludeStems.map(String) : [];
        const models = [];
        let lastErr = null;

        for (let pass = 0; pass < 2 && out.length < 6; pass++) {
            const need = Math.min(7, (6 - out.length) + 1);
            const konteks = pilihKonteksStage(prep, 2 + pass, 2400);
            const prompt = `Kamu guru Bahasa Indonesia penyusun soal HOTS.
${konteks}

TUGAS: Buat TEPAT ${need} soal esai analitis terbuka (mengapa/bagaimana/evaluasi) berdasarkan materi di atas.
Komposisi tingkat: sedang, sulit, dan hots. Bahasa Indonesia baku, tanpa markdown.
Sertakan "bahas" berupa poin-poin kunci jawaban ideal untuk rubrik koreksi AI.
Keluaran HANYA JSON valid:
{"soal":[{"p":"pertanyaan esai analitis","tingkat":"sedang|sulit|hots","waktu":300,"bahas":"poin kunci ekspektasi jawaban"}]}`;
            try {
                const { data, model } = await callAIJsonSmart({
                    systemPrompt: 'Balas HANYA JSON valid murni.',
                    userPrompt: prompt,
                    temperature: 0.4,
                    maxTokens: 1550,
                    timeoutMs: 13500,
                    seed: seed + pass + 3
                });
                models.push(model);
                const rawArr = data.soal || data.esai || [];
                for (const raw of rawArr) {
                    if (out.length >= 6) break;
                    const eItem = soalEsaiLatihan(raw, 'sulit');
                    if (!eItem || isDupStem(eItem.p, stems)) continue;
                    stems.push(eItem.p);
                    out.push(eItem);
                    if (bank.esai.length < 18 && !isDupStem(eItem.p, bank.esai.map(x => x.p))) {
                        bank.esai.push(eItem);
                        bank.ts = Date.now();
                    }
                }
            } catch (e) {
                lastErr = e;
                break;
            }
        }

        if (out.length < 6 && bank.esai.length) {
            for (const q of acak(bank.esai)) {
                if (out.length >= 6) break;
                if (!isDupStem(q.p, stems)) {
                    stems.push(q.p);
                    out.push(q);
                }
            }
        }
        if (out.length < 3) {
            if (allowFallback) {
                out.push(...bangunSoalDarurat('esai', prep, 6 - out.length, stems));
            } else {
                throw lastErr || galat('Soal esai belum mencukupi setelah penyaringan.', 503);
            }
        }
        const sorted = urutTingkatLatihan(out).slice(0, 6);
        return { esai: { soal: sorted, total: sorted.reduce((a, b) => a + b.waktu, 0) }, model: models[0] || 'pool/cache', suggestedDelayMs: isBusyDelay() };
    }

    if (action === 'latihan_kritis') {
        const out = [];
        const stems = Array.isArray(body.excludeStems) ? body.excludeStems.map(String) : [];
        const models = [];
        let lastErr = null;

        for (let pass = 0; pass < 2 && out.length < 8; pass++) {
            const need = Math.min(9, (8 - out.length) + 1);
            const konteks = pilihKonteksStage(prep, 3 + pass, 2400);
            const avoidTxt = stems.length ? `\nHindari mengulang soal: ${stems.slice(-5).map(s => clSpace(s, 60)).join(' | ')}` : '';
            const prompt = `Kamu guru Bahasa Indonesia penyusun soal berpikir kritis.
${konteks}${avoidTxt}

TUGAS: Buat TEPAT ${need} soal uji berpikir kritis bertumpu pada materi di atas (konsep: Fakta vs Opini, Sebab-Akibat, Asumsi Tersirat, Sesat Pikir, Kredibilitas Bukti).
Aturan wajib:
- 4 pilihan jawaban bermakna, DILARANG "Semua benar/salah".
- "j" indeks 0-3 opsi benar.
- "kasus" berisi pernyataan/skenario pemicu singkat dari materi, "p" adalah pertanyaannya.
Keluaran HANYA JSON valid:
{"soal":[{"konsep":"nama konsep","kasus":"kutipan/kasus singkat","p":"pertanyaan analisis","opsi":["","","",""],"j":0,"tingkat":"sedang|sulit|hots","waktu":75,"bahas":"penjelasan logis 1 kalimat"}]}`;
            try {
                const { data, model } = await callAIJsonSmart({
                    systemPrompt: 'Balas HANYA JSON valid murni.',
                    userPrompt: prompt,
                    temperature: 0.45,
                    maxTokens: 2200,
                    timeoutMs: 14500,
                    seed: seed + pass + 4
                });
                models.push(model);
                const rawArr = data.soal || data.kritis || [];
                const cleaned = filterPgList(rawArr, stems, 'sulit');
                for (const q of cleaned) {
                    if (out.length >= 8) break;
                    stems.push(q.p);
                    if (!q.konsep) q.konsep = 'Penalaran Kritis';
                    out.push(q);
                    if (bank.kritis.length < 24 && !isDupStem(q.p, bank.kritis.map(x => x.p))) {
                        bank.kritis.push(q);
                        bank.ts = Date.now();
                    }
                }
            } catch (e) {
                lastErr = e;
                break;
            }
        }

        if (out.length < 8 && bank.kritis.length) {
            for (const q of acak(bank.kritis)) {
                if (out.length >= 8) break;
                if (!isDupStem(q.p, stems)) {
                    const clone = soalPgLatihan(q, q.tingkat);
                    if (clone) { stems.push(clone.p); out.push(clone); }
                }
            }
        }
        if (out.length < 5) {
            if (allowFallback) {
                out.push(...bangunSoalDarurat('kritis', prep, 8 - out.length, stems));
            } else {
                throw lastErr || galat('Soal uji berpikir belum mencukupi setelah penyaringan.', 503);
            }
        }
        const sorted = urutTingkatLatihan(out).slice(0, 8);
        return { kritis: { soal: sorted, total: sorted.reduce((a, b) => a + b.waktu, 0) }, model: models[0] || 'pool/cache', suggestedDelayMs: isBusyDelay() };
    }

    throw galat('Stage latihan tidak dikenali.', 400);
}

/* Fallback kompatibilitas bila ada pemanggil lama { action: 'buat_latihan', handoutId } */
async function handleLatihan({ handoutId, ai }) {
    try {
        const prep = await jalankanLatihanPrep(handoutId, { allowEmergencyFallback: true });
        const base = { ...prep, allowEmergencyFallback: true };
        const [pRes, sRes] = await Promise.all([
            handleLatihanStage('latihan_pilgan', { ...base, part: 'all', seed: 0 }),
            handleLatihanStage('latihan_struktur', { ...base, seed: 1 })
        ]);
        const [eRes, kRes] = await Promise.all([
            handleLatihanStage('latihan_esai', { ...base, seed: 2 }),
            handleLatihanStage('latihan_kritis', { ...base, seed: 3 })
        ]);

        return {
            judul: prep.judul,
            handoutId,
            model: pRes.model || prep.model,
            dibuat: Date.now(),
            ringkasan: prep.ringkasan,
            pilgan: pRes.pilgan,
            struktur: sRes.struktur,
            esai: eRes.esai,
            kritis: kRes.kritis
        };
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

        // 7. Pembuatan Paket Latihan Bertahap & Penuh dari PDF Handout
        if (action === 'latihan_prep' || action === 'latihan_pilgan' || action === 'latihan_struktur' || action === 'latihan_esai' || action === 'latihan_kritis') {
            return res.status(200).json(await handleLatihanStage(action, body));
        }
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
                'latihan_prep',
                'latihan_pilgan',
                'latihan_struktur',
                'latihan_esai',
                'latihan_kritis',
                'modul',
                'suggest',
                'help'
            ]
        });
    } catch (error) {
        console.error('Central AI API error:', error);
        const status = error.status || 500;
        if ((status === 429 || status === 503) && error.retryAfterMs) {
            res.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
        }
        return res.status(status).json({
            error: error.errorTitle || 'Sistem AI Gagal Bekerja',
            detail_error: error.message,
            retryable: status === 429 || status === 503 || status === 504,
            retryAfterMs: error.retryAfterMs || (status === 429 ? 8000 : 0)
        });
    }
};

module.exports.config = { maxDuration: 60 };
