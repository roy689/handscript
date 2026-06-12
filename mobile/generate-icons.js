/**
 * Generates ROUND app icon / adaptive icon / splash / favicon from
 * assets/logo.png, in the "Ink & Parchment" style.
 *
 * The logo is center-cropped to a square (cover) and masked into a circle
 * (transparent corners), so it appears round everywhere.
 *
 * Run once from the `mobile` folder:
 *     npm install jimp@0.22.12      (already installed if you ran this before)
 *     node generate-icons.js
 *
 * Then rebuild:  eas build --profile preview --platform android
 * Overwrites the placeholder asset PNGs in place (app.json paths unchanged).
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

// A circular crop of the logo at the given diameter (transparent corners).
function circularLogo(logo, diameter) {
  const c = logo.clone();
  c.cover(diameter, diameter); // center-square crop, scaled to cover
  c.circle();                  // mask to a circle → transparent corners
  return c;
}

async function build() {
  const logo = await Jimp.read(LOGO);

  // 1) App icon — 1024×1024, round logo on cream (iOS needs opaque corners;
  //    iOS/Android then apply their own squircle/circle mask on top).
  {
    const size = 1024;
    const canvas = await makeCanvas(size, size, CREAM);
    const circ = circularLogo(logo, Math.round(size * 0.88));
    canvas.composite(circ, (size - circ.bitmap.width) / 2, (size - circ.bitmap.height) / 2);
    await canvas.writeAsync(path.join(ASSETS, 'icon.png'));
    console.log('✓ icon.png (round)');
  }

  // 2) Android adaptive foreground — 1024×1024, transparent, round logo in the
  //    ~64% safe zone (Android masks to a circle/squircle automatically).
  {
    const size = 1024;
    const canvas = await makeCanvas(size, size, TRANSPARENT);
    const circ = circularLogo(logo, Math.round(size * 0.64));
    canvas.composite(circ, (size - circ.bitmap.width) / 2, (size - circ.bitmap.height) / 2);
    await canvas.writeAsync(path.join(ASSETS, 'adaptive-icon.png'));
    console.log('✓ adaptive-icon.png (round)');
  }

  // 3) Splash icon — 1024×1024, transparent, round logo centered
  //    (shown on the cream splash background from app.json).
  {
    const size = 1024;
    const canvas = await makeCanvas(size, size, TRANSPARENT);
    const circ = circularLogo(logo, Math.round(size * 0.82));
    canvas.composite(circ, (size - circ.bitmap.width) / 2, (size - circ.bitmap.height) / 2);
    await canvas.writeAsync(path.join(ASSETS, 'splash-icon.png'));
    console.log('✓ splash-icon.png (round)');
  }

  // 4) Web favicon — 256×256, round logo on cream.
  {
    const size = 256;
    const canvas = await makeCanvas(size, size, CREAM);
    const circ = circularLogo(logo, Math.round(size * 0.92));
    canvas.composite(circ, (size - circ.bitmap.width) / 2, (size - circ.bitmap.height) / 2);
    await canvas.writeAsync(path.join(ASSETS, 'favicon.png'));
    console.log('✓ favicon.png (round)');
  }

  console.log('\nDone. All icons are now circular.');
}

build().catch((e) => {
  console.error('Icon generation failed:', e);
  process.exit(1);
});
