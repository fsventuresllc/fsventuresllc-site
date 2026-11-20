#!/usr/bin/env node
// The portfolio list on fsventuresllc.com, generated from ONE data file (cs-015).
//
// scripts/marketing/portfolio.json is the only place a product is listed. It is written by the
// saas-factory control repo (bin/site-portfolio.mjs), which puts every product whose stage is
// launch or later on it automatically (Michael, 2026-11-20). Nobody edits the lists by hand.
//
// This script stamps that file into every place the site lists products:
//   public/portfolio.html, public/index.html  <!-- portfolio-list:start/end -->  (full entries)
//   scripts/marketing/footer.html              <!-- portfolio-names:start/end --> (names only)
//   public/llms.txt                            the "## Products" section
// then sync-partials.mjs carries the footer into every page.
//
//   node scripts/marketing/build-portfolio.mjs          rewrite from portfolio.json
//   node scripts/marketing/build-portfolio.mjs --check  exit 1 if anything has drifted (CI)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const check = process.argv.includes('--check');

const products = JSON.parse(readFileSync(join(here, 'portfolio.json'), 'utf8')).products;
for (const p of products) {
  for (const k of ['slug', 'name', 'blurb', 'url']) {
    if (!p[k] || typeof p[k] !== 'string') throw new Error(`portfolio.json: ${p.slug || '?'} lacks ${k}`);
  }
  if (!/^https:\/\//.test(p.url)) throw new Error(`portfolio.json: ${p.slug} url must be https`);
}

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const utm = (url) => {
  const u = new URL(url);
  u.searchParams.set('utm_source', 'fsventuresllc');
  u.searchParams.set('utm_medium', 'portfolio');
  return u.toString();
};
const host = (url) => new URL(url).hostname.replace(/^www\./, '');

// heading: h2 on the portfolio page (its own h1 above), h3 inside the home page's Portfolio h2.
const list = (heading, indent) =>
  [
    `${indent}<ul class="product-list">`,
    ...products.flatMap((p) => [
      `${indent}  <li>`,
      `${indent}    <${heading}>${esc(p.name)}</${heading}>`,
      `${indent}    <p>${esc(p.blurb)}</p>`,
      `${indent}    <a class="visit" href="${esc(utm(p.url))}">Visit ${esc(host(p.url))}</a>`,
      `${indent}  </li>`,
    ]),
    `${indent}</ul>`,
  ].join('\n');

const names = (indent) =>
  products.map((p) => `${indent}<a href="${esc(utm(p.url))}">${esc(p.name)}</a>`).join('\n');

const llms = [
  '## Products',
  '',
  ...products.map((p) => `- [${p.name}](${p.url}): ${p.blurb}`),
  '',
].join('\n');

const targets = [
  { file: 'public/portfolio.html', marker: 'portfolio-list', body: (i) => list('h2', i) },
  { file: 'public/index.html', marker: 'portfolio-list', body: (i) => list('h3', i) },
  { file: 'scripts/marketing/footer.html', marker: 'portfolio-names', body: (i) => names(i) },
];

const problems = [];
const write = (rel, before, after) => {
  if (before === after) return;
  if (check) problems.push(`${rel}: differs from portfolio.json`);
  else {
    writeFileSync(join(root, rel), after);
    console.log(`updated ${rel}`);
  }
};

for (const t of targets) {
  const html = readFileSync(join(root, t.file), 'utf8');
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
const txt = readFileSync(join(root, llmsPath), 'utf8');
const m = txt.match(/## Products\n[\s\S]*?(?=\n## |$)/);
if (!m) problems.push(`${llmsPath}: needs a "## Products" section`);
else write(llmsPath, txt, txt.replace(m[0], llms.replace(/\n$/, '')));

if (problems.length) {
  console.error(problems.map((p) => `  - ${p}`).join('\n'));
  console.error('Portfolio check failed. Run: node scripts/marketing/build-portfolio.mjs && node scripts/marketing/sync-partials.mjs');
  process.exit(1);
}
console.log(check ? `portfolio OK (${products.length} products)` : `portfolio built (${products.length} products)`);
