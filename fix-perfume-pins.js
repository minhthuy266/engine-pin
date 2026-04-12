/**
 * fix-perfume-pins.js
 * Regenerate chỉ pin 2, 3, 5 của bài oriental perfumes
 * với search_query đã fix + layout phù hợp hơn
 *
 * Usage: node fix-perfume-pins.js
 */

const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
require('dotenv').config();

const WIDTH = 1000, HEIGHT = 1500;
const SLUG = 'best-oriental-perfumes-for-women-that-last-long';
const TS   = 1775923061363; // timestamp gốc → overwrite files cũ

/* ──────────────────────────────────────────────────────────
   PINS TO REGENERATE — curated search queries, fixed layouts
   ────────────────────────────────────────────────────────── */
const PINS = [
    {
        pinIndex: 2,
        layout: 3,           // Minimalist Bottom Block — luxury, clean, editorial
        hook_title: "The secret to smelling expensive.",
        cta_text: "RICH MOM ENERGY",
        queries: [
            "amber perfume bottles vanity gold",
            "luxury perfume flatlay dark",
            "oriental perfume bottle elegant",
            "dark perfume bottle silk velvet",
        ],
        imagen_prompt: "Overhead flatlay of dark amber glass perfume bottles on burgundy velvet with pearls, golden candlelight, moody luxury mood, no visible labels"
    },
    {
        pinIndex: 3,
        layout: 0,           // Classic Editorial — dark gradient + serif, works great for "mistake" content
        hook_title: "The #1 perfume mistake you're making.",
        cta_text: "STOP DOING THIS",
        queries: [
            "woman perfume wrist evening",
            "woman spritzing fragrance silk",
            "perfume spritz close up portrait",
            "woman fragrance night out blurred",
        ],
        imagen_prompt: "Close-up UGC iPhone candid of a woman's wrist being spritzed with perfume before a night out, warm amber bokeh, silk sleeve, no labels"
    },
    {
        pinIndex: 5,
        layout: 0,           // Classic Editorial — romantic, dark, sensual — perfect for "date night scents"
        hook_title: "My all-night date night scents.",
        cta_text: "COPY THIS",
        queries: [
            "woman getting ready date night perfume",
            "woman spraying luxury perfume mirror",
            "elegant woman perfume evening portrait",
            "luxury perfume bottle woman portrait",
        ],
        imagen_prompt: "UGC iPhone candid of an elegant woman in black silk spritzing perfume at her neck, warm golden lamp glow, romantic blur, no readable labels"
    }
];

/* ──────────────────────────────────────────────────────────
   IMAGE FETCH — Unsplash với smart filtering
   ────────────────────────────────────────────────────────── */
async function fetchUnsplash(query) {
    if (!process.env.UNSPLASH_ACCESS_KEY) return null;
    try {
        const res = await axios.get('https://api.unsplash.com/search/photos', {
            params: { query, orientation: 'portrait', per_page: 10, content_filter: 'high', order_by: 'relevant' },
            headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` }
        });
        const results = res.data.results || [];

        // Lọc bỏ ảnh có thể unrelated (chứa từ như 'injury', 'bruise', 'underwear')
        const KEYWORDS_BEAUTY = ['perfume', 'fragrance', 'scent', 'bottle', 'woman', 'beauty', 'luxury', 'makeup', 'cosmetic', 'vanity', 'silk'];
        const best = results.find(p => {
            const desc = (p.alt_description || p.description || '').toLowerCase();
            return KEYWORDS_BEAUTY.some(kw => desc.includes(kw));
        }) || results[0];

        if (!best) return null;
        const img = await axios.get(best.urls.regular, { responseType: 'arraybuffer' });
        console.log(`   ✓ Unsplash: "${best.alt_description || query}" — by ${best.user.name}`);
        return Buffer.from(img.data);
    } catch (e) {
        console.log(`   ✗ Unsplash failed: ${e.message}`);
        return null;
    }
}

/* ──────────────────────────────────────────────────────────
   IMAGE FETCH — Pexels fallback
   ────────────────────────────────────────────────────────── */
async function fetchPexels(query) {
    if (!process.env.PEXELS_API_KEY) return null;
    try {
        const res = await axios.get('https://api.pexels.com/v1/search', {
            params: { query, orientation: 'portrait', per_page: 5 },
            headers: { Authorization: process.env.PEXELS_API_KEY }
        });
        const photo = res.data.photos?.[0];
        if (!photo) return null;
        const img = await axios.get(photo.src.portrait, { responseType: 'arraybuffer' });
        console.log(`   ✓ Pexels: "${photo.alt || query}"`);
        return Buffer.from(img.data);
    } catch (e) {
        console.log(`   ✗ Pexels failed: ${e.message}`);
        return null;
    }
}

/* ──────────────────────────────────────────────────────────
   IMAGE FETCH — Imagen AI fallback
   ────────────────────────────────────────────────────────── */
async function generateImagen(prompt) {
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const token = await auth.getAccessToken();
    const safePrompt = `Shot on iPhone 15 Pro, UGC aesthetic, ${prompt}, NO readable text, NO brand labels, warm natural lighting`;
    const res = await axios.post(
        `https://us-central1-aiplatform.googleapis.com/v1/projects/${process.env.GOOGLE_PROJECT_ID}/locations/us-central1/publishers/google/models/imagen-4.0-ultra-generate-001:predict`,
        { instances: [{ prompt: safePrompt }], parameters: { sampleCount: 1, aspectRatio: '3:4' } },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log(`   ✓ Imagen AI generated`);
    return Buffer.from(res.data.predictions[0].bytesBase64Encoded, 'base64');
}

/* ──────────────────────────────────────────────────────────
   SMART RESOLVER — thử từng query cho đến khi có ảnh
   ────────────────────────────────────────────────────────── */
async function resolveImage(queries, imagenPrompt) {
    for (const q of queries) {
        console.log(`   Trying: "${q}"`);
        const buf = await fetchUnsplash(q);
        if (buf) return buf;
    }
    // Pexels fallback
    const pBuf = await fetchPexels(queries[0]);
    if (pBuf) return pBuf;
    // Imagen cuối cùng
    console.log(`   → Imagen fallback`);
    return await generateImagen(imagenPrompt);
}

/* ──────────────────────────────────────────────────────────
   SVG HELPER
   ────────────────────────────────────────────────────────── */
function esc(s) {
    return (s || '').toString().replace(/[<>&'"]/g, c =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])
    );
}

function wrapText(title, charLimit = 16) {
    const words = title.toUpperCase().split(' ');
    const lines = []; let cur = '';
    words.forEach(w => {
        if ((cur + w).length > charLimit && cur) { lines.push(cur.trim()); cur = w + ' '; }
        else cur += w + ' ';
    });
    if (cur.trim()) lines.push(cur.trim());

    // Orphan prevention
    if (lines.length >= 2) {
        const last = lines[lines.length - 1];
        const lw = last.split(' ').filter(Boolean);
        if (lw.length === 1 && last.length <= 4) {
            const prev = lines[lines.length - 2].split(' ').filter(Boolean);
            if (prev.length > 1) {
                const moved = prev.pop();
                lines[lines.length - 2] = prev.join(' ');
                lines[lines.length - 1] = moved + ' ' + last;
            }
        }
    }
    return lines.slice(0, 5);
}

/* ──────────────────────────────────────────────────────────
   LAYOUT 0 — Classic Editorial (dark gradient, serif, bottom)
   Best for: Pain Point, Mistake, Date Night — dark & editorial
   ────────────────────────────────────────────────────────── */
function layout0(lines, cta) {
    const maxLen = Math.max(...lines.map(l => l.length)) || 1;
    let fs = 95, ls = 110;
    if (lines.length > 3) { fs = 85; ls = 100; }
    if (lines.length > 4) { fs = 72; ls = 85; }
    const maxFs = Math.floor(900 / (maxLen * 0.65));
    if (fs > maxFs) { fs = maxFs; ls = Math.floor(fs * 1.15); }
    const tbH = lines.length * ls;
    const tY = 1240 - tbH;
    const ctaW = Math.max(460, cta.length * 22 + 160);
    const ctaH = 90;

    return `<svg width="${WIDTH}" height="${HEIGHT}">
        <defs><linearGradient id="g0" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#050404" stop-opacity="0.4"/>
            <stop offset="25%" stop-color="#050404" stop-opacity="0"/>
            <stop offset="55%" stop-color="#050404" stop-opacity="0.45"/>
            <stop offset="100%" stop-color="#050404" stop-opacity="0.95"/>
        </linearGradient></defs>
        <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g0)"/>
        <rect x="35" y="35" width="930" height="1430" fill="none" stroke="white" stroke-opacity="0.12" stroke-width="1.5"/>
        <g transform="translate(500,95)">
            <text text-anchor="middle" style="fill:white;fill-opacity:0.9;font-family:'Avenir Next','Helvetica Neue',sans-serif;font-size:16px;font-weight:500;letter-spacing:14px;">GLAMGIRLSHAVEN</text>
            <rect x="-25" y="25" width="50" height="2" fill="#B5838D"/>
        </g>
        <g transform="translate(500,${tY})">
            ${lines.map((l, i) => `<text y="${i * ls}" text-anchor="middle" style="fill:white;font-family:'Didot','Bodoni 72',serif;font-size:${fs}px;font-weight:600;filter:drop-shadow(0px 4px 15px rgba(0,0,0,0.8));">${esc(l)}</text>`).join('')}
        </g>
        <g transform="translate(${(WIDTH - ctaW) / 2},1300)">
            <rect width="${ctaW}" height="${ctaH}" rx="${ctaH / 2}" fill="#B5838D" stroke="white" stroke-width="2" stroke-opacity="0.4"/>
            <text x="${ctaW / 2}" y="${ctaH / 2 + 9}" text-anchor="middle" style="fill:white;font-family:'Avenir Next',sans-serif;font-size:26px;font-weight:700;letter-spacing:5px;">${esc(cta.toUpperCase())} ↗</text>
        </g>
    </svg>`;
}

/* ──────────────────────────────────────────────────────────
   LAYOUT 3 — Minimalist Bottom Block (white panel, serif dark text)
   Best for: Aesthetic/Luxury content — clean, editorial
   ────────────────────────────────────────────────────────── */
function layout3(lines, cta) {
    const maxLen = Math.max(...lines.map(l => l.length)) || 1;
    let fs = Math.min(85, Math.floor(900 / (maxLen * 0.65)));
    let ls = Math.floor(fs * 1.25);
    if (lines.length > 3) { fs = Math.min(fs, 70); ls = Math.floor(fs * 1.2); }
    const tbH = lines.length * ls;
    const tY = 1175 - tbH / 2 + fs * 0.4;
    const ctaW = Math.max(460, cta.length * 22 + 160);
    const ctaH = 90;

    return `<svg width="${WIDTH}" height="${HEIGHT}">
        <rect x="0" y="${HEIGHT - 550}" width="${WIDTH}" height="550" fill="#FDFBFB"/>
        <g transform="translate(500,${HEIGHT - 500})">
            <text text-anchor="middle" style="fill:#B5838D;font-family:'Avenir Next',sans-serif;font-size:14px;font-weight:700;letter-spacing:10px;">GLAMGIRLSHAVEN</text>
        </g>
        <g transform="translate(500,${tY + fs * 0.5})">
            ${lines.map((l, i) => `<text y="${i * ls}" text-anchor="middle" style="fill:#1A1A1A;font-family:'Didot',serif;font-size:${fs}px;font-weight:600;letter-spacing:2px;">${esc(l)}</text>`).join('')}
        </g>
        <g transform="translate(${(WIDTH - ctaW) / 2},1350)">
            <rect width="${ctaW}" height="${ctaH}" rx="${ctaH / 2}" fill="none" stroke="#1A1A1A" stroke-width="2"/>
            <text x="${ctaW / 2}" y="${ctaH / 2 + 9}" text-anchor="middle" style="fill:#1A1A1A;font-family:'Avenir Next',sans-serif;font-size:22px;font-weight:800;letter-spacing:4px;">${esc(cta.toUpperCase())} →</text>
        </g>
    </svg>`;
}

/* ──────────────────────────────────────────────────────────
   COMPOSE PIN
   ────────────────────────────────────────────────────────── */
async function compositePin(bgBuffer, lines, cta, layoutIndex) {
    const svg = layoutIndex === 3 ? layout3(lines, cta) : layout0(lines, cta);
    return await sharp(bgBuffer)
        .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'center' })
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .webp({ quality: 98, effort: 6 })
        .toBuffer();
}

/* ──────────────────────────────────────────────────────────
   MAIN
   ────────────────────────────────────────────────────────── */
async function main() {
    console.log('\n═══════════════════════════════════════════════');
    console.log('  Fix Pins 2, 3, 5 — Oriental Perfumes');
    console.log('  (Targeted regen — no AI call needed)');
    console.log('═══════════════════════════════════════════════\n');

    if (!fs.existsSync('./backups')) fs.mkdirSync('./backups');

    const LAYOUT_NAMES = { 0: 'Classic Editorial (dark gradient + serif)', 3: 'Minimalist Bottom Block (white panel)' };

    for (const pin of PINS) {
        const layoutName = LAYOUT_NAMES[pin.layout] || `Layout ${pin.layout}`;
        console.log(`\n[PIN ${pin.pinIndex}] "${pin.hook_title}"`);
        console.log(`  Layout: ${layoutName}`);

        try {
            // Resolve image
            const bgBuffer = await resolveImage(pin.queries, pin.imagen_prompt);

            // Wrap text
            const lines = wrapText(pin.hook_title);

            // Compose
            const branded = await compositePin(bgBuffer, lines, pin.cta_text, pin.layout);

            // Save — overwrite file cũ với cùng timestamp
            const pinSlug = pin.hook_title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
            const filename = `./backups/${SLUG}-pin${pin.pinIndex}-${pinSlug}-${TS}.webp`;
            fs.writeFileSync(filename, branded);
            console.log(`  ✅ Saved: ${filename}`);

        } catch (err) {
            console.error(`  ❌ Pin ${pin.pinIndex} failed: ${err.message}`);
            if (err.response?.data) {
                console.error('  API error:', JSON.stringify(err.response.data).slice(0, 400));
            }
        }
    }

    console.log('\n═══════════════════════════════════════════════');
    console.log('  ✅ Done! Kiểm tra ./backups/ để xem 3 pin mới');
    console.log('═══════════════════════════════════════════════\n');
}

main();
