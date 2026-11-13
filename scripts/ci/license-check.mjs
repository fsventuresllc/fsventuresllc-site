#!/usr/bin/env node
// tw-029: licence gate over every package in the lockfile tree (all workspaces, dev and optional included).
//
// Fails on GPL-* and AGPL-* (any version, -only/-or-later/+, WITH an exception), and on an unknown licence:
// none recorded, UNLICENSED, "SEE LICENSE IN ...", or a string that is not an SPDX-style expression.
// LGPL-* is REPORTED, not failed (the order's default; changing that is Joe's decision,
// portfolio-security-ci-decisions). Every other licence passes. An SPDX expression is evaluated: OR passes
// when any alternative passes, AND fails when any part fails.
//
// Licence source, in order: the lockfile entry's `license` (npm records it only for packages installed on
// the machine that wrote the lockfile), then node_modules/<path>/package.json when present, then the npm
// registry's document for that exact version. No npm ci needed.
//
// A failing package passes only through security/license-allowlist.json: {package, license, reason, owner,
// expires[, version]}, license equal to the reported string, expires a real YYYY-MM-DD at most 90 days out
// (the tw-027 rule). An incomplete, expired or over-90-day entry fails the check itself.
//
//   node scripts/ci/license-check.mjs [--lockfile=package-lock.json] [--offline] [--json=<report.json>]
// Tests: license-check.test.mjs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fetchVersionManifest, lockPackages, mapLimit, parseDate, parseLock } from "./lockfile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ALLOWLIST_PATH = "security/license-allowlist.json";
export const MAX_DAYS = 90;
const MIN_REASON = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const RANK = { ok: 0, report: 1, fail: 2 };

/**
 * Classify one licence identifier (no operators).
 * @param {string} id
 * @returns {{ verdict: "ok" | "report" | "fail", why: string }}
 */
export function classifyId(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(id)) return { verdict: "fail", why: "unknown" };
  const u = id.toUpperCase();
  if (["UNLICENSED", "UNKNOWN", "NONE", "NOASSERTION", "CUSTOM", "PROPRIETARY"].includes(u)) return { verdict: "fail", why: "unknown" };
  if (/^AGPL([-+.\d]|$)/.test(u)) return { verdict: "fail", why: "AGPL" };
  if (/^GPL([-+.\d]|$)/.test(u)) return { verdict: "fail", why: "GPL" };
  if (/^LGPL([-+.\d]|$)/.test(u)) return { verdict: "report", why: "LGPL" };
  return { verdict: "ok", why: "" };
}

/**
 * Evaluate a licence string as an SPDX expression.
 * @param {string | null | undefined} license
 * @returns {{ verdict: "ok" | "report" | "fail", why: string }}
 */
export function classifyLicense(license) {
  if (typeof license !== "string" || !license.trim()) return { verdict: "fail", why: "unknown" };
  const s = license.trim();
  if (/^SEE LICEN[CS]E IN /i.test(s)) return { verdict: "fail", why: "unknown" };
  const tokens = s.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const unknown = { verdict: /** @type {const} */ ("fail"), why: "unknown" };
  const worst = (a, b) => (RANK[b.verdict] > RANK[a.verdict] ? b : a);
  const best = (a, b) => (RANK[b.verdict] < RANK[a.verdict] ? b : a);
  /** @returns {{ verdict: "ok" | "report" | "fail", why: string } | null} */
  function primary() {
    const t = tokens[i++];
    if (t === undefined) return null;
    if (t === "(") {
      const v = orExpr();
      if (tokens[i++] !== ")") return null;
      return v;
    }
    if (["AND", "OR", "WITH", ")"].includes(t.toUpperCase())) return null;
    const v = classifyId(t);
    if (tokens[i]?.toUpperCase() === "WITH") {
      i++;
      if (tokens[i++] === undefined) return null; // the exception does not change the licence's class
    }
    return v;
  }
  function andExpr() {
    let v = primary();
    while (v && tokens[i]?.toUpperCase() === "AND") {
      i++;
      const r = primary();
      v = r ? worst(v, r) : null;
    }
    return v;
  }
  function orExpr() {
    let v = andExpr();
    while (v && tokens[i]?.toUpperCase() === "OR") {
      i++;
      const r = andExpr();
      v = r ? best(v, r) : null;
    }
    return v;
  }
  const v = orExpr();
  return v && i === tokens.length ? v : unknown;
}

/**
 * A registry/package.json document's (or a lockfile entry's) licence as one string. Old array forms become
 * an OR: `licenses: [{type}]`, and `license: ["MIT", "Apache2"]`, which npm copies into the lockfile as is
 * (tw-030: pause-stream, under audit-ci, was reported "(none)" because of it).
 */
export function manifestLicense(doc) {
  if (!doc || typeof doc !== "object") return null;
  const one = (l) => (typeof l === "string" && l.trim() ? l : l && typeof l.type === "string" ? l.type : null);
  const anyOf = (list) => {
    if (!list.length) return null;
    const ids = list.map(one);
    if (ids.some((x) => !x)) return null;
    return ids.length === 1 ? ids[0] : `(${ids.join(" OR ")})`;
  };
  if (doc.license !== undefined) return Array.isArray(doc.license) ? anyOf(doc.license) : one(doc.license);
  if (Array.isArray(doc.licenses)) return anyOf(doc.licenses);
  return null;
}

/**
 * Problems with the allowlist file (the tw-027 rule), as readable lines.
 * @param {any} doc @param {Date} now
 */
export function allowlistProblems(doc, now) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.entries)) return [`${ALLOWLIST_PATH}: must be an object with an "entries" array`];
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const problems = [];
  doc.entries.forEach((e, idx) => {
    const where = `${ALLOWLIST_PATH} entry ${idx}${e && typeof e.package === "string" ? ` (${e.package})` : ""}`;
    if (!e || typeof e !== "object" || Array.isArray(e)) return void problems.push(`${where}: must be an object`);
    for (const k of ["package", "license", "owner"]) if (typeof e[k] !== "string" || !e[k].trim()) problems.push(`${where}: missing ${k}`);
    if (e.version !== undefined && (typeof e.version !== "string" || !e.version)) problems.push(`${where}: version, when given, must be a string`);
    if (typeof e.reason !== "string" || !e.reason.trim()) problems.push(`${where}: missing reason`);
    else if (e.reason.trim().length < MIN_REASON) problems.push(`${where}: reason too short to explain the waiver`);
    if (e.expires === undefined || e.expires === null || e.expires === "") return void problems.push(`${where}: missing expires`);
    const exp = parseDate(e.expires);
    if (exp === null) problems.push(`${where}: expires must be a real date as YYYY-MM-DD, got ${JSON.stringify(e.expires)}`);
    else if (exp < today) problems.push(`${where}: expired on ${e.expires}; re-read the licence, then remove the package or renew with a new reason`);
    else if (exp - today > MAX_DAYS * DAY_MS) problems.push(`${where}: expires ${e.expires} is more than ${MAX_DAYS} days out`);
  });
  return problems;
}

/**
 * Resolve every package's licence and classify it.
 * @param {{ lock: any, allowlist: any, now: Date,
 *           fallbackLicense: (p: { path: string, name: string, version: string }) => Promise<string | null> }} input
 */
export async function licenseReport({ lock, allowlist, now, fallbackLicense }) {
  const problems = allowlistProblems(allowlist, now);
  const entries = problems.length ? [] : allowlist.entries;
  const pkgs = lockPackages(lock);
  const seen = new Map();
  for (const p of pkgs) {
    const key = `${p.name}@${p.version}`;
    const prev = seen.get(key);
    if (!prev || (!prev.entry.license && p.entry.license)) seen.set(key, p);
  }
  const unique = [...seen.values()];
  const licenses = await mapLimit(unique, 16, async (p) => {
    const fromLock = manifestLicense({ license: p.entry.license });
    if (fromLock) return fromLock;
    return fallbackLicense(p).catch(() => null);
  });
  const failed = [];
  const reported = [];
  const allowed = [];
  const used = new Set();
  unique.forEach((p, i) => {
    const license = licenses[i];
    const { verdict, why } = classifyLicense(license);
    const row = { name: p.name, version: p.version, license: license ?? "(none)", why };
    if (verdict === "report") reported.push(row);
    if (verdict !== "fail") return;
    const hit = entries.findIndex((e) => e.package === p.name && (e.version === undefined || e.version === p.version) && e.license === row.license);
    if (hit === -1) failed.push(row);
    else {
      used.add(hit);
      allowed.push({ ...row, reason: entries[hit].reason, expires: entries[hit].expires });
    }
  });
  const unused = entries.filter((_, idx) => !used.has(idx)).map((e) => `${e.package}${e.version ? `@${e.version}` : ""}`);
  return { checked: unique.length, failed, reported, allowed, unused, problems };
}

async function main() {
  const lockArg = process.argv.find((a) => a.startsWith("--lockfile="))?.slice("--lockfile=".length) ?? "package-lock.json";
  const offline = process.argv.includes("--offline");
  const jsonOut = process.argv.find((a) => a.startsWith("--json="))?.slice("--json=".length);
  const lock = parseLock(readFileSync(path.resolve(ROOT, lockArg), "utf8"), lockArg);
  const allowlist = JSON.parse(readFileSync(path.join(ROOT, ALLOWLIST_PATH), "utf8"));
  const fallbackLicense = async (p) => {
    const local = path.join(ROOT, p.path, "package.json");
    if (existsSync(local)) {
      const fromDisk = manifestLicense(JSON.parse(readFileSync(local, "utf8")));
      if (fromDisk) return fromDisk;
    }
    if (offline) return null;
    return manifestLicense(await fetchVersionManifest(p.name, p.version));
  };
  const r = await licenseReport({ lock, allowlist, now: new Date(), fallbackLicense });
  // tw-031: security-weekly.yml hands this report to scripts/ci/security-findings.mjs (one issue per failure).
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(r, null, 2)}\n`);
  console.log(`license-check: ${r.checked} packages checked`);
  for (const row of r.reported) console.log(`  report (${row.why}, not failed): ${row.name}@${row.version} ${row.license}`);
  for (const row of r.allowed) console.log(`  allowlisted until ${row.expires}: ${row.name}@${row.version} ${row.license} (${row.reason})`);
  for (const u of r.unused) console.log(`  note: allowlist entry ${u} matches nothing; remove it`);
  for (const p of r.problems) console.error(`license-check: ${p}`);
  for (const row of r.failed) console.error(`  FAIL (${row.why}): ${row.name}@${row.version} license=${row.license}`);
  if (r.failed.length || r.problems.length) {
    console.error(`license-check: FAILED. Replace the package, or add a reviewed entry to ${ALLOWLIST_PATH} (package, license, reason, owner, expires at most ${MAX_DAYS} days out).`);
    process.exit(1);
  }
  console.log("license-check: ok");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`license-check: ${err.message}`);
    process.exit(1);
  });
}
