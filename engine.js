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
//  API CLIENTS
// ─────────────────────────────────────────────
const ghost = new GhostAdminAPI({
    url: process.env.GHOST_API_URL,
    key: process.env.GHOST_ADMIN_KEY,
    version: 'v5.0'
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Google Auth — auto-refreshes OAuth2 token, no more manual token in .env
// Reads credentials from GOOGLE_APPLICATION_CREDENTIALS env var (path to service account JSON)
const googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
});

// ─────────────────────────────────────────────
//  UPLOAD IMAGE → GHOST CDN
// ─────────────────────────────────────────────
async function uploadToGhost(imageBuffer, filename) {
    const formData = new FormData();
    formData.append('file', imageBuffer, { filename, contentType: 'image/webp' });
    formData.append('ref', filename);

    const uploadUrl = `${process.env.GHOST_API_URL}/ghost/api/admin/images/upload/`;
    const [id, secret] = process.env.GHOST_ADMIN_KEY.split(':');
    const token = jwt.sign({}, Buffer.from(secret, 'hex'), {
        keyid: id, algorithm: 'HS256', expiresIn: '5m', audience: '/v5.0/admin/'
    });

    const response = await axios.post(uploadUrl, formData, {
        headers: { ...formData.getHeaders(), Authorization: `Ghost ${token}` }
    });
    return response.data.images[0].url;
}

// ─────────────────────────────────────────────
//  IPHONE-STYLE IMAGE PIPELINE
//  1. Try Unsplash (real photo) → 2. Imagen fallback (no-text prompt)
// ─────────────────────────────────────────────

/**
 * Fetch a real photo from Unsplash matching the topic.
 * Returns { buffer, credit } or null if nothing found.
 */
async function fetchUnsplashPhoto(searchQuery, orientation = 'portrait') {
    try {
        const searchRes = await axios.get('https://api.unsplash.com/search/photos', {
            params: {
                query: searchQuery,
                orientation,          // portrait | landscape | squarish
                per_page: 5,
                content_filter: 'high',
                order_by: 'relevant'
            },
            headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` }
        });

        const results = searchRes.data.results;
        if (!results || results.length === 0) {
            console.log(`[UNSPLASH] No results for: "${searchQuery}"`);
            return null;
        }

        const photo = results[0];
        const imgRes = await axios.get(photo.urls.regular, { responseType: 'arraybuffer' });
        console.log(`[UNSPLASH] Found: "${photo.alt_description || photo.description}" by ${photo.user.name}`);

        return {
            buffer: Buffer.from(imgRes.data),
            credit: `Photo by ${photo.user.name} on Unsplash`
        };
    } catch (err) {
        console.log(`[UNSPLASH] Failed (${err.message}) — falling back to Imagen`);
        return null;
    }
}

/**
 * Imagen fallback — generates UGC iPhone-style photo.
 * Wraps prompt with no-text, no-label composition instructions.
 */
async function generateImagenFallback(visualPrompt, aspectRatio = '3:4') {
    const safePrompt = `Shot on iPhone 15 Pro, casual handheld photo, ${visualPrompt}, ` +
        `intentionally slightly out of focus on product labels, ` +
        `hand partially covering bottles so label is not visible, ` +
        `OR overhead flat lay where text is too small to read, ` +
        `OR extreme close-up macro where label is outside frame, ` +
        `warm natural window light, authentic real-home environment, ` +
        `UGC aesthetic, no studio lighting, slight motion blur, ` +
        `NO readable text, NO legible words on any product`;

    const response = await axios.post(
        `https://us-central1-aiplatform.googleapis.com/v1/projects/${process.env.GOOGLE_PROJECT_ID}/locations/us-central1/publishers/google/models/imagen-4.0-ultra-generate-001:predict`,
        {
            instances: [{ prompt: safePrompt }],
            parameters: { sampleCount: 1, aspectRatio }
        },
        {
            headers: {
                Authorization: `Bearer ${await googleAuth.getAccessToken()}`,
                'Content-Type': 'application/json'
            }
        }
    );
    return Buffer.from(response.data.predictions[0].bytesBase64Encoded, 'base64');
}

/**
 * Smart image resolver — Unsplash first, Imagen fallback.
 * Returns uploaded Ghost CDN URL.
 */
async function resolveImage(searchQuery, visualPrompt, aspectRatio, filename) {
    const orientationMap = { '3:4': 'portrait', '4:3': 'landscape', '1:1': 'squarish' };
    const orientation = orientationMap[aspectRatio] || 'landscape';

    // Attempt 1: real stock photo from Unsplash (Exact match)
    if (process.env.UNSPLASH_ACCESS_KEY) {
        let stock = await fetchUnsplashPhoto(searchQuery, orientation);
        
        // Attempt 1b: Generic search if specific fails (to get a REAL generic bottle instead of AI)
        if (!stock) {
            const genericQuery = searchQuery.split(' ').slice(-2).join(' ') + ' luxury minimalist';
            console.log(`[IMAGE]  🔍 Specific failed. Trying generic: "${genericQuery}"`);
            stock = await fetchUnsplashPhoto(genericQuery, orientation);
        }

        if (stock) {
            const url = await uploadToGhost(stock.buffer, filename);
            console.log(`[IMAGE]  ✅ Stock photo: ${filename}`);
            return url;
        }
    }

    // Attempt 2: Imagen with NO-PRODUCT directive (Artistic Vibe only)
    console.log(`[IMAGE]  ⚡ Imagen fallback (Artistic Vibe) for: "${searchQuery}"`);
    const buffer = await generateImagenFallback(visualPrompt, '3:4');
    const url = await uploadToGhost(buffer, filename);
    console.log(`[IMAGE]  ✅ Imagen used: ${filename}`);
    return url;
}

// ─────────────────────────────────────────────
//  BUILD AFFILIATE LINK BLOCK HTML
// ─────────────────────────────────────────────
function buildAffiliateBlock(productName, amazonUrl) {
    return `<!--kg-card-begin: html-->
<div style="display:flex;align-items:center;justify-content:space-between;background:#FDFBFB;border:1px solid #F2EBEB;padding:22px 28px;margin:35px 0;width:100%;box-sizing:border-box;border-radius:2px;">
  <span style="font-family:serif;font-size:20px;font-weight:600;color:#4A3F41;flex:1;margin-right:25px;line-height:1.2;">${productName}</span>
  <a href="${amazonUrl}" target="_blank" rel="sponsored noopener noreferrer" style="background:#B5838D;color:#ffffff;padding:12px 24px;font-size:11px;font-family:sans-serif;font-weight:700;text-decoration:none;text-transform:uppercase;letter-spacing:1px;white-space:nowrap;display:inline-flex;align-items:center;">Check Price on Amazon →</a>
</div>
<!--kg-card-end: html-->`;
}

// ─────────────────────────────────────────────
//  BUILD PINTEREST CTA BLOCK (cuối bài)
// ─────────────────────────────────────────────
function buildPinterestCTA(pinTitle) {
    return `<!--kg-card-begin: html-->
<div style="background:#FDFBFB;border-left:4px solid #B5838D;padding:24px 28px;margin:40px 0;border-radius:0 8px 8px 0;">
  <p style="font-family:serif;font-size:18px;font-weight:700;color:#4A3F41;margin:0 0 8px 0;">Save this for later</p>
  <p style="font-family:sans-serif;font-size:14px;color:#4A3F41;margin:0 0 16px 0;">Found this helpful? Pin it to your <strong>Skincare</strong> or <strong>Beauty Tips</strong> board so you can find it again.</p>
  <p style="font-family:sans-serif;font-size:13px;color:#B5838D;margin:0;font-style:italic;">${pinTitle}</p>
</div>
<!--kg-card-end: html-->`;
}

// ─────────────────────────────────────────────
//  PINTEREST PIN GENERATOR PROMPT
// ─────────────────────────────────────────────
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
  Examples: for gift guide → "Gifts That Always Disappoint Her" / "Stop Buying These Beauty Gifts"
            for skincare → "Why Your Skin Is Still Dull" / "You're Applying Serum Wrong"
            for nails → "Why Your Manicure Chips Fast" / "Stop Filing Nails This Way"

STRATEGY (THE CURIOSITY GAP & TIKTOK HOOKS):
- Never reveal the "How" or "Final Product" on the Pin. 
- Use Gen-Z/Millennial high-converting power hooks adapted to the blog topic.
- Hooks must borderline on psychological clickbait but sound like an insider secret.

IMPORTANT IMAGE RULES:
- ALL image_prompts must be RELEVANT to the blog topic (e.g. if the blog is about nails, the image MUST show nails, hands, or nail products).
- NO GENERIC SYMBOLS: Never use stop signs, traffic lights, or non-beauty warning signs. 
- FOR PIN C (Mistakes/Warning): Describe a visual of a "mistake" or "problem" related to THIS topic specifically.
- Always maintain an "Editorial & High-end" aesthetic (UGC iPhone style, natural lighting, clean backgrounds).

IMPORTANT: NEVER use double quotes (") inside your values. Use single quotes (') instead.

OUTPUT FORMAT: A single JSON array with no preamble and no markdown.
[
  {
    "type": "A (Pain Point)",
    "board": "Exact board name from list below",
    "hook_title": "5-7 word attention-grabbing title (overlay)",
    "description": "150-200 char description with keywords",
    "hashtags": ["#tag1", "#tag2", "#tag3"],
    "image_prompt": "Specific beauty-related visual prompt (e.g. 'close-up of hand holding a glass file')",
    "cta_text": "SEE THE FIX"
  },
  ... (4 more items following B, C, D, E strategies)
]

BOARDS:
- Skincare Tips & Routine for Glowing Skin
- Ultimate Makeup Ideas: Glam & Natural Looks
- Nail Art Inspiration
- Self-Love, Mindfulness & Daily Wellness Rituals
- Beauty Tips & Hacks
- Outfits Idea
- Trendy Hairstyles & Haircare for Women
- Fragrance & Body
- Gift Guides

CTA VARIATIONS (Short, Punchy, Action-Oriented):
- A: "SEE THE FIX", "UNLOCK THE HACK", "STEAL SECRET".
- B: "RICH MOM ENERGY", "THAT GIRL VIBE", "YOUR ERA".
- C: "STOP DOING THIS", "DERM REVEAL", "BIG MISTAKE".
- D: "TARGET SECRET", "SKIP SEPHORA", "THE $9 DUPE".
- E: "30-DAY RESET", "EXACT ROUTINE", "COPY THIS".

CONTENT MIX:
A: Lazy Girl Hack / Pain Point, B: Aesthetic Goal, C: Mistake/Warning, D: Secret Find/Dupe, E: Exact Routine.
`;

// ─────────────────────────────────────────────
//  CLAUDE PROMPTS — SPLIT INTO 2 PHASES
//  Phase 1 → metadata JSON (small, reliable)
//  Phase 2 → full HTML content (plain text, no JSON escaping)
// ─────────────────────────────────────────────

// PHASE 1: Metadata only — fast, cheap, zero JSON corruption risk
const SYSTEM_PROMPT_META = `
You are a senior beauty content strategist with 10 years writing for US audiences on Pinterest-driven affiliate blogs.

TARGET AUDIENCE: American women, ages 25–45, mainstream US culture.
BLOG STAGE: Brand new — zero traffic. Every post must earn clicks from scratch.
PRIMARY TRAFFIC: Pinterest (users scan fast, click on outcomes, save "how-to" content).

═══════════════════════════════════════════
OUTPUT: STRICTLY valid JSON — no preamble, no markdown.
CRITICAL JSON RULE: Since rewritten_html contains HTML, you MUST meticulously escape EVERY double quote inside the HTML (e.g. class=\"kg-card\") OR exclusively use single quotes for all HTML attributes. Unescaped quotes will crash the JSON parser!
═══════════════════════════════════════════

OUTPUT: A single STRICT JSON object. NO markdown, NO preamble, NO extra text.

{
  "seo_title": "Pinterest-optimized post title (outcome-first, 55–65 chars, includes main keyword women actually search)",
  "seo_slug": "url-friendly-slug-from-title",
  "meta_description": "155-char meta description with search keyword + clear benefit",
  "pinterest_description": "150-char pin description using keywords US women search on Pinterest. Start with a hook. Include 3 relevant hashtags at end.",
  "hero_search_query": "Literal visual noun for Unsplash (e.g. 'shampoo bottle', 'woman brushing hair', 'hair salon'). CRITICAL: Never use abstract concepts like 'damaged hair' or 'repair' as Unsplash fails on those.",
  "visual_prompt": "Imagen fallback prompt for HERO — UGC iPhone style, NO brand names, NO readable text on products, describe only shapes/colors/scene",
  "section_images": [
    {
      "placeholder": "{{IMG_SECTION_0}}",
      "search_query": "Literal visual noun relevant to section (e.g. 'hair oil', 'shower head', 'comb'). NO abstract words.",
      "prompt": "Imagen fallback prompt — COMPLETELY different scene from hero and all other images. NO readable text/labels.",
      "section_title": "Exact H2 heading this image belongs under",
      "aspect_ratio": "4:3"
    },
    {
      "placeholder": "{{IMG_SECTION_1}}",
      "search_query": "Different literal visual noun",
      "prompt": "Another unique Imagen fallback prompt — different setting, lighting, composition from ALL previous",
      "section_title": "Exact H2 heading",
      "aspect_ratio": "1:1"
    }
  ],
  "_note_section_images": "Generate exactly 5 section_images entries (IMG_SECTION_0 through IMG_SECTION_4). Hero + 5 = 6 total images per post.",
  "products": [
    {
      "name": "Exact product name for Amazon search",
      "placement_hint": "Short phrase from the article body RIGHT BEFORE where this affiliate block should be inserted — must match article text exactly"
    }
  ],
  "_note_products": "Extract ONLY the top 3 to 5 most important products from the text. CRITICAL: Do NOT extract more than 5 products, even if the text mentions more."
}

`;

// PHASE 2: Full HTML content — returned as PLAIN TEXT (no JSON, no escaping needed)
const SYSTEM_PROMPT_HTML = `
You are a senior beauty content strategist with 10 years writing for US audiences on Pinterest-driven affiliate blogs.

TARGET AUDIENCE: American women, ages 25–45, mainstream US culture.
BLOG STAGE: Brand new — zero traffic. Every post must earn clicks from scratch.
PRIMARY TRAFFIC: Pinterest (users scan fast, click on outcomes, save "how-to" content).

OUTPUT: Return ONLY the raw HTML of the blog post. No JSON, no markdown fences, no preamble, no explanation.
Start directly with <h1> and end with the last closing tag. Nothing else.

═══════════════════════════════════════════
RULES FOR HTML CONTENT — READ CAREFULLY
═══════════════════════════════════════════

[1] SEO & KEYWORD (Criterion 1)
- Use a high-traffic, low-competition keyword as the H1 and naturally throughout (e.g. "morning skincare routine", "best vitamin C serum", NOT brand-sounding phrases).
- Include the keyword in the first 100 words.
- Add 2–3 related LSI keywords in H2/H3 headings.

[2] VOICE & TONE (Criterion 2)
- Write like a knowledgeable best friend — warm, direct, slightly witty.
- Use first person ("I tested this", "my skin went from...").
- Casual American English — contractions, colloquialisms, real experiences.
- NO corporate tone. NO robotic listicles.

[3] AFFILIATE INTENT (Criterion 3)
- Every named product or tool mentioned → must feel like a natural recommendation, not an ad.
- Plant "problem → solution" framing BEFORE each product mention so the link feels like the answer.
- Use placeholder {{AFFILIATE_BLOCK_[INDEX]}} where each affiliate block should be inserted (e.g., {{AFFILIATE_BLOCK_0}}, {{AFFILIATE_BLOCK_1}}...).
- Minimum 3 affiliate link placements per post. Maximum 6.

[4] TRUST SIGNALS (Criterion 4)
- Include at least ONE specific personal anecdote (named timeframe, measurable result).
- Include at least ONE dermatologist-backed or peer-reviewed fact with a conversational explanation.
- Add a "What's Overrated / Worth It" section or similar honest take — this builds trust.

[5] CTA EFFECTIVENESS (Criterion 5)
- Intro hook: First paragraph must promise a clear outcome the reader will get by the end.
- Mid-post CTA: Natural sentence bridging into affiliate block (e.g. "This is the one I actually buy on repeat:").
- End-of-post CTA: Use placeholder {{PINTEREST_CTA}} at the very end, before closing paragraph.
- NO generic "Click here" language.

[6] PINTEREST SEO (Criterion 6)
- H1 title must be outcome-based and searchable: "X Steps to Y Result" / "Best [Product] for [Skin Type]" / "How to [Achieve Result] at Home".
- Include a "Quick Picks" or "At a Glance" summary box near the top (helps Pinterest saves).
- Use {{IMG_HERO}} as the src for the main hero image figure element.

[7] VISUAL HOOK — Pinterest needs images every 200–300 words (Criterion 7)
- TARGET: 6 images per post total — 1 hero + 5 section images.
- Pinterest readers expect visual content throughout. Long text blocks without images = bounce.
- Each image = a separate pin opportunity. More images = more Pinterest entry points.

HERO IMAGE:
- Place immediately after intro paragraph (within first 150 words).
- Use: <figure class="kg-card kg-image-card"><img src="{{IMG_HERO}}" class="kg-image" alt="[descriptive Pinterest SEO alt text]"></figure>
- Portrait ratio 3:4 — optimized for Pinterest feed.

SECTION IMAGES ({{IMG_SECTION_0}} through {{IMG_SECTION_4}}):
- Place one image under each major H2 section heading.
- Use: <figure class="kg-card kg-image-card"><img src="{{IMG_SECTION_N}}" class="kg-image" alt="[alt text]"></figure>
- Vary aspect ratios for visual interest: alternate between 4:3 (landscape) and 1:1 (square).
- CRITICAL — Every image prompt must show a COMPLETELY different scene:
  Different products, setting, lighting, and composition angle every time.
  NEVER describe the same scene twice. Pinterest users will notice repeated visuals.
- Choose sections for images that are naturally visual: ingredient spotlights, routine steps,
  product comparisons, before/after context, flatlay of recommended items.
- If fewer than 5 H2 sections exist, place extra images within longer sections.

NO-TEXT RULE — Imagen AI cannot render readable text. Describing text = hallucinated gibberish.
NEVER mention brand names, product names, or label text in any image prompt.
Use these techniques to hide product text naturally:
  - "thumb and fingers wrapped around bottle, label hidden by hand"
  - "overhead flat lay from 50cm above — labels too small to read"
  - "extreme close-up macro of serum dropper tip, bottle blurred bokeh"
  - "bottles facing away from camera, only caps and shape visible"
  - "products inside open bathroom cabinet, slightly out of focus"
  - "hand mid-application pressing product to skin, label facing down"
Describe ONLY: colors, shapes, textures, materials, scene, lighting, composition.
For search_query: use 2-4 word Unsplash-style tags (e.g. "skincare flatlay morning", "serum dropper closeup", "bathroom vanity routine").

[8] SCANNABLE CONTENT (Criterion 8)
- Morning/evening routines → ALWAYS use <ol> numbered lists, not paragraphs.
- Ingredient comparisons → use <ul> bullet lists.
- Bold the first sentence of each key takeaway.
- Max 3 sentences per paragraph in body content.
- Add a TL;DR or "Bottom Line" box before the FAQ or final section.

[9] IMMEDIATE VALUE — 3-SECOND HOOK (Criterion 9)
- First sentence: call out the reader's exact pain point or desire.
- Second sentence: promise the post will solve it with a specific outcome.
- Third sentence: establish credibility briefly (tested X products, Y years experience, dermatologist-backed).
- Do NOT start with "Are you..." questions or generic openers.

[10] AFFILIATE LINK PLACEMENT (Criterion 10)
- First affiliate placeholder {{AFFILIATE_BLOCK_0}} must appear within the first 30% of the post.
- Space remaining blocks evenly — never two blocks back-to-back.
- Each block must be preceded by a natural 1-sentence lead-in (not just dropped in).
- Final affiliate block should appear in the last 20% of the post.

[11] CONTENT DEPTH & QUALITY REQUIREMENTS (NON-NEGOTIABLE)
- Target 1,200–1,800 words of BODY content (not counting HTML tags, affiliate blocks, or image tags).
- For each product: write a full 5–7 sentence review paragraph with a specific personal experience angle, measurable result, and honest drawback.
- USE <table> freely for: ingredient comparisons, product-vs-product matrices, before/after stat charts, price-tier breakdowns. Tables dramatically improve scannability and reader trust.
- USE <ul>/<li> and <ol>/<li> freely for pros/cons lists, tip columns, routine steps, and ingredient breakdowns.
- REQUIRED SECTIONS — every post must contain ALL of these:
  1. Hook intro (3-second value promise + credibility signal)
  2. "Quick Picks" styled box near the top (for Pinterest scanners who skip to recommendations)
  3. A comparison table OR detailed pros/cons breakdown for products mentioned
  4. An "Honest Take" / "What Actually Happened to Me" personal anecdote with a timeframe and measurable result
  5. Step-by-step routine as a numbered <ol> list
  6. "TL;DR / Bottom Line" callout box before the FAQ
  7. FAQ section with a minimum of 3 Q&A pairs covering real questions US women ask
  8. Closing paragraph with emotional resonance (what the reader's life looks like after solving this problem)
- DO NOT write thin, generic, or robotic content. Every sentence must earn its place — it either builds trust, drives a click, or answers a real reader question.

═══════════════════════════════════════════
HTML STRUCTURE TEMPLATE (MANDATORY — follow this EXACT order)
═══════════════════════════════════════════

<h1>[SEO Title — outcome-first, 55-65 chars]</h1>

<!--kg-card-begin: html-->
<div style='background:#FDFBFB;border:1px solid #F2EBEB;padding:20px 24px;margin:24px 0;border-radius:4px;'>
  <p style='font-family:sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#B5838D;margin:0 0 12px 0;'>Quick Picks — At a Glance</p>
  <ul style='margin:0;padding-left:18px;font-family:sans-serif;font-size:14px;color:#4A3F41;line-height:1.8;'>
    <li><strong>[Product 1 name]</strong> — [one-line hot take: best for X]</li>
    <li><strong>[Product 2 name]</strong> — [one-line hot take: best for Y]</li>
  </ul>
</div>
<!--kg-card-end: html-->

[HOOK INTRO — 3-4 paragraphs, max 3 sentences each. Pain point → promise → credibility.]

<figure class='kg-card kg-image-card'><img src='{{IMG_HERO}}' class='kg-image' alt='[Pinterest SEO alt text]'></figure>

{{AFFILIATE_BLOCK_0}}

<h2>[First Major Section — e.g. "What Makes This Serum Different"]</h2>
<figure class='kg-card kg-image-card'><img src='{{IMG_SECTION_0}}' class='kg-image' alt='[alt text]'></figure>
[3-5 paragraphs of rich content. Include personal experience angle.]

<h2>[Comparison / Product Breakdown Section]</h2>
<figure class='kg-card kg-image-card'><img src='{{IMG_SECTION_1}}' class='kg-image' alt='[alt text]'></figure>
[USE a <table> here for ingredient or product comparisons. MUST wrap it in a responsive container like this:]
<!--kg-card-begin: html-->
<div style='width:100%;overflow-x:auto;margin:24px 0;border:1px solid #F2EBEB;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.02);'>
  <table style='width:100%;min-width:600px;border-collapse:collapse;font-family:sans-serif;font-size:14px;text-align:left;'>
    <thead>
      <tr style='background:#F9F4F5;'>
        <th style='padding:14px 18px;color:#4A3F41;font-weight:700;border-bottom:2px solid #E5D5D8;'>Feature</th>
        <th style='padding:14px 18px;color:#4A3F41;font-weight:700;border-bottom:2px solid #E5D5D8;'>[Product A]</th>
        <th style='padding:14px 18px;color:#4A3F41;font-weight:700;border-bottom:2px solid #E5D5D8;'>[Product B]</th>
      </tr>
    </thead>
    <tbody>
      <tr style='border-bottom:1px solid #F2EBEB;'>
        <td style='padding:14px 18px;color:#4A3F41;'>...</td>
        <td style='padding:14px 18px;color:#4A3F41;'>...</td>
        <td style='padding:14px 18px;color:#4A3F41;'>...</td>
      </tr>
    </tbody>
  </table>
</div>
<!--kg-card-end: html-->

{{AFFILIATE_BLOCK_1}}

<h2>[My Honest Take Section — "What Actually Happened After 30 Days"]</h2>
<figure class='kg-card kg-image-card'><img src='{{IMG_SECTION_2}}' class='kg-image' alt='[alt text]'></figure>
[Personal anecdote: named timeframe (e.g. "By week two..."), measurable result (e.g. "my pores looked..."), and an honest drawback.]
<ul>
  <li><strong>Pros:</strong> ...</li>
  <li><strong>Cons:</strong> ...</li>
</ul>

<h2>[Step-by-Step Routine / How to Use It]</h2>
<figure class='kg-card kg-image-card'><img src='{{IMG_SECTION_3}}' class='kg-image' alt='[alt text]'></figure>
<ol>
  <li><strong>Step 1:</strong> ...</li>
  <li><strong>Step 2:</strong> ...</li>
  <li><strong>Step 3:</strong> ...</li>
</ol>

{{AFFILIATE_BLOCK_2}}

<h2>[Worth It? / Who Should Buy This]</h2>
<figure class='kg-card kg-image-card'><img src='{{IMG_SECTION_4}}' class='kg-image' alt='[alt text]'></figure>
[Content with specific use-case targeting: skin type, budget, lifestyle.]

<!--kg-card-begin: html-->
<div style='background:#F9F4F5;border-left:4px solid #B5838D;padding:20px 24px;margin:32px 0;border-radius:0 8px 8px 0;'>
  <p style='font-family:sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#B5838D;margin:0 0 10px 0;'>TL;DR — Bottom Line</p>
  <p style='font-family:sans-serif;font-size:15px;color:#4A3F41;margin:0;line-height:1.7;'>[2-3 sentences: who this is for, what result they can expect, and whether it's worth the price.]</p>
</div>
<!--kg-card-end: html-->

{{AFFILIATE_BLOCK_[LAST]}}

<h2>Frequently Asked Questions</h2>
<h3>[Real question US women search, e.g. "Can you use this with retinol?"]</h3>
<p>[Honest, specific answer — 2-3 sentences.]</p>
<h3>[Second question]</h3>
<p>[Answer]</p>
<h3>[Third question]</h3>
<p>[Answer]</p>

{{PINTEREST_CTA}}

[CLOSING — 2-3 sentences. Emotional resonance: what the reader's skin/life looks like once they solve this problem. End with a gentle nudge toward action.]
`;

// ─────────────────────────────────────────────
//  HTML → LEXICAL CONVERTER
//  Converts flat HTML into proper Ghost Lexical nodes
//  so content renders as native editor blocks (not 1 raw HTML card)
// ─────────────────────────────────────────────

/**
 * Apply format bitmask (bold=1, italic=2, strikethrough=4, underline=8) recursively
 */
function applyFormat(nodes, formatBit) {
    return nodes.map(node => {
        if (node.type === 'text') {
            return { ...node, format: (node.format || 0) | formatBit };
        } else if (node.type === 'link') {
            return { ...node, children: applyFormat(node.children, formatBit) };
        }
        return node;
    });
}

/**
 * Convert inline HTML (text, <strong>, <em>, <a>, <br>) to Lexical text/link nodes
 */
function inlineChildrenToLexical($, $el) {
    const children = [];

    $el.contents().each((_, node) => {
        if (node.type === 'text') {
            const text = $(node).text();
            if (text) {
                children.push({
                    type: 'text', detail: 0, format: 0, mode: 'normal',
                    style: '', text: text, version: 1
                });
            }
        } else if (node.type === 'tag') {
            const tag = node.tagName.toLowerCase();

            if (tag === 'strong' || tag === 'b') {
                children.push(...applyFormat(inlineChildrenToLexical($, $(node)), 1));
            } else if (tag === 'em' || tag === 'i') {
                children.push(...applyFormat(inlineChildrenToLexical($, $(node)), 2));
            } else if (tag === 'u') {
                children.push(...applyFormat(inlineChildrenToLexical($, $(node)), 8));
            } else if (tag === 's' || tag === 'strike' || tag === 'del') {
                children.push(...applyFormat(inlineChildrenToLexical($, $(node)), 4));
            } else if (tag === 'a') {
                children.push({
                    type: 'link',
                    children: inlineChildrenToLexical($, $(node)),
                    direction: 'ltr', format: '', indent: 0,
                    rel: $(node).attr('rel') || null,
                    target: $(node).attr('target') || null,
                    title: $(node).attr('title') || null,
                    url: $(node).attr('href') || '',
                    version: 1
                });
            } else if (tag === 'br') {
                children.push({ type: 'linebreak', version: 1 });
            } else {
                children.push(...inlineChildrenToLexical($, $(node)));
            }
        }
    });

    return children;
}

/**
 * Convert a top-level HTML element to a Lexical node
 */
function elementToLexicalNode($, el) {
    const tag = el.tagName?.toLowerCase();
    if (!tag) return null;

    const $el = $(el);

    switch (tag) {
        case 'h1': case 'h2': case 'h3':
        case 'h4': case 'h5': case 'h6': {
            const tc = inlineChildrenToLexical($, $el);
            if (tc.length === 0) return null;
            return { type: 'heading', children: tc, direction: 'ltr', format: '', indent: 0, tag, version: 1 };
        }

        case 'p': {
            const tc = inlineChildrenToLexical($, $el);
            if (tc.length === 0) return null;
            return { type: 'paragraph', children: tc, direction: 'ltr', format: '', indent: 0, version: 1 };
        }

        case 'figure': {
            const img = $el.find('img');
            if (img.length) {
                const caption = $el.find('figcaption').text() || '';
                return {
                    type: 'image', version: 1,
                    src: img.attr('src') || '',
                    width: img.attr('width') ? parseInt(img.attr('width')) : null,
                    height: img.attr('height') ? parseInt(img.attr('height')) : null,
                    title: '', alt: img.attr('alt') || '',
                    caption, cardWidth: 'wide', href: ''
                };
            }
            return { type: 'html', version: 1, html: $.html(el) };
        }

        case 'ul': case 'ol': {
            const items = [];
            $el.children('li').each((_, li) => {
                items.push({
                    type: 'listitem',
                    children: inlineChildrenToLexical($, $(li)),
                    direction: 'ltr', format: '', indent: 0,
                    value: items.length + 1, version: 1
                });
            });
            if (items.length === 0) return null;
            return {
                type: 'list', children: items,
                direction: 'ltr', format: '', indent: 0,
                listType: tag === 'ul' ? 'bullet' : 'number',
                start: 1, tag, version: 1
            };
        }

        case 'blockquote': {
            const tc = inlineChildrenToLexical($, $el);
            if (tc.length === 0) return null;
            return { type: 'quote', children: tc, direction: 'ltr', format: '', indent: 0, version: 1 };
        }

        case 'hr':
            return { type: 'horizontalrule', version: 1 };

        default:
            return { type: 'html', version: 1, html: $.html(el) };
    }
}

/**
 * Parse a segment of regular HTML into Lexical nodes
 */
function parseRegularSegment(html) {
    const trimmed = html.trim();
    if (!trimmed) return [];

    const $ = cheerio.load(trimmed, { decodeEntities: false });
    const nodes = [];

    $('body').children().each((_, el) => {
        const node = elementToLexicalNode($, el);
        if (node) nodes.push(node);
    });

    return nodes;
}

/**
 * Convert full HTML (with <!--kg-card-begin: html--> markers) to Lexical children array.
 * - Content inside kg-card markers → html card nodes (keeps custom styled blocks)
 * - Content outside → native Lexical nodes (heading, paragraph, image, list...)
 */
function htmlToLexicalChildren(html) {
    const children = [];
    const kgCardRegex = /<!--kg-card-begin:\s*html\s*-->([\s\S]*?)<!--kg-card-end:\s*html\s*-->/g;
    let lastIndex = 0;
    let match;

    while ((match = kgCardRegex.exec(html)) !== null) {
        if (match.index > lastIndex) {
            children.push(...parseRegularSegment(html.substring(lastIndex, match.index)));
        }
        const cardHtml = match[1].trim();
        if (cardHtml) {
            children.push({ type: 'html', version: 1, html: cardHtml });
        }
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < html.length) {
        children.push(...parseRegularSegment(html.substring(lastIndex)));
    }

    // Safety fallback: if nothing was created, use single html node
    if (children.length === 0 && html.trim()) {
        children.push({ type: 'html', version: 1, html });
    }

    return children;
}

// ─────────────────────────────────────────────
//  MAIN PIPELINE
// ─────────────────────────────────────────────
async function processPost(post) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`[START] Processing: "${post.title}"`);
    console.log(`${'─'.repeat(50)}`);

    // 1. Clean HTML — strip Amazon images, then extract plain text to save input tokens
    //    Claude rewrites from scratch anyway, so it only needs the TEXT content, not HTML tags.
    //    Stripping tags cuts input tokens by ~40-50% (e.g. 4000 tokens → ~2000 tokens).
    const $raw = cheerio.load(post.html || '');
    $raw('img, script, style, iframe').remove();
    const plainText = $raw('body').text()
        .replace(/\s+/g, ' ')
        .trim();

    const inputTokenEstimate = Math.round(plainText.length / 4);
    console.log(`[AI] Input text: ~${plainText.length} chars (~${inputTokenEstimate} tokens after stripping HTML)`);

    // 2. Call Claude PHASE 1 — Get Metadata JSON
    console.log(`[AI] Sending to Claude Sonnet (Phase 1: Metadata)...`);
    const aiMetaResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        temperature: 0.7,
        system: SYSTEM_PROMPT_META,
        messages: [{ role: 'user', content: `Analyze this blog post content and generate the metadata JSON with headings, images (search_query and visual_prompt), and product placements. DO NOT write the article HTML yet.\n\nORIGINAL CONTENT:\n\n${plainText}` }]
    });

    // 3. Parse Metadata Response
    const rawContent = aiMetaResponse.content[0].text;

    function extractJSON(raw) {
        let text = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
        try { return JSON.parse(text); } catch (_) {}
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            try { return JSON.parse(text.substring(start, end + 1)); } catch (_) {}
        }
        if (start !== -1) {
            for (let i = text.length - 1; i > start; i--) {
                if (text[i] === '}') {
                    try { return JSON.parse(text.substring(start, i + 1)); } catch (_) { continue; }
                }
            }
        }
        throw new Error('Could not extract valid JSON from Claude response');
    }

    let parsedData;
    try {
        parsedData = extractJSON(rawContent);
    } catch (e) {
        console.error('[ERROR] JSON parse failed. Raw output saved for debug.');
        fs.writeFileSync(`./backups/parse-error-${Date.now()}.txt`, rawContent, 'utf-8');
        throw new Error(`Claude returned invalid JSON: ${e.message}`);
    }

    // 3.5 Call Claude PHASE 2 — Get Full HTML
    console.log(`[AI] Sending to Claude Sonnet (Phase 2: Full HTML)...`);
    const aiHtmlResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        temperature: 0.7,
        system: SYSTEM_PROMPT_HTML,
        messages: [{
            role: 'user',
            content: `Rewrite this blog post following all rules in the system prompt.
Use the following METADATA PLAN to structure your content. Ensure you place the exact image placeholders and product placeholders defined in this plan correctly.

METADATA PLAN:
${JSON.stringify(parsedData, null, 2)}

ORIGINAL CONTENT (plain text):
${plainText}`
        }]
    });

    let finalRewrittenHtml = aiHtmlResponse.content[0].text;
    // Strip markdown HTML fences if any
    finalRewrittenHtml = finalRewrittenHtml.replace(/^```(?:html)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    parsedData.rewritten_html = finalRewrittenHtml;

    // 4. Backup raw parsed data
    const backupDir = './backups';
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    const backupFile = `${backupDir}/backup-${post.id}-${Date.now()}.json`;
    fs.writeFileSync(backupFile, JSON.stringify(parsedData, null, 2), 'utf-8');
    console.log(`[BACKUP] Saved to: ${backupFile}`);

    // 5. Log cost
    const inputTotal = aiMetaResponse.usage.input_tokens + aiHtmlResponse.usage.input_tokens;
    const outputTotal = aiMetaResponse.usage.output_tokens + aiHtmlResponse.usage.output_tokens;
    const cost = (inputTotal * 0.000003) + (outputTotal * 0.000015);
    console.log(`[COST]   $${cost.toFixed(4)} (~${Math.round(cost * 25400).toLocaleString()} VNĐ)`);
    console.log(`[USAGE]  Input: ${inputTotal} | Output: ${outputTotal}`);

    // 6. Resolve ALL images — Unsplash first, Imagen fallback if needed
    const sectionImages = (parsedData.section_images || []).slice(0, 5);
    const totalImages = 1 + sectionImages.length;
    const timestamp = Date.now();

    console.log(`\n[IMAGE]  Resolving ${totalImages} image(s)...`);
    console.log(`[IMAGE]  Strategy: Unsplash (real photo) → Imagen fallback (no-text prompt)`);

    // Build resolve jobs for all images
    // Each section image in JSON must include a "search_query" field (short topic for Unsplash)
    const heroJob = resolveImage(
        parsedData.hero_search_query || parsedData.seo_title,  // Unsplash search term
        parsedData.visual_prompt,                               // Imagen fallback prompt
        '3:4',
        `glamgirls-hero-${timestamp}.webp`
    );

    const sectionJobs = sectionImages.map((si, i) => {
        const ratio = si.aspect_ratio || (i % 2 === 0 ? '4:3' : '1:1');
        return resolveImage(
            si.search_query || si.section_title,  // Unsplash search term
            si.prompt,                             // Imagen fallback prompt
            ratio,
            `glamgirls-section-${i}-${timestamp}.webp`
        );
    });

    // Run all image jobs in parallel
    const [heroUrl, ...sectionUrls] = await Promise.all([heroJob, ...sectionJobs]);

    console.log(`[IMAGE]  Hero:      ${heroUrl}`);
    sectionUrls.forEach((url, i) => console.log(`[IMAGE]  Section ${i}: ${url}`));

    // 7. Inject all placeholders into HTML
    let finalHtml = parsedData.rewritten_html;

    // Log estimated word count to verify content depth (target: 1200-1800 words)
    const wordCount = finalHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').length;
    console.log(`[QUALITY] Word count: ~${wordCount} words (target: 1200–1800)`);
    if (wordCount < 800) {
        console.warn(`[QUALITY] ⚠️  Content is thin (${wordCount} words). Consider re-running for better quality.`);
    } else if (wordCount >= 1200) {
        console.log(`[QUALITY] ✅ Content depth looks good.`);
    }

    // Hero image
    finalHtml = finalHtml.replace(/\{\{IMG_HERO\}\}/g, heroUrl);

    // Section images — match by placeholder name from JSON
    sectionImages.forEach((si, i) => {
        if (sectionUrls[i]) {
            finalHtml = finalHtml.replace(new RegExp(`\\{\\{${si.placeholder.replace(/[{}]/g, '')}\\}\\}`, 'g'), sectionUrls[i]);
        }
    });

    // Fallback: clean up any unreplaced {{IMG_SECTION_*}} placeholders (safety net)
    finalHtml = finalHtml.replace(/\{\{IMG_SECTION_\d+\}\}/g, '');

    // Log image injection summary
    const injectedCount = 1 + sectionUrls.filter(Boolean).length;
    console.log(`[IMAGE]  ${injectedCount}/${totalImages} images successfully injected into HTML`);

    // 8. Build and inject affiliate blocks
    const products = parsedData.products || [];
    products.forEach((product, index) => {
        const amazonUrl = `https://www.amazon.com/s?k=${encodeURIComponent(product.name)}&tag=${process.env.AMAZON_TAG}`;
        const affiliateBlock = buildAffiliateBlock(product.name, amazonUrl);
        const placeholder = `{{AFFILIATE_BLOCK_${index}}}`;
        if (finalHtml.includes(placeholder)) {
            finalHtml = finalHtml.replace(placeholder, affiliateBlock);
        } else {
            console.warn(`[WARN] Placeholder ${placeholder} not found in HTML — appending block`);
        }
    });

    // Replace Pinterest CTA placeholder
    const pinterestCTA = buildPinterestCTA(parsedData.seo_title);
    finalHtml = finalHtml.replace(/\{\{PINTEREST_CTA\}\}/g, pinterestCTA);

    // Clean up any remaining unreplaced placeholders (safety net)
    finalHtml = finalHtml.replace(/\{\{AFFILIATE_BLOCK_\d+\}\}/g, '');

    // 9. Log SEO metadata
    console.log(`\n[SEO OUTPUT — paste into Ghost fields]`);
    console.log(`  Title:        ${parsedData.seo_title}`);
    console.log(`  Slug:         ${parsedData.seo_slug}`);
    console.log(`  Meta desc:    ${parsedData.meta_description}`);
    console.log(`  Pinterest:    ${parsedData.pinterest_description}`);
    console.log(`  Products (${products.length}): ${products.map(p => p.name).join(' | ')}`);

    // 10. Push to Ghost via Lexical JSON — proper block-level nodes
    const latestPost = await ghost.posts.read({ id: post.id });

    const lexicalChildren = htmlToLexicalChildren(finalHtml);
    console.log(`[LEXICAL] Converted HTML into ${lexicalChildren.length} native editor blocks`);

    const lexicalDoc = JSON.stringify({
        root: {
            children: lexicalChildren,
            direction: null, format: '', indent: 0, type: 'root', version: 1
        }
    });

    const [keyId, keySecret] = process.env.GHOST_ADMIN_KEY.split(':');
    const jwtToken = jwt.sign({}, Buffer.from(keySecret, 'hex'), {
        keyid: keyId, algorithm: 'HS256', expiresIn: '5m', audience: '/v5.0/admin/'
    });

    await axios.put(
        `${process.env.GHOST_API_URL}/ghost/api/admin/posts/${latestPost.id}/`,
        {
            posts: [{
                id: latestPost.id,
                updated_at: latestPost.updated_at,
                lexical: lexicalDoc,
                // Inject SEO fields into Ghost post metadata
                title: parsedData.seo_title,
                slug: parsedData.seo_slug,
                meta_title: parsedData.seo_title,
                meta_description: parsedData.meta_description,
                og_title: parsedData.seo_title,
                og_description: parsedData.pinterest_description,
                twitter_title: parsedData.seo_title,
                twitter_description: parsedData.meta_description,
                status: 'draft'
            }]
        },
        {
            headers: {
                Authorization: `Ghost ${jwtToken}`,
                'Content-Type': 'application/json'
            }
        }
    );

    console.log(`\n[✅ SUCCESS] "${parsedData.seo_title}" saved as draft.`);
    console.log(`[CHECK] Open Ghost Admin → Drafts to review.`);

    // 11. Generate Pinterest Pins Package
    await generatePins(parsedData.seo_title, finalHtml, parsedData.seo_slug);
}

// ─────────────────────────────────────────────
//  GENERATE PINTEREST PINS (Powered by Gemini 1.5 Flash + Branded Designer)
// ─────────────────────────────────────────────
async function generatePins(title, html, slug) {
    console.log(`\n[PINTEREST] Designing 5 Branded Pins (via Gemini + Designer Bot)...`);
    try {
        const accessToken = await googleAuth.getAccessToken();
        const response = await axios.post(
            `https://us-central1-aiplatform.googleapis.com/v1/projects/${process.env.GOOGLE_PROJECT_ID}/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent`,
            {
                contents: [{ role: 'user', parts: [{ text: `Generate a 5-Pin JSON Package based on this blog post:\n\nTitle: ${title}\n\nContent:\n${html}` }] }],
                system_instruction: { parts: [{ text: PINTEREST_PIN_PROMPT }] },
                generationConfig: {
                    maxOutputTokens: 4000,
                    temperature: 0.7,
                    responseMimeType: 'application/json'
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // Sanitize response: Find the true JSON array part
        let rawText = response.data.candidates[0].content.parts[0].text;
        
        // Robust extraction: get everything between the first [ and the last ]
        const startIdx = rawText.indexOf('[');
        const endIdx = rawText.lastIndexOf(']');
        
        if (startIdx === -1 || endIdx === -1) {
            throw new Error('Model failed to output a JSON array');
        }
        
        const cleanJson = rawText.substring(startIdx, endIdx + 1);
        
        let pinsData;
        try {
            pinsData = JSON.parse(cleanJson);
        } catch (err) {
            console.error('[PINTEREST] ❌ JSON Parse failed. Writing failed-json.txt for debug.');
            fs.writeFileSync(`./backups/failed-json-${Date.now()}.txt`, rawText);
            throw err;
        }

        const timestamp = Date.now();
        console.log(`[PINTEREST] AI generated 5 Pin concepts. Creating branded images...`);

        for (let i = 0; i < pinsData.length; i++) {
            const pin = pinsData[i];
            console.log(`[PINTEREST] Creating Pin ${i+1}: ${pin.type}...`);
            
            // 1. Search First Strategy for Pins (Try to find a REAL photo for the background)
            let bgBuffer;
            if (process.env.UNSPLASH_ACCESS_KEY) {
                const stock = await fetchUnsplashPhoto(pin.search_query || pin.hook_title, 'portrait');
                if (stock) bgBuffer = stock.buffer;
            }

            // 2. Fallback to Imagen (Vibe/Texture only)
            if (!bgBuffer) {
                console.log(`[PINTEREST] ⚡ No stock for Pin ${i+1}. Using Imagen Fallback.`);
                bgBuffer = await generateImagenFallback(pin.image_prompt, '3:4');
            }
            
            // 3. Overlay Branding & Text via Sharp
            const layoutOffset = timestamp % 8; // Random stable offset per run
            const brandedBuffer = await createBrandedPin(bgBuffer, pin.hook_title, pin.cta_text, i + layoutOffset);
            
            // 4. Save to backup with SEO filename based on the pin's hook title
            const pinSlug = pin.hook_title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
            const filename = `./backups/${slug}-${pinSlug}-${timestamp}.webp`;
            fs.writeFileSync(filename, brandedBuffer);
            console.log(`[PINTEREST] ✅ Branded Pin saved: ${filename}`);
        }

        // Save metadata for copy-pasting
        const metadataFile = `./backups/pins-data-${slug}-${timestamp}.json`;
        fs.writeFileSync(metadataFile, JSON.stringify(pinsData, null, 2), 'utf-8');
        console.log(`[PINTEREST] 📝 Pin descriptions saved: ${metadataFile}`);

    } catch (err) {
        console.error('[ERROR] Pinterest Designer Bot failed:', err.message);
        if (err.response?.data) {
            console.error('[API DETAILS]', JSON.stringify(err.response.data, null, 2));
        }
    }
}

/**
 * Designer Bot V2: Enhanced with multi-line titles, dynamic CTA sizing, and branded watermark.
 * Ensures every Pin looks like it was designed by a human creative director.
 */
async function createBrandedPin(bgBuffer, title, cta, layoutIndex = 0) {
    const width = 1000;
    const height = 1500;
    
    // 1. Smart Word Wrapping with Orphan Prevention
    const words = title.toUpperCase().split(' ');
    const charLimit = 16; // ~16 chars/line fits the 1000px pin width well across all font sizes

    function wrapWords(wordList, limit) {
        const ls = [];
        let cur = '';
        wordList.forEach(w => {
            if ((cur + w).length > limit && cur !== '') {
                ls.push(cur.trim());
                cur = w + ' ';
            } else {
                cur += w + ' ';
            }
        });
        if (cur.trim()) ls.push(cur.trim());
        return ls;
    }

    let lines = wrapWords(words, charLimit);

    // Orphan prevention: if last line is a single very short word (≤3 chars like "2", "BY", "OF"),
    // pull the last word of the previous line down to join it, creating a balanced 2-word last line.
    if (lines.length >= 2) {
        const lastLine = lines[lines.length - 1];
        const lastLineWords = lastLine.split(' ').filter(Boolean);
        if (lastLineWords.length === 1 && lastLine.length <= 4) {
            const prevLine = lines[lines.length - 2];
            const prevWords = prevLine.split(' ').filter(Boolean);
            if (prevWords.length > 1) {
                // Move last word of prev line down to join the orphan
                const movedWord = prevWords.pop();
                lines[lines.length - 2] = prevWords.join(' ');
                lines[lines.length - 1] = movedWord + ' ' + lastLine;
            }
        }
    }

    const finalLinesRaw = lines.slice(0, 5);
    const maxLineLength = Math.max(...finalLinesRaw.map(l => l.length)) || 1;

    const escapeXml = (str) => (str || '').toString().replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '\'': '&apos;', '"': '&quot;' }[c]));
    const finalLines = finalLinesRaw.map(escapeXml);
    const safeCta = escapeXml(cta.toUpperCase());

    const ctaWidth = Math.max(460, (cta.length * 22) + 160);
    const ctaHeight = 90;
    
    let svgOverlay = '';

    if (layoutIndex % 8 === 0) {
        // LAYOUT 0: Classic Editorial (Bottom Heavy, Dark Gradient, Serif Text)
        let fontSize = 95;
        let lineSpacing = 110;
        if (finalLines.length > 3 || title.length > 35) { fontSize = 85; lineSpacing = 100; }
        if (finalLines.length > 4) { fontSize = 72; lineSpacing = 85; }
        
        let maxAllowedFontSize = Math.floor(900 / (maxLineLength * 0.65));
        if (fontSize > maxAllowedFontSize) {
            fontSize = maxAllowedFontSize;
            lineSpacing = Math.floor(fontSize * 1.15);
        }

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
                ${finalLines.map((line, i) => `<text y="${i * lineSpacing}" text-anchor="middle" style="fill: white; font-family: 'Didot', 'Bodoni 72', 'Playfair Display', serif; font-size: ${fontSize}px; font-weight: 600; letter-spacing: 1px; line-height: 1.1; filter: drop-shadow(0px 4px 15px rgba(0,0,0,0.8));">${line}</text>`).join('\n            ')}
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
        // LAYOUT 1: Modern & Bold (Top Heavy, Light Box behind text, Sans-Serif)
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
        // LAYOUT 2: The "Tape" or Center Highlight Block
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
        // LAYOUT 3: Minimalist Editorial "Bottom Block"
        let fontSize = Math.min(85, Math.floor(900 / (maxLineLength * 0.65)));
        let lineSpacing = Math.floor(fontSize * 1.25);
        if (finalLines.length > 3) {
            fontSize = Math.min(fontSize, 70);
            lineSpacing = Math.floor(fontSize * 1.2);
        }
        const textHeight = finalLines.length * lineSpacing;
        
        const boxHeight = 550; // Bottom 550px is solid white
        const boxY = height - boxHeight; // 950
        
        // Center text vertically in the space between logo (Y~1000) and CTA (Y~1350)
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
        // LAYOUT 4: The "Viral Quote" - Dark Center Banner
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
        if (finalLinesRaw.length > 1) searchQueryRaw += "...";
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
                <path d="M 760 ${boxHeight - 10} C 780 ${boxHeight - 10}, 810 ${boxHeight + 10}, 820 ${boxHeight + 20} C 800 ${boxHeight + 10}, 790 ${boxHeight - 10}, 790 ${boxHeight - 30} Z" fill="#007AFF" filter="drop-shadow(0px 10px 20px rgba(0,0,0,0.2))" />
                
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

// ─────────────────────────────────────────────
//  BOOTSTRAP
// ─────────────────────────────────────────────
async function bootEngine() {
    try {
        const posts = await ghost.posts.browse({
            limit: 1,
            filter: 'tag:legacy',
            formats: ['html']
        });

        if (posts.length === 0) {
            console.log('[INFO] No posts with tag "legacy" found. Tag posts in Ghost first.');
            return;
        }

        for (const post of posts) {
            await processPost(post);
        }
    } catch (err) {
        console.error('[FATAL]', err.message);
        if (err.response?.data) {
            console.error('[API ERROR]', JSON.stringify(err.response.data, null, 2));
        }
    }
}

bootEngine();