#!/usr/bin/env node
// tw-028: Semgrep CE findings fail the PR unless each one is in the reviewed baseline.
//
// Semgrep CE has no baseline FILE (only --baseline-commit), so the security-scan job runs
// `semgrep scan --metrics=off --error --json` and hands the JSON to this gate:
//
//   node scripts/ci/semgrep-gate.mjs <semgrep.json> [--strict] [--json-out=<report.json>]
//
// security/semgrep-baseline.json holds the findings a person has read and accepted:
//   { "findings": [{ rule, path, code, reason, reviewedBy, reviewedOn }] }
// A finding matches an entry when the rule id, the path and `code` (the trimmed source text of the
// finding's FIRST line) are equal, so moving code up or down a file does not break the match but
// editing the flagged line does. Each entry absorbs one finding (two identical lines need two entries).
//
// Exit 1 on: a finding with no entry, an incomplete entry (every field required; reason at least 20
// characters; reviewedOn a real YYYY-MM-DD), or a Semgrep error of level "error" (a ruleset that did not
// load, a crash). Parse warnings are printed, not failed. A baseline entry that no longer matches
// anything is printed as stale; --strict (the weekly full scan) fails on it, so a fixed finding is
// dropped from the baseline within a week without a registry ruleset change turning an unrelated PR red.
// Tests: semgrep-gate.test.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASELINE_PATH = "security/semgrep-baseline.json";
const MIN_REASON = 20;
const FIELDS = ["rule", "path", "code", "reason", "reviewedBy", "reviewedOn"];

/** @param {unknown} doc @returns {string[]} */
export function baselineProblems(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(/** @type {any} */ (doc).findings)) {
    return [`${BASELINE_PATH}: expected { "findings": [...] }`];
  }
  const problems = [];
  /** @type {any[]} */ (/** @type {any} */ (doc).findings).forEach((e, i) => {
    const where = `${BASELINE_PATH} findings[${i}]`;
    if (!e || typeof e !== "object") {
      problems.push(`${where}: not an object`);
      return;
    }
    for (const f of FIELDS) {
      if (typeof e[f] !== "string" || !e[f].trim()) problems.push(`${where}: missing ${f}`);
    }
    if (typeof e.reason === "string" && e.reason.trim() && e.reason.trim().length < MIN_REASON) {
      problems.push(`${where}: reason too short (say why this is not a vulnerability)`);
    }
    if (typeof e.reviewedOn === "string" && e.reviewedOn && !isRealDate(e.reviewedOn)) {
      problems.push(`${where}: reviewedOn must be a real YYYY-MM-DD date`);
    }
  });
  return problems;
}

/** @param {string} s */
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** @param {{rule: string, path: string, code: string}} f */
const keyOf = (f) => `${f.rule}\u0000${f.path}\u0000${f.code}`;

/**
 * @param {{ results?: any[], errors?: any[] }} report Semgrep's --json output
 * @param {{ findings: any[] }} baseline
 * @param {(file: string, line: number) => string} readLine source text of a 1-based line
 */
export function gate(report, baseline, readLine) {
  const problems = baselineProblems(baseline);
  const errors = (report.errors ?? []).filter((e) => e?.level === "error");
  const warnings = (report.errors ?? []).filter((e) => e?.level !== "error");
  const remaining = new Map();
  if (!problems.length) {
    for (const e of baseline.findings) {
      const k = keyOf(e);
      if (!remaining.has(k)) remaining.set(k, []);
      remaining.get(k).push(e);
    }
  }
  const unbaselined = [];
  const accepted = [];
  for (const r of report.results ?? []) {
    const finding = {
      rule: String(r.check_id),
      path: String(r.path),
      line: Number(r.start?.line),
      code: readLine(String(r.path), Number(r.start?.line)).trim(),
      message: String(r.extra?.message ?? "").split("\n")[0],
    };
    const bucket = remaining.get(keyOf(finding));
    if (bucket && bucket.length) {
      bucket.shift();
      accepted.push(finding);
    } else {
      unbaselined.push(finding);
    }
  }
  const stale = [...remaining.values()].flat();
  return { problems, errors, warnings, unbaselined, accepted, stale };
}

/** @param {string} file @param {number} line */
function readSourceLine(file, line) {
  try {
    return readFileSync(path.resolve(ROOT, file), "utf8").split("\n")[line - 1] ?? "";
  } catch {
    return "";
  }
}

function main() {
  const reportPath = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!reportPath) {
    console.error("usage: node scripts/ci/semgrep-gate.mjs <semgrep.json> [--strict]");
    process.exit(2);
  }
  const strict = process.argv.includes("--strict");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const baseline = JSON.parse(readFileSync(path.join(ROOT, BASELINE_PATH), "utf8"));
  const out = gate(report, baseline, readSourceLine);
  // tw-031: security-weekly.yml hands this to scripts/ci/security-findings.mjs (one issue per finding).
  const jsonOut = process.argv.find((a) => a.startsWith("--json-out="))?.slice("--json-out=".length);
  if (jsonOut) {
    const { unbaselined, stale, problems } = out;
    writeFileSync(jsonOut, `${JSON.stringify({ strict, unbaselined, stale, problems, errors: out.errors.map((e) => String(e.message).split("\n")[0]) }, null, 2)}\n`);
  }

  for (const w of out.warnings) console.log(`semgrep-gate: warning (not failed): ${String(w.message).split("\n")[0]}`);
  for (const p of out.problems) console.error(`semgrep-gate: ${p}`);
  for (const e of out.errors) console.error(`semgrep-gate: Semgrep error: ${String(e.message).split("\n")[0]}`);
  for (const f of out.unbaselined) {
    console.error(`semgrep-gate: NEW FINDING ${f.path}:${f.line} [${f.rule}] ${f.message}`);
    console.error(`    code: ${f.code}`);
  }
  for (const s of out.stale) {
    const say = strict ? console.error : console.log;
    say(`semgrep-gate: stale baseline entry (matches nothing now; remove it): ${s.path} [${s.rule}] ${s.code}`);
  }
  const failed = out.problems.length + out.errors.length + out.unbaselined.length + (strict ? out.stale.length : 0);
  console.log(
    `semgrep-gate: ${(report.results ?? []).length} finding(s), ${out.accepted.length} in the reviewed baseline, ` +
      `${out.unbaselined.length} new, ${out.stale.length} stale baseline entr${out.stale.length === 1 ? "y" : "ies"}`,
  );
  if (failed) {
    if (out.unbaselined.length) {
      console.error(
        "semgrep-gate: fix each new finding. Only a finding that is NOT a vulnerability goes into " +
          `${BASELINE_PATH} (rule, path, code = the flagged line trimmed, reason, reviewedBy, reviewedOn), ` +
          "and the PR reviewer reads that entry.",
      );
    }
    process.exit(1);
  }
  console.log("semgrep-gate: ok");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
