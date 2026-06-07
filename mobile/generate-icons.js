/**
 * Generates the app icon / adaptive icon / splash / favicon from assets/logo.png,
 * in the "Ink & Parchment" style (logo centered on warm cream).
 *
 * Run once from the `mobile` folder:
 *     npm install jimp@0.22.12
 *     node generate-icons.js
 *
 * Then rebuild (eas build ...). Overwrites the placeholder asset PNGs in place,
 * so app.json paths stay the same.
 */

const path = require('path');
const Jimp = require('jimp');

const ASSETS = path.join(__dirname, 'assets');
const LOGO = path.join(ASSETS, 'logo.png');

const CREAM = 0xF4EFE6FF;        // parchment background (matches app.json)
const TRANSPARENT = 0x00000000;

function makeCanvas(w, h, color) {
  return new Promise((resolve, reject) => {
    new Jimp(w, h, color, (err, image) => (err ? reject(err) : resolve(image)));
  });
}

async function build() {
  const logo = await Jimp.read(LOGO);

  // 1) App icon — 1024×1024, logo centered on cream with padding.
  {
    const size = 1024;
    const canvas = await makeCanvas(size, size, CREAM);
    const l = logo.clone();
    l.scaleToFit(Math.round(size * 0.80), Math.round(size * 0.80));
    canvas.composite(l, (size - l.bitmap.width) / 2, (size - l.bitmap.height) / 2);
    await canvas.writeAsync(path.join(ASSETS, 'icon.png'));
    console.log('✓ icon.png');
  }

  // 2) Android adaptive foreground — 1024×1024, transparent, logo in the
  //    ~62% safe zone (Android masks/crops the outer ring).
  {
    const size = 1024;
    const canvas = await makeCanvas(size, size, TRANSPARENT);
    const l = logo.clone();
    l.scaleToFit(Math.round(size * 0.60), Math.round(size * 0.60));
    canvas.composite(l, (size - l.bitmap.width) / 2, (size - l.bitmap.height) / 2);
    await canvas.writeAsync(path.join(ASSETS, 'adaptive-icon.png'));
    console.log('✓ adaptive-icon.png');
  }

  // 3) Splash icon — 1200×1200, transparent, logo large & centered
  //    (shown on the cream splash background set in app.json).
  {
    const size = 1200;
    const canvas = await makeCanvas(size, size, TRANSPARENT);
    const l = logo.clone();
    l.scaleToFit(Math.round(size * 0.72), Math.round(size * 0.72));
    canvas.composite(l, (size - l.bitmap.width) / 2, (size - l.bitmap.height) / 2);
    await canvas.writeAsync(path.join(ASSETS, 'splash-icon.png'));
    console.log('✓ splash-icon.png');
  }

  // 4) Web favicon — 256×256 on cream.
  {
    const size = 256;
    const canvas = await makeCanvas(size, size, CREAM);
    const l = logo.clone();
    l.scaleToFit(Math.round(size * 0.84), Math.round(size * 0.84));
    canvas.composite(l, (size - l.bitmap.width) / 2, (size - l.bitmap.height) / 2);
    await canvas.writeAsync(path.join(ASSETS, 'favicon.png'));
    console.log('✓ favicon.png');
  }

  console.log('\nDone. All icons regenerated from logo.png.');
}

build().catch((e) => {
  console.error('Icon generation failed:', e);
  process.exit(1);
});
