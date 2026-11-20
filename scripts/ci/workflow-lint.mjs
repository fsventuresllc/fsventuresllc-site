#!/usr/bin/env node
// tw-030: GitHub Actions workflow hardening, held by a check instead of by memory. Every file in
// .github/workflows/ must:
//
//   1. pin every `uses:` to a full 40-character commit SHA with the version as a trailing comment
//      (`actions/checkout@<sha> # v4.4.0`; Dependabot's github-actions updater bumps both). Local actions
//      (`./...`) pass; a `docker://` image must carry an `@sha256:` digest. A tag or branch can be moved
//      by whoever controls the action's repo; a commit SHA cannot.
//   2. have a top-level `permissions:` block that grants no write (`contents: read`, `{}` or `read-all`),
//      so no job inherits the repository's default token scope. Writes are granted per job only.
//   3. never use `pull_request_target` (it runs with secrets and a write token on a fork's code).
//   4. read no `secrets.*` in a workflow a `pull_request` can trigger. Secrets stay in push / schedule /
//      workflow_dispatch workflows (e2e-staging, smoke, checkout-hosted). Use `github.token` for the job's
//      own token.
//   5. check out with `persist-credentials: false`, except in a job whose permissions grant
//      `contents: write` (none pushes since tw-032 removed changelog.yml). Otherwise the token stays in
//      .git/config for every later step, including npm install scripts.
//   6. never fetch a tool at run time without an exact version (`npx --yes pkg` / `npx -y pkg@^7`). A tool
//      belongs in package.json devDependencies so the lockfile pins it; `npx --yes pkg@1.2.3` is tolerated
//      (and printed) only while a reviewer has not cleared moving it (see CLAUDE.md, tw-030).
//   7. never push from a workflow (cs-012, Joe 2026-11-10: no workflow pushes to main): no `git push` in any
//      step. The one job with `contents: write` (dependabot-policy.yml) only turns on GitHub auto-merge for a
//      Dependabot PR where required checks exist; it never pushes a commit.
//
// No dependencies: a line-based reader for the shape GitHub workflows take (block YAML, two-space
// indent), with tests in workflow-lint.test.mjs, including a run over this repo's real workflows.
//
//   node scripts/ci/workflow-lint.mjs [dir]     (default .github/workflows; exit 1 on any problem)
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;

/** Text before an unquoted ` #` comment, and the comment (without the #). */
function splitComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return { code: line.slice(0, i).replace(/\s+$/, ""), comment: line.slice(i + 1).trim() };
    }
  }
  return { code: line.replace(/\s+$/, ""), comment: "" };
}

const indentOf = (s) => s.length - s.trimStart().length;
const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, "$2");

/**
 * Lines of the workflow with comments split off, blank and comment-only lines dropped.
 * Literal block scalars (`run: |`) are kept as lines too; they never start with a YAML key we read at
 * the indents checked below, except the `secrets.` and `npx` scans, which are meant to see them.
 */
function readLines(text) {
  return text.split(/\r?\n/).map((raw, i) => ({ n: i + 1, ...splitComment(raw) })).filter((l) => l.code.trim() !== "");
}

/** The lines belonging to the block that starts after index `start` (deeper than `indent`). */
function blockAfter(lines, start, indent) {
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (indentOf(lines[i].code) <= indent) break;
    out.push(lines[i]);
  }
  return out;
}

/** Map of `key -> value` for a permissions block (inline or nested), or a string for the inline forms. */
function readPermissions(line, block) {
  const inline = line.code.slice(line.code.indexOf(":") + 1).trim();
  if (inline) return inline === "{}" ? {} : inline; // read-all / write-all / {}
  const perms = {};
  for (const l of block) {
    const m = l.code.trim().match(/^([\w-]+):\s*(\S+)/);
    if (m) perms[m[1]] = m[2];
  }
  return perms;
}

const grantsWrite = (perms) => (typeof perms === "string" ? perms === "write-all" : Object.values(perms).includes("write"));

/** The workflow's triggers (`on:` as a scalar, a flow list or a block map). */
function readTriggers(lines) {
  const i = lines.findIndex((l) => indentOf(l.code) === 0 && /^(on|"on"|'on'|true):/.test(l.code));
  if (i === -1) return [];
  const inline = lines[i].code.slice(lines[i].code.indexOf(":") + 1).trim();
  if (inline) return inline.replace(/^\[|\]$/g, "").split(",").map((s) => unquote(s)).filter(Boolean);
  const block = blockAfter(lines, i, 0);
  const childIndent = block.length ? indentOf(block[0].code) : 0;
  return block.filter((l) => indentOf(l.code) === childIndent).map((l) => unquote(l.code.trim().replace(/:.*$/, "").replace(/^-\s*/, "")));
}

/** Each job: name, its lines, its permissions (null when it sets none). */
function readJobs(lines) {
  const i = lines.findIndex((l) => indentOf(l.code) === 0 && /^jobs:/.test(l.code));
  if (i === -1) return [];
  const block = blockAfter(lines, i, 0);
  const jobIndent = block.length ? indentOf(block[0].code) : 0;
  const jobs = [];
  block.forEach((l, k) => {
    if (indentOf(l.code) !== jobIndent) return;
    const body = blockAfter(block, k, jobIndent);
    const propIndent = body.length ? indentOf(body[0].code) : 0;
    const pIdx = body.findIndex((b) => indentOf(b.code) === propIndent && /^permissions:/.test(b.code.trim()));
    const permissions = pIdx === -1 ? null : readPermissions(body[pIdx], blockAfter(body, pIdx, propIndent));
    jobs.push({ name: l.code.trim().replace(/:.*$/, ""), line: l.n, body, permissions });
  });
  return jobs;
}

/**
 * Problems in one workflow file, as readable lines.
 * @param {string} file  name shown in messages
 * @param {string} text  the workflow's YAML
 * @returns {{ problems: string[], notes: string[] }}
 */
export function lintWorkflow(file, text) {
  const problems = [];
  const notes = [];
  const lines = readLines(text);

  // 2. top-level permissions, read-only
  const top = lines.findIndex((l) => indentOf(l.code) === 0 && /^permissions:/.test(l.code));
  if (top === -1) {
    problems.push(`${file}: no top-level permissions block; add \`permissions:\\n  contents: read\` and grant writes per job`);
  } else {
    const perms = readPermissions(lines[top], blockAfter(lines, top, 0));
    if (grantsWrite(perms)) problems.push(`${file}:${lines[top].n}: the top-level permissions grant write; grant it in the one job that needs it`);
  }

  // 3. pull_request_target
  const triggers = readTriggers(lines);
  if (triggers.includes("pull_request_target")) problems.push(`${file}: pull_request_target runs a fork's code with secrets and a write token; use pull_request`);

  const jobs = readJobs(lines);
  const prReachable = triggers.includes("pull_request") || triggers.includes("pull_request_target");

  for (const l of lines) {
    // 1. pinned uses
    const u = l.code.match(/^\s*(?:-\s+)?uses:\s*(.+)$/);
    if (u) {
      const ref = unquote(u[1]);
      if (ref.startsWith("./")) {
        // local action: versioned with this repo
      } else if (ref.startsWith("docker://")) {
        if (!/@sha256:[0-9a-f]{64}$/.test(ref)) problems.push(`${file}:${l.n}: ${ref} is not pinned to an @sha256: digest`);
      } else {
        const at = ref.lastIndexOf("@");
        const sha = at === -1 ? "" : ref.slice(at + 1);
        if (!SHA.test(sha)) problems.push(`${file}:${l.n}: ${ref} is not pinned to a full commit SHA (resolve the tag's commit and write \`@<sha> # <tag>\`)`);
        else if (!/^v?\d/.test(l.comment)) problems.push(`${file}:${l.n}: ${ref} needs its version as a trailing comment (\`# v1.2.3\`)`);
      }
    }
    // 6. tools fetched at run time
    const npx = l.code.match(/\bnpx\s+(?:--yes|-y)\b(.*)$/);
    if (npx) {
      const spec = npx[1].trim().split(/\s+/).find((t) => t && !t.startsWith("-")) ?? "";
      const at = spec.lastIndexOf("@");
      const version = at > 0 ? spec.slice(at + 1) : "";
      if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`${file}:${l.n}: \`npx --yes ${spec}\` fetches an unpinned tool at run time; add it to devDependencies (lockfile) and run it with \`npx --no-install\``);
      else notes.push(`${file}:${l.n}: ${spec} is fetched at run time (exact version, but its dependencies float); move it to devDependencies when cleared`);
    }
  }

  // 7. no workflow pushes (cs-012)
  for (const l of lines) {
    if (/\bgit\s+push\b/.test(l.code)) problems.push(`${file}:${l.n}: \`git push\` in a workflow; no workflow pushes to the repo (changes arrive as reviewed PRs)`);
  }

  // 4. secrets in pull_request-reachable workflows
  if (prReachable) {
    for (const l of lines) {
      if (/\bsecrets\.[A-Za-z_]/.test(l.code) || /\bsecrets\[/.test(l.code)) {
        const job = jobs.find((j) => j.body.includes(l));
        problems.push(`${file}:${l.n}: ${job ? `job ${job.name} reads` : "reads"} a secret in a workflow a pull_request can trigger; keep secrets in push/schedule/dispatch workflows (use github.token for the job token)`);
      }
    }
  }

  // 5. persist-credentials: false, except where the job may write contents
  for (const job of jobs) {
    const effective = job.permissions ?? (top === -1 ? null : readPermissions(lines[top], blockAfter(lines, top, 0)));
    const mayPush = effective !== null && (effective === "write-all" || (typeof effective === "object" && effective.contents === "write"));
    job.body.forEach((l, k) => {
      const m = l.code.match(/^(\s*)(-\s+)?uses:\s*(.+)$/);
      if (!m || !/^actions\/checkout@/.test(unquote(m[3]))) return;
      // the step: from its `- ` line to the next line at the dash's indent or shallower
      const dashIndent = m[2] ? indentOf(l.code) : indentOf(l.code) - 2;
      const step = [];
      for (let x = k + 1; x < job.body.length && indentOf(job.body[x].code) > dashIndent; x++) step.push(job.body[x]);
      const persistOff = step.some((s) => /^\s*persist-credentials:\s*false\s*$/.test(s.code));
      if (!persistOff && !mayPush) problems.push(`${file}:${l.n}: job ${job.name} checks out without \`persist-credentials: false\` (only a job with contents: write may keep the token)`);
    });
  }

  return { problems, notes };
}

/** Lint every .yml/.yaml file in a directory. */
export function lintDirectory(dir) {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const problems = [];
  const notes = [];
  for (const f of files) {
    const r = lintWorkflow(path.posix.join(".github/workflows", f), readFileSync(path.join(dir, f), "utf8"));
    problems.push(...r.problems);
    notes.push(...r.notes);
  }
  return { files, problems, notes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, ".github/workflows");
  const { files, problems, notes } = lintDirectory(dir);
  for (const n of notes) console.log(`workflow-lint: note: ${n}`);
  if (problems.length) {
    for (const p of problems) console.error(`workflow-lint: ${p}`);
    console.error(`workflow-lint: FAILED (${problems.length} problem${problems.length === 1 ? "" : "s"} in ${files.length} workflows)`);
    process.exit(1);
  }
  console.log(`workflow-lint: ${files.length} workflows ok (SHA-pinned actions, read-only default token, no pull_request_target, no secrets on PRs, no persisted checkout token outside the pushing job)`);
}
