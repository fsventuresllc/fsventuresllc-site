#!/usr/bin/env node
// tw-032: what happens to a Dependabot PR. Run by .github/workflows/dependabot-policy.yml after
// dependabot/fetch-metadata, from the BASE commit's copy of this file (never the PR's), with the job's own
// token. No dependencies; tests in dependabot-policy.test.mjs (GitHub faked).
//
// Policy (Joe, 2026-11-10 standup):
//   - semver patch or minor, maintainers unchanged  -> label `automerge`. The PR is merged only once EVERY
//     check on it is green: by the factory's bin/pr-sweep.sh (it merges a dependabot/* PR only with this
//     label, no `needs-joe`, every commit by Dependabot, all checks green, mergeable_state clean), or by
//     GitHub auto-merge where the repo really has required status checks (see githubAutoMerge below).
//   - semver major, maintainer changes, or an update type fetch-metadata could not read -> label
//     `needs-joe`, one comment naming the reviewer, `automerge` removed. Never merged automatically.
//
// GitHub auto-merge (`gh pr merge --auto`) is used ONLY when the repo allows auto-merge AND the default
// branch has enforced required status checks. Without required checks `gh pr merge --auto` would merge at
// once, so it fails closed: no GitHub auto-merge, and the PR waits for pr-sweep's all-green check. On a
// private repo on GitHub's Free plan neither setting exists (branch protection and rulesets answer
// "Upgrade to GitHub Pro"), so today pr-sweep is the only merger. For an npm PR the GitHub path also waits
// for `dependency-review` (deps.yml) to pass first: it is path-filtered and so never a required check.
//
//   node scripts/ci/dependabot-policy.mjs            decide and apply (env below)
//   node scripts/ci/dependabot-policy.mjs --withdraw remove `automerge` (a later step failed)
//   node scripts/ci/dependabot-policy.mjs --dry-run  read GitHub, print what it would do, write nothing
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, BASE_REF, GITHUB_ACTOR, and from
// fetch-metadata UPDATE_TYPE, PACKAGE_ECOSYSTEM, DEPENDENCY_NAMES, DEPENDENCY_GROUP, MAINTAINER_CHANGES,
// PREVIOUS_VERSION, NEW_VERSION. Writes `github_automerge=true|false` and `verdict=` to GITHUB_OUTPUT.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AUTOMERGE_LABEL = "automerge";
export const NEEDS_JOE_LABEL = "needs-joe";
export const DEPENDABOT = "dependabot[bot]";
export const COMMENT_MARKER = "<!-- dependabot-policy:needs-joe -->";
export const LABELS = {
  [AUTOMERGE_LABEL]: { color: "0e8a16", description: "Dependabot patch/minor: merged once every check is green (tw-032)" },
  [NEEDS_JOE_LABEL]: { color: "d93f0b", description: "Dependabot major or unusual update: Joe reviews, never auto-merged (tw-032)" },
};
export const DEP_REVIEW_CHECK = "dependency-review";

/**
 * The policy verdict for one Dependabot PR (pure).
 * @param {{ updateType?: string, maintainerChanges?: string, actor?: string }} m
 * @returns {{ verdict: "automerge" | "needs-joe", reason: string }}
 */
export function classify({ updateType, maintainerChanges, actor }) {
  if (actor !== DEPENDABOT) return { verdict: "needs-joe", reason: `the push was by ${actor || "an unknown actor"}, not ${DEPENDABOT}` };
  if (String(maintainerChanges).toLowerCase() === "true") return { verdict: "needs-joe", reason: "the package's maintainers changed (a takeover risk)" };
  switch (updateType) {
    case "version-update:semver-patch":
    case "version-update:semver-minor":
      return { verdict: "automerge", reason: `${updateType.replace("version-update:semver-", "")} update` };
    case "version-update:semver-major":
      return { verdict: "needs-joe", reason: "major update" };
    default:
      return { verdict: "needs-joe", reason: `update type ${updateType ? `"${updateType}"` : "unknown"} (not patch/minor)` };
  }
}

/**
 * The enforced required status checks on the default branch, from GET /repos/{r}/branches/{b} (readable
 * with contents: read; branch protection itself needs admin). Empty when unprotected or not enforced.
 */
export function requiredChecks(branch) {
  const rsc = branch?.protection?.required_status_checks;
  if (!branch?.protected || !rsc || rsc.enforcement_level === "off") return [];
  const names = [...(rsc.contexts ?? []), ...(rsc.checks ?? []).map((c) => c.context)];
  return [...new Set(names.filter(Boolean))];
}

/**
 * Whether GitHub auto-merge may be enabled (pure). Fails closed on anything missing.
 * @param {{ verdict: string, allowAutoMerge?: boolean, required: string[], ecosystem?: string, depReview?: string }} o
 */
export function githubAutoMerge({ verdict, allowAutoMerge, required, ecosystem, depReview }) {
  if (verdict !== "automerge") return { enable: false, reason: "not a patch/minor verdict" };
  if (allowAutoMerge !== true) return { enable: false, reason: "the repo does not allow auto-merge (Settings > General); left for pr-sweep" };
  if (!required.length) return { enable: false, reason: "the default branch has no enforced required status checks (a private repo needs a paid plan for them); left for pr-sweep" };
  if (ecosystem === "npm_and_yarn" && depReview !== "success") return { enable: false, reason: `dependency-review is ${depReview || "missing"}, not success; left for pr-sweep` };
  return { enable: true, reason: `required checks ${required.join(", ")} gate the merge` };
}

/** The comment that names the reviewer on a needs-joe PR. */
export function needsJoeComment({ reviewer, reason, names, from, to }) {
  const what = names ? `\`${names}\`${from && to ? ` ${from} -> ${to}` : ""}` : "this update";
  return `${COMMENT_MARKER}\n@${reviewer} ${what} needs your review: ${reason}. Dependabot majors and unusual updates are never auto-merged (tw-032); merge it yourself when it is ready, or close it.`;
}

/** The reviewer the comment names: the first login in security/deps-reviewers.json (Joe). */
export function reviewerFrom(root) {
  try {
    const doc = JSON.parse(readFileSync(path.join(root, "security/deps-reviewers.json"), "utf8"));
    if (Array.isArray(doc.reviewers) && doc.reviewers[0]) return doc.reviewers[0];
  } catch {
    // fall through
  }
  return "joestella99";
}

/** A small GitHub REST client over fetch. */
export function githubClient({ token, repo, fetchImpl = fetch }) {
  const base = `https://api.github.com/repos/${repo}`;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  async function call(method, url, body, ok = []) {
    const res = await fetchImpl(url.startsWith("http") ? url : `${base}${url}`, {
      method,
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && !ok.includes(res.status)) throw new Error(`GitHub ${method} ${url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (!res.ok || res.status === 204) return null;
    return res.json().catch(() => null);
  }
  return {
    repo: () => call("GET", ""),
    branch: (name) => call("GET", `/branches/${encodeURIComponent(name)}`, undefined, [403, 404]),
    pull: (n) => call("GET", `/pulls/${n}`),
    comments: (n) => call("GET", `/issues/${n}/comments?per_page=100`),
    checkRuns: (sha, name) => call("GET", `/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=20`),
    ensureLabel: (name) => call("POST", "/labels", { name, ...LABELS[name] }, [422]),
    addLabels: (n, labels) => call("POST", `/issues/${n}/labels`, { labels }),
    removeLabel: (n, label) => call("DELETE", `/issues/${n}/labels/${encodeURIComponent(label)}`, undefined, [404]),
    comment: (n, body) => call("POST", `/issues/${n}/comments`, { body }),
  };
}

/** The newest dependency-review run's conclusion on a SHA, waiting while it is queued or running. */
export async function waitForCheck(client, sha, { name = DEP_REVIEW_CHECK, timeoutMs = 300_000, intervalMs = 10_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const end = now() + timeoutMs;
  for (;;) {
    const runs = (await client.checkRuns(sha, name))?.check_runs ?? [];
    const newest = runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
    if (newest && newest.status === "completed") return newest.conclusion;
    if (now() >= end) return newest ? "timed_out_waiting" : "missing";
    await sleep(intervalMs);
  }
}

/**
 * Decide and apply. Returns { verdict, reason, github: {enable, reason}, lines } (lines are printable).
 * @param {object} o
 */
export async function run({ env, client, root, dryRun = false, wait = waitForCheck }) {
  const n = env.PR_NUMBER;
  const lines = [];
  const { verdict, reason } = classify({ updateType: env.UPDATE_TYPE, maintainerChanges: env.MAINTAINER_CHANGES, actor: env.GITHUB_ACTOR });
  lines.push(`PR #${n}: ${env.DEPENDENCY_NAMES || "?"} (${env.PACKAGE_ECOSYSTEM || "?"}${env.DEPENDENCY_GROUP ? `, group ${env.DEPENDENCY_GROUP}` : ""}) -> ${verdict}: ${reason}`);

  let github = { enable: false, reason: "not a patch/minor verdict" };
  if (verdict === "automerge") {
    const repo = await client.repo();
    const branch = await client.branch(env.BASE_REF || repo?.default_branch || "main");
    const required = requiredChecks(branch);
    const pre = githubAutoMerge({ verdict, allowAutoMerge: repo?.allow_auto_merge, required, ecosystem: "", depReview: "success" });
    // Only wait for dependency-review when it can change the outcome.
    const depReview = pre.enable && env.PACKAGE_ECOSYSTEM === "npm_and_yarn" ? await wait(client, env.HEAD_SHA) : "success";
    github = githubAutoMerge({ verdict, allowAutoMerge: repo?.allow_auto_merge, required, ecosystem: env.PACKAGE_ECOSYSTEM, depReview });
  }
  lines.push(`GitHub auto-merge: ${github.enable ? "enable" : "no"} (${github.reason})`);

  const act = async (desc, fn) => {
    lines.push(`${dryRun ? "WOULD " : ""}${desc}`);
    if (!dryRun) await fn();
  };
  if (verdict === "automerge") {
    await act(`label ${AUTOMERGE_LABEL}`, async () => {
      await client.ensureLabel(AUTOMERGE_LABEL);
      await client.addLabels(n, [AUTOMERGE_LABEL]);
    });
    await act(`remove ${NEEDS_JOE_LABEL} (if present)`, () => client.removeLabel(n, NEEDS_JOE_LABEL));
  } else {
    await act(`remove ${AUTOMERGE_LABEL} (if present)`, () => client.removeLabel(n, AUTOMERGE_LABEL));
    await act(`label ${NEEDS_JOE_LABEL}`, async () => {
      await client.ensureLabel(NEEDS_JOE_LABEL);
      await client.addLabels(n, [NEEDS_JOE_LABEL]);
    });
    const existing = (await client.comments(n)) ?? [];
    if (existing.some((c) => String(c.body).includes(COMMENT_MARKER))) {
      lines.push("needs-joe comment already posted");
    } else {
      const body = needsJoeComment({ reviewer: reviewerFrom(root), reason, names: env.DEPENDENCY_NAMES, from: env.PREVIOUS_VERSION, to: env.NEW_VERSION });
      await act(`comment: ${body.split("\n")[1]}`, () => client.comment(n, body));
    }
  }
  return { verdict, reason, github, lines };
}

function output(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const env = process.env;
  const client = githubClient({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY });
  try {
    if (process.argv.includes("--withdraw")) {
      await client.removeLabel(env.PR_NUMBER, AUTOMERGE_LABEL);
      console.log(`dependabot-policy: removed ${AUTOMERGE_LABEL} from #${env.PR_NUMBER} (an earlier step failed)`);
    } else {
      const r = await run({ env, client, root, dryRun: process.argv.includes("--dry-run") });
      for (const l of r.lines) console.log(`dependabot-policy: ${l}`);
      output("verdict", r.verdict);
      output("github_automerge", r.github.enable ? "true" : "false");
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Dependabot policy (tw-032)\n\n${r.lines.map((l) => `- ${l}`).join("\n")}\n`);
    }
  } catch (err) {
    console.error(`dependabot-policy: ${err.message}`);
    output("github_automerge", "false");
    process.exit(1);
  }
}
