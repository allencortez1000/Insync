// Renders pages of a PDF to PNG files for visual checking.
//   node render-pdf.mjs <pdf> <outDir> [pages e.g. 1-6,12]
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

const [pdfPath, outDir, spec] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), verbosity: 0 }).promise;
const want = new Set();
for (const part of (spec ?? `1-${doc.numPages}`).split(',')) {
  const [a, b] = part.split('-').map(Number);
  for (let i = a; i <= (b ?? a); i++) if (i >= 1 && i <= doc.numPages) want.add(i);
}
for (const n of [...want].sort((x, y) => x - y)) {
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale: 1.25 });
  const canvas = createCanvas(viewport.width, viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
  fs.writeFileSync(path.join(outDir, `p${String(n).padStart(2, '0')}.png`), canvas.toBuffer('image/png'));
}
console.log(`${want.size} page(s) of ${doc.numPages} rendered to ${outDir}`);
