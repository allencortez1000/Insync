// Builds docs/Insync-User-Manual.pdf from docs/manual/manual.html (headless Edge).
// Two passes: the first finds the page of every heading, the second prints the table of
// contents with real page numbers.   cd e2e && node build-manual.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'docs', 'manual', 'manual.html');
const out = path.join(here, '..', 'docs', 'Insync-User-Manual.pdf');

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
await page.goto(pathToFileURL(src).href, { waitUntil: 'load' });
const broken = await page.evaluate(() => [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute('src')));
if (broken.length) { console.error('Missing images:', broken.join(', ')); process.exit(1); }

// Table of contents + invisible page markers.
const count = await page.evaluate(() => {
  const toc = document.getElementById('toc');
  const heads = [...document.querySelectorAll('h1[id], h2[id]')];
  for (const h of heads) {
    const li = document.createElement('li');
    li.className = h.tagName === 'H1' ? 'l1' : 'l2';
    const num = h.querySelector('.n')?.textContent ?? '';
    const title = [...h.childNodes].filter((n) => !(n.nodeType === 1 && n.classList.contains('n'))).map((n) => n.textContent).join('').trim();
    li.innerHTML = `<a href="#${h.id}">${num ? `${num}&nbsp;&nbsp;` : ''}${title.replace(/&/g, '&amp;')}</a><span class="dots"></span><a class="pg" href="#${h.id}" data-for="${h.id}">00</a>`;
    toc.appendChild(li);
    const mk = document.createElement('span');
    mk.className = 'mk';
    mk.textContent = `@@${h.id}@@`;
    h.appendChild(mk);
  }
  return heads.length;
});

const footer = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:7.5pt;color:#6b7280;width:100%;padding:0 15mm;display:flex;justify-content:space-between">
  <span>Insync — User Manual</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
const pdfOptions = { format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footer };

const first = await page.pdf(pdfOptions);
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({ data: new Uint8Array(first), verbosity: 0 }).promise;
const pages = {};
for (let p = 1; p <= doc.numPages; p++) {
  const text = (await (await doc.getPage(p)).getTextContent()).items.map((i) => i.str).join('');
  for (const m of text.matchAll(/@@([a-z0-9-]+)@@/g)) pages[m[1]] ??= p;
}
const missing = await page.evaluate((map) => {
  const miss = [];
  for (const a of document.querySelectorAll('#toc .pg')) {
    const p = map[a.dataset.for];
    if (p) a.textContent = String(p); else { a.textContent = ''; miss.push(a.dataset.for); }
  }
  for (const m of document.querySelectorAll('.mk')) m.remove();
  return miss;
}, pages);

await page.pdf({ ...pdfOptions, path: out });
await browser.close();
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`${path.relative(path.join(here, '..'), out)}: ${doc.numPages} pages, ${count} headings in contents, ${kb} KB${missing.length ? `; no page found for: ${missing.join(', ')}` : ''}`);
