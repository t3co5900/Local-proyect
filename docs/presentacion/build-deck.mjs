// Arma el PDF de la presentación a partir de slides.json + las imágenes de assets/.
//
//   node docs/presentacion/build-deck.mjs --slides=docs/presentacion/slides.json --assets=<carpeta> \
//        --out=docs/Mr.Cook-POS-presentacion.pdf [--preview=<carpeta-con-PNG-por-diapositiva>]
//
// <assets> debe contener manifest.json, jpg/*.jpg y logo-black.png / logo-white.png
// (los genera scripts/demo/capture-screens.mjs). Variable: CHROMIUM_PATH.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { makeRenderer } from './render-slides.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const slidesFile = path.resolve(args.slides || path.join(here, 'slides.json'));
const assets = path.resolve(args.assets || path.join(here, 'assets'));
const outPdf = path.resolve(args.out || path.join(root, 'docs', 'Mr.Cook-POS-presentacion.pdf'));
const previewDir = args.preview ? path.resolve(args.preview) : null;
const chromePath = process.env.CHROMIUM_PATH || [
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p));

const slides = JSON.parse(fs.readFileSync(slidesFile, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'manifest.json'), 'utf8'));
const render = makeRenderer({ manifest });
let html;
try { html = render(slides); } catch (e) { console.error(`ERROR de contenido: ${e.message}`); process.exit(2); }

const fontsDir = path.join(root, 'node_modules', '@fontsource', 'nunito', 'files');
const fontFaces = [400, 600, 700, 800, 900].map((w) => `@font-face{font-family:'Nunito';font-weight:${w};src:url('${pathToFileURL(path.join(fontsDir, `nunito-latin-${w}-normal.woff2`))}') format('woff2');}`).join('\n');
const css = fs.readFileSync(path.join(here, 'deck.css'), 'utf8');
const doc = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Mr.Cook POS — guía para el local</title><style>${fontFaces}\n${css}</style></head><body>${html}</body></html>`;
const htmlFile = path.join(assets, 'deck.html');
fs.writeFileSync(htmlFile, doc);

const browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  // control de desbordes: nada tiene que quedar fuera de su diapositiva
  // (lo de adentro de .frame se ignora: las imágenes recortadas son más grandes que su marco, que las corta)
  const issues = await page.evaluate(() => [...document.querySelectorAll('.slide')].map((s, i) => {
    const c = s.querySelector('.content');
    if (!c) return null;
    const cb = c.getBoundingClientRect();
    let maxB = 0; let maxR = 0;
    c.querySelectorAll('*').forEach((e) => { if (e.closest('.frame') && !e.classList.contains('frame')) return; const r = e.getBoundingClientRect(); if (r.width && r.height) { maxB = Math.max(maxB, r.bottom); maxR = Math.max(maxR, r.right); } });
    const b = Math.round(maxB - cb.bottom); const r = Math.round(maxR - cb.right);
    // contenedores centrados o flexibles: ningún hijo puede pasarse de su caja (arriba ni abajo)
    let inner = 0;
    c.querySelectorAll('.dia, .cols, .two, .cards, .faq, .chk, .cheat, .cmp').forEach((box) => {
      const bb = box.getBoundingClientRect();
      [...box.children].forEach((k) => { const kb = k.getBoundingClientRect(); inner = Math.max(inner, Math.round(bb.top - kb.top), Math.round(kb.bottom - bb.bottom)); });
    });
    return b > 2 || r > 2 || inner > 2 ? { page: i + 1, id: s.dataset.id, overflowBottomPx: Math.max(b, 0), overflowRightPx: Math.max(r, 0), overflowInnerPx: Math.max(inner, 0) } : null;
  }).filter(Boolean));

  fs.mkdirSync(path.dirname(outPdf), { recursive: true });
  await page.pdf({ path: outPdf, width: '1280px', height: '720px', printBackground: true, preferCSSPageSize: true });

  if (previewDir) {
    fs.mkdirSync(previewDir, { recursive: true });
    const n = slides.length;
    for (let i = 0; i < n; i++) await page.locator('.slide').nth(i).screenshot({ path: path.join(previewDir, `${String(i + 1).padStart(2, '0')}-${slides[i].id}.png`) });
  }
  const size = (fs.statSync(outPdf).size / 1e6).toFixed(1);
  console.log(JSON.stringify({ pdf: outPdf, slides: slides.length, megabytes: Number(size), overflow: issues }, null, 2));
  if (issues.length) process.exitCode = 3;
} finally {
  await browser.close();
}
