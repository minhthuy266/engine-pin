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

// ─── Branded Pin SVG (Layout 0 + Improvements) ──────────────────────────
async function createBrandedPin(bgBuffer, title, cta) {
    const { width, height } = CONFIG.pin;
    const escapeXml = (str) => (str || '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
    
    // Split text into lines
    const words = title.toUpperCase().split(' ');
    const lines = []; let cur = '';
    words.forEach(w => {
        if ((cur + w).length > 14 && cur !== '') { lines.push(cur.trim()); cur = w + ' '; }
        else { cur += w + ' '; }
    });
    if (cur.trim()) lines.push(cur.trim());

    const svgLines = lines.slice(0, 5).map((l, i) => `<text x="${width/2}" y="${800 + i*130}" text-anchor="middle" style="fill:white; font-family:serif; font-size:100px; font-weight:bold; filter: drop-shadow(0 4px 8px rgba(0,0,0,0.8));">${escapeXml(l)}</text>`).join('');

    const ctaWidth = Math.max(420, (cta.length * 18) + 140);
    const svgOverlay = `<svg width="${width}" height="${height}">
        <rect width="${width}" height="${height}" fill="black" fill-opacity="0.3" />
        <rect x="50" y="50" width="900" height="1400" fill="none" stroke="white" stroke-opacity="0.2" stroke-width="2" />
        <text x="${width/2}" y="120" text-anchor="middle" style="fill:white; font-family:sans-serif; font-size:20px; font-weight:bold; letter-spacing:10px; opacity:0.8;">GLAMGIRLSHAVEN</text>
        ${svgLines}
        <rect x="${(width - ctaWidth) / 2}" y="1300" width="${ctaWidth}" height="90" rx="45" fill="#B5838D" />
        <text x="${width/2}" y="1358" text-anchor="middle" style="fill:white; font-family:sans-serif; font-size:28px; font-weight:bold;">${escapeXml(cta.toUpperCase())} ↗</text>
    </svg>`;

    return await sharp(bgBuffer).resize(width, height).composite([{ input: Buffer.from(svgOverlay) }]).webp({ quality: 96 }).toBuffer();
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
            console.log(`[PIN ${i+1}] "${pin.hook_title}"`);

            const queries = Array.isArray(pin.search_queries) ? pin.search_queries : [pin.search_query];
            let bgBuffer = await fetchHighQualityUnsplash(queries);
            if (!bgBuffer) bgBuffer = await generateImagenFallback(pin.image_prompt);

            const branded = await createBrandedPin(bgBuffer, pin.hook_title, pin.cta_text);
            const filename = `${slug}-hp-pin${i+1}-${timestamp}.webp`;
            fs.writeFileSync(`./backups/${filename}`, branded);
            brandedBuffers.push({ buffer: branded, filename, pin });
        }

        await uploadAndSchedulePins(brandedBuffers, pinsData, `${CONFIG.pinterest.siteUrl}/${slug}/`);
        console.log(`\n🎉 SUCCESS. Scheduled 5 high-quality pins.`);

    } catch (err) { console.error('[ERROR]', err.message); process.exit(1); }
})();
