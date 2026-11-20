#!/usr/bin/env node
// Re-capture the portfolio screenshots on fsventuresllc.com from each product's live homepage (cs-016).
//
// For every product in scripts/marketing/portfolio.json (or only the --only=<slug> ones), this opens
// its url in Chromium at 1280x800, takes the above-the-fold view, encodes it as WebP (stepping the
// quality down until the file is under 150 KB) and writes public/assets/portfolio/<slug>.webp.
// build-portfolio.mjs then shows it on /portfolio.html when the entry's `screenshot` field points at it.
//
//   node scripts/marketing/capture-screenshots.mjs                 every product
//   node scripts/marketing/capture-screenshots.mjs --only=a,b      just these slugs
//   node scripts/marketing/capture-screenshots.mjs --missing       only products with no file yet
//
// Needs Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`). It is not
// a dependency of this repo and never runs in CI: screenshots are committed images, reviewed in the PR.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const outDir = join(root, 'public', 'assets', 'portfolio');
const MAX_BYTES = 150 * 1024;
const VIEWPORT = { width: 1280, height: 800 };

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const missingOnly = process.argv.includes('--missing');

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -g playwright && npx playwright install chromium');
  process.exit(1);
}

const products = JSON.parse(readFileSync(join(here, 'portfolio.json'), 'utf8')).products.filter(
  (p) =>
    (!only.length || only.includes(p.slug)) &&
    (!missingOnly || !existsSync(join(outDir, `${p.slug}.webp`))),
);
if (!products.length) {
  console.log('nothing to capture');
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const failures = [];
try {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const encoder = await context.newPage();
  for (const p of products) {
    const page = await context.newPage();
    try {
      await page.goto(p.url, { waitUntil: 'load', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1_000); // web fonts and entrance transitions settle
      const png = await page.screenshot({ type: 'png' }); // viewport only: above the fold
      // Chromium encodes WebP through a canvas, so no image library is needed.
      const webp = await encoder.evaluate(
        async ({ b64, max }) => {
          const img = new Image();
          img.src = `data:image/png;base64,${b64}`;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          let out = '';
          for (const q of [0.82, 0.75, 0.68, 0.6, 0.5, 0.4]) {
            out = c.toDataURL('image/webp', q).split(',')[1];
            if (out.length * 0.75 < max) break;
          }
          return out;
        },
        { b64: png.toString('base64'), max: MAX_BYTES },
      );
      const buf = Buffer.from(webp, 'base64');
      writeFileSync(join(outDir, `${p.slug}.webp`), buf);
      console.log(`captured ${p.slug}.webp (${Math.round(buf.length / 1024)} KB) from ${p.url}`);
    } catch (e) {
      failures.push(`${p.slug}: ${e.message.split('\n')[0]}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
