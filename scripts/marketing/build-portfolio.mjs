#!/usr/bin/env node
// The portfolio list on fsventuresllc.com, generated from ONE data file (cs-015, rich entries cs-016).
//
// scripts/marketing/portfolio.json is the only place a product is listed. It is written by the
// saas-factory control repo (bin/site-portfolio.mjs), which puts every product whose stage is
// launch or later on it automatically (Michael, 2026-11-20). Nobody edits the lists by hand.
//
// Each product needs slug, name, blurb (one sentence) and url (https). Optional (cs-016):
//   description  2-3 plain sentences: who it is for, the problem, what it does (else: blurb)
//   highlights   up to 5 short strings, shown as bullets on /portfolio.html
//   screenshot   /assets/portfolio/<slug>.webp|png|jpg, its live homepage above the fold
//                (scripts/marketing/capture-screenshots.mjs makes it); width/height read from the file
//   screenshot_alt  alt text for it (else: "The <name> homepage at <host>")
//   sticker      /assets/stickers/<slug>.svg, the product's sticker icon
// An entry without them still renders: blurb only, no images.
//
// This script stamps that file into every place the site lists products:
//   public/portfolio.html  <!-- portfolio-list:start/end -->   rich entries (h2)
//   public/index.html      <!-- portfolio-list:start/end -->   compact cards (h3)
//   scripts/marketing/footer.html <!-- portfolio-names:start/end --> (names only)
//   public/llms.txt        the "## Products" section
// then sync-partials.mjs carries the footer into every page.
//
//   node scripts/marketing/build-portfolio.mjs          rewrite from portfolio.json
//   node scripts/marketing/build-portfolio.mjs --check  exit 1 if anything has drifted (CI)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const utm = (url) => {
  const u = new URL(url);
  u.searchParams.set('utm_source', 'fsventuresllc');
  u.searchParams.set('utm_medium', 'portfolio');
  return u.toString();
};
const host = (url) => new URL(url).hostname.replace(/^www\./, '');

// Pixel size of a PNG, JPEG or WebP file, so every <img> carries its real width and height.
export function imageSize(buf) {
  if (buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
    }
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i < buf.length - 9; ) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  throw new Error('not a PNG, JPEG or WebP file');
}

// Throws on the first problem; returns the products with screenshot sizes resolved.
export function validate(products, root = ROOT) {
  return products.map((p) => {
    for (const k of ['slug', 'name', 'blurb', 'url']) {
      if (!p[k] || typeof p[k] !== 'string') throw new Error(`portfolio.json: ${p.slug || '?'} lacks ${k}`);
    }
    if (!/^https:\/\//.test(p.url)) throw new Error(`portfolio.json: ${p.slug} url must be https`);
    for (const k of ['description', 'screenshot_alt']) {
      if (p[k] !== undefined && (typeof p[k] !== 'string' || !p[k].trim())) {
        throw new Error(`portfolio.json: ${p.slug} ${k} must be a non-empty string`);
      }
    }
    if (p.highlights !== undefined) {
      const h = p.highlights;
      if (!Array.isArray(h) || h.length > 5 || h.some((x) => typeof x !== 'string' || !x.trim())) {
        throw new Error(`portfolio.json: ${p.slug} highlights must be 1-5 non-empty strings`);
      }
    }
    const out = { ...p };
    for (const [k, dir, exts] of [
      ['screenshot', '/assets/portfolio/', /\.(webp|png|jpe?g)$/],
      ['sticker', '/assets/stickers/', /\.svg$/],
    ]) {
      if (p[k] === undefined) continue;
      if (typeof p[k] !== 'string' || !p[k].startsWith(dir) || p[k].includes('..') || !exts.test(p[k])) {
        throw new Error(`portfolio.json: ${p.slug} ${k} must be a file under ${dir} (${exts.source})`);
      }
      const file = join(root, 'public', p[k]);
      if (!existsSync(file)) {
        throw new Error(`portfolio.json: ${p.slug} ${k} ${p[k]} is not in public/ (screenshots: run scripts/marketing/capture-screenshots.mjs --only=${p.slug})`);
      }
      if (k === 'screenshot') out.shotSize = imageSize(readFileSync(file));
    }
    return out;
  });
}

const sticker = (p, size, indent) =>
  p.sticker
    ? [`${indent}<img class="sticker" src="${esc(p.sticker)}" alt="" width="${size}" height="${size}">`]
    : [];

// Rich entry for /portfolio.html.
const richEntry = (p, h, indent) => [
  `${indent}<li class="product${p.screenshot ? '' : ' no-shot'}" id="${esc(p.slug)}">`,
  `${indent}  <div class="product-text">`,
  `${indent}    <div class="product-title">`,
  ...sticker(p, 72, `${indent}      `),
  `${indent}      <${h}>${esc(p.name)}</${h}>`,
  `${indent}    </div>`,
  `${indent}    <p class="product-desc">${esc(p.description || p.blurb)}</p>`,
  ...(p.highlights?.length
    ? [
        `${indent}    <ul class="highlights">`,
        ...p.highlights.map((x) => `${indent}      <li>${esc(x)}</li>`),
        `${indent}    </ul>`,
      ]
    : []),
  `${indent}    <a class="visit" href="${esc(utm(p.url))}">Visit ${esc(host(p.url))}</a>`,
  `${indent}  </div>`,
  ...(p.screenshot
    ? [
        `${indent}  <figure class="shot">`,
        `${indent}    <img src="${esc(p.screenshot)}" width="${p.shotSize.width}" height="${p.shotSize.height}" loading="lazy" decoding="async" alt="${esc(p.screenshot_alt || `The ${p.name} homepage at ${host(p.url)}`)}">`,
        `${indent}  </figure>`,
      ]
    : []),
  `${indent}</li>`,
];

// Compact card for the home page.
const compactEntry = (p, h, indent) => [
  `${indent}<li class="product-card">`,
  ...sticker(p, 56, `${indent}  `),
  `${indent}  <${h}>${esc(p.name)}</${h}>`,
  `${indent}  <p>${esc(p.blurb)}</p>`,
  `${indent}  <a class="visit" href="${esc(utm(p.url))}">Visit ${esc(host(p.url))}</a>`,
  `${indent}</li>`,
];

export const renderList = (products, { heading, rich }, indent = '') =>
  [
    `${indent}<ul class="${rich ? 'product-list' : 'product-grid'}">`,
    ...products.flatMap((p) => (rich ? richEntry : compactEntry)(p, heading, `${indent}  `)),
    `${indent}</ul>`,
  ].join('\n');

const renderNames = (products, indent) =>
  products.map((p) => `${indent}<a href="${esc(utm(p.url))}">${esc(p.name)}</a>`).join('\n');

const renderLlms = (products) =>
  ['## Products', '', ...products.map((p) => `- [${p.name}](${p.url}): ${p.blurb}`), ''].join('\n');

function main() {
  const check = process.argv.includes('--check');
  const products = validate(JSON.parse(readFileSync(join(here, 'portfolio.json'), 'utf8')).products);
  const targets = [
    { file: 'public/portfolio.html', marker: 'portfolio-list', body: (i) => renderList(products, { heading: 'h2', rich: true }, i) },
    { file: 'public/index.html', marker: 'portfolio-list', body: (i) => renderList(products, { heading: 'h3', rich: false }, i) },
    { file: 'scripts/marketing/footer.html', marker: 'portfolio-names', body: (i) => renderNames(products, i) },
  ];

  const problems = [];
  const write = (rel, before, after) => {
    if (before === after) return;
    if (check) problems.push(`${rel}: differs from portfolio.json`);
    else {
      writeFileSync(join(ROOT, rel), after);
      console.log(`updated ${rel}`);
    }
  };

  for (const t of targets) {
    const html = readFileSync(join(ROOT, t.file), 'utf8');
    const start = `<!-- ${t.marker}:start -->`;
    const end = `<!-- ${t.marker}:end -->`;
    const s = html.indexOf(start);
    const e = html.indexOf(end);
    if (s === -1 || e === -1 || e < s) {
      problems.push(`${t.file}: needs a ${start} ... ${end} pair`);
      continue;
    }
    const lineStart = html.lastIndexOf('\n', s) + 1;
    const indent = html.slice(lineStart, s);
    const next = `${html.slice(0, s)}${start}\n${t.body(indent)}\n${indent}${html.slice(e)}`;
    write(t.file, html, next);
  }

  const llmsPath = 'public/llms.txt';
  const txt = readFileSync(join(ROOT, llmsPath), 'utf8');
  const m = txt.match(/## Products\n[\s\S]*?(?=\n## |$)/);
  if (!m) problems.push(`${llmsPath}: needs a "## Products" section`);
  else write(llmsPath, txt, txt.replace(m[0], renderLlms(products).replace(/\n$/, '')));

  if (problems.length) {
    console.error(problems.map((p) => `  - ${p}`).join('\n'));
    console.error('Portfolio check failed. Run: node scripts/marketing/build-portfolio.mjs && node scripts/marketing/sync-partials.mjs');
    process.exit(1);
  }
  console.log(check ? `portfolio OK (${products.length} products)` : `portfolio built (${products.length} products)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
