// tw-030: tests for scripts/ci/workflow-lint.mjs. Workflows in memory, one rule per test, plus a run over this
// repo's real .github/workflows (must pass) and over a copy of it with one action seeded back to a tag (must fail).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintDirectory, lintWorkflow } from "./workflow-lint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOWS = path.join(ROOT, ".github/workflows");
const CHECKOUT = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0";
const SETUP_NODE = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0";

/** A clean pull_request workflow; `over` replaces named parts. */
function wf(over = {}) {
  const o = {
    on: "on:\n  pull_request:\n    branches: [main]\n",
    permissions: "permissions:\n  contents: read\n",
    jobPermissions: "",
    checkout: `      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n`,
    steps: `      - uses: ${SETUP_NODE}\n        with:\n          node-version: 20\n      - run: npm ci\n`,
    ...over,
  };
  return `name: T\n\n${o.on}\n${o.permissions}\njobs:\n  build:\n    runs-on: ubuntu-latest\n${o.jobPermissions}    steps:\n${o.checkout}${o.steps}`;
}
const lint = (text) => lintWorkflow("t.yml", text).problems;

test("a clean workflow passes", () => {
  assert.deepEqual(lint(wf()), []);
});

test("a tag or branch ref fails; a full SHA without its version comment fails; local and digest refs pass", () => {
  assert.match(lint(wf({ checkout: "      - uses: actions/checkout@v4\n        with:\n          persist-credentials: false\n" })).join("\n"), /actions\/checkout@v4 is not pinned to a full commit SHA/);
  assert.match(lint(wf({ steps: "      - uses: actions/setup-node@main\n" })).join("\n"), /setup-node@main is not pinned/);
  assert.match(lint(wf({ steps: "      - uses: actions/setup-node@49933ea\n" })).join("\n"), /not pinned to a full commit SHA/);
  assert.match(lint(wf({ steps: "      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\n" })).join("\n"), /needs its version as a trailing comment/);
  assert.match(lint(wf({ steps: "      - name: x\n        uses: owner/action/sub@v1 # v1\n" })).join("\n"), /owner\/action\/sub@v1 is not pinned/);
  assert.deepEqual(lint(wf({ steps: "      - uses: ./.github/actions/local\n" })), []);
  assert.match(lint(wf({ steps: "      - uses: docker://semgrep/semgrep:1.182.1\n" })).join("\n"), /not pinned to an @sha256: digest/);
  assert.deepEqual(lint(wf({ steps: `      - uses: docker://semgrep/semgrep@sha256:${"a".repeat(64)}\n` })), []);
});

test("a comment mentioning uses: is not a step", () => {
  assert.deepEqual(lint(wf({ steps: "      # uses: actions/checkout@v4 would be wrong here\n      - run: echo ok\n" })), []);
});

test("no top-level permissions fails; a top-level write fails; {} and read-all pass", () => {
  assert.match(lint(wf({ permissions: "" })).join("\n"), /no top-level permissions block/);
  assert.match(lint(wf({ permissions: "permissions:\n  contents: write\n" })).join("\n"), /top-level permissions grant write/);
  assert.match(lint(wf({ permissions: "permissions: write-all\n" })).join("\n"), /top-level permissions grant write/);
  assert.deepEqual(lint(wf({ permissions: "permissions: {}\n" })), []);
  assert.deepEqual(lint(wf({ permissions: "permissions: read-all\n" })), []);
  // a job-level permissions block does not count as the top-level one
  assert.match(lint(wf({ permissions: "", jobPermissions: "    permissions:\n      contents: read\n" })).join("\n"), /no top-level permissions block/);
});

test("pull_request_target fails, in a block or a flow list", () => {
  assert.match(lint(wf({ on: "on:\n  pull_request_target:\n    types: [opened]\n" })).join("\n"), /pull_request_target/);
  assert.match(lint(wf({ on: "on: [push, pull_request_target]\n" })).join("\n"), /pull_request_target/);
});

test("a secret in a pull_request workflow fails and names the job; on push or schedule it passes", () => {
  const steps = "      - run: npm test\n        env:\n          KEY: ${{ secrets.E2E_STRIPE_TEST_SECRET_KEY }}\n";
  assert.match(lint(wf({ steps })).join("\n"), /t\.yml:\d+: job build reads a secret in a workflow a pull_request can trigger/);
  assert.match(lint(wf({ on: "on: [push, pull_request]\n", steps })).join("\n"), /reads a secret/);
  assert.match(lint(wf({ steps: "      - run: echo ${{ secrets['X'] }}\n" })).join("\n"), /reads a secret/);
  assert.deepEqual(lint(wf({ on: "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n", steps })), []);
  assert.deepEqual(lint(wf({ on: "on:\n  schedule:\n    - cron: \"0 0 * * *\"\n", steps })), []);
  // github.token is not a secrets.* read
  assert.deepEqual(lint(wf({ steps: "      - run: node x.mjs\n        env:\n          GITHUB_TOKEN: ${{ github.token }}\n" })), []);
  // a comment that mentions secrets. is not a read
  assert.deepEqual(lint(wf({ steps: "      # no secrets.* here on purpose\n      - run: echo ok\n" })), []);
});

test("checkout must drop the token unless the job may write contents", () => {
  const bare = `      - uses: ${CHECKOUT}\n`;
  const withDepth = `      - uses: ${CHECKOUT}\n        with:\n          fetch-depth: 0\n`;
  assert.match(lint(wf({ checkout: bare })).join("\n"), /job build checks out without `persist-credentials: false`/);
  assert.match(lint(wf({ checkout: withDepth })).join("\n"), /persist-credentials/);
  assert.match(lint(wf({ checkout: `      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: true\n` })).join("\n"), /persist-credentials/);
  // a persist-credentials line in a LATER step does not cover this checkout
  assert.match(lint(wf({ checkout: bare, steps: `      - uses: ${SETUP_NODE}\n        with:\n          persist-credentials: false\n` })).join("\n"), /persist-credentials/);
  // the one pushing job (contents: write) may keep it
  assert.deepEqual(lint(wf({ on: "on:\n  push:\n    branches: [main]\n", checkout: bare, jobPermissions: "    permissions:\n      contents: write\n" })), []);
  // a write on something else does not count
  assert.match(lint(wf({ checkout: bare, jobPermissions: "    permissions:\n      issues: write\n" })).join("\n"), /persist-credentials/);
});

test("npx --yes with no exact version fails; an exact version is only noted; npx --no-install passes", () => {
  assert.match(lint(wf({ steps: "      - run: npx --yes audit-ci@^7 --config audit-ci.json\n" })).join("\n"), /fetches an unpinned tool at run time/);
  assert.match(lint(wf({ steps: "      - run: npx -y some-tool\n" })).join("\n"), /fetches an unpinned tool/);
  const exact = lintWorkflow("t.yml", wf({ steps: "      - run: npx --yes @lhci/cli@0.15.1 autorun\n" }));
  assert.deepEqual(exact.problems, []);
  assert.match(exact.notes.join("\n"), /@lhci\/cli@0\.15\.1 is fetched at run time/);
  assert.deepEqual(lint(wf({ steps: "      - run: npx --no-install audit-ci --config audit-ci.json\n      - run: npx --workspace=e2e playwright test --list\n" })), []);
});

test("this repo's real workflows pass", () => {
  const r = lintDirectory(WORKFLOWS);
  assert.ok(r.files.length >= 5, `expected this repo's workflows, found ${r.files.join(", ")}`);
  assert.deepEqual(r.problems, []);
});

test("the real tree with one action seeded back to a tag fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "workflow-lint-"));
  for (const f of readdirSync(WORKFLOWS)) copyFileSync(path.join(WORKFLOWS, f), path.join(dir, f));
  const target = path.join(dir, "api.yml");
  const text = readFileSync(target, "utf8");
  const seeded = text.replace(/actions\/checkout@[0-9a-f]{40} # v[\d.]+/, "actions/checkout@v4");
  assert.notEqual(seeded, text, "api.yml should carry a pinned checkout to seed");
  writeFileSync(target, seeded);
  const r = lintDirectory(dir);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^\.github\/workflows\/api\.yml:\d+: actions\/checkout@v4 is not pinned to a full commit SHA/);
});

test("cs-012: a workflow that pushes fails (no workflow pushes to main)", () => {
  const r = lintWorkflow("t.yml", wf({ on: "on:\n  push:\n    branches: [main]\n", steps: "      - run: git push origin HEAD:main\n" }));
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /git push/);
});
