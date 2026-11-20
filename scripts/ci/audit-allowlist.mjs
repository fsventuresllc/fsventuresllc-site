#!/usr/bin/env node
// tw-027: the dependency CVE gate's allowlist has an id, a reason, an owner and an expiry, and goes stale loudly.
//
// security-audit runs audit-ci (high + critical, the `npm audit --audit-level=high` bar) from audit-ci.json.
// audit-ci's own allowlist is a bare list of ids, so a waiver never had a date and nothing failed when one
// went stale. The source of truth is now security/audit-allowlist.json; audit-ci.json is GENERATED from it.
//
//   node scripts/ci/audit-allowlist.mjs           check (exit 1 on a problem): every entry valid and
//                                                 unexpired, and audit-ci.json equal to what --write makes
//   node scripts/ci/audit-allowlist.mjs --write   regenerate audit-ci.json from the allowlist
//
// An entry needs: id (GHSA-xxxx-xxxx-xxxx or CVE-YYYY-NNNN), reason (a sentence, not a placeholder), owner
// (who re-checks it), expires (a real YYYY-MM-DD date, today or later, at most MAX_DAYS days from today).
// Duplicate ids fail. Dates are compared in UTC. Tests: audit-allowlist.test.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ALLOWLIST_PATH = "security/audit-allowlist.json";
export const AUDIT_CI_PATH = "audit-ci.json";
export const MAX_DAYS = 90;
const MIN_REASON = 20;
const ID_RE = /^(GHSA(-[23456789cfghjmpqrvwx]{4}){3}|CVE-\d{4}-\d{4,})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {string} s @returns {number | null} UTC midnight of a real calendar date, else null */
export function parseDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
  return t;
}

/** @param {Date} now @returns {number} */
function utcMidnight(now) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * Every problem with the allowlist, as human-readable lines. Empty = valid.
 * @param {unknown} doc parsed security/audit-allowlist.json
 * @param {Date} now
 * @returns {string[]}
 */
export function allowlistProblems(doc, now) {
  if (!doc || typeof doc !== "object" || !Array.isArray(/** @type {any} */ (doc).entries)) {
    return [`${ALLOWLIST_PATH}: must be an object with an "entries" array`];
  }
  const today = utcMidnight(now);
  const problems = [];
  const seen = new Set();
  /** @type {any[]} */ (/** @type {any} */ (doc).entries).forEach((e, i) => {
    const where = `entry ${i}${e && typeof e.id === "string" ? ` (${e.id})` : ""}`;
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      problems.push(`${where}: must be an object`);
      return;
    }
    if (typeof e.id !== "string" || !e.id) problems.push(`${where}: missing id`);
    else if (!ID_RE.test(e.id)) problems.push(`${where}: id must be an advisory id (GHSA-xxxx-xxxx-xxxx or CVE-YYYY-NNNN)`);
    else if (seen.has(e.id)) problems.push(`${where}: duplicate id`);
    else seen.add(e.id);
    if (typeof e.reason !== "string" || !e.reason.trim()) problems.push(`${where}: missing reason`);
    else if (e.reason.trim().length < MIN_REASON) problems.push(`${where}: reason too short to explain the waiver`);
    if (typeof e.owner !== "string" || !e.owner.trim()) problems.push(`${where}: missing owner`);
    if (e.expires === undefined || e.expires === null || e.expires === "") {
      problems.push(`${where}: missing expires`);
      return;
    }
    const exp = parseDate(e.expires);
    if (exp === null) {
      problems.push(`${where}: expires must be a real date as YYYY-MM-DD, got ${JSON.stringify(e.expires)}`);
    } else if (exp < today) {
      problems.push(`${where}: expired on ${e.expires}; re-check the advisory, then fix it or renew with a new reason`);
    } else if (exp - today > MAX_DAYS * DAY_MS) {
      problems.push(`${where}: expires ${e.expires} is more than ${MAX_DAYS} days out`);
    }
  });
  return problems;
}

/**
 * The audit-ci config the allowlist implies. Thresholds are fixed: high and critical fail.
 * @param {{ entries: { id: string }[] }} doc
 */
export function buildAuditCiConfig(doc) {
  return {
    $schema: "https://github.com/IBM/audit-ci/raw/main/docs/schema.json",
    _generated: `GENERATED from ${ALLOWLIST_PATH} by scripts/ci/audit-allowlist.mjs --write (tw-027). Do not edit by hand; reasons, owners and expiry dates live there.`,
    high: true,
    critical: true,
    allowlist: doc.entries.map((e) => e.id),
  };
}

/** @param {object} config */
export function serialise(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Allowlist problems plus drift between the committed audit-ci.json and the generated one.
 * @param {{ allowlistText: string, auditCiText: string, now: Date }} input
 */
export function checkProblems({ allowlistText, auditCiText, now }) {
  let doc;
  try {
    doc = JSON.parse(allowlistText);
  } catch (err) {
    return [`${ALLOWLIST_PATH}: not valid JSON (${/** @type {Error} */ (err).message})`];
  }
  const problems = allowlistProblems(doc, now);
  if (problems.length === 0 && auditCiText !== serialise(buildAuditCiConfig(doc))) {
    problems.push(`${AUDIT_CI_PATH} is out of step with ${ALLOWLIST_PATH}: run node scripts/ci/audit-allowlist.mjs --write`);
  }
  return problems;
}

function main() {
  const allowlistText = readFileSync(path.join(ROOT, ALLOWLIST_PATH), "utf8");
  if (process.argv.includes("--write")) {
    const doc = JSON.parse(allowlistText);
    const problems = allowlistProblems(doc, new Date());
    if (problems.length) {
      for (const p of problems) console.error(`audit-allowlist: ${p}`);
      process.exit(1);
    }
    writeFileSync(path.join(ROOT, AUDIT_CI_PATH), serialise(buildAuditCiConfig(doc)));
    console.log(`audit-allowlist: wrote ${AUDIT_CI_PATH} (${doc.entries.length} entr${doc.entries.length === 1 ? "y" : "ies"})`);
    return;
  }
  let auditCiText = "";
  try {
    auditCiText = readFileSync(path.join(ROOT, AUDIT_CI_PATH), "utf8");
  } catch {
    // missing file is reported as drift below
  }
  const problems = checkProblems({ allowlistText, auditCiText, now: new Date() });
  if (problems.length) {
    for (const p of problems) console.error(`audit-allowlist: ${p}`);
    process.exit(1);
  }
  console.log("audit-allowlist: ok");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
