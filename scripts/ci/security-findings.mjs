#!/usr/bin/env node
// tw-031: the weekly security re-audit's findings become GitHub issues, one per finding, with an SLA.
//
// security-weekly.yml runs the same checks as the PR gate (audit-ci, the licence check, gitleaks over the
// FULL history, Semgrep CE with --strict) plus the allowlist expiry checks, and each step leaves a JSON
// report in one directory. This script reads those reports, turns them into findings, and opens or updates
// ONE issue per finding, labelled `security` + its severity (`critical` / `high`). The factory's
// `node bin/factory.mjs security-sweep` reads those open issues across every app repo and raises a work
// order `<prefix>-sec-<id>` with `due:` from the SLA, so a scan result reaches a person.
//
//   node scripts/ci/security-findings.mjs tools --out=<dir>/tools.json
//       pinned run-time tools (`npx --yes <pkg>@<x.y.z>` in .github/workflows) that have a newer
//       major/minor release at least 14 days old (Joe 2026-11-10: flag @lhci/cli 0.16.x so it can move
//       into the lockfile). Exit 1 when there is one.
//   node scripts/ci/security-findings.mjs sync --reports=<dir> [--dry-run]
//       collect every finding and sync the issues (GITHUB_TOKEN / GH_TOKEN, GITHUB_REPOSITORY).
//       --dry-run prints what it would do and writes nothing (used off the default branch).
//       SEED_FIXTURE=1 adds one made-up `high` finding (`fixture-tw031`) to prove the path end to end.
//
// SLA (from first seen): critical 48 hours, high 7 days. First seen is kept from the open issue across
// runs; a finding that comes back after its issue was closed reopens it with a new first seen. An open
// issue whose finding is gone from a scanner that DID run is commented on and closed; a scanner that did
// not produce a report (crashed, network) closes nothing. The issue body carries a machine-readable marker
// (`<!-- security-finding:v1 {...} -->`) that security-sweep parses; never edit it by hand.
// Report files never carry a secret's value: gitleaks runs with --redact and only rule, file, line and
// commit are read. Tests: security-findings.test.mjs (GitHub faked, fixed clock).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { allowlistProblems as auditAllowlistProblems } from "./audit-allowlist.mjs";
import { allowlistProblems as licenseAllowlistProblems } from "./license-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const SLA_HOURS = { critical: 48, high: 7 * 24 };
export const MARKER = "security-finding:v1";
export const LABEL_COLORS = { security: "b60205", critical: "5c0000", high: "d93f0b" };
export const MAX_NEW_ISSUES = 25;
export const TOOL_MIN_AGE_DAYS = 14;
/** Every kind a finding can have. `allowlist` and `fixture` are always "scanned" (no external tool). */
export const KINDS = ["dependency", "license", "secret", "sast", "baseline", "allowlist", "tool", "fixture"];

/** @param {string} s */
export const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
/** @param {string} s */
const hash10 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);

/**
 * @typedef {{ id: string, kind: string, severity: "critical" | "high", advisory: string, package: string,
 *             path: string, title: string, detail?: string, url?: string }} Finding
 */

/** The due time for a severity, from first seen. @param {"critical"|"high"} severity @param {string} firstSeen ISO */
export function dueFor(severity, firstSeen) {
  const hours = SLA_HOURS[severity];
  if (!hours) throw new Error(`no SLA for severity ${severity}`);
  return new Date(Date.parse(firstSeen) + hours * HOUR_MS).toISOString();
}

// --- collectors (pure: parsed report in, findings out) ---------------------------------------------------

/**
 * npm audit --json (report version 2): one finding per high/critical advisory not in the allowlist, with
 * every installed path it reaches. Severity is the advisory's own.
 * @param {any} report @param {any} lock parsed package-lock.json @param {string[]} allowIds
 */
export function dependencyFindings(report, lock, allowIds) {
  const allow = new Set(allowIds);
  /** @type {Map<string, Finding & { paths: Set<string> }>} */
  const byId = new Map();
  for (const vuln of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of /** @type {any} */ (vuln).via ?? []) {
      if (!via || typeof via !== "object") continue; // a string `via` is a package that inherits another's advisory
      if (via.severity !== "critical" && via.severity !== "high") continue;
      const advisory = String(via.url ?? "").match(/GHSA(-[0-9a-z]{4}){3}/i)?.[0] ?? `npm-${via.source}`;
      if (allow.has(advisory)) continue;
      const nodes = /** @type {any} */ (vuln).nodes ?? [];
      const versions = [...new Set(nodes.map((n) => lock?.packages?.[n]?.version).filter(Boolean))];
      let f = byId.get(advisory);
      if (!f) {
        f = {
          id: slug(advisory),
          kind: "dependency",
          severity: via.severity,
          advisory,
          package: `${via.name}${versions.length ? `@${versions.join(", ")}` : ""} (vulnerable ${via.range ?? "?"})`,
          path: "",
          title: String(via.title ?? "advisory"),
          url: via.url,
          paths: new Set(),
        };
        byId.set(advisory, f);
      }
      if (via.severity === "critical") f.severity = "critical";
      for (const n of nodes) f.paths.add(n);
    }
  }
  return [...byId.values()].map(({ paths, ...f }) => ({ ...f, path: [...paths].sort().join(", ") || "package-lock.json" }));
}

/** license-check.mjs --json report: one finding per failed package. @param {any} report */
export function licenseFindings(report) {
  return (report?.failed ?? []).map((row) => ({
    id: slug(`license-${row.name}-${row.version}`),
    kind: "license",
    severity: /** @type {const} */ ("high"),
    advisory: `licence ${row.license} (${row.why})`,
    package: `${row.name}@${row.version}`,
    path: "package-lock.json",
    title: `${row.why} licence not allowed`,
  }));
}

/** gitleaks --report-format json (redacted): one finding per leak. Secrets are critical (rotation). @param {any[]} report */
export function secretFindings(report) {
  return (Array.isArray(report) ? report : []).map((leak) => {
    const commit = String(leak.Commit ?? "").slice(0, 12);
    return {
      id: `secret-${hash10(String(leak.Fingerprint ?? `${leak.Commit}:${leak.File}:${leak.RuleID}:${leak.StartLine}`))}`,
      kind: "secret",
      severity: /** @type {const} */ ("critical"),
      advisory: `gitleaks ${leak.RuleID}`,
      package: "-",
      path: `${leak.File}:${leak.StartLine}${commit ? ` @ ${commit}` : ""}`,
      title: String(leak.Description ?? "secret in git history"),
      detail: "A real secret is ROTATED (factory bin/rotate-secrets.sh, Michael), never allowlisted. A false positive gets an exact-value entry in .gitleaks.toml with a comment.",
    };
  });
}

/** semgrep-gate.mjs --json-out report: new findings (high) and, under --strict, stale baseline entries (high). @param {any} report */
export function semgrepFindings(report) {
  const out = [];
  for (const f of report?.unbaselined ?? []) {
    out.push({
      id: `sast-${hash10(`${f.rule}\0${f.path}\0${f.code}`)}`,
      kind: "sast",
      severity: /** @type {const} */ ("high"),
      advisory: `semgrep ${f.rule}`,
      package: "-",
      path: `${f.path}:${f.line}`,
      title: String(f.message || "Semgrep finding").slice(0, 120),
      detail: "Fix it; only a finding that is not a vulnerability goes into security/semgrep-baseline.json, with a reason.",
    });
  }
  if (report?.strict) {
    for (const s of report?.stale ?? []) {
      out.push({
        id: `baseline-${hash10(`${s.rule}\0${s.path}\0${s.code}`)}`,
        kind: "baseline",
        severity: /** @type {const} */ ("high"),
        advisory: `stale baseline ${s.rule}`,
        package: "-",
        path: s.path,
        title: "Semgrep baseline entry matches nothing now",
        detail: "Remove the entry from security/semgrep-baseline.json.",
      });
    }
  }
  return out;
}

/**
 * Allowlist problems (expired, incomplete, over 90 days out) in security/audit-allowlist.json and
 * security/license-allowlist.json, one finding each.
 * @param {{ audit?: any, license?: any }} docs @param {Date} now
 */
export function allowlistFindings(docs, now) {
  const out = [];
  const add = (file, problems) => {
    for (const p of problems) {
      const subject = p.match(/\(([^)]+)\)/)?.[1] ?? file;
      out.push({
        id: `allowlist-${slug(subject)}-${hash10(`${file}\0${p}`).slice(0, 6)}`,
        kind: "allowlist",
        severity: /** @type {const} */ ("high"),
        advisory: `allowlist ${subject}`,
        package: subject,
        path: file,
        title: p.replace(/^security\/[a-z-]+\.json /, ""),
        detail: "Re-check it, then fix the dependency or renew the entry with a new reason and expiry in a reviewed PR.",
      });
    }
  };
  if (docs.audit !== undefined) add("security/audit-allowlist.json", auditAllowlistProblems(docs.audit, now));
  if (docs.license !== undefined) add("security/license-allowlist.json", licenseAllowlistProblems(docs.license, now));
  return out;
}

/** tools.json (from the `tools` subcommand). @param {any} report */
export function toolFindings(report) {
  return (report?.upgrades ?? []).map((u) => ({
    id: slug(`tool-${u.name}-${u.latest}`),
    kind: "tool",
    severity: /** @type {const} */ ("high"),
    advisory: `run-time tool ${u.name}@${u.pinned} has ${u.latest}`,
    package: `${u.name}@${u.pinned}`,
    path: u.where,
    title: `${u.name} ${u.latest} is out (published ${u.published.slice(0, 10)})`,
    detail: "A tool fetched with npx is outside the lockfile and the audit. Move it into the root devDependencies (exact version) and run it with npx --no-install, or record why not (portfolio-security-ci-decisions).",
  }));
}

export const FIXTURE = Object.freeze({
  id: "fixture-tw031",
  kind: "fixture",
  severity: /** @type {const} */ ("high"),
  advisory: "TW031-SEEDED-FIXTURE",
  package: "-",
  path: "scripts/ci/security-findings.mjs",
  title: "Seeded test finding (not a vulnerability)",
  detail: "Proves the weekly scan -> issue -> factory work order path. The next run without seed_fixture closes it.",
});

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Every finding from a reports directory, and which kinds produced a usable report (only those may close
 * issues). @param {{ dir: string, root: string, now: Date, seed: boolean }} input
 */
export function collect({ dir, root, now, seed }) {
  const scanned = new Set(["allowlist", "fixture"]);
  /** @type {Finding[]} */
  const findings = [];
  const audit = readJson(path.join(dir, "npm-audit.json"));
  const auditAllow = readJson(path.join(root, "security/audit-allowlist.json"));
  if (audit && typeof audit === "object" && audit.vulnerabilities && !audit.error) {
    scanned.add("dependency");
    const lock = readJson(path.join(root, "package-lock.json"));
    findings.push(...dependencyFindings(audit, lock, (auditAllow?.entries ?? []).map((e) => e?.id)));
  }
  const lic = readJson(path.join(dir, "license.json"));
  if (lic && Array.isArray(lic.failed)) {
    scanned.add("license");
    findings.push(...licenseFindings(lic));
  }
  const leaks = readJson(path.join(dir, "gitleaks.json"));
  if (Array.isArray(leaks)) {
    scanned.add("secret");
    findings.push(...secretFindings(leaks));
  }
  const sg = readJson(path.join(dir, "semgrep-gate.json"));
  if (sg && Array.isArray(sg.unbaselined)) {
    scanned.add("sast");
    if (sg.strict) scanned.add("baseline");
    findings.push(...semgrepFindings(sg));
  }
  const tools = readJson(path.join(dir, "tools.json"));
  if (tools && Array.isArray(tools.upgrades)) {
    scanned.add("tool");
    findings.push(...toolFindings(tools));
  }
  findings.push(...allowlistFindings({ audit: auditAllow ?? { entries: "unreadable" }, license: readJson(path.join(root, "security/license-allowlist.json")) ?? { entries: "unreadable" } }, now));
  if (seed) findings.push({ ...FIXTURE });
  // One issue per finding id: merge accidental duplicates (keep the worst severity).
  const byId = new Map();
  for (const f of findings) {
    const prev = byId.get(f.id);
    if (!prev || (prev.severity === "high" && f.severity === "critical")) byId.set(f.id, f);
  }
  return { findings: [...byId.values()], scanned: [...scanned] };
}

// --- issues -----------------------------------------------------------------------------------------------

/** The machine-readable marker in an issue body, or null. @param {string | null | undefined} body */
export function parseMarker(body) {
  const m = String(body ?? "").match(/[<]!-- security-finding:v1 (\{[^]*?\}) -->/);
  if (!m) return null;
  try {
    const meta = JSON.parse(m[1]);
    return meta && typeof meta.id === "string" ? meta : null;
  } catch {
    return null;
  }
}

/** @param {Finding} f */
export function issueTitle(f) {
  const where = f.package && f.package !== "-" ? f.package.split(" ")[0] : f.path.split(" ")[0];
  return `[security] ${f.severity}: ${f.advisory} in ${where}`.slice(0, 240);
}

/** @param {Finding} f @param {{ firstSeen: string, lastSeen: string, runUrl?: string, reopenedFrom?: string }} t */
export function issueBody(f, t) {
  const due = dueFor(f.severity, t.firstSeen);
  const meta = { id: f.id, kind: f.kind, severity: f.severity, advisory: f.advisory, package: f.package, path: f.path, firstSeen: t.firstSeen, due, lastSeen: t.lastSeen };
  const rows = [
    ["Advisory", f.url ? `[${f.advisory}](${f.url})` : f.advisory],
    ["Severity", f.severity],
    ["Package", f.package],
    ["Path", f.path],
    ["First seen", t.firstSeen],
    ["Due", `${due} (${f.severity === "critical" ? "48 hours" : "7 days"} from first seen)`],
    ["Last seen", t.lastSeen],
    ["Kind", f.kind],
  ];
  const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `**${cell(f.title)}**`,
    "",
    "| | |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`),
    "",
    f.detail ?? "",
    t.reopenedFrom ? `\nReopened: this finding came back after its issue was closed (previously first seen ${t.reopenedFrom}).` : "",
    t.runUrl ? `\nLast seen by ${t.runUrl}` : "",
    "",
    "Opened and updated by `security-weekly.yml` (tw-031); closed by it when a later run no longer finds this. The factory's `security-sweep` turns it into a work order with this due date.",
    "",
    `<!-- ${MARKER} ${JSON.stringify(meta)} -->`,
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

/**
 * The plan: what to create, update, reopen and close. Pure.
 * @param {{ findings: Finding[], scanned: string[], issues: any[], now: Date, runUrl?: string }} input
 */
export function plan({ findings, scanned, issues, now, runUrl }) {
  const nowIso = now.toISOString();
  /** @type {Map<string, any>} */
  const open = new Map();
  /** @type {Map<string, any>} */
  const closed = new Map();
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const meta = parseMarker(issue.body);
    if (!meta) continue;
    const target = issue.state === "open" ? open : closed;
    const prev = target.get(meta.id);
    if (!prev || issue.number > prev.issue.number) target.set(meta.id, { issue, meta });
  }
  const actions = [];
  const seen = new Set();
  let created = 0;
  for (const f of findings) {
    seen.add(f.id);
    const labels = ["security", f.severity];
    const o = open.get(f.id);
    if (o) {
      const firstSeen = typeof o.meta.firstSeen === "string" && !Number.isNaN(Date.parse(o.meta.firstSeen)) ? o.meta.firstSeen : nowIso;
      actions.push({ op: "update", number: o.issue.number, finding: f, title: issueTitle(f), body: issueBody(f, { firstSeen, lastSeen: nowIso, runUrl }), labels, dropLabels: f.severity === "critical" ? ["high"] : ["critical"] });
      continue;
    }
    const c = closed.get(f.id);
    if (c) {
      actions.push({ op: "reopen", number: c.issue.number, finding: f, title: issueTitle(f), body: issueBody(f, { firstSeen: nowIso, lastSeen: nowIso, runUrl, reopenedFrom: c.meta.firstSeen }), labels, dropLabels: f.severity === "critical" ? ["high"] : ["critical"] });
      continue;
    }
    if (created >= MAX_NEW_ISSUES) {
      actions.push({ op: "skip", finding: f, reason: `more than ${MAX_NEW_ISSUES} new findings in one run` });
      continue;
    }
    created++;
    actions.push({ op: "create", finding: f, title: issueTitle(f), body: issueBody(f, { firstSeen: nowIso, lastSeen: nowIso, runUrl }), labels });
  }
  const scannedSet = new Set(scanned);
  for (const [id, o] of open) {
    if (seen.has(id)) continue;
    if (!scannedSet.has(o.meta.kind)) continue; // that scanner produced no report this run: leave it open
    actions.push({ op: "close", number: o.issue.number, id, comment: `Not found by the weekly scan on ${nowIso.slice(0, 10)}${runUrl ? ` (${runUrl})` : ""}; closing. It reopens if a later run finds it again.` });
  }
  return actions;
}

/** A small GitHub REST client over fetch. @param {{ token: string, repo: string, fetchImpl?: typeof fetch }} o */
export function githubClient({ token, repo, fetchImpl = fetch }) {
  const base = `https://api.github.com/repos/${repo}`;
  async function call(method, url, body) {
    const res = await fetchImpl(url.startsWith("http") ? url : `${base}${url}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && !(method === "POST" && url.startsWith("/labels") && res.status === 422)) {
      throw new Error(`GitHub ${method} ${url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json().catch(() => null);
  }
  return {
    async listSecurityIssues() {
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const batch = await call("GET", `/issues?labels=security&state=all&per_page=100&page=${page}`);
        out.push(...batch);
        if (batch.length < 100) break;
      }
      return out;
    },
    async ensureLabel(name) {
      const res = await fetchImpl(`${base}/labels/${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
      if (res.ok) return;
      await call("POST", "/labels", { name, color: LABEL_COLORS[name] ?? "ededed", description: name === "security" ? "Weekly security scan finding (tw-031)" : `Security finding severity: ${name}` });
    },
    createIssue: (title, body, labels) => call("POST", "/issues", { title, body, labels }),
    updateIssue: (number, patch) => call("PATCH", `/issues/${number}`, patch),
    addLabels: (number, labels) => call("POST", `/issues/${number}/labels`, { labels }),
    removeLabel: async (number, label) => {
      const res = await fetchImpl(`${base}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
      if (!res.ok && res.status !== 404) throw new Error(`GitHub DELETE label ${label} on #${number} answered ${res.status}`);
    },
    comment: (number, body) => call("POST", `/issues/${number}/comments`, { body }),
  };
}

/** Apply a plan through a client. Returns printable lines. */
export async function apply(actions, client, { dryRun }) {
  const lines = [];
  if (!dryRun && actions.some((a) => a.op === "create" || a.op === "update" || a.op === "reopen")) {
    for (const l of ["security", "critical", "high"]) await client.ensureLabel(l);
  }
  for (const a of actions) {
    const say = (s) => lines.push(`${dryRun ? "[dry-run] " : ""}${s}`);
    if (a.op === "create") {
      say(`create: ${a.title} (due ${parseMarker(a.body).due})`);
      if (!dryRun) {
        const issue = await client.createIssue(a.title, a.body, a.labels);
        lines[lines.length - 1] += ` -> #${issue?.number}`;
      }
    } else if (a.op === "update" || a.op === "reopen") {
      say(`${a.op} #${a.number}: ${a.title} (due ${parseMarker(a.body).due})`);
      if (!dryRun) {
        await client.updateIssue(a.number, { title: a.title, body: a.body, ...(a.op === "reopen" ? { state: "open" } : {}) });
        await client.addLabels(a.number, a.labels);
        for (const l of a.dropLabels) await client.removeLabel(a.number, l);
      }
    } else if (a.op === "close") {
      say(`close #${a.number}: ${a.id} no longer found`);
      if (!dryRun) {
        await client.comment(a.number, a.comment);
        await client.updateIssue(a.number, { state: "closed", state_reason: "completed" });
      }
    } else if (a.op === "skip") {
      say(`skip (not filed): ${a.finding.id} ${a.finding.advisory}: ${a.reason}`);
    }
  }
  return lines;
}

// --- run-time tool pins -----------------------------------------------------------------------------------

/** `npx --yes <pkg>@<x.y.z>` in workflow text. @param {{ file: string, text: string }[]} files */
export function npxPins(files) {
  const out = [];
  for (const { file, text } of files) {
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/npx\s+(?:--yes|-y)\s+((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+)\b/gi)) {
        out.push({ name: m[1], pinned: m[2], where: `${file}:${i + 1}` });
      }
    });
  }
  return out;
}

/** @param {string} v */
const parts = (v) => v.split(".").map(Number);
/**
 * The newest stable release on a newer major or minor than `pinned` that is at least TOOL_MIN_AGE_DAYS old.
 * @param {string} pinned @param {Record<string, string>} times npm's `time` map (version -> ISO)
 * @param {Date} now
 */
export function newerRelease(pinned, times, now) {
  const [pM, pm] = parts(pinned);
  let best = null;
  for (const [v, t] of Object.entries(times ?? {})) {
    if (!/^\d+\.\d+\.\d+$/.test(v)) continue; // skips "created", "modified" and pre-releases
    const [M, m] = parts(v);
    if (M < pM || (M === pM && m <= pm)) continue;
    if (now.getTime() - Date.parse(t) < TOOL_MIN_AGE_DAYS * DAY_MS) continue;
    if (!best || M > best.M || (M === best.M && m > best.m) || (M === best.M && m === best.m && parts(v)[2] > parts(best.v)[2])) best = { v, t, M, m };
  }
  return best ? { latest: best.v, published: new Date(Date.parse(best.t)).toISOString() } : null;
}

async function toolsMain(outFile) {
  const dir = path.join(ROOT, ".github/workflows");
  const files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({ file: `.github/workflows/${f}`, text: readFileSync(path.join(dir, f), "utf8") }));
  const upgrades = [];
  const seen = new Set();
  for (const pin of npxPins(files)) {
    const key = `${pin.name}@${pin.pinned}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const res = await fetch(`https://registry.npmjs.org/${pin.name.replace("/", "%2f")}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`registry answered ${res.status} for ${pin.name}`);
    const doc = await res.json();
    const newer = newerRelease(pin.pinned, doc.time, new Date());
    console.log(`security-findings tools: ${key} (${pin.where}) ${newer ? `-> ${newer.latest} available since ${newer.published.slice(0, 10)}` : "is current"}`);
    if (newer) upgrades.push({ ...pin, ...newer });
  }
  writeFileSync(outFile, `${JSON.stringify({ upgrades }, null, 2)}\n`);
  if (upgrades.length) {
    console.error("security-findings tools: a pinned npx tool has a newer release; move it into the lockfile (see the issue).");
    process.exit(1);
  }
}

async function syncMain(dir, dryRun) {
  const now = new Date();
  const seed = process.env.SEED_FIXTURE === "1" || process.env.SEED_FIXTURE === "true";
  const { findings, scanned } = collect({ dir, root: ROOT, now, seed });
  console.log(`security-findings: ${findings.length} finding(s); scanners with a report: ${scanned.join(", ")}`);
  for (const f of findings) console.log(`  ${f.severity.padEnd(8)} ${f.id}  ${f.advisory}  ${f.package}  ${f.path}`);
  const missing = KINDS.filter((k) => !scanned.includes(k) && k !== "baseline");
  if (missing.length) console.log(`security-findings: no report from: ${missing.join(", ")} (their open issues are left as they are)`);
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    if (!dryRun) throw new Error("GITHUB_REPOSITORY and GH_TOKEN/GITHUB_TOKEN are required (or pass --dry-run)");
    console.log("security-findings: dry run with no GitHub access: every finding would be a new issue");
  }
  const client = repo && token ? githubClient({ token, repo }) : null;
  const issues = client ? await client.listSecurityIssues() : [];
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  const actions = plan({ findings, scanned, issues, now, runUrl });
  const lines = await apply(actions, client ?? /** @type {any} */ ({}), { dryRun: dryRun || !client });
  for (const l of lines) console.log(`security-findings: ${l}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [`### Security findings: ${findings.length}`, "", ...findings.map((f) => `- **${f.severity}** \`${f.id}\` ${f.advisory} (${f.package}; ${f.path})`), "", ...lines.map((l) => `- ${l}`), ""].join("\n");
    try {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
    } catch {
      // the summary is a convenience
    }
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (cmd === "tools") {
    const out = arg("out");
    if (!out) throw new Error("usage: security-findings.mjs tools --out=<file>");
    return toolsMain(out);
  }
  if (cmd === "sync") {
    const dir = arg("reports");
    if (!dir || !existsSync(dir)) throw new Error("usage: security-findings.mjs sync --reports=<existing dir> [--dry-run]");
    return syncMain(dir, rest.includes("--dry-run"));
  }
  throw new Error("usage: security-findings.mjs tools --out=<file> | sync --reports=<dir> [--dry-run]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`security-findings: ${err.message}`);
    process.exit(2);
  });
}
