// tw-027: tests for scripts/ci/audit-allowlist.mjs. Pure inputs and a fixed clock; the last tests check
// this repo's own security/audit-allowlist.json and audit-ci.json, so a stale waiver fails CI here too.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  allowlistProblems,
  buildAuditCiConfig,
  checkProblems,
  parseDate,
  serialise,
} from "./audit-allowlist.mjs";

const NOW = new Date("2026-11-10T15:00:00Z");
const REASON = "Transitive dev-only dependency, never reached with attacker input.";
const entry = (over = {}) => ({ id: "GHSA-ggr8-5vv4-36mx", reason: REASON, expires: "2027-01-15", owner: "joe", ...over });
const doc = (...entries) => ({ entries });

test("a complete, unexpired entry within 90 days passes", () => {
  assert.deepEqual(allowlistProblems(doc(entry()), NOW), []);
  assert.deepEqual(allowlistProblems(doc(entry({ id: "CVE-2026-12345" })), NOW), []);
  assert.deepEqual(allowlistProblems(doc(), NOW), []);
});

test("an entry with no expiry fails", () => {
  const { expires, ...noExpiry } = entry();
  assert.match(allowlistProblems(doc(noExpiry), NOW).join("\n"), /missing expires/);
  assert.match(allowlistProblems(doc(entry({ expires: "" })), NOW).join("\n"), /missing expires/);
});

test("an expired entry fails; expiring today still passes", () => {
  assert.match(allowlistProblems(doc(entry({ expires: "2026-11-09" })), NOW).join("\n"), /expired on 2026-11-09/);
  assert.deepEqual(allowlistProblems(doc(entry({ expires: "2026-11-10" })), NOW), []);
});

test("an expiry more than 90 days out fails; exactly 90 days passes", () => {
  assert.deepEqual(allowlistProblems(doc(entry({ expires: "2027-02-08" })), NOW), []);
  assert.match(allowlistProblems(doc(entry({ expires: "2027-02-09" })), NOW).join("\n"), /more than 90 days out/);
});

test("a malformed or impossible date fails", () => {
  for (const bad of ["2027-02-30", "15/01/2027", "2027-1-5", 20270115]) {
    assert.match(allowlistProblems(doc(entry({ expires: bad })), NOW).join("\n"), /real date as YYYY-MM-DD/, String(bad));
  }
});

test("missing id, reason or owner fails, as does a non-advisory id or a duplicate", () => {
  const { id, ...noId } = entry();
  assert.match(allowlistProblems(doc(noId), NOW).join("\n"), /missing id/);
  assert.match(allowlistProblems(doc(entry({ reason: "  " })), NOW).join("\n"), /missing reason/);
  assert.match(allowlistProblems(doc(entry({ reason: "ok" })), NOW).join("\n"), /reason too short/);
  assert.match(allowlistProblems(doc(entry({ owner: undefined })), NOW).join("\n"), /missing owner/);
  assert.match(allowlistProblems(doc(entry({ id: "deepmerge-ts" })), NOW).join("\n"), /must be an advisory id/);
  assert.match(allowlistProblems(doc(entry(), entry()), NOW).join("\n"), /duplicate id/);
});

test("a file without an entries array fails", () => {
  assert.match(allowlistProblems([], NOW).join("\n"), /"entries" array/);
  assert.match(allowlistProblems({ allowlist: [] }, NOW).join("\n"), /"entries" array/);
  assert.match(checkProblems({ allowlistText: "{", auditCiText: "", now: NOW }).join("\n"), /not valid JSON/);
});

test("parseDate accepts real dates only", () => {
  assert.equal(parseDate("2028-02-29"), Date.UTC(2028, 1, 29));
  assert.equal(parseDate("2027-02-29"), null);
});

test("audit-ci.json is generated with high + critical and the ids, and drift fails the check", () => {
  const d = doc(entry(), entry({ id: "CVE-2026-0001" }));
  const config = buildAuditCiConfig(d);
  assert.equal(config.high, true);
  assert.equal(config.critical, true);
  assert.deepEqual(config.allowlist, ["GHSA-ggr8-5vv4-36mx", "CVE-2026-0001"]);
  const allowlistText = JSON.stringify(d);
  assert.deepEqual(checkProblems({ allowlistText, auditCiText: serialise(config), now: NOW }), []);
  const stale = serialise({ ...config, allowlist: ["GHSA-ggr8-5vv4-36mx"] });
  assert.match(checkProblems({ allowlistText, auditCiText: stale, now: NOW }).join("\n"), /out of step/);
  assert.match(checkProblems({ allowlistText, auditCiText: "", now: NOW }).join("\n"), /out of step/);
});

test("this repo's allowlist is valid today and audit-ci.json matches it", () => {
  const allowlistText = readFileSync(new URL("../../security/audit-allowlist.json", import.meta.url), "utf8");
  const auditCiText = readFileSync(new URL("../../audit-ci.json", import.meta.url), "utf8");
  assert.deepEqual(checkProblems({ allowlistText, auditCiText, now: new Date() }), []);
});

test("no workflow pushes to the repo from the security-audit job or runs npm audit fix", () => {
  const yml = readFileSync(new URL("../../.github/workflows/api.yml", import.meta.url), "utf8");
  // cs-012: the audit is folded into api.yml's one job.
  const start = yml.indexOf("\n  api:");
  assert.ok(start > 0, "api job present");
  const rest = yml.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
  const job = next === -1 ? rest : rest.slice(0, next + 1);
  assert.doesNotMatch(job, /git push|npm audit fix|continue-on-error|contents: write/);
  // tw-030: audit-ci comes from the lockfile (an exact root devDependency), never fetched at run time.
  assert.match(job, /npx --no-install audit-ci /, "audit-ci run from the lockfile");
  assert.doesNotMatch(job, /npx (--yes|-y) audit-ci/, "audit-ci never fetched at run time");
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.match(pkg.devDependencies?.["audit-ci"] ?? "", /^\d+\.\d+\.\d+$/, "audit-ci an exact root devDependency");
  assert.match(job, /node scripts\/ci\/audit-allowlist\.mjs/);
});
