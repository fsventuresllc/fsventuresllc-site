// tw-031: tests for scripts/ci/security-findings.mjs. Reports in memory or a temp dir, GitHub faked, a fixed
// clock. The seeded-finding test is the order's done condition: a failing finding becomes an issue with the
// right due date (critical 48 h, high 7 days from first seen), and keeps that first seen on later runs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FIXTURE,
  MAX_NEW_ISSUES,
  allowlistFindings,
  apply,
  collect,
  dependencyFindings,
  dueFor,
  issueBody,
  licenseFindings,
  newerRelease,
  npxPins,
  parseMarker,
  plan,
  secretFindings,
  semgrepFindings,
  slug,
  toolFindings,
} from "./security-findings.mjs";

const NOW = new Date("2026-11-16T07:45:00.000Z");
const REASON = "Reviewed: only the CLI's own static config reaches this code path.";

const auditReport = {
  auditReportVersion: 2,
  vulnerabilities: {
    "@prisma/config": { name: "@prisma/config", severity: "high", via: ["deepmerge-ts"], nodes: ["node_modules/@prisma/config"] },
    "deepmerge-ts": {
      name: "deepmerge-ts",
      severity: "high",
      via: [{ source: 1, name: "deepmerge-ts", title: "stack exhaustion", url: "https://github.com/advisories/GHSA-ggr8-5vv4-36mx", severity: "high", range: "<8.0.0" }],
      nodes: ["node_modules/deepmerge-ts"],
    },
    "evil-lib": {
      name: "evil-lib",
      severity: "critical",
      via: [
        { source: 2, name: "evil-lib", title: "RCE", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "critical", range: "<2.0.0" },
        { source: 3, name: "evil-lib", title: "minor", url: "https://github.com/advisories/GHSA-mmmm-mmmm-mmmm", severity: "moderate", range: "<2.0.0" },
      ],
      nodes: ["node_modules/evil-lib", "node_modules/x/node_modules/evil-lib"],
    },
  },
};
const lock = { packages: { "node_modules/evil-lib": { version: "1.2.3" }, "node_modules/x/node_modules/evil-lib": { version: "1.0.0" }, "node_modules/deepmerge-ts": { version: "7.1.5" } } };

test("SLA: critical is due 48 hours after first seen, high 7 days", () => {
  assert.equal(dueFor("critical", "2026-11-16T07:45:00.000Z"), "2026-11-18T07:45:00.000Z");
  assert.equal(dueFor("high", "2026-11-16T07:45:00.000Z"), "2026-11-23T07:45:00.000Z");
  assert.throws(() => dueFor(/** @type {any} */ ("moderate"), NOW.toISOString()));
});

test("npm audit: one finding per high/critical advisory not allowlisted, with every path and version", () => {
  const f = dependencyFindings(auditReport, lock, ["GHSA-ggr8-5vv4-36mx"]);
  assert.equal(f.length, 1);
  assert.equal(f[0].id, "ghsa-aaaa-bbbb-cccc");
  assert.equal(f[0].severity, "critical");
  assert.equal(f[0].advisory, "GHSA-aaaa-bbbb-cccc");
  assert.match(f[0].package, /^evil-lib@1\.2\.3, 1\.0\.0 \(vulnerable <2\.0\.0\)$/);
  assert.equal(f[0].path, "node_modules/evil-lib, node_modules/x/node_modules/evil-lib");
  // Not allowlisted: the deepmerge advisory is a finding too (a string `via` never is).
  assert.deepEqual(dependencyFindings(auditReport, lock, []).map((x) => x.id).sort(), ["ghsa-aaaa-bbbb-cccc", "ghsa-ggr8-5vv4-36mx"]);
});

test("licence, secret, Semgrep and tool reports become findings; secrets are critical, the rest high", () => {
  const lic = licenseFindings({ failed: [{ name: "agpl-thing", version: "1.0.0", license: "AGPL-3.0-only", why: "AGPL" }] });
  assert.deepEqual([lic[0].id, lic[0].severity, lic[0].package], ["license-agpl-thing-1-0-0", "high", "agpl-thing@1.0.0"]);

  const leak = { RuleID: "aws-access-token", File: "api/src/x.ts", StartLine: 3, Commit: "0123456789abcdef0123", Fingerprint: "0123:api/src/x.ts:aws-access-token:3", Secret: "REDACTED", Match: "REDACTED" };
  const s = secretFindings([leak]);
  assert.equal(s[0].severity, "critical");
  assert.match(s[0].id, /^secret-[0-9a-f]{10}$/);
  assert.equal(s[0].path, "api/src/x.ts:3 @ 0123456789ab");
  assert.ok(!JSON.stringify(s).includes("REDACTED"), "no Match/Secret field is copied into a finding");
  assert.equal(secretFindings([leak])[0].id, s[0].id, "stable id across runs");

  const sg = { strict: true, unbaselined: [{ rule: "r1", path: "api/src/a.ts", line: 9, code: "eval(x)", message: "dynamic code" }], stale: [{ rule: "r2", path: "web/src/b.ts", code: "y" }] };
  assert.deepEqual(semgrepFindings(sg).map((x) => x.kind), ["sast", "baseline"]);
  assert.deepEqual(semgrepFindings({ ...sg, strict: false }).map((x) => x.kind), ["sast"], "stale entries count only under --strict");

  const t = toolFindings({ upgrades: [{ name: "@lhci/cli", pinned: "0.15.1", latest: "0.16.0", published: "2026-11-02T00:00:00.000Z", where: ".github/workflows/test.yml:191" }] });
  assert.equal(t[0].id, "tool-lhci-cli-0-16-0");
});

test("allowlists: an expired or incomplete entry in either file is a finding", () => {
  const audit = { entries: [{ id: "GHSA-ggr8-5vv4-36mx", reason: REASON, owner: "joestella99", expires: "2026-11-15" }] };
  const license = { entries: [{ package: "agpl-thing", license: "AGPL-3.0-only", reason: REASON, owner: "joestella99" }] };
  const f = allowlistFindings({ audit, license }, NOW);
  assert.equal(f.length, 2);
  assert.match(f[0].title, /expired on 2026-11-15/);
  assert.equal(f[0].package, "GHSA-ggr8-5vv4-36mx");
  assert.match(f[1].title, /missing expires/);
  assert.deepEqual(allowlistFindings({ audit: { entries: [{ ...audit.entries[0], expires: "2027-01-10" }] }, license: { entries: [] } }, NOW), []);
});

test("npx pins and the newer-release rule (newer minor/major, stable, at least 14 days old)", () => {
  const pins = npxPins([{ file: "t.yml", text: "a\n      - run: npx --yes @lhci/cli@0.15.1 autorun\n      - run: npx -y foo@1.2.3\n      - run: npx --no-install audit-ci" }]);
  assert.deepEqual(pins, [
    { name: "@lhci/cli", pinned: "0.15.1", where: "t.yml:2" },
    { name: "foo", pinned: "1.2.3", where: "t.yml:3" },
  ]);
  const times = { created: "2020-01-01T00:00:00Z", "0.15.1": "2025-06-01T00:00:00Z", "0.15.2": "2025-07-01T00:00:00Z", "0.16.0-beta.1": "2026-10-01T00:00:00Z", "0.16.0": "2026-11-02T00:00:00Z" };
  assert.equal(newerRelease("0.15.1", times, new Date("2026-11-10T00:00:00Z")), null, "0.16.0 is under 14 days old; a patch bump never counts");
  assert.deepEqual(newerRelease("0.15.1", times, new Date("2026-11-16T00:00:00Z")), { latest: "0.16.0", published: "2026-11-02T00:00:00.000Z" });
});

/** A fake GitHub: issues in memory, every call recorded. */
function fakeGitHub(issues = []) {
  const calls = [];
  let next = 100;
  return {
    issues,
    calls,
    ensureLabel: async (n) => void calls.push(["label", n]),
    createIssue: async (title, body, labels) => {
      const issue = { number: next++, title, body, labels: labels.map((name) => ({ name })), state: "open" };
      issues.push(issue);
      calls.push(["create", issue.number]);
      return issue;
    },
    updateIssue: async (number, patch) => {
      Object.assign(issues.find((i) => i.number === number), patch);
      calls.push(["update", number, patch.state ?? null]);
    },
    addLabels: async (number, labels) => void calls.push(["addLabels", number, labels.join(",")]),
    removeLabel: async (number, label) => void calls.push(["removeLabel", number, label]),
    comment: async (number) => void calls.push(["comment", number]),
  };
}

test("DONE CONDITION: a seeded failing finding opens an issue with the right due date; a later run keeps first seen", async () => {
  const gh = fakeGitHub();
  const first = plan({ findings: [{ ...FIXTURE }], scanned: ["fixture"], issues: gh.issues, now: NOW });
  assert.deepEqual(first.map((a) => a.op), ["create"]);
  await apply(first, gh, { dryRun: false });
  assert.equal(gh.issues.length, 1);
  const meta = parseMarker(gh.issues[0].body);
  assert.deepEqual([meta.id, meta.severity, meta.firstSeen, meta.due], ["fixture-tw031", "high", "2026-11-16T07:45:00.000Z", "2026-11-23T07:45:00.000Z"]);
  assert.deepEqual(gh.issues[0].labels.map((l) => l.name), ["security", "high"]);
  assert.match(gh.issues[0].body, /\| Due \| 2026-11-23T07:45:00\.000Z \(7 days from first seen\) \|/);

  // A week later it is still there: same issue, first seen and due unchanged, last seen moved.
  const later = new Date("2026-11-23T07:45:00.000Z");
  const second = plan({ findings: [{ ...FIXTURE }], scanned: ["fixture"], issues: gh.issues, now: later });
  assert.deepEqual(second.map((a) => [a.op, a.number]), [["update", 100]]);
  await apply(second, gh, { dryRun: false });
  const meta2 = parseMarker(gh.issues[0].body);
  assert.deepEqual([meta2.firstSeen, meta2.due, meta2.lastSeen], [meta.firstSeen, meta.due, later.toISOString()]);
  assert.equal(gh.issues.length, 1, "ONE issue per finding");
});

test("a finding that escalates to critical swaps the severity label and gets the 48-hour SLA", () => {
  const f = { ...FIXTURE, severity: /** @type {const} */ ("critical") };
  const body = issueBody({ ...FIXTURE }, { firstSeen: NOW.toISOString(), lastSeen: NOW.toISOString() });
  const [a] = plan({ findings: [f], scanned: [], issues: [{ number: 7, state: "open", body }], now: NOW });
  assert.equal(a.op, "update");
  assert.deepEqual([a.labels, a.dropLabels], [["security", "critical"], ["high"]]);
  assert.equal(parseMarker(a.body).due, "2026-11-18T07:45:00.000Z");
});

test("closing: gone from a scanner that ran -> closed; scanner without a report -> left open; closed + back -> reopened", async () => {
  const mk = (id, kind, number, state = "open") => ({ number, state, body: issueBody({ ...FIXTURE, id, kind }, { firstSeen: "2026-11-01T00:00:00.000Z", lastSeen: "2026-11-09T00:00:00.000Z" }) });
  const issues = [mk("ghsa-aaaa-bbbb-cccc", "dependency", 1), mk("secret-0123456789", "secret", 2), mk("license-x-1-0-0", "license", 3, "closed"), { number: 4, state: "open", body: "no marker", pull_request: {} }];
  const actions = plan({
    findings: [{ ...FIXTURE, id: "license-x-1-0-0", kind: "license" }],
    scanned: ["dependency", "license", "allowlist", "fixture"], // gitleaks produced no report
    issues,
    now: NOW,
  });
  assert.deepEqual(actions.map((a) => [a.op, a.number]), [["reopen", 3], ["close", 1]]);
  const reopened = parseMarker(actions[0].body);
  assert.equal(reopened.firstSeen, NOW.toISOString(), "a reopened finding starts a new SLA");
  assert.match(actions[0].body, /previously first seen 2026-11-01/);
  const gh = fakeGitHub(issues);
  await apply(actions, gh, { dryRun: false });
  assert.deepEqual(gh.calls.filter((c) => c[0] !== "label"), [
    ["update", 3, "open"],
    ["addLabels", 3, "security,high"],
    ["removeLabel", 3, "critical"],
    ["comment", 1],
    ["update", 1, "closed"],
  ]);
});

test("dry run writes nothing; more than MAX_NEW_ISSUES new findings are skipped, not filed", async () => {
  const findings = Array.from({ length: MAX_NEW_ISSUES + 2 }, (_, i) => ({ ...FIXTURE, id: `fixture-${i}` }));
  const actions = plan({ findings, scanned: [], issues: [], now: NOW });
  assert.equal(actions.filter((a) => a.op === "create").length, MAX_NEW_ISSUES);
  assert.equal(actions.filter((a) => a.op === "skip").length, 2);
  const gh = fakeGitHub();
  const lines = await apply(actions, gh, { dryRun: true });
  assert.deepEqual(gh.calls, []);
  assert.ok(lines.every((l) => l.startsWith("[dry-run] ")));
});

test("collect: reads a reports directory; a missing or broken report marks that scanner as not run", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-"));
  const root = path.join(dir, "repo");
  mkdirSync(path.join(root, "security"), { recursive: true });
  writeFileSync(path.join(root, "security/audit-allowlist.json"), JSON.stringify({ entries: [{ id: "GHSA-ggr8-5vv4-36mx", reason: REASON, owner: "joestella99", expires: "2027-01-10" }] }));
  writeFileSync(path.join(root, "security/license-allowlist.json"), JSON.stringify({ entries: [] }));
  writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
  const reports = path.join(dir, "reports");
  mkdirSync(reports);
  writeFileSync(path.join(reports, "npm-audit.json"), JSON.stringify(auditReport));
  writeFileSync(path.join(reports, "gitleaks.json"), "[]");
  writeFileSync(path.join(reports, "semgrep-gate.json"), "{not json");
  const { findings, scanned } = collect({ dir: reports, root, now: NOW, seed: true });
  assert.deepEqual(findings.map((f) => f.id).sort(), ["fixture-tw031", "ghsa-aaaa-bbbb-cccc"]);
  assert.deepEqual(scanned.sort(), ["allowlist", "dependency", "fixture", "secret"]);
  // npm audit's own error document (registry down) is not a scan.
  writeFileSync(path.join(reports, "npm-audit.json"), JSON.stringify({ error: { code: "ENOTFOUND" } }));
  assert.ok(!collect({ dir: reports, root, now: NOW, seed: false }).scanned.includes("dependency"));
});

test("slug keeps work-order ids safe", () => {
  assert.equal(slug("GHSA-AAAA-bbbb-cccc"), "ghsa-aaaa-bbbb-cccc");
  assert.equal(slug("license-@scope/pkg-1.0.0"), "license-scope-pkg-1-0-0");
});
