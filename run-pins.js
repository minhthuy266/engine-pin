require('dotenv').config();
const fs = require('fs');

let engineCode = fs.readFileSync('engine.js', 'utf8');
engineCode = engineCode.replace('bootEngine();', '');

eval(engineCode);

const backup = JSON.parse(fs.readFileSync('./backups/backup-69d0c5ebbb15840001a5421e-1775409420717.json', 'utf8'));

generatePins(backup.seo_title, backup.rewritten_html, backup.seo_slug)
  .then(() => {
    console.log('Successfully regenerated pins!');
    process.exit(0);
  })
  .catch(err => {
    console.error('Error generating pins:', err);
    process.exit(1);
  });
