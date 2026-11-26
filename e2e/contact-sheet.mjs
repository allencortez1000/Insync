// Combines rendered page PNGs into contact sheets (8 pages each) for a quick layout check.
//   node contact-sheet.mjs <pagesDir>
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => /^p\d+\.png$/.test(f)).sort();
const cols = 4, rows = 2, w = 372, h = 526, pad = 8;
for (let i = 0, n = 1; i < files.length; i += cols * rows, n++) {
  const canvas = createCanvas(cols * (w + pad) + pad, rows * (h + pad + 14) + pad);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#6b7280'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let k = 0; k < cols * rows && i + k < files.length; k++) {
    const img = await loadImage(path.join(dir, files[i + k]));
    const x = pad + (k % cols) * (w + pad), y = pad + Math.floor(k / cols) * (h + pad + 14);
    ctx.drawImage(img, x, y + 14, w, h);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.fillText(files[i + k].replace('.png', ''), x + 2, y + 11);
  }
  fs.writeFileSync(path.join(dir, `sheet${n}.png`), canvas.toBuffer('image/png'));
}
console.log('sheets written');
