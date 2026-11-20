// tw-032: tests for scripts/ci/dependabot-policy.mjs. GitHub is faked in memory; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTOMERGE_LABEL,
  COMMENT_MARKER,
  DEPENDABOT,
  NEEDS_JOE_LABEL,
  classify,
  githubAutoMerge,
  githubClient,
  requiredChecks,
  run,
  waitForCheck,
} from "./dependabot-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** A fake repo: settings, protection, labels and comments on PR #7, recorded writes. */
function fakeGitHub({ allowAutoMerge = false, branch = { protected: false, protection: { enabled: false, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } } }, comments = [], checkRuns = [] } = {}) {
  const writes = [];
  const labels = new Set(["dependencies"]);
  const client = {
    repo: async () => ({ default_branch: "main", allow_auto_merge: allowAutoMerge }),
    branch: async () => branch,
    pull: async () => ({}),
    comments: async () => comments,
    checkRuns: async () => ({ check_runs: checkRuns.length > 1 ? [checkRuns.shift()] : checkRuns }),
    ensureLabel: async (name) => writes.push(["ensureLabel", name]),
    addLabels: async (n, ls) => {
      ls.forEach((l) => labels.add(l));
      writes.push(["addLabels", n, ls]);
    },
    removeLabel: async (n, l) => {
      labels.delete(l);
      writes.push(["removeLabel", n, l]);
    },
    comment: async (n, body) => writes.push(["comment", n, body]),
  };
  return { client, writes, labels };
}

const env = (over = {}) => ({
  PR_NUMBER: "7",
  HEAD_SHA: "a".repeat(40),
  BASE_REF: "main",
  GITHUB_ACTOR: DEPENDABOT,
  UPDATE_TYPE: "version-update:semver-patch",
  PACKAGE_ECOSYSTEM: "npm_and_yarn",
  DEPENDENCY_NAMES: "fastify",
  PREVIOUS_VERSION: "5.12.5",
  NEW_VERSION: "5.12.6",
  MAINTAINER_CHANGES: "false",
  ...over,
});
const protectedBranch = { protected: true, protection: { enabled: true, required_status_checks: { enforcement_level: "everyone", contexts: ["api-tests"], checks: [{ context: "security-audit" }] } } };

test("patch and minor are automerge; major, unknown and maintainer changes are needs-joe", () => {
  assert.equal(classify({ updateType: "version-update:semver-patch", actor: DEPENDABOT }).verdict, "automerge");
  assert.equal(classify({ updateType: "version-update:semver-minor", actor: DEPENDABOT }).verdict, "automerge");
  assert.equal(classify({ updateType: "version-update:semver-major", actor: DEPENDABOT }).verdict, "needs-joe");
  assert.equal(classify({ updateType: "", actor: DEPENDABOT }).verdict, "needs-joe");
  assert.equal(classify({ updateType: undefined, actor: DEPENDABOT }).verdict, "needs-joe");
  assert.match(classify({ updateType: "version-update:semver-patch", maintainerChanges: "true", actor: DEPENDABOT }).reason, /maintainers changed/);
  assert.equal(classify({ updateType: "version-update:semver-patch", actor: "someone" }).verdict, "needs-joe");
});

test("required checks are read from the branch summary, and only when enforced", () => {
  assert.deepEqual(requiredChecks(protectedBranch), ["api-tests", "security-audit"]);
  assert.deepEqual(requiredChecks({ protected: true, protection: { required_status_checks: { enforcement_level: "off", contexts: ["x"] } } }), []);
  assert.deepEqual(requiredChecks({ protected: false }), []);
  assert.deepEqual(requiredChecks(null), []); // 403/404 from the branch endpoint
});

test("GitHub auto-merge fails closed without the setting, without required checks, or before dependency-review passes", () => {
  const base = { verdict: "automerge", allowAutoMerge: true, required: ["api-tests"], ecosystem: "npm_and_yarn", depReview: "success" };
  assert.equal(githubAutoMerge(base).enable, true);
  assert.equal(githubAutoMerge({ ...base, allowAutoMerge: false }).enable, false);
  assert.equal(githubAutoMerge({ ...base, allowAutoMerge: undefined }).enable, false);
  assert.equal(githubAutoMerge({ ...base, required: [] }).enable, false);
  assert.equal(githubAutoMerge({ ...base, depReview: "failure" }).enable, false);
  assert.equal(githubAutoMerge({ ...base, depReview: "missing" }).enable, false);
  assert.equal(githubAutoMerge({ ...base, ecosystem: "github_actions", depReview: undefined }).enable, true);
  assert.equal(githubAutoMerge({ ...base, verdict: "needs-joe" }).enable, false);
});

test("a patch PR on today's repo (no auto-merge setting, no protection) is labelled automerge and left for pr-sweep", async () => {
  const gh = fakeGitHub();
  let waited = false;
  const r = await run({ env: env(), client: gh.client, root: ROOT, wait: async () => ((waited = true), "success") });
  assert.equal(r.verdict, "automerge");
  assert.equal(r.github.enable, false);
  assert.match(r.github.reason, /pr-sweep/);
  assert.equal(waited, false, "no point waiting for dependency-review when GitHub auto-merge is off anyway");
  assert.ok(gh.labels.has(AUTOMERGE_LABEL));
  assert.ok(!gh.writes.some((w) => w[0] === "comment"));
});

test("a minor PR on a protected repo that allows auto-merge enables it after dependency-review passes", async () => {
  const gh = fakeGitHub({ allowAutoMerge: true, branch: protectedBranch });
  const r = await run({ env: env({ UPDATE_TYPE: "version-update:semver-minor" }), client: gh.client, root: ROOT, wait: async () => "success" });
  assert.equal(r.github.enable, true);
  const red = await run({ env: env({ UPDATE_TYPE: "version-update:semver-minor" }), client: fakeGitHub({ allowAutoMerge: true, branch: protectedBranch }).client, root: ROOT, wait: async () => "failure" });
  assert.equal(red.github.enable, false);
});

test("a major PR gets needs-joe, loses automerge and one comment naming the reviewer", async () => {
  const gh = fakeGitHub({ allowAutoMerge: true, branch: protectedBranch });
  gh.labels.add(AUTOMERGE_LABEL);
  const r = await run({ env: env({ UPDATE_TYPE: "version-update:semver-major", DEPENDENCY_NAMES: "vite", PREVIOUS_VERSION: "6.4.6", NEW_VERSION: "7.0.0" }), client: gh.client, root: ROOT });
  assert.equal(r.verdict, "needs-joe");
  assert.equal(r.github.enable, false);
  assert.ok(gh.labels.has(NEEDS_JOE_LABEL));
  assert.ok(!gh.labels.has(AUTOMERGE_LABEL));
  const comment = gh.writes.find((w) => w[0] === "comment");
  assert.ok(comment);
  const reviewer = JSON.parse(readFileSync(path.join(ROOT, "security/deps-reviewers.json"), "utf8")).reviewers[0];
  assert.match(comment[2], new RegExp(`@${reviewer} \`vite\` 6\\.4\\.6 -> 7\\.0\\.0 needs your review: major update`));
  assert.ok(comment[2].includes(COMMENT_MARKER));
});

test("the needs-joe comment is posted once (a Dependabot rebase re-runs the job)", async () => {
  const gh = fakeGitHub({ comments: [{ body: `${COMMENT_MARKER}\n@joe earlier` }] });
  const r = await run({ env: env({ UPDATE_TYPE: "version-update:semver-major" }), client: gh.client, root: ROOT });
  assert.ok(!gh.writes.some((w) => w[0] === "comment"));
  assert.ok(r.lines.includes("needs-joe comment already posted"));
});

test("dry run reads but writes nothing", async () => {
  const gh = fakeGitHub();
  const r = await run({ env: env({ UPDATE_TYPE: "version-update:semver-major" }), client: gh.client, root: ROOT, dryRun: true });
  assert.deepEqual(gh.writes, []);
  assert.ok(r.lines.some((l) => l.startsWith(`WOULD label ${NEEDS_JOE_LABEL}`)));
});

test("waitForCheck polls until the check completes, and gives up as not-success", async () => {
  let t = 0;
  const clock = { now: () => t, sleep: async (ms) => void (t += ms) };
  const runs = [{ status: "queued" }, { status: "in_progress" }, { status: "completed", conclusion: "success", started_at: "2026-11-11T00:00:00Z" }];
  let i = 0;
  const client = { checkRuns: async () => ({ check_runs: [runs[Math.min(i++, 2)]] }) };
  assert.equal(await waitForCheck(client, "sha", { ...clock, intervalMs: 10 }), "success");
  t = 0;
  assert.equal(await waitForCheck({ checkRuns: async () => ({ check_runs: [] }) }, "sha", { ...clock, timeoutMs: 50, intervalMs: 10 }), "missing");
  t = 0;
  assert.equal(await waitForCheck({ checkRuns: async () => ({ check_runs: [{ status: "in_progress" }] }) }, "sha", { ...clock, timeoutMs: 50, intervalMs: 10 }), "timed_out_waiting");
});

test("the REST client treats a 404 label removal and a 422 existing label as done, and a 403 branch as unprotected", async () => {
  const calls = [];
  const status = { "DELETE /issues/7/labels/automerge": 404, "POST /labels": 422, "GET /branches/main": 403 };
  const fetchImpl = async (url, init) => {
    const key = `${init.method} ${url.replace("https://api.github.com/repos/o/r", "")}`;
    calls.push(key);
    const s = status[key] ?? 200;
    return { ok: s < 300, status: s, json: async () => ({}), text: async () => "x" };
  };
  const c = githubClient({ token: "t", repo: "o/r", fetchImpl });
  assert.equal(await c.removeLabel(7, "automerge"), null);
  assert.equal(await c.ensureLabel("automerge"), null);
  assert.equal(await c.branch("main"), null);
  assert.deepEqual(requiredChecks(await c.branch("main")), []);
  await assert.rejects(githubClient({ token: "t", repo: "o/r", fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }) }).comment(7, "x"), /answered 500/);
});

test("the workflow is wired the way the policy assumes", () => {
  const wf = readFileSync(path.join(ROOT, ".github/workflows/dependabot-policy.yml"), "utf8");
  assert.match(wf, /github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'/, "runs only on Dependabot's PRs");
  assert.match(wf, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/, "the policy script comes from the base commit, not the PR");
  assert.match(wf, /dependabot\/fetch-metadata@[0-9a-f]{40} # v\d/, "fetch-metadata is SHA-pinned");
  assert.match(wf, /steps\.policy\.outputs\.github_automerge == 'true'/, "gh pr merge --auto runs only when the policy says so");
  assert.match(wf, /gh pr merge --auto --squash/);
  assert.match(wf, /--withdraw/, "a failed run takes the automerge label away");
  assert.doesNotMatch(wf, /pull_request_target/);
  assert.doesNotMatch(wf, /secrets\./);
  const cfg = readFileSync(path.join(ROOT, ".github/dependabot.yml"), "utf8");
  for (const eco of ["npm", "github-actions"]) assert.match(cfg, new RegExp(`package-ecosystem: ${eco}\\n    directory: /\\n    schedule:\\n      interval: weekly`));
  assert.equal((cfg.match(/applies-to: security-updates/g) ?? []).length, 2, "security updates are grouped too");
  assert.equal((cfg.match(/update-types: \[minor, patch\]/g) ?? []).length, 4, "majors are never in a group");
});
