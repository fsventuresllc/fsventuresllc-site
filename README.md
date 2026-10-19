# fsventuresllc-site

The company website for F&S VENTURES LLC (fsventuresllc.com) — the page D&B, Apple and
Google Play look at when they verify the entity is a real operating company.

Plain static HTML/CSS. No build step, no framework, no third-party scripts, no analytics.
Deployed as a Render static site. The pages live in `public/`, which is Render's publish
directory, so `scripts/`, `.github/` and this README are never served (cs-publish-scope).

Source of truth for content decisions: `state/briefs/company-site.md` in the
`schnapf74/saas-factory` control repo.

## Shared waitlist endpoint (`api/`, cs-waitlist)

The one waitlist endpoint every paused app's teaser page posts to (Michael 2026-10-18). A small
Fastify service on a free Render web service (`fsventuresllc-waitlist`, see `render.yaml`); the
static site above is unaffected.

`POST https://fsventuresllc-waitlist.onrender.com/api/v1/waitlist`, `Content-Type: application/json`,
body `{"email", "source", "turnstile_token"}`. `source` is an app slug listed in
`api/src/sources.ts`; the page must render the Turnstile widget "F&S waitlist (teaser pages)",
site key `0x4AAAAAAFbtrCIwCZhASyIy`. Answers `200 {ok:true}`, `400 invalid_email|invalid_source|invalid_body`,
`403 captcha_failed|origin_not_allowed`, `429 rate_limited` (5/min per IP), `502 waitlist_unavailable`,
`503 waitlist_not_configured`. It never sends an email and never returns list data.

Storage: the contact is upserted into the Resend audience "Waitlist"
(`28fba1a4-6f92-4ee5-88db-5ae20bc59e7d`) with the contact property `waitlist_<slug>_at` (hyphens
become underscores) set to the ISO-8601 UTC time of the latest signup for that app. To add a teaser
app: its slug in `SOURCES`, its domain in `ALLOWED_ORIGINS`, and the domain on the Turnstile widget.
Free instances sleep when idle: a teaser form should wait up to ~60 s for the first answer.

`npm ci && npm test --workspace=api && npm run typecheck --workspace=api`. Env vars follow the
three-place rule (`api/.env.example`, `api/src/env.ts`, `render.yaml` with `sync: false`).

## Shared header and footer

Every page renders the same header and footer. Each lives once, in `scripts/marketing/header.html`
and `scripts/marketing/footer.html`, and `node scripts/marketing/sync-partials.mjs` stamps them into
every page between `<!-- site-header:start/end -->` and `<!-- site-footer:start/end -->` markers.
Their links are root-relative (`/products.html`) because `public/404.html` is served at any missing
path. To change either, edit the partial and run the sync. To add a page, copy `scripts/marketing/page-template.html` into `public/`,
add the URL to `public/sitemap.xml`, and run the sync. The `Marketing footer` CI workflow fails if any page
drifts or lacks the markers.
