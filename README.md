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

Deploys (cs-013): the service uses Render's `autoDeployTrigger: checksPass`, so a commit on `main`
deploys only after every GitHub check on it has passed (the `API` workflow: tests, typecheck, build).
No Blueprint is attached, so `render.yaml` is documentation: change the live setting through the
Render API and read it back. `api/src/renderConfig.test.ts` fails if `render.yaml` drops the trigger.

`npm ci && npm test --workspace=api && npm run typecheck --workspace=api`. Env vars follow the
three-place rule (`api/.env.example`, `api/src/env.ts`, `render.yaml` with `sync: false`).

## Shared header and footer

Every page renders the same header and footer. Each lives once, in `scripts/marketing/header.html`
and `scripts/marketing/footer.html`, and `node scripts/marketing/sync-partials.mjs` stamps them into
every page between `<!-- site-header:start/end -->` and `<!-- site-footer:start/end -->` markers.
Their links are root-relative (`/portfolio.html`) because `public/404.html` is served at any missing
path. To change either, edit the partial and run the sync. To add a page, copy `scripts/marketing/page-template.html` into `public/`,
add the URL to `public/sitemap.xml`, and run the sync. The `Marketing footer` CI workflow fails if any page
drifts or lacks the markers.

## Security CI (cs-012, port of template-web tw-026..tw-032)

- **Lockfile installs** (tw-026): CI and Render both run `npm ci` from the root `package-lock.json`.
- **CVE gate** (tw-027): the `API` workflow's job runs `audit-ci` (exact root devDependency, `npx --no-install`)
  and fails on any high or critical advisory. A waiver lives only in `security/audit-allowlist.json` (id,
  reason, owner, expiry at most 90 days out); `node scripts/ci/audit-allowlist.mjs --write` regenerates
  `audit-ci.json` (never edit it by hand). cs-012 moved `zod` 3 -> 4.6.7 to clear GHSA-mrhx-c7xc-m3w5.
- **Secrets and SAST** (tw-028): the same job runs gitleaks over the PR's commits and Semgrep CE over `api/src`
  and `scripts` (`scripts/ci/security-scan.sh`); a Semgrep finding not in the reviewed
  `security/semgrep-baseline.json` fails. Fix real findings; baseline only a false positive, with a reason.
  This repo is public, so GitHub's own secret scanning and push protection are free; turning them on is a repo
  setting for Michael.
- **New dependencies and licences** (tw-029): `deps.yml`, only on PRs that change package files.
  `scripts/ci/dep-review.mjs` flags a new package with an install script, a typosquat-like name or a version
  under 14 days old; the `deps-reviewed` label clears the flags only when last added by a login in
  `security/deps-reviewers.json`, and stops counting once a later push changes `package-lock.json`.
  `scripts/ci/license-check.mjs` fails GPL/AGPL/unknown unless allowlisted in `security/license-allowlist.json`.
  Never make `Dependency review` a required check (it is path-filtered).
- **Workflow hardening** (tw-030): `node scripts/ci/workflow-lint.mjs` fails on an action not pinned to a
  40-character SHA with a `# vX.Y.Z` comment, a missing read-only top-level `permissions:`,
  `pull_request_target`, secrets in a PR-reachable workflow, a checkout that keeps its token, an unpinned
  `npx --yes`, or a `git push` (no workflow pushes to `main`).
- **Weekly re-audit** (tw-031): `security-weekly.yml` (Monday 07:41 UTC) runs the audit, the licence check,
  gitleaks over the full history and Semgrep `--strict`, and keeps one GitHub issue per finding (labels
  `security` + `critical`/`high`, due 48 h / 7 days from first seen).
- **Dependabot** (tw-032): `.github/dependabot.yml`, weekly grouped patch/minor PRs (labelled `automerge`
  by `dependabot-policy.yml`), majors one per dependency (labelled `needs-joe`, never merged automatically).
- Run locally: `node --test scripts/ci/*.test.mjs && node scripts/ci/workflow-lint.mjs`.

## Portfolio list (cs-015)

Every product the site lists comes from `scripts/marketing/portfolio.json`, which the saas-factory
control repo writes (`bin/site-portfolio.mjs`): any app at stage launch or later, not internal or
paused, is on it automatically, and the night run opens a `portfolio-sync` PR when the set changes.
`node scripts/marketing/build-portfolio.mjs` stamps it into `/portfolio.html`, the home Portfolio
section, the footer's product names and `llms.txt`; CI fails if any of them drift. Never hand-edit
those lists. `/products.html` is retired: a Render redirect rule sends it to `/portfolio.html`.

Rich entries (cs-016): each product may also carry `description` (2-3 sentences), `highlights` (up to 5
bullets), `screenshot` (`/assets/portfolio/<slug>.webp`) and `sticker` (`/assets/stickers/<slug>.svg`).
`/portfolio.html` shows them; the home page shows a compact card (sticker, name, blurb). An entry without
them falls back to the blurb with no images. Screenshots are the product's live homepage at 1280x800,
WebP under 150 KB: `node scripts/marketing/capture-screenshots.mjs --only=<slug>` (or `--missing`)
re-captures them (needs Playwright locally; never runs in CI). Sticker SVGs are hand-drawn, use
presentation attributes only (no `<style>`, no external refs) so the CSP holds, and are tested for it.

## Visual identity (cs-016)

Colour, type and spacing tokens live at the top of `public/style.css` (contrast ratios noted beside
them). The header is a CSS-only menu (no script under the CSP). Illustrations are self-hosted SVGs in
`public/assets/` (`hero.svg`, `logo-mark.svg`, `stickers/`).

## Company page (cs-017)

`/company.html` holds the company intro, the two founders, the principles, the legal facts card and the
contact band; the home page keeps only a short teaser that links to it. The founder portraits
(`public/assets/founders/michael.svg`, `todd.svg`) are PLACEHOLDER cartoon busts, not likenesses: to swap in
the real caricatures, replace each file (keep a square image, its `role="img"` and `aria-label`, and the
SVG hygiene the tests check: no `<style>`, script or external refs).
