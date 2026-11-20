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
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
});

test('the portfolio page, home page, footer and llms.txt all list exactly portfolio.json', () => {
  const entries = (html, h) =>
    [...html.matchAll(new RegExp(`<${h}>([^<]+)</${h}>[\\s\\S]*?<a class="visit" href="([^"]+)">Visit ([^<]+)</a>`, 'g'))]
      .map(([, name, url, label]) => ({ name, url, label }));
  const want = portfolioJson.map((p) => ({ name: p.name, url: utmUrl(p.url), label: new URL(p.url).hostname }));
  const list = (html) => html.slice(html.indexOf('<!-- portfolio-list:start -->'), html.indexOf('<!-- portfolio-list:end -->'));
  assert.deepEqual(entries(list(siteFile('portfolio.html')), 'h2'), want);
  assert.deepEqual(entries(list(siteFile('index.html')), 'h3'), want);
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

// cs-016: rich portfolio entries (description, highlights, screenshot, sticker), all optional.
const { renderList, validate, imageSize } = await import('./build-portfolio.mjs');
const repoRoot = join(here, '..', '..');

test('every rich field in portfolio.json renders on /portfolio.html, with a lazy, sized, described screenshot', () => {
  const html = siteFile('portfolio.html');
  for (const p of portfolioJson) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    if (p.description) assert.ok(html.includes(`<p class="product-desc">${esc(p.description)}</p>`), p.slug);
    for (const h of p.highlights || []) assert.ok(html.includes(`<li>${esc(h)}</li>`), `${p.slug}: ${h}`);
    if (p.sticker) assert.ok(html.includes(`<img class="sticker" src="${p.sticker}" alt="" width="72" height="72">`), p.slug);
    if (p.screenshot) {
      const img = html.match(new RegExp(`<img src="${p.screenshot}"[^>]*>`));
      assert.ok(img, `${p.slug}: screenshot img`);
      assert.match(img[0], /width="\d+" height="\d+" loading="lazy" decoding="async" alt="[^"]{10,}"/);
    }
  }
});

test('the six launched products all carry the rich fields, and each screenshot is a 1280x800 image under 150 KB', () => {
  for (const p of portfolioJson) {
    assert.ok(p.description && p.highlights?.length >= 3 && p.screenshot && p.sticker, p.slug);
    const buf = readFileSync(join(realPages, p.screenshot));
    assert.ok(buf.length < 150 * 1024, `${p.slug}: ${buf.length} bytes`);
    assert.deepEqual(imageSize(buf), { width: 1280, height: 800 }, p.slug);
  }
});

test('an entry without the new fields still renders: blurb, no images, no highlights', () => {
  const [p] = validate([{ slug: 'x', name: 'X App', blurb: 'Does one thing.', url: 'https://x.example' }], repoRoot);
  const rich = renderList([p], { heading: 'h2', rich: true });
  assert.match(rich, /<li class="product no-shot" id="x">/);
  assert.match(rich, /<p class="product-desc">Does one thing\.<\/p>/);
  assert.doesNotMatch(rich, /<img|class="highlights"/);
  const compact = renderList([p], { heading: 'h3', rich: false });
  assert.match(compact, /<h3>X App<\/h3>\s*<p>Does one thing\.<\/p>/);
  assert.doesNotMatch(compact, /<img/);
});

test('validate rejects bad rich fields and missing asset files', () => {
  const base = { slug: 'x', name: 'X', blurb: 'B.', url: 'https://x.example' };
  const bad = [
    [{ highlights: 'one' }, /highlights/],
    [{ highlights: ['a', ''] }, /highlights/],
    [{ description: '' }, /description/],
    [{ screenshot: 'https://cdn.example/x.webp' }, /screenshot must be a file under/],
    [{ screenshot: '/assets/portfolio/../../x.webp' }, /screenshot must be a file under/],
    [{ screenshot: '/assets/portfolio/nope.webp' }, /is not in public/],
    [{ sticker: '/assets/stickers/x.png' }, /sticker must be a file under/],
    [{ sticker: '/assets/stickers/nope.svg' }, /is not in public/],
  ];
  for (const [extra, re] of bad) assert.throws(() => validate([{ ...base, ...extra }], repoRoot), re, JSON.stringify(extra));
});

test('sticker, hero and founder SVGs are self-contained (no script, style, external refs) so the CSP holds', () => {
  const dir = join(realPages, 'assets');
  const svgs = [
    'hero.svg',
    'logo-mark.svg',
    ...readdirSync(join(dir, 'stickers')).map((f) => `stickers/${f}`),
    ...readdirSync(join(dir, 'founders')).map((f) => `founders/${f}`),
  ];
  for (const f of svgs) {
    const svg = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(svg, /<script|<style|style=|<image|href="http|xlink:href/i, f);
    assert.match(svg, /aria-label="[^"]+"/, f);
  }
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

// cs-017: the company has its own page with the founders; nothing links to the old /#company anchor.
test('company.html is a sitemap page with the shared header and footer, and the nav links to it', () => {
  const html = siteFile('company.html');
  assert.ok(html.includes(header), 'company.html: header');
  assert.ok(html.includes(footer), 'company.html: footer');
  assert.match(siteFile('sitemap.xml'), /<loc>https:\/\/fsventuresllc\.com\/company\.html<\/loc>/);
  assert.match(header, /<a href="\/company\.html">Company<\/a>/);
  assert.match(footer, /<a href="\/company\.html">Company<\/a>/);
  assert.match(html, /<body data-page="company">/);
  assert.match(siteFile('llms.txt'), /^- \[Company\]\(https:\/\/fsventuresllc\.com\/company\.html\): /m);
});

test('no page or partial links to /#company', () => {
  const pages = readdirSync(realPages).filter((f) => /\.(html|txt|xml)$/.test(f));
  for (const name of pages) assert.doesNotMatch(siteFile(name), /href="\/?#company"|\/#company/, name);
  for (const [name, html] of [['header.html', header], ['footer.html', footer]]) {
    assert.doesNotMatch(html, /#company/, name);
  }
});

test('company.html carries both founders, their portraits, the legal facts and founder JSON-LD', () => {
  const html = siteFile('company.html');
  for (const [name, file] of [['Michael Schnapf', 'michael'], ['Todd Frostad', 'todd']]) {
    assert.match(html, new RegExp(`<h3>${name}</h3>`));
    assert.match(html, new RegExp(`<img class="founder-portrait" src="/assets/founders/${file}\\.svg" width="200" height="200" alt="Illustration of ${name}">`));
    assert.ok(existsSync(join(realPages, 'assets', 'founders', `${file}.svg`)), file);
    assert.match(readFileSync(join(realPages, 'assets', 'founders', `${file}.svg`), 'utf8'), new RegExp(`aria-label="Illustration of ${name}"`));
  }
  for (const fact of ['F&amp;S VENTURES LLC', 'Delaware limited liability company', 'Minnetonka, MN 55305', 'mailto:hello@fsventuresllc.com']) {
    assert.ok(html.includes(fact), fact);
  }
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(ld['@type'], 'Organization');
  assert.deepEqual(ld.founder.map((f) => f.name), ['Michael Schnapf', 'Todd Frostad']);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  // CSP default-src 'self': no inline script other than JSON-LD, no inline style.
  assert.doesNotMatch(html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ''), /<script|<style|style="/i);
});

test('the home page keeps a short company teaser linking to /company.html and its Organization JSON-LD', () => {
  const html = siteFile('index.html');
  assert.match(html, /<a class="more" href="\/company\.html">Meet the founders<\/a>/);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(ld.name, 'F&S VENTURES LLC');
  assert.equal(ld.founder, undefined);
});
