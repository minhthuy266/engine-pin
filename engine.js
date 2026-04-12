/**
 * GlamGirls Haven — Content Engine v3
 * ─────────────────────────────────────
 * Strategy: Pinterest-first + Google long-tail
 * Target:   $2-3K/month via Amazon affiliate + display ads
 * Content:  800-1000 words, buyer-intent, conversion-focused
 *
 * MODES:
 *   node engine.js              → REWRITE mode: rewrite Ghost posts tagged "legacy"
 *   node engine.js create       → CREATE mode:  create new posts from keywords.txt
 *   node engine.js create 3     → CREATE mode:  process only 3 keywords
 */

const GhostAdminAPI = require('@tryghost/admin-api');
const { GoogleAuth } = require('google-auth-library');
const Anthropic = require('@anthropic-ai/sdk');
const cheerio = require('cheerio');
const axios = require('axios');
const FormData = require('form-data');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const sharp = require('sharp');
require('dotenv').config();

// ─────────────────────────────────────────────
//  CONFIG — chỉnh ở đây, không sửa code bên dưới
// ─────────────────────────────────────────────
const CONFIG = {
    pin: { width: 1000, height: 1500 },
    content: { targetWords: 900, maxTokens: 8192 },
    batch: { limit: 1 },                    // Số bài xử lý mỗi lần chạy (REWRITE mode)
    create: { limit: 1 },                   // Số keyword xử lý mỗi lần chạy (CREATE mode)
    image: { quality: 98 },
    amazon: { tag: process.env.AMAZON_TAG },
    keywordsFile: './keywords.txt',         // File chứa keyword list cho CREATE mode
    pinterest: {
        siteUrl: 'https://glamgirlshaven.com',
        driveFolder: '1p1_NFTpt-j4XLIHxpgvqL9JHWAXiAi3V',
        sheetId: '1ukj-MajaswMa5gDeUg_JV0jAQ2dgQl7da_JSO22YGuY',
        sheetName: 'AFFILIATE',
        daysBetweenPins: 2,                 // Mỗi pin cách nhau 2 ngày
        postingHour: 9,                     // 9 AM Vietnam = 9 PM EST (US peak Pinterest time)
    },
};

// ─────────────────────────────────────────────
//  API CLIENTS
// ─────────────────────────────────────────────
const ghost = new GhostAdminAPI({
    url: process.env.GHOST_API_URL,
    key: process.env.GHOST_ADMIN_KEY,
    version: 'v5.0'
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
});

// ─────────────────────────────────────────────
//  VERTEX AI / GEMINI CALLER
// ─────────────────────────────────────────────
async function callGemini(systemPrompt, userPrompt, maxTokens = 4096, mimeType = 'application/json') {
    const project = process.env.GOOGLE_PROJECT_ID || 'solar-climber-492410-g1';
    const region = 'us-central1';
    const modelId = 'gemini-2.5-pro';

    const client = await googleAuth.getClient();
    const url = `https://${region}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${region}/publishers/google/models/${modelId}:generateContent`;

    const data = {
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
        contents: [{
            role: 'user',
            parts: [{ text: userPrompt }]
        }],
        generationConfig: {
            maxOutputTokens: maxTokens,
            temperature: 0.7,
            responseMimeType: mimeType
        }
    };

    const res = await client.request({
        url,
        method: 'POST',
        data
    });

    const candidate = res.data.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text || '';
    
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
        console.warn(`[AI] Warning: Gemini finish reason was "${candidate.finishReason}"`);
        // If it truncated, write the full raw response for debugging
        fs.writeFileSync(`./backups/debug-raw-${Date.now()}.json`, JSON.stringify(res.data, null, 2));
    }

    return {
        text,
        usage: {
            input_tokens: Math.ceil((systemPrompt.length + userPrompt.length) / 3.5),
            output_tokens: Math.ceil(text.length / 3.5)
        }
    };
}

// Separate auth instance for Google Workspace APIs (Drive + Sheets)
const googleAuthWorkspace = new GoogleAuth({
    scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/spreadsheets'
    ]
});

// ─────────────────────────────────────────────
//  UTILITY: Ghost JWT — dùng 1 chỗ duy nhất
// ─────────────────────────────────────────────
function generateGhostJWT() {
    const [id, secret] = process.env.GHOST_ADMIN_KEY.split(':');
    return jwt.sign({}, Buffer.from(secret, 'hex'), {
        keyid: id, algorithm: 'HS256', expiresIn: '5m', audience: '/v5.0/admin/'
    });
}

// ─────────────────────────────────────────────
//  BRAND FAVICON — dùng làm avatar trong Tweet layout
// ─────────────────────────────────────────────
let faviconB64 = null; // sẽ populate khi startup
async function loadFavicon() {
    try {
        const res = await axios.get('https://glamgirlshaven.com/public/icon.png', {
            responseType: 'arraybuffer', timeout: 6000
        });
        faviconB64 = `data:image/png;base64,${Buffer.from(res.data).toString('base64')}`;
        console.log('[FAVICON] ✅ Loaded from glamgirlshaven.com/public/icon.png');
    } catch (e) {
        console.log('[FAVICON] ⚠️  Could not load — using letter G fallback:', e.message);
    }
}

// ─────────────────────────────────────────────
//  UTILITY: Safe placeholder replace
//  (tránh bug với $ trong URLs)
// ─────────────────────────────────────────────
function safereplace(html, placeholder, value) {
    return html.split(placeholder).join(value);
}

// ─────────────────────────────────────────────
//  UTILITY: Extract JSON từ AI response
// ─────────────────────────────────────────────
function extractJSON(raw) {
    if (!raw) throw new Error('AI returned empty response');
    let text = raw.replace(/^```(?:json)?\s*/gm, '').replace(/\s*```\s*$/gm, '').trim();
    try { return JSON.parse(text); } catch (_) {}
    
    // Tìm cặp { } đầu tiên và cuối cùng để try parse
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
        try { return JSON.parse(text.substring(start, end + 1)); } catch (_) {}
    }
    throw new Error('Không parse được JSON từ AI response');
}

// ─────────────────────────────────────────────
//  IMAGE: Upload lên Ghost CDN
// ─────────────────────────────────────────────
async function uploadToGhost(imageBuffer, filename) {
    const formData = new FormData();
    formData.append('file', imageBuffer, { filename, contentType: 'image/webp' });
    formData.append('ref', filename);

    const response = await axios.post(
        `${process.env.GHOST_API_URL}/ghost/api/admin/images/upload/`,
        formData,
        { headers: { ...formData.getHeaders(), Authorization: `Ghost ${generateGhostJWT()}` } }
    );
    return response.data.images[0].url;
}

// ─────────────────────────────────────────────
//  IMAGE: Unsplash
// ─────────────────────────────────────────────
async function fetchUnsplash(query, orientation = 'portrait') {
    if (!process.env.UNSPLASH_ACCESS_KEY) return null;
    try {
        const res = await axios.get('https://api.unsplash.com/search/photos', {
            params: { query, orientation, per_page: 5, content_filter: 'high', order_by: 'relevant' },
            headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` }
        });
        const photo = res.data.results?.[0];
        if (!photo) return null;
        const img = await axios.get(photo.urls.regular, { responseType: 'arraybuffer' });
        console.log(`[UNSPLASH] "${photo.alt_description || query}" by ${photo.user.name}`);
        return Buffer.from(img.data);
    } catch (err) {
        console.log(`[UNSPLASH] Failed: ${err.message}`);
        return null;
    }
}

// ─────────────────────────────────────────────
//  IMAGE: Pexels fallback
// ─────────────────────────────────────────────
async function fetchPexels(query, orientation = 'portrait') {
    if (!process.env.PEXELS_API_KEY) return null;
    try {
        const res = await axios.get('https://api.pexels.com/v1/search', {
            params: { query, orientation, per_page: 5 },
            headers: { Authorization: process.env.PEXELS_API_KEY }
        });
        const photo = res.data.photos?.[0];
        if (!photo) return null;
        const imgUrl = orientation === 'portrait' ? photo.src.portrait : photo.src.landscape;
        const img = await axios.get(imgUrl, { responseType: 'arraybuffer' });
        console.log(`[PEXELS] Found: "${photo.alt || query}"`);
        return Buffer.from(img.data);
    } catch (err) {
        console.log(`[PEXELS] Failed: ${err.message}`);
        return null;
    }
}

// ─────────────────────────────────────────────
//  IMAGE: Imagen AI fallback
// ─────────────────────────────────────────────
async function generateImagen(visualPrompt, aspectRatio = '3:4') {
    const safePrompt = `Shot on iPhone 15 Pro, casual handheld photo, ${visualPrompt}, ` +
        `hand partially covering bottles so label is not visible, ` +
        `warm natural window light, authentic real-home environment, ` +
        `UGC aesthetic, slight motion blur, NO readable text, NO legible words`;

    const token = await googleAuth.getAccessToken();
    const res = await axios.post(
        `https://us-central1-aiplatform.googleapis.com/v1/projects/${process.env.GOOGLE_PROJECT_ID}/locations/us-central1/publishers/google/models/imagen-4.0-ultra-generate-001:predict`,
        { instances: [{ prompt: safePrompt }], parameters: { sampleCount: 1, aspectRatio } },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return Buffer.from(res.data.predictions[0].bytesBase64Encoded, 'base64');
}

// ─────────────────────────────────────────────
//  IMAGE: Smart resolver
//  Unsplash → Pexels → Imagen
// ─────────────────────────────────────────────
async function resolveImage(searchQuery, visualPrompt, aspectRatio, filename) {
    const orientMap = { '3:4': 'portrait', '4:3': 'landscape', '1:1': 'squarish' };
    const orientation = orientMap[aspectRatio] || 'landscape';

    // 1. Unsplash
    let buffer = await fetchUnsplash(searchQuery, orientation);

    // 2. Unsplash generic fallback
    if (!buffer) {
        const generic = searchQuery.split(' ').slice(-2).join(' ') + ' luxury';
        console.log(`[IMAGE] Unsplash retry: "${generic}"`);
        buffer = await fetchUnsplash(generic, orientation);
    }

    // 3. Pexels
    if (!buffer) {
        console.log(`[IMAGE] Pexels: "${searchQuery}"`);
        buffer = await fetchPexels(searchQuery, orientation);
    }

    // 4. Imagen
    if (!buffer) {
        console.log(`[IMAGE] Imagen fallback: "${searchQuery}"`);
        buffer = await generateImagen(visualPrompt, aspectRatio);
    }

    const url = await uploadToGhost(buffer, filename);
    console.log(`[IMAGE] ✅ ${filename}`);
    return url;
}

// ─────────────────────────────────────────────
//  HTML BUILDERS
// ─────────────────────────────────────────────
function buildAffiliateBlock(productName, amazonUrl) {
    return `<!--kg-card-begin: html-->
<div style="display:flex;align-items:center;justify-content:space-between;background:#FDFBFB;border:1px solid #F2EBEB;padding:22px 28px;margin:35px 0;width:100%;box-sizing:border-box;border-radius:2px;">
  <span style="font-family:serif;font-size:20px;font-weight:600;color:#4A3F41;flex:1;margin-right:25px;line-height:1.2;">${productName}</span>
  <a href="${amazonUrl}" target="_blank" rel="sponsored noopener noreferrer" style="background:#B5838D;color:#ffffff;padding:12px 24px;font-size:11px;font-family:sans-serif;font-weight:700;text-decoration:none;text-transform:uppercase;letter-spacing:1px;white-space:nowrap;display:inline-flex;align-items:center;">Check Price on Amazon →</a>
</div>
<!--kg-card-end: html-->`;
}

function buildPinterestCTA(pinTitle) {
    return `<!--kg-card-begin: html-->
<div style="background:#FDFBFB;border-left:4px solid #B5838D;padding:24px 28px;margin:40px 0;border-radius:0 8px 8px 0;">
  <p style="font-family:serif;font-size:18px;font-weight:700;color:#4A3F41;margin:0 0 8px 0;">Save this for later ↓</p>
  <p style="font-family:sans-serif;font-size:14px;color:#4A3F41;margin:0 0 4px 0;">Found this helpful? Pin it so you can find it again.</p>
  <p style="font-family:sans-serif;font-size:13px;color:#B5838D;margin:0;font-style:italic;">${pinTitle}</p>
</div>
<!--kg-card-end: html-->`;
}

// ─────────────────────────────────────────────
//  PHASE 1 PROMPT — Metadata + Keyword Strategy
// ─────────────────────────────────────────────
const PROMPT_META = `
You are a senior SEO + Amazon Affiliate strategist for GlamGirls Haven — a Pinterest-first beauty blog targeting American women 25-45.

🎯 GOAL: Every post MUST drive Amazon affiliate clicks. This means:
- ONLY commercial/buyer-intent content ("best X for Y under $Z")
- NEVER pure informational ("how to do X", "what is X")
- Products must be REAL, highly-reviewed items available on Amazon

OUTPUT: STRICTLY valid JSON. No markdown, no preamble.

{
  "target_keyword": "MUST be buyer-intent: 'best [product] for [specific person/problem] [price anchor or qualifier]'. Examples: 'best vitamin c serum for dark spots under 30', 'best long lasting perfume women under 50', 'best drugstore foundation oily skin full coverage'. NEVER generic like 'best moisturizer'.",
  "search_intent": "commercial",
  "seo_title": "55-65 chars. Format: '[Number] Best [Product] for [Problem/Person] [Price] ([Trust Signal])'. The NUMBER in the title MUST match exactly the number of products in the products array. E.g. if you list 4 products, title must say '4 Best...' NOT '7 Best'. E.g. '5 Best Vitamin C Serums Under $30 That Actually Brighten (Tested)'",
  "seo_slug": "url-friendly-slug-with-keyword",
  "meta_description": "155 chars max. Lead with specific benefit + number of products + price anchor. E.g. 'These 5 vitamin C serums under $30 actually fade dark spots in 4 weeks. Derm-tested, honest reviews + comparison table.'",
  "pinterest_description": "150 chars. Pain point hook + what they'll get + 3 niche hashtags. E.g. '✨ Stop wasting money on serums that don't work — these 5 vitamin C picks under $30 actually brighten in 4 weeks #skincare #beautyfinds #serumreview'",
  "hero_search_query": "2-4 concrete nouns for Unsplash. Must be beauty/product related. E.g. 'woman applying serum mirror', 'skincare products flatlay'. Never abstract.",
  "visual_prompt": "Imagen fallback. UGC iPhone style, no readable text. Must show beauty context.",
  "section_images": [
    {
      "placeholder": "{{IMG_SECTION_0}}",
      "search_query": "2-4 concrete Unsplash nouns — different beauty scene from hero",
      "prompt": "Imagen fallback — completely different beauty scene",
      "section_title": "Exact H2 this image goes under",
      "aspect_ratio": "4:3"
    },
    {
      "placeholder": "{{IMG_SECTION_1}}",
      "search_query": "different 2-4 word beauty noun",
      "prompt": "unique beauty scene",
      "section_title": "Exact H2",
      "aspect_ratio": "1:1"
    },
    {
      "placeholder": "{{IMG_SECTION_2}}",
      "search_query": "different beauty noun",
      "prompt": "unique beauty scene",
      "section_title": "Exact H2",
      "aspect_ratio": "4:3"
    }
  ],
  "_note_images": "Exactly 3 section images. Hero + 3 = 4 total. Each must be a completely different scene.",
  "products": [
    {
      "name": "Exact product name e.g. 'TruSkin Vitamin C Serum'",
      "star_rating": "4.5 stars",
      "review_count": "28,400+",
      "price_indicator": "Use: 'Affordable find', 'Mid-level investment', 'Luxury splurge', or 'Drugstore favorite'.",
      "price_anchor": "Use: 'Under $20', 'Around $50'. NEVER use exact '$X.99'.",
      "pros": ["3 specific bullet points about results, texture, or scent"],
      "cons": ["1 honest con e.g. 'Slight medicinal scent'", "1 limitation e.g. 'Rich texture suited for PM'"],
      "placement_hint": "Bridge sentence connecting to this product"
    }
  ],
  "_note_products": "MUST be 3-5 real Amazon bestsellers. Price indicators + anchors are critical for conversion."
}
`;

// ─────────────────────────────────────────────
//  PHASE 2 PROMPT — Content (800-1000 words)
// ─────────────────────────────────────────────
const PROMPT_HTML = `
You are Sarah Mitchell, Beauty Editor at GlamGirls Haven — a Pinterest-first beauty affiliate blog for American women 25-45.

🎯 PRIMARY GOAL: Drive Amazon affiliate clicks. Every section must move the reader toward a PURCHASE DECISION.

CRITICAL: Target 800-1000 words ONLY. Pinterest readers scan fast — short, punchy, scannable.

OUTPUT: Raw HTML only. Start with <h1>. Nothing else before or after.
CRITICAL HTML RULE: EVERY single paragraph of text MUST be wrapped in <p>...</p> tags. Do NOT output raw floating text without a tag.

════════════════════════════
CONTENT TYPE (non-negotiable)
════════════════════════════
This is a PRODUCT RECOMMENDATION post, NOT an educational article.
- DO: Compare products, give verdicts, include prices, mention review counts
- DO: Say "I tested this", "After 2 weeks I noticed", "The honest con is..."
- DO NOT: Write generic how-to content or explain what ingredients are
- DO NOT: Write "in this article we will explore" or any corporate filler

════════════════════════════
KEYWORD RULES (non-negotiable)
════════════════════════════
- Target keyword MUST appear in: H1, first 100 words, at least 1 H2
- Use keyword naturally — not stuffed
- LSI keywords (related phrases) in other H2s

════════════════════════════
STRUCTURE (follow exactly)
════════════════════════════

<h1>[SEO title from metadata — must contain keyword, must have a number]</h1>

<!--kg-card-begin: html-->
<p style='font-family:sans-serif;font-size:12px;color:#7A6B6E;margin:0 0 24px 0;font-style:italic;line-height:1.5;'>As an Amazon Associate, GlamGirls Haven earns from qualifying purchases. We only recommend products with strong review data and proven results. Prices and availability are subject to change.</p>
<!--kg-card-end: html-->

<!--kg-card-begin: html-->
<div style='background:#FDFBFB;border:1px solid #F2EBEB;padding:18px 22px;margin:20px 0;border-radius:4px;'>
  <p style='font-family:sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#B5838D;margin:0 0 10px 0;'>Quick Picks</p>
  <ul style='margin:0;padding-left:16px;font-family:sans-serif;font-size:14px;color:#4A3F41;line-height:1.9;'>
    [Write ONE <li> per product from the metadata products array. Format: <li><strong>[Product name]</strong> — [one-line verdict with price anchor + star rating ⭐]</li>. Include ALL products, not just 3.]
  </ul>
</div>
<!--kg-card-end: html-->

<p>[HOOK PARAGRAPH 1: The exact frustration this reader has RIGHT NOW (specific, not generic). E.g. "Most vitamin C serums oxidize within a month and smell like metal — yet they still charge you $80 for it."]</p>
<p>[HOOK PARAGRAPH 2: What this post gives them + your credibility. E.g. "I tested 12 serums over 6 weeks. These 5 are the only ones worth your money — all under $30." NO "Are you..." openers. NO corporate intros.]</p>

<figure class='kg-card kg-image-card'><img src='{{IMG_HERO}}' class='kg-image' alt='[keyword-rich descriptive alt text]'></figure>

<h2>[products[0].name]: [Verdict in 4-6 words]</h2>
<p>[PARAGRAPH 1: High-end editorial breakdown. Specific texture/result detail. Mention 1 key ingredient.]</p>

<!--kg-card-begin: html-->
<div style='margin:18px 0;padding:15px;background:#FDFBFB;border:1px solid #F2EBEB;border-radius:4px;'>
  <div style='display:flex;gap:20px;'>
    <div style='flex:1;'>
      <p style='font-family:sans-serif;font-size:12px;font-weight:700;color:#2D6A4F;margin:0 0 8px 0;'>THE PROS</p>
      <ul style='margin:0;padding-left:14px;font-family:sans-serif;font-size:13px;color:#4A3F41;line-height:1.5;'>
        [3 bullet points from metadata.pros]
      </ul>
    </div>
    <div style='flex:1;'>
      <p style='font-family:sans-serif;font-size:12px;font-weight:700;color:#9B2226;margin:0 0 8px 0;'>THE CONS</p>
      <ul style='margin:0;padding-left:14px;font-family:sans-serif;font-size:13px;color:#4A3F41;line-height:1.5;'>
        [2 bullet points from metadata.cons]
      </ul>
    </div>
  </div>
</div>
<!--kg-card-end: html-->

<p><strong>Verdict:</strong> [Final 1-sentence decision on who this is for + price_indicator/anchor info.]</p>
<p>[1-sentence social proof for products[0]: star rating + review count]</p>
{{AFFILIATE_BLOCK_0}}

<h2>[products[1].name]: [Verdict in 4-6 words]</h2>
<figure class='kg-card kg-image-card'><img src='{{IMG_SECTION_0}}' class='kg-image' alt='[relevant alt]'></figure>
<p>[PARAGRAPH 1: Editorial breakdown — authentic, insider feel.]</p>

<!--kg-card-begin: html-->
<div style='margin:18px 0;padding:15px;background:#FDFBFB;border:1px solid #F2EBEB;border-radius:4px;'>
  <div style='display:flex;gap:20px;'>
    <div style='flex:1;'>
      <p style='font-family:sans-serif;font-size:12px;font-weight:700;color:#2D6A4F;margin:0 0 8px 0;'>THE PROS</p>
      <ul style='margin:0;padding-left:14px;font-family:sans-serif;font-size:13px;color:#4A3F41;line-height:1.5;'>
        [Pros for products[1]]
      </ul>
    </div>
    <div style='flex:1;'>
      <p style='font-family:sans-serif;font-size:12px;font-weight:700;color:#9B2226;margin:0 0 8px 0;'>THE CONS</p>
      <ul style='margin:0;padding-left:14px;font-family:sans-serif;font-size:13px;color:#4A3F41;line-height:1.5;'>
        [Cons for products[1]]
      </ul>
    </div>
  </div>
</div>
<!--kg-card-end: html-->

<p><strong>Verdict:</strong> [Final recommendation sentence]</p>
<p>[1-sentence social proof]</p>
{{AFFILIATE_BLOCK_1}}

<h2>How to Choose: [Product Category] Comparison</h2>
<figure class='kg-card kg-image-card'><img src='{{IMG_SECTION_1}}' class='kg-image' alt='[relevant alt]'></figure>

<!--kg-card-begin: html-->
<div style='width:100%;overflow-x:auto;margin:20px 0;border:1px solid #F2EBEB;border-radius:8px;'>
  <table style='width:100%;min-width:540px;border-collapse:collapse;font-family:sans-serif;font-size:13px;text-align:left;'>
    <thead>
      <tr style='background:#F9F4F5;'>
        <th style='padding:12px 16px;color:#4A3F41;font-weight:700;border-bottom:2px solid #E5D5D8;'>Product</th>
        <th style='padding:12px 16px;color:#4A3F41;font-weight:700;border-bottom:2px solid #E5D5D8;'>Best For</th>
        <th style='padding:12px 16px;color:#4A3F41;font-weight:700;border-bottom:2px solid #E5D5D8;'>Rating</th>
        <th style='padding:12px 16px;color:#4A3F41;font-weight:700;border-bottom:2px solid #E5D5D8;'>Price</th>
        <th style='padding:12px 16px;color:#4A3F41;font-weight:700;border-bottom:2px solid #E5D5D8;'>Verdict</th>
      </tr>
    </thead>
    <tbody>
      [Fill in one <tr> per product with real data from metadata]
    </tbody>
  </table>
</div>
<!--kg-card-end: html-->

<h2>[Pro Tips / How to Get the Most Out of These / Mistakes to Avoid]</h2>
<figure class='kg-card kg-image-card'><img src='{{IMG_SECTION_2}}' class='kg-image' alt='[relevant alt]'></figure>
<p>[1 short intro sentence]</p>
<ol>
  <li><strong>[Specific actionable tip]:</strong> [1-2 sentences with a real, specific detail]</li>
  <li><strong>[Specific actionable tip]:</strong> [1-2 sentences]</li>
  <li><strong>[Specific actionable tip]:</strong> [1-2 sentences]</li>
</ol>

<!--kg-card-begin: html-->
<div style='background:#F9F4F5;border-left:4px solid #B5838D;padding:18px 22px;margin:28px 0;border-radius:0 8px 8px 0;'>
  <p style='font-family:sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#B5838D;margin:0 0 8px 0;'>Bottom Line</p>
  <p style='font-family:sans-serif;font-size:14px;color:#4A3F41;margin:0;line-height:1.7;'>[2 sentences. Lead with the best pick + why. End with an honest caveat or who shouldn't bother. NO hype words like "amazing" or "game-changer".]</p>
</div>
<!--kg-card-end: html-->

<p>[1 sentence social proof for products[2]: star rating + review count]</p>
{{AFFILIATE_BLOCK_2}} <!--← THIS BLOCK IS FOR products[2] ONLY-->

<h2>Frequently Asked Questions</h2>
<h3>[Real question from Google's People Also Ask for this topic — must be specific]</h3>
<p>[2-3 sentence direct answer. No padding.]</p>
<h3>[Second specific question]</h3>
<p>[Answer]</p>
<h3>[Third specific question]</h3>
<p>[Answer]</p>

{{PINTEREST_CTA}}

<p>[EDITOR'S CLOSING NOTE — 2 sentences. Give one final piece of grounded, insider advice. E.g. "At the end of the day, the best SPF is the one you actually look forward to wearing. Find your formula, wait for the set-up, and just glow with it." NO "Imagine your skin" or infomercial sến patterns. Talk like a real NYC beauty editor.]</p>

════════════════════════════
AMAZON AFFILIATE COMPLIANCE RULES (STRICT)
════════════════════════════
- ABSOLUTELY NO EXACT PRICES: Prices on Amazon change constantly. Never write "$19.99". You MUST use "under $20", "around $50", or more descriptive price indicators like "drugstore favorite" or "luxury splurge".
- NO REVIEW COPY/PASTING: Do not copy verbatim customer reviews. Synthesize them in your own words (e.g., "Many reviewers note that...").
- NO TRADEMARK INFRINGEMENT: Do NOT use phrases like "Amazon's Choice", "Amazon Best Seller", or "Prime delivery". Use generic terms like "Highly rated", "Cult-favorite", or "Top-rated".

════════════════════════════
VOICE & UX RULES (non-negotiable)
════════════════════════════
- Warm, direct, knowledgeable best friend — NOT corporate, NOT a listicle robot.
- First person required: "I tested this for 3 weeks", "I bought 8 serums so you don't have to".
- CRITICAL FOR SCANNERS: Every product MUST have dedicated Pros/Cons blocks using the provided HTML templates.
- Social proof before EVERY affiliate block: star rating + review count + price anchor.
- FORBIDDEN: "Click here", "Buy now", "amazing", "game-changer", "in this article", "imagine your skin".
- ALLOWED: "Check current price", "See on Amazon", "worth every penny", "skip it if...".
`;

// ─────────────────────────────────────────────
//  PINTEREST PIN PROMPT
// ─────────────────────────────────────────────
const PROMPT_PINS = `
You are a Pinterest viral content strategist for GlamGirls Haven beauty blog.

TASK: Read the blog post and output a JSON array of exactly 5 pins.

🚨 CRITICAL IMAGE RULES (most important):
1. search_queries MUST match the EXACT product/topic of this post — always include the product category word.
2. NO generic lifestyle. NO food. NO faces. NO emotions. Product-centric only.
3. Every search_query MUST be specific. E.g. if the post is about 'eye cream', queries should be ["eye cream tube", "skincare flatlay luxury", "under eye serum", "beauty product aesthetic"].
4. Provide 4 search_queries per pin (most specific → most generic) as fallback options.
5. image_prompt must NOT describe readable text, brand names, or labels.

🎯 HOOK RULES (READ CAREFULLY):
6. Every hook_title MUST mention the SPECIFIC product category (serum, mascara, sunscreen, etc.) or specific problem.
7. BAD: 'The beauty secret no one tells you' → FORBIDDEN.
8. GOOD: 'Your sunscreen is aging you faster' / 'This mascara beats Charlotte Tilbury'.
9. NEVER use double quotes (") inside values — use single quotes (') instead.

OUTPUT: Single JSON array. No preamble, no markdown.

[
  {
    "type": "A..E",
    "board": "[board name from list]",
    "hook_title": "5-7 word attention-grabbing title",
    "description": "150-200 char description with specific keywords",
    "keywords": "10-15 long-tail Pinterest keywords",
    "image_prompt": "UGC iPhone style beauty product visual — NO people, NO food",
    "search_queries": ["q1", "q2", "q3", "q4"],
    "cta_text": "SEE THE FIX"
  }
]

CONTENT MIX: A: Pain Point, B: Aesthetic Goal, C: Mistake/Warning, D: Secret Find/Dupe, E: Exact Routine.
BOARDS: MUST CHOOSE EXACTLY ONE OF THESE: Skincare Tips & Routine for Glowing Skin | Ultimate Makeup Ideas: Glam & Natural Looks | Nail Art Inspiration | Self-Love, Mindfulness & Daily Wellness Rituals | Beauty Tips & Hacks | Outfits Idea | Trendy Hairstyles & Haircare for Women | Fragrance & Body | Gift Guides
`;


// ─────────────────────────────────────────────
//  CONTENT QUALITY CHECK
// ─────────────────────────────────────────────
function checkQuality(html, keyword) {
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const words = text.split(' ').length;

    // Fuzzy keyword match: ít nhất 60% words của keyword xuất hiện trong content
    const kwWords = keyword.toLowerCase().split(' ').filter(w => w.length > 2 && !['for','and','the','with','that','from','under'].includes(w));
    const matchedKwWords = kwWords.filter(w => text.includes(w));
    const kwMatchRatio = kwWords.length > 0 ? matchedKwWords.length / kwWords.length : 0;
    const hasKeyword = kwMatchRatio >= 0.6;

    const hasAffiliateBlocks = (html.match(/AFFILIATE_BLOCK/g) || []).length;
    const hasImages = (html.match(/IMG_SECTION/g) || []).length;
    const hasDisclosure = html.includes('Amazon Associate');
    const hasPriceForbidden = /\$\d+\.\d{2}/.test(html); // exact price like $19.99

    console.log(`\n[QUALITY CHECK]`);
    console.log(`  Words:        ${words} (target: 800-1000)`);
    console.log(`  Keyword:      ${hasKeyword ? '✅' : '⚠️  LOW'} "${keyword}" (${Math.round(kwMatchRatio*100)}% match)`);
    console.log(`  Affiliate:    ${hasAffiliateBlocks} blocks`);
    console.log(`  Images:       ${hasImages} section placeholders`);
    console.log(`  Disclosure:   ${hasDisclosure ? '✅ Present' : '❌ MISSING — FTC violation!'}`);
    console.log(`  Exact Prices: ${hasPriceForbidden ? '❌ FOUND (e.g. $19.99) — Amazon violation!' : '✅ Clean'}`);

    if (words < 600) console.warn(`  ⚠️  Content quá ngắn (${words} words)`);
    if (words > 1200) console.warn(`  ⚠️  Content quá dài (${words} words)`);
    if (!hasKeyword) console.warn(`  ⚠️  Keyword coverage thấp — SEO sẽ kém`);
    if (hasAffiliateBlocks < 2) console.warn(`  ⚠️  Ít affiliate blocks quá`);
    if (!hasDisclosure) console.warn(`  🚨 FTC/Amazon: Thiếu disclosure!`);
    if (hasPriceForbidden) console.warn(`  🚨 Amazon policy: Có giá cố định (format $XX.XX)!`);

    return { words, hasKeyword, hasAffiliateBlocks, hasDisclosure, hasPriceForbidden };
}

// ─────────────────────────────────────────────
//  MAIN PIPELINE
// ─────────────────────────────────────────────
async function processPost(post) {
    console.log(`\n${'═'.repeat(55)}`);
    console.log(`[START] "${post.title}"`);
    console.log(`${'═'.repeat(55)}`);

    // Ensure backup dir exists
    if (!fs.existsSync('./backups')) fs.mkdirSync('./backups');

    // Clean HTML → plain text (tiết kiệm ~40% tokens)
    const $ = cheerio.load(post.html || '');
    $('img, script, style, iframe').remove();
    const plainText = $('body').text().replace(/\s+/g, ' ').trim();
    console.log(`[TEXT] ~${plainText.length} chars → ~${Math.round(plainText.length / 4)} tokens`);

    // ── PHASE 1: Metadata + Keyword ──────────────
    console.log(`\n[AI] Phase 1: Metadata & keyword strategy (Gemini)...`);
    const metaRes = await callGemini(
        PROMPT_META,
        `Analyze this post and generate metadata JSON with keyword strategy.\n\nCONTENT:\n${plainText}`,
        8192
    );

    let meta;
    try {
        meta = extractJSON(metaRes.text);
    } catch (e) {
        fs.writeFileSync(`./backups/error-meta-${Date.now()}.txt`, metaRes.text);
        throw new Error(`Phase 1 JSON parse failed: ${e.message}`);
    }

    console.log(`[META] Keyword: "${meta.target_keyword}"`);
    console.log(`[META] Intent:  ${meta.search_intent}`);
    console.log(`[META] Title:   ${meta.seo_title}`);

    // ── PHASE 2: HTML Content ─────────────────────
    console.log(`\n[AI] Phase 2: Writing ${CONFIG.content.targetWords}-word content (Gemini)...`);
    const htmlRes = await callGemini(
        PROMPT_HTML,
        `Write an 800-1000 word blog post...`,
        CONFIG.content.maxTokens,
        'text/plain'
    );

    let html = htmlRes.text
        .replace(/^```(?:html)?\s*/m, '')
        .replace(/\s*```\s*$/m, '')
        .trim();

    // Cost tracking (Free via GCP Credits)
    const inputTokens = metaRes.usage.input_tokens + htmlRes.usage.input_tokens;
    const outputTokens = metaRes.usage.output_tokens + htmlRes.usage.output_tokens;
    console.log(`\n[CREDITS] Bào thành công ~${inputTokens + outputTokens} tokens Google Cloud Free Trial`);
    console.log(`[TOKEN] Input: ${inputTokens} | Output: ${outputTokens}`);

    // Quality check
    checkQuality(html, meta.target_keyword);

    // Backup
    const backupData = { meta, html, timestamp: new Date().toISOString() };
    const backupFile = `./backups/backup-${post.id}-${Date.now()}.json`;
    fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
    console.log(`[BACKUP] ${backupFile}`);

    // ── IMAGES ────────────────────────────────────
    const sectionImages = (meta.section_images || []).slice(0, 3);
    const ts = Date.now();
    console.log(`\n[IMAGE] Resolving ${1 + sectionImages.length} images...`);

    const [heroUrl, ...sectionUrls] = await Promise.all([
        resolveImage(meta.hero_search_query, meta.visual_prompt, '3:4', `glamgirls-hero-${ts}.webp`),
        ...sectionImages.map((si, i) =>
            resolveImage(
                si.search_query || si.section_title,
                si.prompt,
                si.aspect_ratio || (i % 2 === 0 ? '4:3' : '1:1'),
                `glamgirls-section-${i}-${ts}.webp`
            )
        )
    ]);

    // ── INJECT PLACEHOLDERS ───────────────────────
    html = safereplace(html, '{{IMG_HERO}}', heroUrl);
    sectionImages.forEach((si, i) => {
        if (sectionUrls[i]) {
            const key = si.placeholder.replace(/[{}]/g, '');
            html = safereplace(html, `{{${key}}}`, sectionUrls[i]);
        }
    });

    // Cleanup unreplaced image placeholders
    html = html.replace(/\{\{IMG_SECTION_\d+\}\}/g, '');

    // Affiliate blocks
    const products = meta.products || [];
    products.forEach((product, i) => {
        const url = `https://www.amazon.com/s?k=${encodeURIComponent(product.name)}&tag=${CONFIG.amazon.tag}`;
        html = safereplace(html, `{{AFFILIATE_BLOCK_${i}}}`, buildAffiliateBlock(product.name, url));
    });

    // Last affiliate block = last product
    if (products.length > 0) {
        const last = products[products.length - 1];
        const lastUrl = `https://www.amazon.com/s?k=${encodeURIComponent(last.name)}&tag=${CONFIG.amazon.tag}`;
        html = safereplace(html, '{{AFFILIATE_BLOCK_LAST}}', buildAffiliateBlock(last.name, lastUrl));
    }

    // Pinterest CTA
    html = safereplace(html, '{{PINTEREST_CTA}}', buildPinterestCTA(meta.seo_title));

    // Cleanup remaining placeholders
    html = html.replace(/\{\{AFFILIATE_BLOCK_[^}]+\}\}/g, '');

    console.log(`[IMAGE] Hero: ${heroUrl}`);
    sectionUrls.forEach((u, i) => console.log(`[IMAGE] Section ${i}: ${u}`));

    // ── PUSH TO GHOST ─────────────────────────────
    const latestPost = await ghost.posts.read({ id: post.id });
    const lexical = JSON.stringify({
        root: {
            children: htmlToLexical(html),
            direction: null, format: '', indent: 0, type: 'root', version: 1
        }
    });

    await axios.put(
        `${process.env.GHOST_API_URL}/ghost/api/admin/posts/${latestPost.id}/`,
        {
            posts: [{
                id: latestPost.id,
                updated_at: latestPost.updated_at,
                lexical,
                title: meta.seo_title,
                slug: meta.seo_slug,
                meta_title: meta.seo_title,
                meta_description: meta.meta_description,
                og_title: meta.seo_title,
                og_description: meta.pinterest_description,
                twitter_title: meta.seo_title,
                twitter_description: meta.meta_description,
                status: 'draft'
            }]
        },
        { headers: { Authorization: `Ghost ${generateGhostJWT()}`, 'Content-Type': 'application/json' } }
    );

    console.log(`\n[✅] "${meta.seo_title}" saved as draft`);
    console.log(`[SEO] Slug: /${meta.seo_slug}`);
    console.log(`[SEO] Keyword: "${meta.target_keyword}"`);

    // ── PINTEREST PINS ────────────────────────────
    await generatePins(meta, html, meta.seo_slug);
}

// ─────────────────────────────────────────────
//  PINTEREST PIN GENERATOR
// ─────────────────────────────────────────────

// Layout màp theo pin type — không random nữa
// A (Pain Point)    → 0: Classic Editorial (dark gradient, serif — dramatic & editorial)
// B (Aesthetic Goal) → 3: Minimalist Bottom Block (clean, luxury — aspirational)
// C (Mistake/Warning)→ 4: Viral Quote (dark center banner — warning/attention-grabbing)
// D (Dupe/Find)      → 6: Search Bar ("TOP RESULT" — perfect for discovery angle)
// E (Exact Routine)  → 5: Tweet Style (personal, relatable — feels like a real recommendation)
const PIN_TYPE_LAYOUT = { A: 0, B: 3, C: 4, D: 6, E: 5 };

// Bộ keyword beauty — dùng để filter Unsplash results
const BEAUTY_KEYWORDS = [
    'perfume', 'fragrance', 'scent', 'parfum',
    'serum', 'skincare', 'moisturizer', 'cream', 'lotion', 'toner',
    'makeup', 'foundation', 'lipstick', 'mascara', 'blush', 'eyeshadow',
    'beauty', 'cosmetic', 'product', 'bottle', 'jar', 'tube',
    'flatlay', 'vanity', 'skincare routine', 'face', 'glow',
    'nail', 'hair', 'gift', 'skincare', 'self-care',
];

// Fetch Unsplash cho pin — có beauty filter
async function fetchUnsplashPin(queries) {
    for (const query of queries) {
        try {
            const res = await axios.get('https://api.unsplash.com/search/photos', {
                params: { query, orientation: 'portrait', per_page: 20, content_filter: 'high', order_by: 'relevant' },
                headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` }
            });
            const results = res.data.results || [];

            // Score mỗi ảnh: ưu tiên ảnh beauty nhất, tránh ảnh người/mặt
            const AVOID_KEYWORDS = ['face', 'woman', 'girl', 'man', 'person', 'people', 'portrait', 'smile', 'injury', 'wound', 'skin rash'];
            const scored = results.map(p => {
                const desc = (p.alt_description || p.description || '').toLowerCase();
                let score = 0;
                BEAUTY_KEYWORDS.forEach(kw => { if (desc.includes(kw)) score += 2; });
                AVOID_KEYWORDS.forEach(kw => { if (desc.includes(kw)) score -= 3; });
                return { p, score };
            }).sort((a, b) => b.score - a.score);

            // Chỉ dùng ảnh có score >= 0 — nếu không, thử query tiếp theo
            const best = scored[0];
            if (!best || best.score < 0) {
                console.log(`   [UNSPLASH] "${query}" — no quality beauty image (best score: ${best?.score ?? 'N/A'}), trying next query...`);
                continue;
            }

            const img = await axios.get(best.p.urls.regular, { responseType: 'arraybuffer' });
            console.log(`   [UNSPLASH] "${best.p.alt_description || query}" by ${best.p.user.name} (score: ${best.score})`);
            return Buffer.from(img.data);
        } catch (e) {
            console.log(`   [UNSPLASH] "${query}" failed: ${e.message}`);
        }
    }
    return null;
}

async function generatePins(meta, html, slug) {
    console.log(`\n[PINTEREST] Generating 5 pins...`);

    let pinsData;
    try {
        const category = meta.target_keyword.split(' ').slice(1, 3).join(' ');
        const userPrompt = `Blog title: ${meta.seo_title}\nTarget keyword: ${meta.target_keyword}\nCategory: ${category}\n\nContent (first 4000 chars):\n${html.substring(0, 4000)}`;
        
        const pinRes = await callGemini(PROMPT_PINS, userPrompt, 8192, 'application/json');
        pinsData = extractJSON(pinRes.text);
    } catch (err) {
        console.error(`[PINTEREST] ❌ Pin generation failed: ${err.message}`);
        return;
    }

    const ts = Date.now();
    const brandedBuffers = []; // collect pin buffers for Drive upload

    // Process each pin individually with error isolation
    for (let i = 0; i < pinsData.length; i++) {
        const pin = pinsData[i];
        try {
            // Layout theo type — không random
            const pinTypeLetter = (pin.type || 'A').charAt(0).toUpperCase();
            const layoutIndex = PIN_TYPE_LAYOUT[pinTypeLetter] ?? i;
            console.log(`[PIN ${i + 1}] Type:${pinTypeLetter} Layout:${layoutIndex} — "${pin.hook_title}"`);

            // Background image — dùng search_queries array (3 fallback) nếu có, fallback search_query cũ
            const queries = Array.isArray(pin.search_queries) && pin.search_queries.length > 0
                ? pin.search_queries
                : [pin.search_query || pin.hook_title];

            let bgBuffer = await fetchUnsplashPin(queries);
            if (!bgBuffer) {
                console.log(`   [PEXELS] fallback...`);
                bgBuffer = await fetchPexels(queries[0], 'portrait');
            }
            if (!bgBuffer) {
                console.log(`   [IMAGEN] fallback...`);
                bgBuffer = await generateImagen(pin.image_prompt, '3:4');
            }

            const branded = await createBrandedPin(bgBuffer, pin.hook_title, pin.cta_text, layoutIndex);
            const pinSlug = pin.hook_title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
            const filename = `./backups/${slug}-pin${i + 1}-${pinSlug}-${ts}.webp`;
            fs.writeFileSync(filename, branded);
            brandedBuffers.push({ buffer: branded, filename: `${slug}-pin${i + 1}-${pinSlug}.webp`, pin });
            console.log(`[PIN ${i + 1}] ✅ ${filename}`);

        } catch (pinErr) {
            // Per-pin error isolation — 1 pin fail không crash toàn bộ
            console.error(`[PIN ${i + 1}] ❌ Failed: ${pinErr.message}`);
        }
    }

    // Save pin metadata (descriptions, hashtags, boards)
    fs.writeFileSync(
        `./backups/pins-${slug}-${ts}.json`,
        JSON.stringify(pinsData, null, 2)
    );
    console.log(`[PINTEREST] Pin metadata saved → ./backups/pins-${slug}-${ts}.json`);

    // ── Auto-upload to Google Drive + schedule in Google Sheet ──
    const postUrl = `${CONFIG.pinterest.siteUrl}/${slug}/`;
    try {
        await uploadAndSchedulePins(brandedBuffers, pinsData, postUrl);
    } catch (err) {
        console.error(`[SHEET] ❌ Drive/Sheet pipeline failed: ${err.message}`);
        console.log(`[SHEET] Pins đã lưu local tại ./backups/ — upload thủ công nếu cần`);
    }
}

// ─────────────────────────────────────────────
//  IMGBB UPLOAD
// ─────────────────────────────────────────────
async function uploadToImgbb(buffer, filename) {
    const base64Image = buffer.toString('base64');
    const params = new URLSearchParams();
    params.append('key', process.env.IMGBB_API_KEY);
    params.append('image', base64Image);
    params.append('name', filename);

    const res = await axios.post('https://api.imgbb.com/1/upload', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        maxBodyLength: Infinity
    });

    return res.data.data.url;
}

// ─────────────────────────────────────────────
//  UPLOAD + SCHEDULE IN GOOGLE SHEET
// ─────────────────────────────────────────────
async function uploadAndSchedulePins(brandedBuffers, pinsData, postUrl) {
    if (!brandedBuffers.length) return;

    console.log(`\n[IMGBB] Uploading ${brandedBuffers.length} pins to ImgBB...`);
    const mediaLinks = [];

    for (let i = 0; i < brandedBuffers.length; i++) {
        const { buffer, filename } = brandedBuffers[i];
        try {
            const link = await uploadToImgbb(buffer, filename);
            mediaLinks.push(link);
            console.log(`[IMGBB] Pin ${i + 1} ✅ ${link}`);
        } catch (e) {
            mediaLinks.push('');
            console.error(`[IMGBB] Pin ${i + 1} ❌ ${e.response?.data?.error?.message || e.message}`);
        }
    }

    // ── Append rows to Google Sheet with auto-scheduled dates ──
    console.log(`\n[SHEET] Scheduling ${pinsData.length} pins in Google Sheet...`);
    const token = await googleAuthWorkspace.getAccessToken();

    // Pin 1 = tomorrow, pin 2 = +2 ngày, pin 3 = +4 ngày, ...
    const startDate = new Date();
    startDate.setDate(startDate.getDate() + 1);
    startDate.setHours(CONFIG.pinterest.postingHour, 0, 0, 0);

    const pad = n => String(n).padStart(2, '0');

    const rows = pinsData.map((pin, i) => {
        let dateStr;
        if (i === 0) {
            const pinDate = new Date(startDate);
            dateStr = `${pinDate.getFullYear()}-${pad(pinDate.getMonth() + 1)}-${pad(pinDate.getDate())} ${pad(pinDate.getHours())}:00:00`;
        } else {
            // Formula to dynamically add days depending on the row above
            dateStr = `=INDIRECT("F"&ROW()-1) + ${CONFIG.pinterest.daysBetweenPins}`;
        }

        const keywords = pin.keywords || (pin.description || '').match(/#\w+/g)?.map(t=>t.replace('#','')).join(', ') || '';

        return [
            pin.hook_title  || '',   // A: Title
            pin.description || '',   // B: Description
            postUrl,                 // C: Link
            mediaLinks[i]   || '',   // D: Media URL (ImgBB)
            pin.board       || '',   // E: Board
            dateStr,                 // F: Scheduled date
            keywords                 // G: Keywords
        ];
    });

    await axios.post(
        `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.pinterest.sheetId}/values/${encodeURIComponent(CONFIG.pinterest.sheetName)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { values: rows },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    console.log(`\n[SHEET] ✅ ${rows.length} pins scheduled:`);
    rows.forEach((r, i) => {
        const urlOk = r[3] ? '✅' : '⚠️ ';
        console.log(`  Pin ${i + 1}: "${r[0].substring(0, 40)}" → ${r[5]}  ${urlOk}`);
    });
}


// ─────────────────────────────────────────────
//  PIN DESIGNER — 8 layouts
// ─────────────────────────────────────────────
async function createBrandedPin(bgBuffer, title, cta, layoutIndex = 0) {
    const { width, height } = CONFIG.pin;

    const words = title.toUpperCase().split(' ');
    const charLimit = 16;

    function wrapWords(wordList, limit) {
        const lines = [];
        let cur = '';
        wordList.forEach(w => {
            if ((cur + w).length > limit && cur !== '') {
                lines.push(cur.trim());
                cur = w + ' ';
            } else {
                cur += w + ' ';
            }
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
    const ctaW = Math.max(460, cta.length * 22 + 160);
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
        // Tape / Center Highlight — alternating rotated blocks
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
        // Tweet / Threads Style — white card anchored at fixed Y (not floating)
        let fs = Math.min(72, Math.floor(680 / (maxLen * 0.58)));
        let ls = Math.floor(fs * 1.28);
        const tbH = finalLines.length * ls;
        const cardW = 860;
        const cardX = (width - cardW) / 2;
        // Card anchored at 1/3 from top — not vertically centered
        const cardY = 280;
        const headerH = 120;
        const textPadding = 50;
        const cardH = headerH + tbH + textPadding * 2 + 20;

        // Avatar: favicon or letter G fallback
        const avatarR = 38;
        const avatarCX = cardX + 65;
        const avatarCY = cardY + 62;
        const avatarBlock = faviconB64
            ? `<defs><clipPath id="avc"><circle cx="${avatarCX}" cy="${avatarCY}" r="${avatarR}"/></clipPath></defs>
               <circle cx="${avatarCX}" cy="${avatarCY}" r="${avatarR}" fill="#F5F0EB"/>
               <image href="${faviconB64}" x="${avatarCX - avatarR}" y="${avatarCY - avatarR}" width="${avatarR * 2}" height="${avatarR * 2}" clip-path="url(#avc)"/>`
            : `<circle cx="${avatarCX}" cy="${avatarCY}" r="${avatarR}" fill="#F5F0EB"/>
               <text x="${avatarCX}" y="${avatarCY + 12}" text-anchor="middle" style="fill:#B5838D;font-family:'Avenir Next',sans-serif;font-size:32px;font-weight:bold;">G</text>`;

        svg = `<svg width="${width}" height="${height}">
            <rect width="${width}" height="${height}" fill="black" fill-opacity="0.22"/>
            <!-- White card — anchored at top third -->
            <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="20" fill="white" filter="drop-shadow(0px 12px 28px rgba(0,0,0,0.22))"/>
            <!-- Avatar -->
            ${avatarBlock}
            <!-- Author info -->
            <text x="${cardX + 120}" y="${cardY + 52}" style="fill:#1A1A1A;font-family:'Helvetica Neue',sans-serif;font-size:26px;font-weight:700;">GlamGirls Haven</text>
            <text x="${cardX + 120}" y="${cardY + 84}" style="fill:#657786;font-family:'Helvetica Neue',sans-serif;font-size:22px;">@glamgirlshaven</text>
            <!-- Divider line -->
            <line x1="${cardX + 30}" y1="${cardY + headerH}" x2="${cardX + cardW - 30}" y2="${cardY + headerH}" stroke="#F0E8E8" stroke-width="1"/>
            <!-- Hook text — left-aligned, inside card -->
            <g transform="translate(${cardX + textPadding},${cardY + headerH + textPadding + fs * 0.85})">
                ${finalLines.map((l, i) => `<text y="${i * ls}" style="fill:#1A1A1A;font-family:'Helvetica Neue',sans-serif;font-size:${fs}px;font-weight:800;">${l}</text>`).join('')}
            </g>
            <!-- CTA button — outside card, at bottom -->
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

    // ── Color Grading Pipeline — make any Unsplash photo look cinematic ──
    // 1. Resize to pin dimensions
    // 2. Boost saturation + warm tint (beauty aesthetic)
    // 3. Add contrast + slight sharpening
    // 4. Composite SVG text overlay
    const gradedBuffer = await sharp(bgBuffer)
        .resize(width, height, { fit: 'cover', position: 'center' })
        // Boost saturation & warmth: modulate(brightness, saturation, hue)
        .modulate({ brightness: 1.05, saturation: 1.35, hue: 8 })
        // Add contrast with linear levels
        .linear(1.08, -(0.08 * 255))
        // Subtle sharpen for crispness
        .sharpen({ sigma: 0.6, m1: 0.5, m2: 0.2 })
        .toBuffer();

    return await sharp(gradedBuffer)
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .webp({ quality: CONFIG.image.quality, effort: 6 })
        .toBuffer();
}

// ─────────────────────────────────────────────
//  HTML → LEXICAL CONVERTER
// ─────────────────────────────────────────────
function applyFmt(nodes, bit) {
    return nodes.map(n => {
        if (n.type === 'text') return { ...n, format: (n.format || 0) | bit };
        if (n.type === 'link') return { ...n, children: applyFmt(n.children, bit) };
        return n;
    });
}

function inlineToLexical($, $el) {
    const children = [];
    $el.contents().each((_, node) => {
        if (node.type === 'text') {
            const text = $(node).text();
            if (text) children.push({ type: 'text', detail: 0, format: 0, mode: 'normal', style: '', text, version: 1 });
        } else if (node.type === 'tag') {
            const tag = node.tagName.toLowerCase();
            if (tag === 'strong' || tag === 'b') children.push(...applyFmt(inlineToLexical($, $(node)), 1));
            else if (tag === 'em' || tag === 'i') children.push(...applyFmt(inlineToLexical($, $(node)), 2));
            else if (tag === 'u') children.push(...applyFmt(inlineToLexical($, $(node)), 8));
            else if (tag === 's' || tag === 'del') children.push(...applyFmt(inlineToLexical($, $(node)), 4));
            else if (tag === 'a') children.push({ type: 'link', children: inlineToLexical($, $(node)), direction: 'ltr', format: '', indent: 0, rel: $(node).attr('rel') || null, target: $(node).attr('target') || null, title: $(node).attr('title') || null, url: $(node).attr('href') || '', version: 1 });
            else if (tag === 'br') children.push({ type: 'linebreak', version: 1 });
            else children.push(...inlineToLexical($, $(node)));
        }
    });
    return children;
}

function elToNode($, el) {
    const tag = el.tagName?.toLowerCase();
    if (!tag) return null;
    const $el = $(el);

    if (['h1','h2','h3','h4','h5','h6'].includes(tag)) {
        const c = inlineToLexical($, $el);
        return c.length ? { type: 'heading', children: c, direction: 'ltr', format: '', indent: 0, tag, version: 1 } : null;
    }
    if (tag === 'p') {
        const c = inlineToLexical($, $el);
        return c.length ? { type: 'paragraph', children: c, direction: 'ltr', format: '', indent: 0, version: 1 } : null;
    }
    if (tag === 'figure') {
        const img = $el.find('img');
        if (img.length) return { type: 'image', version: 1, src: img.attr('src') || '', width: null, height: null, title: '', alt: img.attr('alt') || '', caption: $el.find('figcaption').text() || '', cardWidth: 'wide', href: '' };
        return { type: 'html', version: 1, html: $.html(el) };
    }
    if (tag === 'ul' || tag === 'ol') {
        const items = [];
        $el.children('li').each((_, li) => items.push({ type: 'listitem', children: inlineToLexical($, $(li)), direction: 'ltr', format: '', indent: 0, value: items.length + 1, version: 1 }));
        return items.length ? { type: 'list', children: items, direction: 'ltr', format: '', indent: 0, listType: tag === 'ul' ? 'bullet' : 'number', start: 1, tag, version: 1 } : null;
    }
    if (tag === 'blockquote') {
        const c = inlineToLexical($, $el);
        return c.length ? { type: 'quote', children: c, direction: 'ltr', format: '', indent: 0, version: 1 } : null;
    }
    if (tag === 'hr') return { type: 'horizontalrule', version: 1 };
    return { type: 'html', version: 1, html: $.html(el) };
}

function htmlToLexical(html) {
    const children = [];
    const kgRe = /<!--kg-card-begin:\s*html\s*-->([\s\S]*?)<!--kg-card-end:\s*html\s*-->/g;
    let last = 0, m;

    while ((m = kgRe.exec(html)) !== null) {
        if (m.index > last) {
            const seg = html.substring(last, m.index).trim();
            if (seg) {
                const $ = cheerio.load(seg, { decodeEntities: false });
                $('body').children().each((_, el) => { const n = elToNode($, el); if (n) children.push(n); });
            }
        }
        const card = m[1].trim();
        if (card) children.push({ type: 'html', version: 1, html: card });
        last = m.index + m[0].length;
    }

    if (last < html.length) {
        const seg = html.substring(last).trim();
        if (seg) {
            const $ = cheerio.load(seg, { decodeEntities: false });
            $('body').children().each((_, el) => { const n = elToNode($, el); if (n) children.push(n); });
        }
    }

    if (children.length === 0 && html.trim()) children.push({ type: 'html', version: 1, html });
    return children;
}

// ─────────────────────────────────────────────
//  CREATE MODE — tạo bài mới từ keyword
// ─────────────────────────────────────────────
async function createFromKeyword(keyword) {
    console.log(`\n${'═'.repeat(55)}`);
    console.log(`[CREATE] Keyword: "${keyword}"`);
    console.log(`${'═'.repeat(55)}`);

    if (!fs.existsSync('./backups')) fs.mkdirSync('./backups');

    // PHASE 1: Generate metadata via Gemini
    console.log(`\n[AI] Phase 1: Designing post metadata (Gemini)...`);
    const metaRes = await callGemini(
        PROMPT_META,
        `Generate metadata JSON for a new blog post targeting this keyword.

KEYWORD: "${keyword}"

This is a buyer-intent keyword for a beauty affiliate blog. The post should be a "Best X for Y" style product roundup targeting American women 25-45 who are ready to buy. Generate real Amazon bestseller products with accurate review counts and prices.`,
        8192
    );

    let meta;
    try {
        meta = extractJSON(metaRes.text);
    } catch (e) {
        fs.writeFileSync(`./backups/error-meta-${Date.now()}.txt`, metaRes.text);
        throw new Error(`Phase 1 JSON parse failed: ${e.message}`);
    }

    console.log(`[META] Keyword: "${meta.target_keyword}"`);
    console.log(`[META] Title:   ${meta.seo_title}`);
    console.log(`[META] Products: ${(meta.products || []).map(p => p.name).join(', ')}`);

    // PHASE 2: Write HTML content via Gemini
    console.log(`\n[AI] Phase 2: Writing content (Gemini)...`);
    const htmlRes = await callGemini(
        PROMPT_HTML,
        `Write an 800-1000 word product recommendation post for GlamGirls Haven.

METADATA:
${JSON.stringify(meta, null, 2)}

This is a NEW post — not a rewrite. Write it fresh, using the products in the metadata as the real recommendations. Include specific details about each product (texture, scent if applicable, who it's best for, honest con).`,
        CONFIG.content.maxTokens,
        'text/plain'
    );

    let html = htmlRes.text
        .replace(/^```(?:html)?\s*/m, '')
        .replace(/\s*```\s*$/m, '')
        .trim();

    // Cost tracking (Free via Credits)
    const inputTokens = metaRes.usage.input_tokens + htmlRes.usage.input_tokens;
    const outputTokens = metaRes.usage.output_tokens + htmlRes.usage.output_tokens;
    console.log(`\n[CREDITS] Bào thành công ~${inputTokens + outputTokens} tokens Google Cloud Free Trial`);

    checkQuality(html, meta.target_keyword);

    // Backup
    const ts = Date.now();
    const backupFile = `./backups/new-${meta.seo_slug}-${ts}.json`;
    fs.writeFileSync(backupFile, JSON.stringify({ meta, html, keyword, timestamp: new Date().toISOString() }, null, 2));
    console.log(`[BACKUP] ${backupFile}`);

    // Images
    const sectionImages = (meta.section_images || []).slice(0, 3);
    console.log(`\n[IMAGE] Resolving ${1 + sectionImages.length} images...`);

    const [heroUrl, ...sectionUrls] = await Promise.all([
        resolveImage(meta.hero_search_query, meta.visual_prompt, '3:4', `glamgirls-hero-${ts}.webp`),
        ...sectionImages.map((si, i) =>
            resolveImage(
                si.search_query || si.section_title,
                si.prompt,
                si.aspect_ratio || (i % 2 === 0 ? '4:3' : '1:1'),
                `glamgirls-section-${i}-${ts}.webp`
            )
        )
    ]);

    // Inject placeholders
    html = safereplace(html, '{{IMG_HERO}}', heroUrl);
    sectionImages.forEach((si, i) => {
        if (sectionUrls[i]) {
            const key = si.placeholder.replace(/[{}]/g, '');
            html = safereplace(html, `{{${key}}}`, sectionUrls[i]);
        }
    });
    html = html.replace(/\{\{IMG_SECTION_\d+\}\}/g, '');

    // Affiliate blocks
    const products = meta.products || [];
    products.forEach((product, i) => {
        const url = `https://www.amazon.com/s?k=${encodeURIComponent(product.name)}&tag=${CONFIG.amazon.tag}`;
        html = safereplace(html, `{{AFFILIATE_BLOCK_${i}}}`, buildAffiliateBlock(product.name, url));
    });
    if (products.length > 0) {
        const last = products[products.length - 1];
        const lastUrl = `https://www.amazon.com/s?k=${encodeURIComponent(last.name)}&tag=${CONFIG.amazon.tag}`;
        html = safereplace(html, '{{AFFILIATE_BLOCK_LAST}}', buildAffiliateBlock(last.name, lastUrl));
    }
    html = safereplace(html, '{{PINTEREST_CTA}}', buildPinterestCTA(meta.seo_title));
    html = html.replace(/\{\{AFFILIATE_BLOCK_[^}]+\}\}/g, '');

    // Push to Ghost as NEW post
    const lexical = JSON.stringify({
        root: {
            children: htmlToLexical(html),
            direction: null, format: '', indent: 0, type: 'root', version: 1
        }
    });

    const created = await axios.post(
        `${process.env.GHOST_API_URL}/ghost/api/admin/posts/`,
        {
            posts: [{
                title: meta.seo_title,
                slug: meta.seo_slug,
                lexical,
                meta_title: meta.seo_title,
                meta_description: meta.meta_description,
                og_title: meta.seo_title,
                og_description: meta.pinterest_description,
                twitter_title: meta.seo_title,
                twitter_description: meta.meta_description,
                status: 'draft',
                tags: [{ name: 'affiliate' }, { name: 'pinterest' }]
            }]
        },
        { headers: { Authorization: `Ghost ${generateGhostJWT()}`, 'Content-Type': 'application/json' } }
    );

    const newPostId = created.data.posts[0].id;
    console.log(`\n[✅] NEW post created: "${meta.seo_title}"`);
    console.log(`[GHOST] ID: ${newPostId} | Slug: /${meta.seo_slug}`);

    // Generate pins
    await generatePins(meta, html, meta.seo_slug);

    // Mark keyword as done
    return meta.seo_slug;
}

// ─────────────────────────────────────────────
//  BOOTSTRAP
// ─────────────────────────────────────────────
async function main() {
    const mode = process.argv[2] || 'rewrite';
    const batchLimit = parseInt(process.argv[3]) || (mode === 'create' ? CONFIG.create.limit : CONFIG.batch.limit);

    // Pre-load brand favicon for Tweet layout avatar
    await loadFavicon();

    console.log(`\n${'═'.repeat(55)}`);
    console.log(`  GlamGirls Haven — Content Engine v3`);
    console.log(`  Mode: ${mode === 'create' ? 'CREATE (from keywords)' : 'REWRITE (legacy posts)'}`);
    console.log(`  Batch: ${batchLimit} item(s)`);
    console.log(`${'═'.repeat(55)}\n`);

    try {
        if (mode === 'create') {
            // ── CREATE MODE: từ keywords.txt ──────────────
            if (!fs.existsSync(CONFIG.keywordsFile)) {
                console.error(`[ERROR] ${CONFIG.keywordsFile} không tồn tại.`);
                console.error(`[INFO]  Tạo file keywords.txt với mỗi dòng là 1 keyword cần viết bài.`);
                console.error(`[INFO]  Ví dụ:`);
                console.error(`        best vitamin c serum under 30`);
                console.error(`        best drugstore foundation oily skin`);
                console.error(`        beauty gifts for her under 30 amazon`);
                process.exit(1);
            }

            const allKeywords = fs.readFileSync(CONFIG.keywordsFile, 'utf-8')
                .split('\n')
                .map(k => k.trim())
                .filter(k => k && !k.startsWith('#')); // dòng bắt đầu # = comment, bỏ qua

            const doneFile = './backups/keywords-done.txt';
            const done = fs.existsSync(doneFile)
                ? fs.readFileSync(doneFile, 'utf-8').split('\n').map(k => k.trim()).filter(Boolean)
                : [];

            const pending = allKeywords.filter(k => !done.includes(k));

            if (pending.length === 0) {
                console.log('[INFO] Tất cả keyword trong keywords.txt đã được xử lý.');
                console.log('[INFO] Thêm keyword mới vào file rồi chạy lại.');
                return;
            }

            console.log(`[KEYWORDS] Tổng: ${allKeywords.length} | Đã xong: ${done.length} | Còn lại: ${pending.length}`);
            console.log(`[BATCH]    Xử lý ${batchLimit} keyword lần này\n`);

            const batch = pending.slice(0, batchLimit);
            for (const keyword of batch) {
                const slug = await createFromKeyword(keyword);
                // Mark as done
                fs.appendFileSync(doneFile, keyword + '\n');
                console.log(`[DONE] "${keyword}" → ${slug}`);
            }

            console.log(`\n${'═'.repeat(55)}`);
            console.log(`  ✅ Done! ${batch.length} bài mới tạo → Ghost Admin → Drafts`);
            console.log(`  📌 Pin images → ./backups/`);
            console.log(`  📝 Còn lại: ${pending.length - batch.length} keyword chưa xử lý`);
            console.log(`${'═'.repeat(55)}\n`);

        } else {
            // ── REWRITE MODE: Legacy Ghost posts ──────────
            const posts = await ghost.posts.browse({
                limit: batchLimit,
                filter: 'tag:legacy',
                formats: ['html']
            });

            if (posts.length === 0) {
                console.log('[INFO] Không tìm thấy bài nào có tag "legacy".');
                console.log('[INFO] Vào Ghost Admin → tag bài cần xử lý với "legacy" trước.');
                return;
            }

            console.log(`[BATCH] Tìm thấy ${posts.length} bài để rewrite\n`);

            for (const post of posts) {
                await processPost(post);
            }

            console.log(`\n${'═'.repeat(55)}`);
            console.log(`  ✅ Done! Check Ghost Admin → Drafts`);
            console.log(`  📌 Pin images → ./backups/`);
            console.log(`${'═'.repeat(55)}\n`);
        }

    } catch (err) {
        console.error('[FATAL]', err.message);
        if (err.response?.data) console.error('[API]', JSON.stringify(err.response.data, null, 2));
        process.exit(1);
    }
}

main();