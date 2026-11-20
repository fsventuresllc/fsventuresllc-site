// Tests for sync-partials.mjs (marketing footer standard). Run: node --test scripts/marketing/sync-partials.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'sync-partials.mjs');
const realPages = join(here, '..', '..', 'public');
const footer = readFileSync(join(here, 'footer.html'), 'utf8').trimEnd();
const header = readFileSync(join(here, 'header.html'), 'utf8').trimEnd();

function run(dir, ...args) {
  return spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, MARKETING_DIR: dir },
    encoding: 'utf8',
  });
}

const page = (footerMarkers = true) =>
  [
    '<!doctype html><html><head><meta charset="utf-8" /></head><body>',
    '<!-- site-header:start -->\n<!-- site-header:end -->',
    footerMarkers ? '<!-- site-footer:start -->\n<!-- site-footer:end -->' : '<footer>old</footer>',
    '</body></html>',
  ].join('\n');

function tmp(pages) {
  const dir = mkdtempSync(join(tmpdir(), 'mkt-'));
  for (const [name, html] of Object.entries(pages)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), html);
  }
  return dir;
}

test('the real marketing site is in sync (same check CI runs)', () => {
  const r = run(realPages, '--check');
  assert.equal(r.status, 0, r.stderr);
});

test('the new-page template carries the footer markers', () => {
  const tpl = readFileSync(join(here, 'page-template.html'), 'utf8');
  const dir = tmp({ 'new.html': tpl });
  assert.equal(run(dir).status, 0);
  assert.ok(readFileSync(join(dir, 'new.html'), 'utf8').includes(footer));
  assert.ok(readFileSync(join(dir, 'new.html'), 'utf8').includes(header));
});

test('sync stamps the footer into nested pages, then --check passes', () => {
  const dir = tmp({ 'a.html': page(), 'blog/post/index.html': page() });
  assert.equal(run(dir, '--check').status, 1);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['a.html', 'blog/post/index.html']) {
    assert.ok(readFileSync(join(dir, f), 'utf8').includes(footer), f);
    assert.ok(readFileSync(join(dir, f), 'utf8').includes(header), f);
  }
  assert.equal(run(dir, '--check').status, 0);
});

test('--check fails for a new page with a hand-written footer and no markers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mkt-'));
  cpSync(realPages, dir, { recursive: true, filter: (s) => !/node_modules|\.git/.test(s) });
  mkdirSync(join(dir, 'blog', 'new-post'), { recursive: true });
  writeFileSync(join(dir, 'blog', 'new-post', 'index.html'), page(false));
  const r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /blog\/new-post\/index\.html: needs exactly one <!-- site-footer:start -->/);
});

test('--check fails when the footer inside a page was hand-edited', () => {
  const dir = tmp({ 'a.html': page() });
  run(dir);
  const f = join(dir, 'a.html');
  writeFileSync(f, readFileSync(f, 'utf8').replace('</footer>', '<a href="/x">x</a></footer>'));
  const r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.html: footer differs from scripts\/marketing\/footer\.html/);
});

test('--check fails when a second <footer> sits outside the markers', () => {
  const html = page().replace('</body>', '<footer>stray</footer>\n</body>');
  const r = run(tmp({ 'a.html': html }), '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has a <footer> outside/);
});

test('--check fails for a sitemap URL with no page on disk', () => {
  const dir = tmp({
    'index.html': page(),
    'sitemap.xml': '<urlset><url><loc>https://example.com/blog/missing/</loc></url></urlset>',
  });
  run(dir);
  const r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /blog\/missing\/index\.html: listed in sitemap\.xml but not found/);
});

test('the publish directory holds only site files (cs-publish-scope)', () => {
  const published = readdirSync(realPages);
  for (const name of ['scripts', '.github', 'README.md', 'package.json', '.git']) {
    assert.ok(!published.includes(name), `${name} must not be under public/`);
  }
  assert.ok(published.includes('index.html'));
});

test('--check fails when a second <header> sits outside the markers', () => {
  const html = page().replace('<body>', '<body>\n<header>stray</header>');
  const r = run(tmp({ 'a.html': html }), '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has a <header> outside/);
});

// cs-polish: the shared partials and 404.html are served at arbitrary missing paths, so every
// local link in them must be root-relative. The CSP's base-uri 'none' rules out <base href>.
test('the shared partials link only with root-relative URLs', () => {
  for (const [name, html] of [['header.html', header], ['footer.html', footer]]) {
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      assert.match(href, /^(\/|mailto:|https:\/\/)/, `${name}: ${href}`);
    }
  }
});

const siteFile = (name) => readFileSync(join(realPages, name), 'utf8');
const SITE = 'https://fsventuresllc.com';

test('every sitemap page carries a canonical link to its own URL', () => {
  const locs = [...siteFile('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length >= 5);
  for (const loc of locs) {
    const path = new URL(loc).pathname;
    const html = siteFile(path === '/' ? 'index.html' : path.slice(1));
    const canon = [...html.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map((m) => m[1]);
    assert.deepEqual(canon, [loc], path);
  }
  assert.match(siteFile('index.html'), new RegExp(`<link rel="canonical" href="${SITE}/">`));
});

test('404.html is noindex, has no canonical, and loads only root-relative same-origin assets', () => {
  const html = siteFile('404.html');
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(html, /rel="canonical"/);
  assert.doesNotMatch(siteFile('sitemap.xml'), /404/);
  for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    assert.match(url, /^(\/|mailto:|https:\/\/)/, url);
  }
  // CSP default-src 'self': no inline script or style, no off-site stylesheet or script.
  assert.doesNotMatch(html, /<script|<style|style="/i);
});

test('favicon.ico is a real ICO file', () => {
  const ico = readFileSync(join(realPages, 'favicon.ico'));
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0]); // ICONDIR reserved=0, type=1 (icon)
  assert.ok(ico.readUInt16LE(4) >= 1, 'at least one image');
});

// cs-015: one data file, portfolio.json (written by saas-factory bin/site-portfolio.mjs from app
// state: every product at stage launch or later), drives every place the site lists products.
// build-portfolio.mjs stamps it; these tests prove each place matches it.
const portfolioJson = JSON.parse(readFileSync(join(here, 'portfolio.json'), 'utf8')).products;
const utmUrl = (url) => {
  const u = new URL(url);
  u.searchParams.set('utm_source', 'fsventuresllc');
  u.searchParams.set('utm_medium', 'portfolio');
  return u.toString().replace(/&/g, '&amp;');
};

test('portfolio.json lists at least the three original products, each with an https apex link', () => {
  const names = portfolioJson.map((p) => p.name);
  for (const n of ['LedgerMedic', 'Sprinklerly', 'GrantClose']) assert.ok(names.includes(n), n);
  for (const p of portfolioJson) assert.match(p.url, /^https:\/\/[a-z0-9-]+\.[a-z]+\/?$/, p.name);
});

test('product headings on portfolio.html are h2 under the page h1', () => {
  const html = siteFile('portfolio.html');
  assert.doesNotMatch(html, /<h3\b/);
  for (const p of portfolioJson) assert.match(html, new RegExp(`<h2>${p.name}</h2>`));
});

test('the portfolio page, home page, footer and llms.txt all list exactly portfolio.json', () => {
  const entries = (html, h) =>
    [...html.matchAll(new RegExp(`<li>\\s*<${h}>([^<]+)</${h}>[\\s\\S]*?<a class="visit" href="([^"]+)">Visit ([^<]+)</a>`, 'g'))]
      .map(([, name, url, label]) => ({ name, url, label }));
  const want = portfolioJson.map((p) => ({ name: p.name, url: utmUrl(p.url), label: new URL(p.url).hostname }));
  assert.deepEqual(entries(siteFile('portfolio.html'), 'h2'), want);
  assert.deepEqual(entries(siteFile('index.html'), 'h3'), want);
  assert.match(siteFile('index.html'), /<a class="more" href="\/portfolio.html">See the full portfolio<\/a>/);

  const names = [...footer.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)]
    .filter(([, href]) => href.includes('utm_medium=portfolio'))
    .map(([, href, name]) => ({ name, url: href }));
  assert.deepEqual(names, portfolioJson.map((p) => ({ name: p.name, url: utmUrl(p.url) })));

  const llms = siteFile('llms.txt');
  const llmsProducts = [...llms.matchAll(/^- \[([^\]]+)\]\((https:\/\/[^)]+)\): /gm)]
    .filter(([, , url]) => !url.startsWith('https://fsventuresllc.com'))
    .map(([, name, url]) => ({ name, url }));
  assert.deepEqual(llmsProducts, portfolioJson.map(({ name, url }) => ({ name, url })));
});

test('products.html is retired: no page links to it (Render redirects it to /portfolio.html)', () => {
  assert.ok(!existsSync(join(realPages, 'products.html')));
  for (const name of ['index.html', 'portfolio.html', 'contact.html', '404.html', 'sitemap.xml', 'llms.txt']) {
    assert.doesNotMatch(siteFile(name), /products\.html/, name);
  }
});

test('no page advertises an unlaunched product', () => {
  for (const name of ['index.html', 'portfolio.html', 'llms.txt', 'contact.html']) {
    assert.doesNotMatch(siteFile(name), /coming soon|launching soon/i, name);
  }
});
