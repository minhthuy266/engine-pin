/**
 * regen-pins.js — Regenerate Pinterest Pins only
 * Usage: node regen-pins.js <backup-json-file>
 * Example: node regen-pins.js ./backups/backup-69d0c5ebbb15840001a54223-1775489772062.json
 *
 * This re-runs ONLY the Pinterest pin generation step using saved backup data.
 * No Claude call, no Ghost update, no image re-upload.
 */

const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
const FormData = require('form-data');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const fs = require('fs');
require('dotenv').config();

const googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
});

// ─── Load backup file ──────────────────────────────────────────────────────
const backupFile = process.argv[2];
if (!backupFile) {
    console.error('Usage: node regen-pins.js <backup-json-file>');
    console.error('Example: node regen-pins.js ./backups/backup-69d0c5ebbb15840001a54223-1775489772062.json');
    process.exit(1);
}

const parsedData = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));
const title = parsedData.seo_title;
const slug = parsedData.seo_slug;
const html = parsedData.rewritten_html || '';

console.log(`\n[REGEN] Regenerating pins for: "${title}"`);
console.log(`[REGEN] Slug: ${slug}\n`);

// ─── Copy image helpers ────────────────────────────────────────────────────
async function fetchUnsplashPhoto(searchQuery, orientation = 'portrait') {
    try {
        const searchRes = await axios.get('https://api.unsplash.com/search/photos', {
            params: { query: searchQuery, orientation, per_page: 5, content_filter: 'high', order_by: 'relevant' },
            headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` }
        });
        const results = searchRes.data.results;
        if (!results || results.length === 0) return null;
        const photo = results[0];
        const imgRes = await axios.get(photo.urls.regular, { responseType: 'arraybuffer' });
        console.log(`[UNSPLASH] Found: "${photo.alt_description || photo.description}" by ${photo.user.name}`);
        return { buffer: Buffer.from(imgRes.data), credit: `Photo by ${photo.user.name} on Unsplash` };
    } catch (err) {
        console.log(`[UNSPLASH] Failed (${err.message})`);
        return null;
    }
}

async function generateImagenFallback(visualPrompt, aspectRatio = '3:4') {
    const safePrompt = `Shot on iPhone 15 Pro, casual handheld photo, ${visualPrompt}, ` +
        `intentionally slightly out of focus on product labels, warm natural window light, ` +
        `UGC aesthetic, no studio lighting, NO readable text, NO legible words on any product`;
    const response = await axios.post(
        `https://us-central1-aiplatform.googleapis.com/v1/projects/${process.env.GOOGLE_PROJECT_ID}/locations/us-central1/publishers/google/models/imagen-4.0-ultra-generate-001:predict`,
        { instances: [{ prompt: safePrompt }], parameters: { sampleCount: 1, aspectRatio } },
        { headers: { Authorization: `Bearer ${await googleAuth.getAccessToken()}`, 'Content-Type': 'application/json' } }
    );
    return Buffer.from(response.data.predictions[0].bytesBase64Encoded, 'base64');
}

// ─── Brand designer — Full 8 layouts (same as engine.js) ──────────────────
async function createBrandedPin(bgBuffer, title, cta, layoutIndex = 0) {
    const width = 1000;
    const height = 1500;

    const words = title.toUpperCase().split(' ');
    const charLimit = 16;

    function wrapWords(wordList, limit) {
        const ls = []; let cur = '';
        wordList.forEach(w => {
            if ((cur + w).length > limit && cur !== '') { ls.push(cur.trim()); cur = w + ' '; }
            else { cur += w + ' '; }
        });
        if (cur.trim()) ls.push(cur.trim());
        return ls;
    }

    let lines = wrapWords(words, charLimit);

    // Orphan prevention: merge single short last word with previous line's last word
    if (lines.length >= 2) {
        const lastLine = lines[lines.length - 1];
        const lastLineWords = lastLine.split(' ').filter(Boolean);
        if (lastLineWords.length === 1 && lastLine.length <= 4) {
            const prevWords = lines[lines.length - 2].split(' ').filter(Boolean);
            if (prevWords.length > 1) {
                const movedWord = prevWords.pop();
                lines[lines.length - 2] = prevWords.join(' ');
                lines[lines.length - 1] = movedWord + ' ' + lastLine;
            }
        }
    }

    const finalLinesRaw = lines.slice(0, 5);
    const maxLineLength = Math.max(...finalLinesRaw.map(l => l.length)) || 1;

    const escapeXml = (str) => (str || '').toString().replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
    const finalLines = finalLinesRaw.map(escapeXml);
    const safeCta = escapeXml(cta.toUpperCase());
    const ctaWidth = Math.max(460, (cta.length * 22) + 160);
    const ctaHeight = 90;

    let svgOverlay = '';

    if (layoutIndex % 8 === 0) {
        // LAYOUT 0: Classic Editorial (Bottom Heavy, Dark Gradient, Serif)
        let fontSize = 95, lineSpacing = 110;
        if (finalLines.length > 3 || title.length > 35) { fontSize = 85; lineSpacing = 100; }
        if (finalLines.length > 4) { fontSize = 72; lineSpacing = 85; }
        let maxAllowedFontSize = Math.floor(900 / (maxLineLength * 0.65));
        if (fontSize > maxAllowedFontSize) { fontSize = maxAllowedFontSize; lineSpacing = Math.floor(fontSize * 1.15); }
        const textBlockHeight = finalLines.length * lineSpacing;
        const textStartY = 1240 - textBlockHeight;
        svgOverlay = `
        <svg width="${width}" height="${height}">
            <defs>
                <linearGradient id="magazineGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#050404" stop-opacity="0.4"/>
                    <stop offset="25%" stop-color="#050404" stop-opacity="0.0"/>
                    <stop offset="55%" stop-color="#050404" stop-opacity="0.45"/>
                    <stop offset="100%" stop-color="#050404" stop-opacity="0.95"/>
                </linearGradient>
            </defs>
            <rect width="${width}" height="${height}" fill="url(#magazineGrad)" />
            <rect x="35" y="35" width="930" height="1430" fill="none" stroke="white" stroke-opacity="0.12" stroke-width="1.5" />
            <g transform="translate(500, 95)">
                <text text-anchor="middle" style="fill: white; fill-opacity: 0.9; font-family: 'Avenir Next', 'Helvetica Neue', sans-serif; font-size: 16px; font-weight: 500; letter-spacing: 14px; text-transform: uppercase;">GLAMGIRLSHAVEN</text>
                <rect x="-25" y="25" width="50" height="2" fill="#B5838D" />
            </g>
            <g transform="translate(500, ${textStartY})">
                ${finalLines.map((line, i) => `<text y="${i * lineSpacing}" text-anchor="middle" style="fill: white; font-family: 'Didot', 'Bodoni 72', 'Playfair Display', serif; font-size: ${fontSize}px; font-weight: 600; letter-spacing: 1px; filter: drop-shadow(0px 4px 15px rgba(0,0,0,0.8));">${line}</text>`).join('\n            ')}
            </g>
            <g transform="translate(${(width - ctaWidth) / 2}, 1300)">
                <rect x="0" y="5" width="${ctaWidth}" height="${ctaHeight}" rx="${ctaHeight/2}" fill="black" fill-opacity="0.4" filter="blur(6px)" />
                <rect width="${ctaWidth}" height="${ctaHeight}" rx="${ctaHeight/2}" fill="#B5838D" stroke="white" stroke-width="2" stroke-opacity="0.4" />
                <text x="${ctaWidth / 2}" y="${ctaHeight/2 + 9}" text-anchor="middle" style="fill: white; font-family: 'Avenir Next', 'Helvetica Neue', sans-serif; font-size: 26px; font-weight: 700; text-transform: uppercase; letter-spacing: 5px;">
                    ${safeCta} ↗
                </text>
            </g>
        </svg>`;

    } else if (layoutIndex % 8 === 1) {
        // LAYOUT 1: Modern & Bold (Top Heavy, Light Box, Sans-Serif)
        let fontSize = Math.min(105, Math.floor(820 / (maxLineLength * 0.6)));
        let lineSpacing = Math.floor(fontSize * 1.15);
        if (finalLines.length > 4) { fontSize = Math.min(fontSize, 75); lineSpacing = Math.floor(fontSize * 1.15); }
        const textBlockHeight = finalLines.length * lineSpacing;
        const boxHeight = textBlockHeight + 160;
        const boxY = 80;
        svgOverlay = `
        <svg width="${width}" height="${height}">
            <rect width="${width}" height="${height}" fill="black" fill-opacity="0.15" />
            <g transform="translate(50, ${boxY})">
                <rect width="900" height="${boxHeight}" fill="#FDFBFB" fill-opacity="0.95" rx="16" filter="drop-shadow(0px 15px 30px rgba(0,0,0,0.25))" />
                <rect x="20" y="20" width="860" height="${boxHeight - 40}" fill="none" stroke="#B5838D" stroke-width="2" stroke-opacity="0.6" rx="8" />
                <g transform="translate(450, 45)">
                    <text text-anchor="middle" style="fill: #B5838D; font-family: 'Avenir Next', sans-serif; font-size: 14px; font-weight: 700; letter-spacing: 8px;">GLAMGIRLSHAVEN</text>
                </g>
                <g transform="translate(450, ${90 + fontSize*0.8})">
                    ${finalLines.map((line, i) => `<text y="${i * lineSpacing}" text-anchor="middle" style="fill: #1A1A1A; font-family: 'Avenir Next', sans-serif; font-size: ${fontSize}px; font-weight: 900; letter-spacing: -2px;">${line}</text>`).join('\n                    ')}
                </g>
            </g>
            <g transform="translate(${(width - ctaWidth) / 2}, 1300)">
                <rect width="${ctaWidth}" height="${ctaHeight}" rx="4" fill="white" filter="drop-shadow(0px 8px 16px rgba(0,0,0,0.2))" />
                <text x="${ctaWidth / 2}" y="${ctaHeight/2 + 9}" text-anchor="middle" style="fill: #1A1A1A; font-family: 'Avenir Next', sans-serif; font-size: 26px; font-weight: 800; letter-spacing: 3px;">
                    ${safeCta} →
                </text>
            </g>
        </svg>`;

    } else if (layoutIndex % 8 === 2) {
        // LAYOUT 2: Tape / Center Highlight Block (Italic Serif, Slightly Rotated)
        let fontSize = Math.min(85, Math.floor(900 / (maxLineLength * 0.65)));
        let lineSpacing = Math.floor(fontSize * 1.35);
        const textStartY = height/2 - ((finalLines.length * lineSpacing) / 2) - 40;
        const blocks = finalLines.map((line, i) => {
            const charW = fontSize * 0.62;
            const bgWidth = Math.min(line.length * charW + 80, 950);
            const yPos = textStartY + (i * lineSpacing);
            const rot = (i % 2 === 0) ? -1 : 1;
            return `
            <g transform="translate(${(width - bgWidth)/2}, ${yPos - fontSize*0.9})">
                <g transform="rotate(${rot}, ${bgWidth/2}, ${fontSize/2})">
                    <rect width="${bgWidth}" height="${fontSize * 1.4}" fill="white" fill-opacity="0.96" filter="drop-shadow(0px 4px 10px rgba(0,0,0,0.15))" />
                    <text x="${bgWidth/2}" y="${fontSize * 1.0}" text-anchor="middle" style="fill: #1A1A1A; font-family: 'Didot', serif; font-size: ${fontSize}px; font-weight: 700; font-style: italic;">${line}</text>
                </g>
            </g>`;
        }).join('');
        svgOverlay = `
        <svg width="${width}" height="${height}">
            <rect width="${width}" height="${height}" fill="black" fill-opacity="0.2" />
            <circle cx="500" cy="${height/2}" r="450" fill="white" fill-opacity="0.1" filter="blur(50px)" />
            ${blocks}
            <g transform="translate(500, ${height - 180})">
                <text text-anchor="middle" style="fill: white; font-family: 'Avenir Next', sans-serif; font-size: 16px; font-weight: 600; letter-spacing: 12px; filter: drop-shadow(0px 2px 5px rgba(0,0,0,0.8));">GLAMGIRLSHAVEN</text>
            </g>
            <g transform="translate(${(width - ctaWidth) / 2}, ${height - 130})">
                <rect width="${ctaWidth}" height="70" rx="35" fill="#1A1A1A" filter="drop-shadow(0px 5px 10px rgba(0,0,0,0.3))" />
                <text x="${ctaWidth / 2}" y="45" text-anchor="middle" style="fill: white; font-family: 'Avenir Next', sans-serif; font-size: 18px; font-weight: 700; letter-spacing: 5px;">
                    ${safeCta}
                </text>
            </g>
        </svg>`;

    } else if (layoutIndex % 8 === 3) {
        // LAYOUT 3: Minimalist Editorial Bottom Block (White Panel, Dark Text)
        let fontSize = Math.min(85, Math.floor(900 / (maxLineLength * 0.65)));
        let lineSpacing = Math.floor(fontSize * 1.25);
        if (finalLines.length > 3) { fontSize = Math.min(fontSize, 70); lineSpacing = Math.floor(fontSize * 1.2); }
        const textHeight = finalLines.length * lineSpacing;
        const boxHeight = 550;
        const boxY = height - boxHeight;
        const textStartY = 1175 - (textHeight / 2) + (fontSize * 0.4);
        svgOverlay = `
        <svg width="${width}" height="${height}">
            <rect x="0" y="0" width="${width}" height="${height}" fill="black" fill-opacity="0.05" />
            <rect x="0" y="${boxY}" width="${width}" height="${boxHeight}" fill="#FDFBFB" />
            <rect x="50" y="${boxY - 50}" width="900" height="100" fill="none" stroke="white" stroke-width="4" stroke-opacity="0.8" />
            <g transform="translate(500, ${boxY + 50})">
                <text text-anchor="middle" style="fill: #B5838D; font-family: 'Avenir Next', sans-serif; font-size: 14px; font-weight: 700; letter-spacing: 10px;">GLAMGIRLSHAVEN</text>
            </g>
            <g transform="translate(500, ${textStartY + fontSize * 0.5})">
                ${finalLines.map((line, i) => `<text y="${i * lineSpacing}" text-anchor="middle" style="fill: #1A1A1A; font-family: 'Didot', serif; font-size: ${fontSize}px; font-weight: 600; letter-spacing: 2px;">${line}</text>`).join('\n                ')}
            </g>
            <g transform="translate(${(width - ctaWidth) / 2}, 1350)">
                <rect width="${ctaWidth}" height="${ctaHeight}" rx="${ctaHeight/2}" fill="none" stroke="#1A1A1A" stroke-width="2" />
                <text x="${ctaWidth / 2}" y="${ctaHeight/2 + 9}" text-anchor="middle" style="fill: #1A1A1A; font-family: 'Avenir Next', sans-serif; font-size: 22px; font-weight: 800; letter-spacing: 4px;">
                    ${safeCta} →
                </text>
            </g>
        </svg>`;

    } else if (layoutIndex % 8 === 4) {
        // LAYOUT 4: Viral Quote — Dark Center Banner
        let fontSize = Math.min(95, Math.floor(950 / (maxLineLength * 0.6)));
        let lineSpacing = Math.floor(fontSize * 1.25);
        if (finalLines.length > 4) { fontSize = Math.min(80, fontSize); lineSpacing = Math.floor(fontSize * 1.15); }
        const textHeight = finalLines.length * lineSpacing;
        const boxHeight = textHeight + 240;
        const boxY = (height - boxHeight) / 2;
        svgOverlay = `
        <svg width="${width}" height="${height}">
            <rect x="0" y="0" width="${width}" height="${height}" fill="black" fill-opacity="0.1" />
            <rect x="0" y="${boxY}" width="${width}" height="${boxHeight}" fill="#1A1A1A" fill-opacity="0.85" />
            <rect x="30" y="${boxY + 30}" width="940" height="${boxHeight - 60}" fill="none" stroke="#B5838D" stroke-width="2" stroke-opacity="0.5" />
            <g transform="translate(500, ${boxY + 65})">
                <text text-anchor="middle" style="fill: #F9E5C9; font-family: 'Avenir Next', sans-serif; font-size: 14px; font-weight: 600; letter-spacing: 12px;">GLAMGIRLSHAVEN</text>
            </g>
            <g transform="translate(500, ${boxY + 120 + fontSize * 0.5})">
                ${finalLines.map((line, i) => `<text y="${i * lineSpacing}" text-anchor="middle" style="fill: white; font-family: 'Avenir Next', sans-serif; font-size: ${fontSize}px; font-weight: 800; letter-spacing: -1px;">${line}</text>`).join('\n                ')}
            </g>
            <g transform="translate(${(width - ctaWidth) / 2}, ${boxY + boxHeight - 45})">
                <rect width="${ctaWidth}" height="90" rx="45" fill="#B5838D" />
                <text x="${ctaWidth / 2}" y="54" text-anchor="middle" style="fill: white; font-family: 'Avenir Next', sans-serif; font-size: 20px; font-weight: 800; letter-spacing: 4px;">
                    ${safeCta}
                </text>
            </g>
        </svg>`;

    } else if (layoutIndex % 8 === 5) {
        // LAYOUT 5: Viral Tweet / Threads Box
        let fontSize = Math.min(65, Math.floor(700 / (maxLineLength * 0.6)));
        let lineSpacing = Math.floor(fontSize * 1.3);
        const textHeight = finalLines.length * lineSpacing;
        const boxHeight = textHeight + 200;
        const boxY = Math.max((height - boxHeight) / 2, 250);
        svgOverlay = `
        <svg width="${width}" height="${height}">
            <rect width="${width}" height="${height}" fill="black" fill-opacity="0.2" />
            <rect x="100" y="${boxY}" width="800" height="${boxHeight}" rx="20" fill="white" filter="drop-shadow(0px 10px 20px rgba(0,0,0,0.15))" />
            <circle cx="170" cy="${boxY + 70}" r="35" fill="#F5F0EB" />
            <text x="170" y="${boxY + 80}" text-anchor="middle" style="fill: #B5838D; font-family: 'Avenir Next', sans-serif; font-size: 30px; font-weight: bold;">G</text>
            <text x="225" y="${boxY + 65}" text-anchor="start" style="fill: #1A1A1A; font-family: 'Helvetica Neue', Helvetica, sans-serif; font-size: 24px; font-weight: 700;">GlamGirls Haven</text>
            <text x="225" y="${boxY + 95}" text-anchor="start" style="fill: #657786; font-family: 'Helvetica Neue', Helvetica, sans-serif; font-size: 20px;">@glamgirlshaven</text>
            <g transform="translate(150, ${boxY + 160 + fontSize*0.8})">
                ${finalLines.map((line, i) => `<text y="${i * lineSpacing}" x="0" text-anchor="start" style="fill: #1A1A1A; font-family: 'Helvetica Neue', Helvetica, sans-serif; font-size: ${fontSize}px; font-weight: 500; letter-spacing: -0.5px;">${line}</text>`).join('\n                ')}
            </g>
            <g transform="translate(${(width - ctaWidth) / 2}, 1300)">
                <rect width="${ctaWidth}" height="80" rx="40" fill="#B5838D" filter="drop-shadow(0px 4px 8px rgba(181, 131, 141, 0.4))" />
                <text x="${ctaWidth / 2}" y="48" text-anchor="middle" style="fill: white; font-family: 'Avenir Next', sans-serif; font-size: 20px; font-weight: 800; letter-spacing: 2px;">
                    ${safeCta}
                </text>
            </g>
        </svg>`;

    } else if (layoutIndex % 8 === 6) {
        // LAYOUT 6: Search Bar Aesthetic
        let searchQueryRaw = finalLinesRaw[0] || '';
        if (finalLinesRaw.length > 1) searchQueryRaw += '...';
        let searchQuery = escapeXml(searchQueryRaw.toLowerCase());
        let mainFontSize = Math.min(95, Math.floor(900 / (maxLineLength * 0.6)));
        let mainLineSpacing = Math.floor(mainFontSize * 1.25);
        svgOverlay = `
        <svg width="${width}" height="${height}">
            <rect width="${width}" height="${height}" fill="black" fill-opacity="0.3" />
            <rect x="100" y="150" width="800" height="90" rx="45" fill="white" filter="drop-shadow(0px 8px 16px rgba(0,0,0,0.15))" />
            <circle cx="160" cy="195" r="14" fill="none" stroke="#657786" stroke-width="4" />
            <line x1="170" y1="205" x2="185" y2="220" stroke="#657786" stroke-width="4" stroke-linecap="round" />
            <text x="210" y="205" text-anchor="start" style="fill: #1A1A1A; font-family: 'Avenir Next', sans-serif; font-size: 32px; font-weight: 500;">${searchQuery}|</text>
            <g transform="translate(500, 450)">
                <text text-anchor="middle" style="fill: #F9E5C9; font-family: 'Avenir Next', sans-serif; font-size: 16px; font-weight: 700; letter-spacing: 12px; text-transform: uppercase;">TOP RESULT</text>
            </g>
            <g transform="translate(500, ${520 + mainFontSize*0.8})">
                ${finalLines.map((line, i) => `<text y="${i * mainLineSpacing}" text-anchor="middle" style="fill: white; font-family: 'Avenir Next', sans-serif; font-size: ${mainFontSize}px; font-weight: 900; letter-spacing: -2px; filter: drop-shadow(0px 4px 12px rgba(0,0,0,0.5));">${line}</text>`).join('\n                ')}
            </g>
            <g transform="translate(${(width - ctaWidth) / 2}, 1300)">
                <rect width="${ctaWidth}" height="80" rx="40" fill="white" />
                <text x="${ctaWidth / 2}" y="48" text-anchor="middle" style="fill: #1A1A1A; font-family: 'Avenir Next', sans-serif; font-size: 20px; font-weight: 800; letter-spacing: 2px;">
                    ${safeCta} →
                </text>
            </g>
        </svg>`;

    } else {
        // LAYOUT 7: iMessage Bubble
        let fontSize = Math.min(65, Math.floor(700 / (maxLineLength * 0.6)));
        let lineSpacing = Math.floor(fontSize * 1.3);
        const textHeight = finalLines.length * lineSpacing;
        const boxHeight = textHeight + 100;
        const boxY = (height - boxHeight) / 2;
        svgOverlay = `
        <svg width="${width}" height="${height}">
            <rect width="${width}" height="${height}" fill="black" fill-opacity="0.15" />
            <g transform="translate(100, ${boxY})">
                <rect width="800" height="${boxHeight}" rx="40" fill="#007AFF" filter="drop-shadow(0px 10px 20px rgba(0,0,0,0.2))" />
                <path d="M 760 ${boxHeight - 10} C 780 ${boxHeight - 10}, 810 ${boxHeight + 10}, 820 ${boxHeight + 20} C 800 ${boxHeight + 10}, 790 ${boxHeight - 10}, 790 ${boxHeight - 30} Z" fill="#007AFF" />
                <g transform="translate(50, ${50 + fontSize*0.8})">
                    ${finalLines.map((line, i) => `<text y="${i * lineSpacing}" x="0" text-anchor="start" style="fill: white; font-family: 'Helvetica Neue', Helvetica, sans-serif; font-size: ${fontSize}px; font-weight: 500; letter-spacing: -0.5px;">${line}</text>`).join('\n                    ')}
                </g>
            </g>
            <g transform="translate(500, ${boxY - 30})">
                <text text-anchor="middle" style="fill: white; font-family: 'Helvetica Neue', Helvetica, sans-serif; font-size: 18px; font-weight: 700; text-transform: uppercase;">Derm Bestie</text>
            </g>
            <g transform="translate(${(width - ctaWidth) / 2}, 1300)">
                <rect width="${ctaWidth}" height="80" rx="40" fill="white" />
                <text x="${ctaWidth / 2}" y="48" text-anchor="middle" style="fill: #007AFF; font-family: 'Avenir Next', sans-serif; font-size: 20px; font-weight: 800; letter-spacing: 2px;">
                    ${safeCta}
                </text>
            </g>
        </svg>`;
    }

    return await sharp(bgBuffer)
        .resize(width, height, { fit: 'cover', position: 'center' })
        .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
        .webp({ quality: 98, effort: 6 })
        .toBuffer();
}

// ─── Pinterest pin prompt ──────────────────────────────────────────────────
const PINTEREST_PIN_PROMPT = `
Role: Bạn là Chuyên gia Chiến lược Pinterest VIRAL cho blog "GlamGirls Haven".

NHIỆM VỤ: Read the blog and output a STRICT JSON array of 5 Pins. 

🚨 CRITICAL RELEVANCE RULE (MOST IMPORTANT):
Every single hook_title, description, and image_prompt MUST be 100% directly about the SPECIFIC TOPIC of this blog post.
- If the blog is about GIFT IDEAS → all 5 pins must be about gifting beauty products.
- If the blog is about SKINCARE ROUTINE → all 5 pins must be about skincare steps.
- If the blog is about NAIL TOOLS → all 5 pins must be about nail care.
- NEVER write hooks about unrelated topics (e.g. do NOT write "Why Your Hair Is Breaking" for a gift guide post).
- The "Mistake/Warning" pin (type C) must call out a mistake related to THIS post's topic only.

STRATEGY (THE CURIOSITY GAP & TIKTOK HOOKS):
- Never reveal the "How" or "Final Product" on the Pin.
- Use Gen-Z/Millennial high-converting power hooks adapted to the blog topic.
- Hooks must borderline on psychological clickbait but sound like an insider secret.

IMPORTANT: NEVER use double quotes (") inside your values. Use single quotes (') instead.

OUTPUT FORMAT: A single JSON array with no preamble and no markdown.
[
  {
    "type": "A (Pain Point)",
    "board": "Exact board name from list below",
    "hook_title": "5-7 word attention-grabbing title (overlay)",
    "description": "150-200 char description with keywords",
    "hashtags": ["#tag1", "#tag2", "#tag3"],
    "image_prompt": "Specific beauty-related visual prompt",
    "search_query": "2-4 word Unsplash search term",
    "cta_text": "SEE THE FIX"
  }
]

BOARDS: Skincare Tips & Routine for Glowing Skin | Ultimate Makeup Ideas: Glam & Natural Looks | Nail Art Inspiration | Beauty Tips & Hacks | Trendy Hairstyles & Haircare for Women | Fragrance & Body | Gift Guides

CTA VARIATIONS:
- A: "SEE THE FIX", "UNLOCK THE HACK"
- B: "RICH MOM ENERGY", "THAT GIRL VIBE"
- C: "STOP DOING THIS", "BIG MISTAKE"
- D: "TARGET SECRET", "THE $9 DUPE"
- E: "EXACT ROUTINE", "COPY THIS"

CONTENT MIX: A: Pain Point, B: Aesthetic Goal, C: Mistake/Warning, D: Secret Find/Dupe, E: Exact Routine.
`;

// ─── Main ──────────────────────────────────────────────────────────────────
(async () => {
    try {
        // Delete all existing pins for this slug
        const files = fs.readdirSync('./backups');
        const oldPins = files.filter(f => f.startsWith(slug) && f.endsWith('.webp'));
        oldPins.forEach(f => {
            fs.unlinkSync(`./backups/${f}`);
            console.log(`[REGEN] 🗑  Deleted old pin: ${f}`);
        });

        // Call Gemini to regenerate pin concepts
        console.log(`\n[REGEN] Calling Gemini for new pin concepts...`);
        const accessToken = await googleAuth.getAccessToken();
        const response = await axios.post(
            `https://us-central1-aiplatform.googleapis.com/v1/projects/${process.env.GOOGLE_PROJECT_ID}/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent`,
            {
                contents: [{ role: 'user', parts: [{ text: `Generate a 5-Pin JSON Package based on this blog post:\n\nTitle: ${title}\n\nContent:\n${html.substring(0, 8000)}` }] }],
                system_instruction: { parts: [{ text: PINTEREST_PIN_PROMPT }] },
                generationConfig: { maxOutputTokens: 4000, temperature: 0.7, responseMimeType: 'application/json' }
            },
            { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );

        let rawText = response.data.candidates[0].content.parts[0].text;
        const startIdx = rawText.indexOf('[');
        const endIdx = rawText.lastIndexOf(']');
        if (startIdx === -1 || endIdx === -1) throw new Error('Model failed to output a JSON array');
        const pinsData = JSON.parse(rawText.substring(startIdx, endIdx + 1));

        console.log(`[REGEN] ✅ Got ${pinsData.length} new pin concepts:\n`);
        pinsData.forEach((p, i) => console.log(`  ${i+1}. [${p.type}] "${p.hook_title}"`));

        const timestamp = Date.now();

        // Generate branded images
        for (let i = 0; i < pinsData.length; i++) {
            const pin = pinsData[i];
            console.log(`\n[REGEN] Creating Pin ${i+1}: ${pin.type}...`);

            let bgBuffer;
            if (process.env.UNSPLASH_ACCESS_KEY) {
                const stock = await fetchUnsplashPhoto(pin.search_query || pin.hook_title, 'portrait');
                if (stock) bgBuffer = stock.buffer;
            }
            if (!bgBuffer) {
                console.log(`[REGEN] ⚡ Imagen fallback for Pin ${i+1}`);
                bgBuffer = await generateImagenFallback(pin.image_prompt, '3:4');
            }

            const brandedBuffer = await createBrandedPin(bgBuffer, pin.hook_title, pin.cta_text, i);
            const pinSlug = pin.hook_title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
            const filename = `./backups/${slug}-${pinSlug}-${timestamp}.webp`;
            fs.writeFileSync(filename, brandedBuffer);
            console.log(`[REGEN] ✅ Saved: ${filename}`);
        }

        // Save updated metadata
        const metadataFile = `./backups/pins-data-${slug}-${timestamp}.json`;
        fs.writeFileSync(metadataFile, JSON.stringify(pinsData, null, 2), 'utf-8');
        console.log(`\n[REGEN] 📝 Pin metadata saved: ${metadataFile}`);
        console.log(`[REGEN] 🎉 Done! ${pinsData.length} pins regenerated.`);

    } catch (err) {
        console.error('[ERROR]', err.message);
        if (err.response?.data) console.error('[API]', JSON.stringify(err.response.data, null, 2));
        process.exit(1);
    }
})();
