/**
 * upload-pins.js — Upload pin images lên Drive + ghi schedule vào Google Sheet
 * Dùng khi engine.js bị crash ở bước Drive/Sheet nhưng pin files đã được lưu.
 *
 * Usage:
 *   node upload-pins.js <slug>
 *   node upload-pins.js best-retinol-for-beginners-sensitive-skin
 *   node upload-pins.js          ← tự động lấy backup mới nhất
 */

const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ─── Config (giống engine.js) ───────────────────────────────────────────────
const PINTEREST = {
    siteUrl:        'https://glamgirlshaven.com',
    driveFolder:    '1p1_NFTpt-j4XLIHxpgvqL9JHWAXiAi3V',
    sheetId:        '1ukj-MajaswMa5gDeUg_JV0jAQ2dgQl7da_JSO22YGuY',
    sheetName:      'AFFILIATE',
    daysBetweenPins: 2,
    postingHour:    9,   // 9 AM Vietnam = 9 PM EST
};

const googleAuth = new GoogleAuth({
    scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/spreadsheets'
    ]
});

// ─── Upload 1 file lên ImgBB ────────────────────────────────────────
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

// ─── Ghi schedule vào Google Sheet ─────────────────────────────────────────
async function appendToSheet(rows) {
    const token = await googleAuth.getAccessToken();
    await axios.post(
        `https://sheets.googleapis.com/v4/spreadsheets/${PINTEREST.sheetId}/values/${encodeURIComponent(PINTEREST.sheetName)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { values: rows },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
    const backupsDir = './backups';
    const slugArg = process.argv[2];

    // Tìm pins JSON file
    const allJsonFiles = fs.readdirSync(backupsDir)
        .filter(f => f.startsWith('pins-') && f.endsWith('.json'))
        .map(f => ({ f, mtime: fs.statSync(path.join(backupsDir, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime);

    let pinsFile;
    if (slugArg) {
        pinsFile = allJsonFiles.find(({ f }) => f.includes(slugArg));
        if (!pinsFile) {
            console.error(`❌ Không tìm thấy file pins-${slugArg}*.json trong ./backups/`);
            process.exit(1);
        }
    } else {
        pinsFile = allJsonFiles[0];
        if (!pinsFile) {
            console.error('❌ Không có pins JSON nào trong ./backups/');
            process.exit(1);
        }
    }

    const pinsJsonPath = path.join(backupsDir, pinsFile.f);
    const pinsData = JSON.parse(fs.readFileSync(pinsJsonPath, 'utf-8'));
    console.log(`\n📌 Pins JSON: ${pinsFile.f}`);

    // Lấy slug từ tên file (pins-<slug>-<ts>.json)
    const slugMatch = pinsFile.f.match(/^pins-(.+)-\d+\.json$/);
    const slug = slugMatch ? slugMatch[1] : 'unknown-slug';
    const postUrl = `${PINTEREST.siteUrl}/${slug}/`;
    console.log(`🔗 Post URL: ${postUrl}`);

    // Tìm image files tương ứng (cùng slug, cùng timestamp)
    const ts = pinsFile.f.match(/(\d+)\.json$/)?.[1] || '';
    const imageFiles = fs.readdirSync(backupsDir)
        .filter(f => f.startsWith(`${slug}-pin`) && f.endsWith('.webp') && f.includes(ts))
        .sort(); // sort để đúng thứ tự pin1, pin2, pin3...

    console.log(`🖼  Found ${imageFiles.length} image files:\n  ${imageFiles.join('\n  ')}\n`);

    if (imageFiles.length === 0) {
        console.error('❌ Không tìm thấy image files! Kiểm tra lại ./backups/');
        process.exit(1);
    }

    // Upload từng pin lên ImgBB
    console.log('[IMGBB] Uploading pins...');
    const mediaLinks = [];
    for (let i = 0; i < imageFiles.length; i++) {
        const imgPath = path.join(backupsDir, imageFiles[i]);
        const buffer = fs.readFileSync(imgPath);
        try {
            const link = await uploadToImgbb(buffer, imageFiles[i]);
            mediaLinks.push(link);
            console.log(`  Pin ${i + 1} ✅ ${link}`);
        } catch (e) {
            mediaLinks.push('');
            console.error(`  Pin ${i + 1} ❌ ${e.message}`);
        }
    }

    // Ghi schedule vào Sheet
    console.log('\n[SHEET] Scheduling pins...');
    const startDate = new Date();
    startDate.setDate(startDate.getDate() + 1);
    startDate.setHours(PINTEREST.postingHour, 0, 0, 0);
    const pad = n => String(n).padStart(2, '0');

    const rows = pinsData.map((pin, i) => {
        let dateStr;
        if (i === 0) {
            const pinDate = new Date(startDate);
            dateStr = `${pinDate.getFullYear()}-${pad(pinDate.getMonth()+1)}-${pad(pinDate.getDate())} ${pad(pinDate.getHours())}:00:00`;
        } else {
            dateStr = `=INDIRECT("F"&ROW()-1) + ${PINTEREST.daysBetweenPins}`;
        }
        const keywords = pin.keywords || (pin.description || '').match(/#\w+/g)?.map(t=>t.replace('#','')).join(', ') || '';

        return [
            pin.hook_title  || '',
            pin.description || '',
            postUrl,
            mediaLinks[i]   || '',
            pin.board       || '',
            dateStr,
            keywords
        ];
    });

    await appendToSheet(rows);

    console.log(`\n✅ Xong! ${rows.length} pins đã được schedule:`);
    rows.forEach((r, i) => {
        console.log(`  Pin ${i+1}: "${r[0].substring(0, 45)}" → ${r[5]}  ${r[3] ? '✅ Drive' : '⚠️  No img'}`);
    });
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
