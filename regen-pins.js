/**
 * regen-pins.js — Regenerate Pinterest Pins (High Quality + Auto Schedule)
 * Optimization: Uses multi-query fallback + beauty-first scoring to avoid irrelevant images.
 */

const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const fs = require('fs');
require('dotenv').config();

const CONFIG = {
    pin: { width: 1000, height: 1500 },
    pinterest: {
        siteUrl: 'https://glamgirlshaven.com',
        sheetId: '1ukj-MajaswMa5gDeUg_JV0jAQ2dgQl7da_JSO22YGuY',
        sheetName: 'AFFILIATE',
        daysBetweenPins: 2,
        postingHour: 9, 
    },
};

const BEAUTY_KEYWORDS = [
    'perfume','fragrance','scent','parfum','serum','skincare','moisturizer','cream','lotion','toner',
    'makeup','foundation','lipstick','mascara','blush','eyeshadow','beauty','cosmetic','product',
    'bottle','jar','tube','flatlay','vanity','face','glow','nail','hair','gift','self-care','aesthetic'
];

const AVOID_KEYWORDS = ['face','woman','girl','man','person','people','portrait','smile','injury','wound','skin rash','food','drink','syrup','wine','table'];

const googleAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const googleAuthWorkspace = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'] });

const backupFile = process.argv[2];
if (!backupFile) { console.error('Usage: node regen-pins.js <backup-json-file>'); process.exit(1); }

const parsedData = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));
const metaData = parsedData.meta || parsedData;
const title = metaData.seo_title || parsedData.seo_title;
const slug  = metaData.seo_slug  || parsedData.seo_slug;
const html  = parsedData.html || parsedData.rewritten_html || '';

console.log(`\n[REGEN] High Quality Pins for: "${title}"`);

let faviconB64 = null;
async function loadFavicon() {
    try {
        if (fs.existsSync('./icon.png')) {
            const data = fs.readFileSync('./icon.png');
            faviconB64 = `data:image/png;base64,${data.toString('base64')}`;
            console.log('   [BRAND] ✅ Logo loaded from local icon.png');
            return;
        }
        const res = await axios.get('https://glamgirlshaven.com/public/icon.png', { responseType: 'arraybuffer', timeout: 6000 });
        faviconB64 = `data:image/png;base64,${Buffer.from(res.data).toString('base64')}`;
        console.log('   [BRAND] ✅ Logo loaded from URL.');
    } catch (e) { console.log('   [BRAND] ⚠️  Logo failed, using fallback.'); }
}

// ─── Image Logic ───────────────────────────────────────────────────────────
async function fetchHighQualityUnsplash(queries) {
    for (const query of queries) {
        try {
            console.log(`   [UNSPLASH] Searching: "${query}"...`);
            const res = await axios.get('https://api.unsplash.com/search/photos', {
                params: { query, orientation: 'portrait', per_page: 20, content_filter: 'high', order_by: 'relevant' },
                headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` }
            });
            const results = res.data.results || [];
            
            // Scoring logic: prioritize beauty context, penalize generic people/lifestyle
            const scored = results.map(p => {
                const desc = (p.alt_description || p.description || '').toLowerCase();
                let score = 0;
                BEAUTY_KEYWORDS.forEach(kw => { if (desc.includes(kw)) score += 2; });
                AVOID_KEYWORDS.forEach(kw => { if (desc.includes(kw)) score -= 5; });
                return { p, score };
            }).sort((a, b) => b.score - a.score);

            const best = scored[0];
            if (best && best.score >= 0) {
                const img = await axios.get(best.p.urls.regular, { responseType: 'arraybuffer' });
                console.log(`   [UNSPLASH] ✅ Found: "${best.p.alt_description || query}" (Score: ${best.score})`);
                return Buffer.from(img.data);
            }
        } catch (err) { console.log(`   [UNSPLASH] Error: ${err.message}`); }
    }
    return null;
}

async function generateImagenFallback(visualPrompt, aspectRatio = '3:4') {
    const safePrompt = `Professional product photography, luxury beauty aesthetic, ${visualPrompt}, NO readable text, NO brands, NO people, blurry background, soft lighting`;
    const response = await axios.post(
        `https://us-central1-aiplatform.googleapis.com/v1/projects/${process.env.GOOGLE_PROJECT_ID}/locations/us-central1/publishers/google/models/imagen-4.0-ultra-generate-001:predict`,
        { instances: [{ prompt: safePrompt }], parameters: { sampleCount: 1, aspectRatio } },
        { headers: { Authorization: `Bearer ${await googleAuth.getAccessToken()}`, 'Content-Type': 'application/json' } }
    );
    return Buffer.from(response.data.predictions[0].bytesBase64Encoded, 'base64');
}

async function uploadToImgbb(buffer, filename) {
    const params = new URLSearchParams();
    params.append('key', process.env.IMGBB_API_KEY);
    params.append('image', buffer.toString('base64'));
    params.append('name', filename);
    const res = await axios.post('https://api.imgbb.com/1/upload', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return res.data.data.url;
}

async function uploadAndSchedulePins(brandedBuffers, pinsData, postUrl) {
    if (!brandedBuffers.length) return;
    const mediaLinks = [];
    console.log(`\n[IMGBB] Uploading...`);
    for (let i = 0; i < brandedBuffers.length; i++) {
        try {
            const link = await uploadToImgbb(brandedBuffers[i].buffer, brandedBuffers[i].filename);
            mediaLinks.push(link);
            console.log(`   Pin ${i+1} ✅ ${link}`);
        } catch (e) { mediaLinks.push(''); }
    }

    const token = await googleAuthWorkspace.getAccessToken();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() + 1);
    startDate.setHours(CONFIG.pinterest.postingHour, 0, 0, 0);
    const pad = n => String(n).padStart(2, '0');

    const rows = pinsData.map((pin, i) => {
        let dateStr = i === 0 ? `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())} ${pad(startDate.getHours())}:00:00` : `=INDIRECT("F"&ROW()-1) + ${CONFIG.pinterest.daysBetweenPins}`;
        const keywords = Array.isArray(pin.keywords) ? pin.keywords.join(', ') : pin.keywords || '';
        return [pin.hook_title, pin.description, postUrl, mediaLinks[i], pin.board, dateStr, keywords];
    });

    await axios.post(
        `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.pinterest.sheetId}/values/${encodeURIComponent(CONFIG.pinterest.sheetName)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { values: rows },
        { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`[SHEET] ✅ Scheduled ${rows.length} rows.`);
}

// ─── Layout mapping: same as engine.js ──────────────────────────────────
const PIN_TYPE_LAYOUT = { A: 0, B: 3, C: 4, D: 6, E: 5 };

// ─── Branded Pin — 8 layouts (full system from engine.js) ───────────────
async function createBrandedPin(bgBuffer, title, cta, layoutIndex = 0) {
    const { width, height } = CONFIG.pin;

    const words = title.toUpperCase().split(' ');
    const charLimit = 16;

    function wrapWords(wordList, limit) {
        const lines = []; let cur = '';
        wordList.forEach(w => {
            if ((cur + w).length > limit && cur !== '') { lines.push(cur.trim()); cur = w + ' '; }
            else { cur += w + ' '; }
        });
        if (cur.trim()) lines.push(cur.trim());
        return lines;
    }

    let lines = wrapWords(words, charLimit);

    // Orphan prevention
    if (lines.length >= 2) {
        const last = lines[lines.length - 1];
        const lastWords = last.split(' ').filter(Boolean);
        if (lastWords.length === 1 && last.length <= 4) {
            const prev = lines[lines.length - 2].split(' ').filter(Boolean);
            if (prev.length > 1) {
                const moved = prev.pop();
                lines[lines.length - 2] = prev.join(' ');
                lines[lines.length - 1] = moved + ' ' + last;
            }
        }
    }

    const rawLines = lines.slice(0, 5);
    const maxLen = Math.max(...rawLines.map(l => l.length)) || 1;

    const esc = str => (str || '').toString().replace(/[<>&'"]/g, c =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])
    );

    const finalLines = rawLines.map(esc);
    const safeCta = esc((cta || 'SEE MORE').toUpperCase());
    const ctaW = Math.max(460, (cta || '').length * 22 + 160);
    const ctaH = 90;

    let svg = '';
    const li = layoutIndex % 8;

    if (li === 0) {
        // Classic Editorial — dark gradient, serif, bottom-heavy
        let fs = 95, ls = 110;
        if (finalLines.length > 3) { fs = 85; ls = 100; }
        if (finalLines.length > 4) { fs = 72; ls = 85; }
        const maxFs = Math.floor(900 / (maxLen * 0.65));
        if (fs > maxFs) { fs = maxFs; ls = Math.floor(fs * 1.15); }
        const tbH = finalLines.length * ls;
        const tY = 1240 - tbH;

        svg = `<svg width="${width}" height="${height}">
            <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#050404" stop-opacity="0.4"/>
                <stop offset="25%" stop-color="#050404" stop-opacity="0"/>
                <stop offset="55%" stop-color="#050404" stop-opacity="0.45"/>
                <stop offset="100%" stop-color="#050404" stop-opacity="0.95"/>
            </linearGradient></defs>
            <rect width="${width}" height="${height}" fill="url(#g)"/>
            <rect x="35" y="35" width="930" height="1430" fill="none" stroke="white" stroke-opacity="0.12" stroke-width="1.5"/>
            <g transform="translate(500,95)">
                <text text-anchor="middle" style="fill:white;fill-opacity:0.9;font-family:'Avenir Next','Helvetica Neue',sans-serif;font-size:16px;font-weight:500;letter-spacing:14px;">GLAMGIRLSHAVEN</text>
                <rect x="-25" y="25" width="50" height="2" fill="#B5838D"/>
            </g>
            <g transform="translate(500,${tY})">
                ${finalLines.map((l, i) => `<text y="${i * ls}" text-anchor="middle" style="fill:white;font-family:'Didot','Bodoni 72',serif;font-size:${fs}px;font-weight:600;filter:drop-shadow(0px 4px 15px rgba(0,0,0,0.8));">${l}</text>`).join('')}
            </g>
            <g transform="translate(${(width - ctaW) / 2},1300)">
                <rect width="${ctaW}" height="${ctaH}" rx="${ctaH / 2}" fill="#B5838D" stroke="white" stroke-width="2" stroke-opacity="0.4"/>
                <text x="${ctaW / 2}" y="${ctaH / 2 + 9}" text-anchor="middle" style="fill:white;font-family:'Avenir Next',sans-serif;font-size:26px;font-weight:700;letter-spacing:5px;">${safeCta} ↗</text>
            </g>
        </svg>`;

    } else if (li === 1) {
        // Modern Bold — white box top, sans-serif
        let fs = Math.min(105, Math.floor(820 / (maxLen * 0.6)));
        let ls = Math.floor(fs * 1.15);
        if (finalLines.length > 4) { fs = Math.min(fs, 75); ls = Math.floor(fs * 1.15); }
        const tbH = finalLines.length * ls;
        const boxH = tbH + 160;

        svg = `<svg width="${width}" height="${height}">
            <rect width="${width}" height="${height}" fill="black" fill-opacity="0.15"/>
            <g transform="translate(50,80)">
                <rect width="900" height="${boxH}" fill="#FDFBFB" fill-opacity="0.95" rx="16" filter="drop-shadow(0px 15px 30px rgba(0,0,0,0.25))"/>
                <rect x="20" y="20" width="860" height="${boxH - 40}" fill="none" stroke="#B5838D" stroke-width="2" stroke-opacity="0.6" rx="8"/>
                <g transform="translate(450,45)"><text text-anchor="middle" style="fill:#B5838D;font-family:'Avenir Next',sans-serif;font-size:14px;font-weight:700;letter-spacing:8px;">GLAMGIRLSHAVEN</text></g>
                <g transform="translate(450,${90 + fs * 0.8})">
                    ${finalLines.map((l, i) => `<text y="${i * ls}" text-anchor="middle" style="fill:#1A1A1A;font-family:'Avenir Next',sans-serif;font-size:${fs}px;font-weight:900;letter-spacing:-2px;">${l}</text>`).join('')}
                </g>
            </g>
            <g transform="translate(${(width - ctaW) / 2},1300)">
                <rect width="${ctaW}" height="${ctaH}" rx="4" fill="white" filter="drop-shadow(0px 8px 16px rgba(0,0,0,0.2))"/>
                <text x="${ctaW / 2}" y="${ctaH / 2 + 9}" text-anchor="middle" style="fill:#1A1A1A;font-family:'Avenir Next',sans-serif;font-size:26px;font-weight:800;letter-spacing:3px;">${safeCta} →</text>
            </g>
        </svg>`;

    } else if (li === 2) {
        // Tape / Center Highlight
        let fs = Math.min(85, Math.floor(900 / (maxLen * 0.65)));
        let ls = Math.floor(fs * 1.35);
        const tY = height / 2 - (finalLines.length * ls) / 2 - 40;

        const blocks = finalLines.map((l, i) => {
            const bw = Math.min(l.length * fs * 0.62 + 80, 950);
            const y = tY + i * ls;
            const rot = i % 2 === 0 ? -1 : 1;
            return `<g transform="translate(${(width - bw) / 2},${y - fs * 0.9})">
                <g transform="rotate(${rot},${bw / 2},${fs / 2})">
                    <rect width="${bw}" height="${fs * 1.4}" fill="white" fill-opacity="0.96"/>
                    <text x="${bw / 2}" y="${fs}" text-anchor="middle" style="fill:#1A1A1A;font-family:'Didot',serif;font-size:${fs}px;font-weight:700;font-style:italic;">${l}</text>
                </g>
            </g>`;
        }).join('');

        svg = `<svg width="${width}" height="${height}">
            <rect width="${width}" height="${height}" fill="black" fill-opacity="0.2"/>
            ${blocks}
            <g transform="translate(500,${height - 180})"><text text-anchor="middle" style="fill:white;font-family:'Avenir Next',sans-serif;font-size:16px;font-weight:600;letter-spacing:12px;">GLAMGIRLSHAVEN</text></g>
            <g transform="translate(${(width - ctaW) / 2},${height - 130})">
                <rect width="${ctaW}" height="70" rx="35" fill="#1A1A1A"/>
                <text x="${ctaW / 2}" y="45" text-anchor="middle" style="fill:white;font-family:'Avenir Next',sans-serif;font-size:18px;font-weight:700;letter-spacing:5px;">${safeCta}</text>
            </g>
        </svg>`;

    } else if (li === 3) {
        // Minimalist Bottom Block — white panel at bottom
        let fs = Math.min(85, Math.floor(900 / (maxLen * 0.65)));
        let ls = Math.floor(fs * 1.25);
        if (finalLines.length > 3) { fs = Math.min(fs, 70); ls = Math.floor(fs * 1.2); }
        const tbH = finalLines.length * ls;
        const tY = 1175 - tbH / 2 + fs * 0.4;

        svg = `<svg width="${width}" height="${height}">
            <rect x="0" y="${height - 550}" width="${width}" height="550" fill="#FDFBFB"/>
            <g transform="translate(500,${height - 500})"><text text-anchor="middle" style="fill:#B5838D;font-family:'Avenir Next',sans-serif;font-size:14px;font-weight:700;letter-spacing:10px;">GLAMGIRLSHAVEN</text></g>
            <g transform="translate(500,${tY + fs * 0.5})">
                ${finalLines.map((l, i) => `<text y="${i * ls}" text-anchor="middle" style="fill:#1A1A1A;font-family:'Didot',serif;font-size:${fs}px;font-weight:600;letter-spacing:2px;">${l}</text>`).join('')}
            </g>
            <g transform="translate(${(width - ctaW) / 2},1350)">
                <rect width="${ctaW}" height="${ctaH}" rx="${ctaH / 2}" fill="none" stroke="#1A1A1A" stroke-width="2"/>
                <text x="${ctaW / 2}" y="${ctaH / 2 + 9}" text-anchor="middle" style="fill:#1A1A1A;font-family:'Avenir Next',sans-serif;font-size:22px;font-weight:800;letter-spacing:4px;">${safeCta} →</text>
            </g>
        </svg>`;

    } else if (li === 4) {
        // Viral Quote — dark center banner
        let fs = Math.min(95, Math.floor(950 / (maxLen * 0.6)));
        let ls = Math.floor(fs * 1.25);
        if (finalLines.length > 4) { fs = Math.min(80, fs); ls = Math.floor(fs * 1.15); }
        const tbH = finalLines.length * ls;
        const boxH = tbH + 240;
        const boxY = (height - boxH) / 2;

        svg = `<svg width="${width}" height="${height}">
            <rect x="0" y="${boxY}" width="${width}" height="${boxH}" fill="#1A1A1A" fill-opacity="0.85"/>
            <rect x="30" y="${boxY + 30}" width="940" height="${boxH - 60}" fill="none" stroke="#B5838D" stroke-width="2" stroke-opacity="0.5"/>
            <g transform="translate(500,${boxY + 65})"><text text-anchor="middle" style="fill:#F9E5C9;font-family:'Avenir Next',sans-serif;font-size:14px;font-weight:600;letter-spacing:12px;">GLAMGIRLSHAVEN</text></g>
            <g transform="translate(500,${boxY + 120 + fs * 0.5})">
                ${finalLines.map((l, i) => `<text y="${i * ls}" text-anchor="middle" style="fill:white;font-family:'Avenir Next',sans-serif;font-size:${fs}px;font-weight:800;letter-spacing:-1px;">${l}</text>`).join('')}
            </g>
            <g transform="translate(${(width - ctaW) / 2},${boxY + boxH - 45})">
                <rect width="${ctaW}" height="90" rx="45" fill="#B5838D"/>
                <text x="${ctaW / 2}" y="54" text-anchor="middle" style="fill:white;font-family:'Avenir Next',sans-serif;font-size:20px;font-weight:800;letter-spacing:4px;">${safeCta}</text>
            </g>
        </svg>`;

    } else if (li === 5) {
        // Tweet / Threads Style — white card top third
        let fs = Math.min(72, Math.floor(680 / (maxLen * 0.58)));
        let ls = Math.floor(fs * 1.28);
        const tbH = finalLines.length * ls;
        const cardW = 860, cardX = (width - cardW) / 2, cardY = 280;
        const headerH = 120, textPadding = 50;
        const cardH = headerH + tbH + textPadding * 2 + 20;
        const avatarR = 38, avatarCX = cardX + 65, avatarCY = cardY + 62;
        const avatarBlock = faviconB64
            ? `<defs><clipPath id="avc"><circle cx="${avatarCX}" cy="${avatarCY}" r="${avatarR}"/></clipPath></defs>
               <circle cx="${avatarCX}" cy="${avatarCY}" r="${avatarR}" fill="#F5F0EB"/>
               <image href="${faviconB64}" x="${avatarCX - avatarR}" y="${avatarCY - avatarR}" width="${avatarR * 2}" height="${avatarR * 2}" clip-path="url(#avc)"/>`
            : `<circle cx="${avatarCX}" cy="${avatarCY}" r="${avatarR}" fill="#F5F0EB"/>
               <text x="${avatarCX}" y="${avatarCY + 12}" text-anchor="middle" style="fill:#B5838D;font-family:'Avenir Next',sans-serif;font-size:32px;font-weight:bold;">G</text>`;

        svg = `<svg width="${width}" height="${height}">
            <rect width="${width}" height="${height}" fill="black" fill-opacity="0.22"/>
            <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="20" fill="white" filter="drop-shadow(0px 12px 28px rgba(0,0,0,0.22))"/>
            ${avatarBlock}
            <text x="${cardX + 120}" y="${cardY + 52}" style="fill:#1A1A1A;font-family:'Helvetica Neue',sans-serif;font-size:26px;font-weight:700;">GlamGirls Haven</text>
            <text x="${cardX + 120}" y="${cardY + 84}" style="fill:#657786;font-family:'Helvetica Neue',sans-serif;font-size:22px;">@glamgirlshaven</text>
            <line x1="${cardX + 30}" y1="${cardY + headerH}" x2="${cardX + cardW - 30}" y2="${cardY + headerH}" stroke="#F0E8E8" stroke-width="1"/>
            <g transform="translate(${cardX + textPadding},${cardY + headerH + textPadding + fs * 0.85})">
                ${finalLines.map((l, i) => `<text y="${i * ls}" style="fill:#1A1A1A;font-family:'Helvetica Neue',sans-serif;font-size:${fs}px;font-weight:800;">${l}</text>`).join('')}
            </g>
            <g transform="translate(${(width - ctaW) / 2},${Math.max(cardY + cardH + 80, height - 200)})">
                <rect width="${ctaW}" height="${ctaH}" rx="${ctaH / 2}" fill="#B5838D"/>
                <text x="${ctaW / 2}" y="${ctaH / 2 + 9}" text-anchor="middle" style="fill:white;font-family:'Avenir Next',sans-serif;font-size:22px;font-weight:800;letter-spacing:3px;">${safeCta}</text>
            </g>
        </svg>`;

    } else if (li === 6) {
        // Search Bar aesthetic
        const searchRaw = esc((rawLines[0] || '').toLowerCase() + (rawLines.length > 1 ? '...' : ''));
        let mfs = Math.min(95, Math.floor(900 / (maxLen * 0.6)));
        let mls = Math.floor(mfs * 1.25);

        svg = `<svg width="${width}" height="${height}">
            <rect width="${width}" height="${height}" fill="black" fill-opacity="0.3"/>
            <rect x="100" y="150" width="800" height="90" rx="45" fill="white" filter="drop-shadow(0px 8px 16px rgba(0,0,0,0.15))"/>
            <circle cx="160" cy="195" r="14" fill="none" stroke="#657786" stroke-width="4"/>
            <line x1="170" y1="205" x2="185" y2="220" stroke="#657786" stroke-width="4" stroke-linecap="round"/>
            <text x="210" y="205" style="fill:#1A1A1A;font-family:'Avenir Next',sans-serif;font-size:32px;font-weight:500;">${searchRaw}|</text>
            <g transform="translate(500,450)"><text text-anchor="middle" style="fill:#F9E5C9;font-family:'Avenir Next',sans-serif;font-size:16px;font-weight:700;letter-spacing:12px;">TOP RESULT</text></g>
            <g transform="translate(500,${520 + mfs * 0.8})">
                ${finalLines.map((l, i) => `<text y="${i * mls}" text-anchor="middle" style="fill:white;font-family:'Avenir Next',sans-serif;font-size:${mfs}px;font-weight:900;letter-spacing:-2px;filter:drop-shadow(0px 4px 12px rgba(0,0,0,0.5));">${l}</text>`).join('')}
            </g>
            <g transform="translate(${(width - ctaW) / 2},1300)">
                <rect width="${ctaW}" height="80" rx="40" fill="white"/>
                <text x="${ctaW / 2}" y="48" text-anchor="middle" style="fill:#1A1A1A;font-family:'Avenir Next',sans-serif;font-size:20px;font-weight:800;letter-spacing:2px;">${safeCta} →</text>
            </g>
        </svg>`;

    } else {
        // iMessage Bubble
        let fs = Math.min(65, Math.floor(700 / (maxLen * 0.6)));
        let ls = Math.floor(fs * 1.3);
        const tbH = finalLines.length * ls;
        const boxH = tbH + 100;
        const boxY = (height - boxH) / 2;

        svg = `<svg width="${width}" height="${height}">
            <rect width="${width}" height="${height}" fill="black" fill-opacity="0.15"/>
            <g transform="translate(100,${boxY})">
                <rect width="800" height="${boxH}" rx="40" fill="#007AFF" filter="drop-shadow(0px 10px 20px rgba(0,0,0,0.2))"/>
                <g transform="translate(50,${50 + fs * 0.8})">
                    ${finalLines.map((l, i) => `<text y="${i * ls}" style="fill:white;font-family:'Helvetica Neue',sans-serif;font-size:${fs}px;font-weight:500;">${l}</text>`).join('')}
                </g>
            </g>
            <g transform="translate(500,${boxY - 30})"><text text-anchor="middle" style="fill:white;font-family:'Helvetica Neue',sans-serif;font-size:18px;font-weight:700;">Beauty Editor</text></g>
            <g transform="translate(${(width - ctaW) / 2},1300)">
                <rect width="${ctaW}" height="80" rx="40" fill="white"/>
                <text x="${ctaW / 2}" y="48" text-anchor="middle" style="fill:#007AFF;font-family:'Avenir Next',sans-serif;font-size:20px;font-weight:800;letter-spacing:2px;">${safeCta}</text>
            </g>
        </svg>`;
    }

    // Color grading pipeline (saturation boost, warmth, contrast, sharpen)
    const gradedBuffer = await sharp(bgBuffer)
        .resize(width, height, { fit: 'cover', position: 'center' })
        .modulate({ brightness: 1.05, saturation: 1.35, hue: 8 })
        .linear(1.08, -(0.08 * 255))
        .sharpen({ sigma: 0.6, m1: 0.5, m2: 0.2 })
        .toBuffer();

    return await sharp(gradedBuffer)
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .webp({ quality: 96, effort: 6 })
        .toBuffer();
}

const PINTEREST_PIN_PROMPT = `
Role: Pinterest Viral Designer.
Topic: ${title}

Rules:
1. Every pin MUST be directly about the blog's topic.
2. NO generic lifestyle. NO food. NO faces. Product-centric only.
3. Hook title: 5-7 words, curiosity gap, specific to the product category.
4. search_queries: Array of 4 strings, from specific to generic. 
   Examples: ["eye cream tube", "skincare flatlay luxury", "under eye serum", "beauty product aesthetic"]
5. BOARDS (MUST choose exactly one from this list): Skincare Tips & Routine for Glowing Skin | Ultimate Makeup Ideas: Glam & Natural Looks | Nail Art Inspiration | Self-Love, Mindfulness & Daily Wellness Rituals | Beauty Tips & Hacks | Outfits Idea | Trendy Hairstyles & Haircare for Women | Fragrance & Body | Gift Guides

Output STRICT JSON array only. No preamble.
[ { "type": "A..E", "board": "Board Name", "hook_title": "...", "description": "...", "keywords": "...", "image_prompt": "...", "search_queries": ["q1", "q2", "q3", "q4"], "cta_text": "..." } ]
`;

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
    try {
        await loadFavicon();
        const accessToken = await googleAuth.getAccessToken();
        const response = await axios.post(
            `https://us-central1-aiplatform.googleapis.com/v1/projects/${process.env.GOOGLE_PROJECT_ID}/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent`,
            {
                contents: [{ role: 'user', parts: [{ text: `Generate 5 high-quality Pinterest pins based on this post:\n\n${html.substring(0, 4000)}` }] }],
                system_instruction: { parts: [{ text: PINTEREST_PIN_PROMPT }] },
                generationConfig: { maxOutputTokens: 8192, responseMimeType: 'application/json' }
            },
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        const pinsData = JSON.parse(response.data.candidates[0].content.parts[0].text);
        const brandedBuffers = [];
        const timestamp = Date.now();

        for (let i = 0; i < pinsData.length; i++) {
            const pin = pinsData[i];
            const pinTypeLetter = (pin.type || 'A').charAt(0).toUpperCase();
            const layoutIndex = PIN_TYPE_LAYOUT[pinTypeLetter] ?? i;
            console.log(`[PIN ${i+1}] Type:${pinTypeLetter} Layout:${layoutIndex} — "${pin.hook_title}"`);

            const queries = Array.isArray(pin.search_queries) ? pin.search_queries : [pin.search_query || pin.hook_title];
            let bgBuffer = await fetchHighQualityUnsplash(queries);
            if (!bgBuffer) bgBuffer = await generateImagenFallback(pin.image_prompt);

            const branded = await createBrandedPin(bgBuffer, pin.hook_title, pin.cta_text, layoutIndex);
            const pinSlug = pin.hook_title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
            const filename = `${slug}-pin${i+1}-${pinSlug}-${timestamp}.webp`;
            fs.writeFileSync(`./backups/${filename}`, branded);
            brandedBuffers.push({ buffer: branded, filename, pin });
        }

        await uploadAndSchedulePins(brandedBuffers, pinsData, `${CONFIG.pinterest.siteUrl}/${slug}/`);
        console.log(`\n🎉 SUCCESS. Scheduled 5 high-quality pins.`);

    } catch (err) { console.error('[ERROR]', err.message); process.exit(1); }
})();
