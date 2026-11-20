#!/usr/bin/env node
// tw-029: new-dependency review on every PR that changes the lockfile. Free: GitHub's
// dependency-review-action needs paid Advanced Security on a private repo.
//
// Diffs package-lock.json between the PR base and head. A package is NEW when its name appears nowhere
// in the base lockfile (a version bump of a package already present is not new). Each new package is
// flagged when:
//   install-script  its lockfile entry has hasInstallScript: true (preinstall/install/postinstall run
//                   on every npm ci, on CI and on Render);
//   typosquat       its name is within edit distance 1-2 of a well-known package
//                   (security/typosquat-reference.json) or of a name already in the base lockfile,
//                   without being equal (1 edit for names of 3-5 characters, 2 for longer ones; names
//                   under 3 characters and siblings in the same @scope are not compared);
//   too-new         the version was published less than MIN_AGE_DAYS days ago
//                   (`npm view <name>@<version> time --json`); an unreadable publish date is a flag too.
// Any flag fails the job, unless the PR carries the label deps-reviewed added (most recently) by a login
// in security/deps-reviewers.json, read from the PR's issue events. Either way every flag is printed.
//
// cs-012 (Joe, 2026-11-10): the label stops counting when a push AFTER it changes package-lock.json. The
// PR's head at label time is the head_sha of the latest pull_request workflow run on the PR's branch created
// at or before the label (every push starts one); the label counts only while package-lock.json's blob at the
// current head equals its blob at that commit (GitHub contents API). Anything that cannot be read fails
// closed: a reviewer reads the new lockfile and adds the label again.
//
//   node scripts/ci/dep-review.mjs [--base-ref=HEAD^1] [--head-file=package-lock.json]
//     env (CI): DEPS_REVIEWED_LABEL=1 when the PR has the label, GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER,
//               PR_HEAD_SHA, PR_HEAD_REF, PR_HEAD_REPO (owner/name of the PR's head repository)
//
// The base lockfile is read with `git show <base-ref>:package-lock.json` (the PR merge commit's first
// parent is the base). Tests: dep-review.test.mjs.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { lockPackages, mapLimit, parseLock } from "./lockfile.mjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MIN_AGE_DAYS = 14;
export const LABEL = "deps-reviewed";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Damerau-Levenshtein (optimal string alignment) distance, giving up early above `max`.
 * @param {string} a @param {string} b @param {number} max
 * @returns {number} the distance, or max + 1 when it is larger than max
 */
export function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length;
  let prev2 = new Array(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

/** @param {string} name */
function bare(name) {
  return name.replace(/^@[^/]+\//, "");
}
/** @param {string} name */
function scopeOf(name) {
  return name.startsWith("@") ? name.slice(0, name.indexOf("/")) : null;
}

/**
 * The known names a new package name is suspiciously close to.
 * @param {string} name @param {Iterable<string>} known
 * @returns {{ near: string, distance: number }[]}
 */
export function typosquatMatches(name, known) {
  const out = [];
  const lower = name.toLowerCase();
  for (const k of known) {
    const kl = k.toLowerCase();
    if (kl === lower) continue;
    const shortest = Math.min(bare(lower).length, bare(kl).length);
    if (shortest < 3) continue;
    const scope = scopeOf(lower);
    if (scope && scope === scopeOf(kl)) continue; // a scope has one owner on npm: siblings are not squats
    const max = shortest <= 5 ? 1 : 2;
    const d = editDistance(lower, kl, max);
    if (d <= max) out.push({ near: k, distance: d });
  }
  return out;
}

/**
 * Packages in head whose name does not appear anywhere in base. One row per name@version.
 * @param {any} baseLock @param {any} headLock
 */
export function newPackages(baseLock, headLock) {
  const baseNames = new Set(lockPackages(baseLock).map((p) => p.name));
  const seen = new Set();
  const out = [];
  for (const p of lockPackages(headLock)) {
    if (baseNames.has(p.name)) continue;
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return { baseNames, added: out };
}

/**
 * Every flag for the new packages, as { pkg, kind, detail } rows.
 * @param {{ baseLock: any, headLock: any, reference: string[], now: Date,
 *           publishedAt: (name: string, version: string) => Promise<string | null> }} input
 */
export async function reviewFlags({ baseLock, headLock, reference, now, publishedAt }) {
  const { baseNames, added } = newPackages(baseLock, headLock);
  const known = new Set([...reference, ...baseNames]);
  const flags = [];
  const times = await mapLimit(added, 8, (p) => publishedAt(p.name, p.version).catch(() => null));
  added.forEach((p, i) => {
    const pkg = `${p.name}@${p.version}`;
    if (p.entry.hasInstallScript) {
      flags.push({ pkg, kind: "install-script", detail: "runs an install script (preinstall/install/postinstall) on npm ci" });
    }
    for (const m of typosquatMatches(p.name, known)) {
      flags.push({ pkg, kind: "typosquat", detail: `name is ${m.distance} edit${m.distance === 1 ? "" : "s"} from "${m.near}"` });
    }
    const t = times[i] ? Date.parse(times[i]) : NaN;
    if (Number.isNaN(t)) {
      flags.push({ pkg, kind: "too-new", detail: "publish date could not be read from the npm registry" });
    } else {
      const ageDays = (now.getTime() - t) / DAY_MS;
      if (ageDays < MIN_AGE_DAYS) {
        flags.push({ pkg, kind: "too-new", detail: `published ${times[i]} (${ageDays.toFixed(1)} days ago; minimum ${MIN_AGE_DAYS})` });
      }
    }
  });
  return { added, flags };
}

/**
 * Whether the deps-reviewed label counts: present, and its most recent "labeled" event is by a reviewer.
 * @param {{ event: string, label?: { name?: string }, actor?: { login?: string } }[]} events
 * @param {string[]} reviewers
 * @returns {{ ok: boolean, by: string | null }}
 */
export function labelApproval(events, reviewers) {
  let by = null;
  let at = null;
  for (const e of events) {
    if (e?.label?.name !== LABEL) continue;
    if (e.event === "labeled") {
      by = e.actor?.login ?? null;
      at = e.created_at ?? null;
    } else if (e.event === "unlabeled") {
      by = null;
      at = null;
    }
  }
  return { ok: by !== null && reviewers.includes(by), by, at };
}

/**
 * cs-012: the PR's head commit when the label was added: the head_sha of the latest pull_request run on the
 * PR's head branch (and head repository) created at or before the label. null when none can be found.
 * @param {{ event?: string, head_branch?: string, head_sha?: string, created_at?: string,
 *           head_repository?: { full_name?: string } }[]} runs
 * @param {{ at: string | null, branch: string, headRepo: string }} where
 * @returns {string | null}
 */
export function headAtLabel(runs, { at, branch, headRepo }) {
  const t = at ? Date.parse(at) : NaN;
  if (Number.isNaN(t)) return null;
  let best = null;
  for (const r of runs) {
    if (r?.event !== "pull_request" || r.head_branch !== branch) continue;
    if (headRepo && r.head_repository?.full_name !== headRepo) continue;
    const c = Date.parse(r.created_at ?? "");
    if (Number.isNaN(c) || c > t || typeof r.head_sha !== "string") continue;
    if (!best || c > best.c) best = { c, sha: r.head_sha };
  }
  return best ? best.sha : null;
}

/**
 * cs-012: whether the lockfile is unchanged since the label: both blob shas known and equal.
 * @param {{ labelSha: string | null, labelBlob: string | null, headBlob: string | null }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function lockfileUnchanged({ labelSha, labelBlob, headBlob }) {
  if (!labelSha) return { ok: false, reason: `the PR's head when ${LABEL} was added could not be found` };
  if (!labelBlob || !headBlob) return { ok: false, reason: `package-lock.json could not be read at ${labelSha.slice(0, 7)} or at the current head` };
  if (labelBlob !== headBlob) return { ok: false, reason: `package-lock.json changed after ${LABEL} was added (at ${labelSha.slice(0, 7)})` };
  return { ok: true, reason: `package-lock.json unchanged since ${LABEL} was added (at ${labelSha.slice(0, 7)})` };
}

/**
 * The job's verdict: pass when nothing is flagged, or when every flag was accepted through the label.
 * @param {{ flags: unknown[], labelPresent: boolean, approval: { ok: boolean } | null }} input
 */
export function decide({ flags, labelPresent, approval, lockfile }) {
  if (flags.length === 0) return { pass: true, reason: "nothing flagged" };
  if (labelPresent && approval?.ok && lockfile?.ok) return { pass: true, reason: `flags accepted through ${LABEL}` };
  if (labelPresent && approval?.ok) return { pass: false, reason: lockfile?.reason ?? `package-lock.json not checked since ${LABEL} was added` };
  if (labelPresent) return { pass: false, reason: `${LABEL} was not added by a reviewer` };
  return { pass: false, reason: "flagged, no review label" };
}

/** The PR's issue events from the GitHub REST API (paginated). */
export async function fetchIssueEvents({ repo, pr, token, fetchImpl = fetch }) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${pr}/events?per_page=100&page=${page}`, {
      headers: ghHeaders(token),
    });
    if (!res.ok) throw new Error(`GitHub issue events: HTTP ${res.status}`);
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

const ghHeaders = (token) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" });

/** cs-012: pull_request workflow runs on a branch created at or before `at` (newest first, up to 300). */
export async function fetchRunsBefore({ repo, branch, at, token, fetchImpl = fetch }) {
  const all = [];
  for (let page = 1; page <= 3; page++) {
    const q = new URLSearchParams({ event: "pull_request", branch, created: `<=${at}`, per_page: "100", page: String(page) });
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/runs?${q}`, { headers: ghHeaders(token) });
    if (!res.ok) throw new Error(`GitHub workflow runs: HTTP ${res.status}`);
    const batch = (await res.json()).workflow_runs ?? [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** cs-012: the blob sha of package-lock.json at a commit, or null when it cannot be read. */
export async function fetchLockBlob({ repo, ref, token, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/contents/package-lock.json?ref=${encodeURIComponent(ref)}`, {
    headers: { ...ghHeaders(token), accept: "application/vnd.github.object+json" },
  });
  if (!res.ok) return null;
  const body = await res.json();
  return typeof body?.sha === "string" ? body.sha : null;
}

/** `npm view <name>@<version> time --json` -> the ISO publish time of that version, or null. */
export async function npmPublishedAt(name, version) {
  const { stdout } = await run("npm", ["view", `${name}@${version}`, "time", "--json"], { timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  const times = JSON.parse(stdout);
  return typeof times?.[version] === "string" ? times[version] : null;
}

/** @param {{ pkg: string, kind: string, detail: string }[]} flags */
export function formatFlags(flags) {
  return flags.map((f) => `  ${f.kind.padEnd(14)} ${f.pkg}: ${f.detail}`).join("\n");
}

async function main() {
  const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
  const baseRef = arg("base-ref", "HEAD^1");
  const headFile = arg("head-file", "package-lock.json");
  const { stdout: baseText } = await run("git", ["show", `${baseRef}:package-lock.json`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  const baseLock = parseLock(baseText, `${baseRef}:package-lock.json`);
  const headLock = parseLock(readFileSync(path.resolve(ROOT, headFile), "utf8"), headFile);
  const reference = JSON.parse(readFileSync(path.join(ROOT, "security/typosquat-reference.json"), "utf8")).names;

  const { added, flags } = await reviewFlags({ baseLock, headLock, reference, now: new Date(), publishedAt: npmPublishedAt });
  console.log(`dep-review: ${added.length} new package${added.length === 1 ? "" : "s"} against ${baseRef}`);
  for (const p of added) console.log(`  + ${p.name}@${p.version}`);
  if (flags.length === 0) {
    console.log("dep-review: ok, nothing flagged");
    return;
  }
  console.log(`dep-review: ${flags.length} flag${flags.length === 1 ? "" : "s"}:\n${formatFlags(flags)}`);

  if (process.env.DEPS_REVIEWED_LABEL === "1") {
    const reviewers = JSON.parse(readFileSync(path.join(ROOT, "security/deps-reviewers.json"), "utf8")).reviewers;
    const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, PR_NUMBER: pr } = process.env;
    if (!token || !repo || !pr) {
      console.error("dep-review: the PR has the deps-reviewed label but GITHUB_TOKEN/GITHUB_REPOSITORY/PR_NUMBER are not set, so who added it cannot be checked");
      process.exit(1);
    }
    const approval = labelApproval(await fetchIssueEvents({ repo, pr, token }), reviewers);
    if (!approval.ok) {
      console.error(`dep-review: ${LABEL} was last added by ${approval.by ?? "nobody"}, who is not in security/deps-reviewers.json (${reviewers.join(", ")}); it clears nothing`);
      process.exit(1);
    }
    const { PR_HEAD_SHA: headSha, PR_HEAD_REF: branch, PR_HEAD_REPO: headRepo } = process.env;
    let lockfile = { ok: false, reason: "PR_HEAD_SHA/PR_HEAD_REF are not set, so the lockfile cannot be compared with the one the reviewer saw" };
    if (headSha && branch && approval.at) {
      const runs = await fetchRunsBefore({ repo, branch, at: approval.at, token });
      const labelSha = headAtLabel(runs, { at: approval.at, branch, headRepo: headRepo ?? "" });
      const [labelBlob, headBlob] = labelSha
        ? await Promise.all([fetchLockBlob({ repo, ref: labelSha, token }), fetchLockBlob({ repo, ref: headSha, token })])
        : [null, null];
      lockfile = lockfileUnchanged({ labelSha, labelBlob, headBlob });
    }
    const verdict = decide({ flags, labelPresent: true, approval, lockfile });
    if (verdict.pass) {
      console.log(`dep-review: flags accepted, ${LABEL} added by ${approval.by}; ${lockfile.reason}`);
      return;
    }
    console.error(`dep-review: ${LABEL} (added by ${approval.by}) no longer counts: ${verdict.reason}. A reviewer reads the new lockfile and adds the label again.`);
    process.exit(1);
  }
  console.error(`dep-review: FAILED. A reviewer in security/deps-reviewers.json reads the flags above and, if they are fine, adds the ${LABEL} label (that re-runs this check). Otherwise drop or replace the package.`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`dep-review: ${err.message}`);
    process.exit(1);
  });
}
