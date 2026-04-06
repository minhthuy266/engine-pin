require('dotenv').config();
const fs = require('fs');

let engineCode = fs.readFileSync('engine.js', 'utf8');
// remove bootEngine
engineCode = engineCode.replace('bootEngine();', '');
eval(engineCode);

async function runImagesOnly(jsonFile, slug) {
    const pinsData = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    const timestamp = Date.now();
    console.log(`[PINTEREST] Reading 5 Pin concepts from JSON. Creating branded images...`);

    for (let i = 0; i < pinsData.length; i++) {
        const pin = pinsData[i];
        console.log(`[PINTEREST] Creating Pin ${i+1}: ${pin.type || 'Unknown'}...`);
        
        let bgBuffer;
        if (process.env.UNSPLASH_ACCESS_KEY) {
            const stock = await fetchUnsplashPhoto(pin.search_query || pin.hook_title, 'portrait');
            if (stock) bgBuffer = stock.buffer;
        }

        if (!bgBuffer) {
            console.log(`[PINTEREST] ⚡ No stock for Pin ${i+1}. Using Imagen Fallback.`);
            bgBuffer = await generateImagenFallback(pin.image_prompt, '3:4');
        }
        
        const layoutOffset = timestamp % 8;
        const brandedBuffer = await createBrandedPin(bgBuffer, pin.hook_title, pin.cta_text, i + layoutOffset);
        
        const pinSlug = pin.hook_title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
        const filename = `./backups/${slug}-${pinSlug}-${timestamp}.webp`;
        fs.writeFileSync(filename, brandedBuffer);
        console.log(`[PINTEREST] ✅ Branded Pin saved: ${filename}`);
    }
    console.log(`[SUCCESS] All pins completed.`);
}

const targetJson = './backups/pins-data-best-shampoo-for-damaged-hair-1775410753986.json';
const targetSlug = 'best-shampoo-for-damaged-hair';

runImagesOnly(targetJson, targetSlug)
    .then(() => process.exit(0))
    .catch(err => {
        console.error('Error generating pins:', err);
        process.exit(1);
    });
