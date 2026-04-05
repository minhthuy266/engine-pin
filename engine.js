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
<div style="background:#FDFBFB;border-left:4px solid #e60023;padding:24px 28px;margin:40px 0;border-radius:0 8px 8px 0;">
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

STRATEGY (THE CURIOSITY GAP & TIKTOK HOOKS):
- Never reveal the "How" or "Final Product" on the Pin. 
- Use Gen-Z/Millennial high-converting power hooks: "The Exact Routine", "The $9 Alternative", "Why You're Breaking Out", "Rich Mom Energy", "Derm Says Stop This".
- Hooks must borderline on psychological clickbait but sound like an insider secret (Fear of wasting money, Greed for perfect skin/hair, or Exposing a myth).

IMPORTANT: NEVER use double quotes (") inside your values. Use single quotes (') instead.

OUTPUT FORMAT: A single JSON array with no preamble and no markdown.
[
  {
    "type": "A (Pain Point)",
    "board": "Exact board name from list below",
    "hook_title": "5-7 word attention-grabbing title for the image overlay",
    "description": "150-200 char description with keywords and hook",
    "hashtags": ["#tag1", "#tag2", "#tag3"],
    "image_prompt": "UGC iPhone style background image prompt, leave copy space at TOP/BOTTOM for text",
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
- A (Pain Point / Hack): "SEE THE FIX", "UNLOCK THE HACK", "STEAL SECRET".
- B (Aesthetic Goal): "RICH MOM ENERGY", "THAT GIRL VIBE", "YOUR ERA".
- C (Mistakes / Warning): "STOP DOING THIS", "DERM REVEAL", "BIG MISTAKE".
- D (Dupe / Money Saver): "TARGET SECRET", "SKIP SEPHORA", "THE $9 DUPE".
- E (Transformation): "30-DAY RESET", "EXACT ROUTINE", "COPY THIS".

COLOR RULES for Graphic Overlay (Bot will use these):
- Accent color: #b5838d (Dusty Rose).
- Text color: Black #1A1A1A or White #FFFFFF (depending on background).
- Background: 60% Warm White/Cream #F5F0EB.

CONTENT MIX:
A: Lazy Girl Hack / Pain Point, B: Aesthetic Goal, C: Mistake/Warning, D: Secret Find/Dupe, E: Exact Routine.
`;

// ─────────────────────────────────────────────
//  CLAUDE SYSTEM PROMPT — 10-CRITERIA COMPLIANT
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are a senior beauty content strategist with 10 years writing for US audiences on Pinterest-driven affiliate blogs.

TARGET AUDIENCE: American women, ages 25–45, mainstream US culture.
BLOG STAGE: Brand new — zero traffic. Every post must earn clicks from scratch.
PRIMARY TRAFFIC: Pinterest (users scan fast, click on outcomes, save "how-to" content).

═══════════════════════════════════════════
OUTPUT: STRICTLY valid JSON — no preamble, no markdown.
CRITICAL JSON RULE: Since rewritten_html contains HTML, you MUST meticulously escape EVERY double quote inside the HTML (e.g. class=\"kg-card\") OR exclusively use single quotes for all HTML attributes. Unescaped quotes will crash the JSON parser!
═══════════════════════════════════════════

{
  "seo_title": "Pinterest-optimized post title (outcome-first, 55–65 chars, includes main keyword women actually search)",
  "seo_slug": "url-friendly-slug-from-title",
  "meta_description": "155-char meta description with search keyword + clear benefit",
  "pinterest_description": "150-char pin description using keywords US women search on Pinterest. Start with a hook. Include 3 relevant hashtags at end.",
  "hero_search_query": "2-4 word Unsplash search term for hero image (e.g. 'skincare morning routine', 'vitamin c serum flatlay')",
  "visual_prompt": "Imagen fallback prompt for HERO — UGC iPhone style, NO brand names, NO readable text on products, describe only shapes/colors/scene",
  "section_images": [
    {
      "placeholder": "{{IMG_SECTION_0}}",
      "search_query": "2-4 word Unsplash search term specific to THIS section topic",
      "prompt": "Imagen fallback prompt — COMPLETELY different scene from hero and all other images. NO readable text/labels. Describe angle that hides product text: overhead, macro texture, hand covering label, blurred background.",
      "section_title": "Exact H2 heading this image belongs under",
      "aspect_ratio": "4:3"
    },
    {
      "placeholder": "{{IMG_SECTION_1}}",
      "search_query": "2-4 word Unsplash search for this section",
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
  "rewritten_html": "Full rewritten blog post HTML — rules below"
}

═══════════════════════════════════════════
RULES FOR rewritten_html — READ CAREFULLY
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

[11] TOKEN SAVING & EXTREME BREVITY (CRITICAL)
[11] LENGTH & FORMATTING LIMITS (CRITICAL TO AVOID ERROR)
- VERY IMPORTANT: Your entire JSON output MUST NOT exceed 3500 tokens. If you write too much, the system will crash.
- For each product, write a natural, punchy 3-4 sentence paragraph.
- DO NOT use any HTML tables (no <table>) or bullet lists (no <ul>/<li>) for Pros and Cons. Simply write "Pro: [short text]. Con: [short text]."
- Keep the introduction and closing paragraphs brief.
- This structure guarantees you provide high-quality US-style recommendations while safely fitting inside the API size limits.

═══════════════════════════════════════════
HTML STRUCTURE TEMPLATE (follow this order)
═══════════════════════════════════════════

<h1>[SEO Title from seo_title field]</h1>

<!-- At-a-Glance Quick Picks box -->
<!--kg-card-begin: html-->
<div style="background:#FDFBFB;border:1px solid #F2EBEB;padding:20px 24px;margin:24px 0;border-radius:4px;">
  <p style="font-family:sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#B5838D;margin:0 0 12px 0;">Quick Picks — Products Mentioned</p>
  <ul style="margin:0;padding-left:18px;font-family:sans-serif;font-size:14px;color:#4A3F41;line-height:1.8;">
    <!-- List product names as <li> items here — these anchor the page for Pinterest scanners -->
  </ul>
</div>
<!--kg-card-end: html-->

[Intro paragraphs — 3-second hook]

<figure class="kg-card kg-image-card"><img src="{{IMG_HERO}}" class="kg-image" alt="[alt text]"></figure>

{{AFFILIATE_BLOCK_0}}  ← first block within top 30%

[H2 sections with content...]

{{AFFILIATE_BLOCK_1}}

[More H2 sections...]

{{AFFILIATE_BLOCK_2}}

[Routine steps as <ol>...]

[TL;DR / Bottom Line box]

{{AFFILIATE_BLOCK_[LAST]}}  ← final block in bottom 20%

{{PINTEREST_CTA}}

[Closing paragraph — 2-3 sentences max]
`;

// ─────────────────────────────────────────────
//  MAIN PIPELINE
// ─────────────────────────────────────────────
async function processPost(post) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`[START] Processing: "${post.title}"`);
    console.log(`${'─'.repeat(50)}`);

    // 1. Clean HTML — strip Amazon image assets
    const $ = cheerio.load(post.html || '');
    $('img').each((_, el) => {
        if ($(el).attr('src')?.includes('amazon.com')) $(el).remove();
    });
    const cleanHtml = $.html();

    // 2. Call Claude — rewrite with full 10-criteria system prompt
    console.log(`[AI] Sending to Claude Sonnet...`);
    const aiResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 5000,
        temperature: 0.7,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Rewrite this blog post following all rules:\n\n${cleanHtml}` }]
    });

    // 3. Parse response
    const rawContent = aiResponse.content[0].text;
    const cleanContent = rawContent.replace(/```json|```/g, '').trim();
    let parsedData;
    try {
        parsedData = JSON.parse(cleanContent);
    } catch (e) {
        console.error('[ERROR] JSON parse failed. Raw output saved for debug.');
             fs.writeFileSync(`./backups/parse-error-${Date.now()}.txt`, rawContent, 'utf-8');
             throw new Error('Claude returned invalid JSON');
    }

    // 4. Backup raw parsed data
    const backupDir = './backups';
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    const backupFile = `${backupDir}/backup-${post.id}-${Date.now()}.json`;
    fs.writeFileSync(backupFile, JSON.stringify(parsedData, null, 2), 'utf-8');
    console.log(`[BACKUP] Saved to: ${backupFile}`);

    // 5. Log cost
    const { input_tokens, output_tokens } = aiResponse.usage;
    const cost = (input_tokens * 0.000003) + (output_tokens * 0.000015);
    console.log(`[COST]   $${cost.toFixed(4)} (~${Math.round(cost * 25400).toLocaleString()} VNĐ)`);
    console.log(`[USAGE]  Input: ${input_tokens} | Output: ${output_tokens}`);

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

    // 10. Push to Ghost via Lexical JSON
    const latestPost = await ghost.posts.read({ id: post.id });

    const lexicalDoc = JSON.stringify({
        root: {
            children: [{ type: 'html', version: 1, html: finalHtml }],
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
    
    // 1. Smart Word Wrapping
    const words = title.toUpperCase().split(' ');
    const lines = [];
    let currentLine = '';
    const charLimit = 12; // Reduced from 18 to prevent text cutoff
    
    words.forEach(word => {
        if ((currentLine + word).length > charLimit && currentLine !== '') {
            lines.push(currentLine.trim());
            currentLine = word + ' ';
        } else {
            currentLine += word + ' ';
        }
    });
    if (currentLine) lines.push(currentLine.trim());
    
    const finalLines = lines.slice(0, 5);
    const maxLineLength = Math.max(...finalLines.map(l => l.length)) || 1;

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
                    ${cta.toUpperCase()} ↗
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
                    ${cta.toUpperCase()} →
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
                    ${cta.toUpperCase()}
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
                    ${cta.toUpperCase()} →
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
                    ${cta.toUpperCase()}
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
                    ${cta.toUpperCase()}
                </text>
            </g>
        </svg>`;
    } else if (layoutIndex % 8 === 6) {
        // LAYOUT 6: Search Bar Aesthetic
        let searchQuery = finalLines[0];
        if (finalLines.length > 1) searchQuery += "...";

        let mainFontSize = Math.min(95, Math.floor(900 / (maxLineLength * 0.6)));
        let mainLineSpacing = Math.floor(mainFontSize * 1.25);

        svgOverlay = `
        <svg width="${width}" height="${height}">
            <rect width="${width}" height="${height}" fill="black" fill-opacity="0.3" />
            
            <rect x="100" y="150" width="800" height="90" rx="45" fill="white" filter="drop-shadow(0px 8px 16px rgba(0,0,0,0.15))" />
            <circle cx="160" cy="195" r="14" fill="none" stroke="#657786" stroke-width="4" />
            <line x1="170" y1="205" x2="185" y2="220" stroke="#657786" stroke-width="4" stroke-linecap="round" />
            
            <text x="210" y="205" text-anchor="start" style="fill: #1A1A1A; font-family: 'Avenir Next', sans-serif; font-size: 32px; font-weight: 500;">${searchQuery.toLowerCase()}|</text>
            
            <g transform="translate(500, 450)">
                <text text-anchor="middle" style="fill: #F9E5C9; font-family: 'Avenir Next', sans-serif; font-size: 16px; font-weight: 700; letter-spacing: 12px; text-transform: uppercase;">TOP RESULT</text>
            </g>

            <g transform="translate(500, ${520 + mainFontSize*0.8})">
                ${finalLines.map((line, i) => `<text y="${i * mainLineSpacing}" text-anchor="middle" style="fill: white; font-family: 'Avenir Next', sans-serif; font-size: ${mainFontSize}px; font-weight: 900; letter-spacing: -2px; filter: drop-shadow(0px 4px 12px rgba(0,0,0,0.5));">${line}</text>`).join('\n                ')}
            </g>

            <g transform="translate(${(width - ctaWidth) / 2}, 1300)">
                <rect width="${ctaWidth}" height="80" rx="40" fill="white" />
                <text x="${ctaWidth / 2}" y="48" text-anchor="middle" style="fill: #1A1A1A; font-family: 'Avenir Next', sans-serif; font-size: 20px; font-weight: 800; letter-spacing: 2px;">
                    ${cta.toUpperCase()} →
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
                    ${cta.toUpperCase()}
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