// tw-029: tests for scripts/ci/dep-review.mjs. Lockfiles are built in memory, the registry lookup is faked
// and the clock is fixed, so nothing here touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decide,
  editDistance,
  fetchIssueEvents,
  fetchLockBlob,
  fetchRunsBefore,
  headAtLabel,
  lockfileUnchanged,
  labelApproval,
  newPackages,
  reviewFlags,
  typosquatMatches,
} from "./dep-review.mjs";

const NOW = new Date("2026-11-10T12:00:00Z");
const OLD = "2025-01-01T00:00:00.000Z";
const REFERENCE = JSON.parse(readFileSync(new URL("../../security/typosquat-reference.json", import.meta.url), "utf8")).names;

/** @param {Record<string, object>} pkgs name -> entry fields */
function lock(pkgs) {
  const packages = { "": { name: "app", workspaces: ["api"] }, api: { name: "api", version: "0.0.0" }, "node_modules/api": { link: true, resolved: "api" } };
  for (const [name, entry] of Object.entries(pkgs)) packages[`node_modules/${name}`] = { version: "1.0.0", license: "MIT", ...entry };
  return { lockfileVersion: 3, packages };
}
const BASE = lock({ fastify: { version: "5.0.0" }, zod: { version: "4.6.7" }, "@prisma/client": { version: "6.19.3" } });
const allOld = async () => OLD;
const UNCHANGED = { ok: true, reason: "package-lock.json unchanged" };

/** @param {Record<string, object>} extra @param {(n: string, v: string) => Promise<string | null>} publishedAt */
async function flagsFor(extra, publishedAt = allOld) {
  const headLock = lock({ fastify: { version: "5.0.0" }, zod: { version: "4.6.7" }, "@prisma/client": { version: "6.19.3" }, ...extra });
  return reviewFlags({ baseLock: BASE, headLock, reference: REFERENCE, now: NOW, publishedAt });
}

const JOE = (event = "labeled", login = "joestella99", name = "deps-reviewed") => ({ event, label: { name }, actor: { login }, created_at: "2026-11-10T12:00:00Z" });
const reviewers = ["joestella99"];

test("edit distance counts insertions, deletions, substitutions and transpositions", () => {
  assert.equal(editDistance("lodash", "lodash", 2), 0);
  assert.equal(editDistance("lodash", "lodahs", 2), 1);
  assert.equal(editDistance("express", "expres", 2), 1);
  assert.equal(editDistance("express", "exprexx", 2), 2);
  assert.equal(editDistance("react", "preact", 2), 1);
  assert.equal(editDistance("typescript", "zod", 2), 3);
});

test("a version bump is not new; a name absent from the base is new, workspaces and links ignored", () => {
  const { added } = newPackages(BASE, lock({ fastify: { version: "5.1.0" }, zod: { version: "4.6.7" }, "left-pad": {} }));
  assert.deepEqual(added.map((p) => p.name), ["left-pad"]);
  assert.deepEqual(newPackages(BASE, BASE).added, []);
});

test("a nested path counts by its package name, and an alias by its real name", () => {
  const head = lock({ fastify: { version: "5.0.0" } });
  head.packages["node_modules/fastify/node_modules/zod"] = { version: "3.0.0", license: "MIT" };
  head.packages["node_modules/my-alias"] = { name: "evil-pkg", version: "1.0.0", license: "MIT" };
  assert.deepEqual(newPackages(BASE, head).added.map((p) => p.name), ["evil-pkg"]);
});

test("nothing new or nothing flagged passes", async () => {
  const { flags } = await flagsFor({ "left-pad": {} });
  assert.deepEqual(flags, []);
  assert.equal(decide({ flags, labelPresent: false, approval: null }).pass, true);
});

test("a NEW package with an install script fails, and passes once Joe adds deps-reviewed", async () => {
  const { flags } = await flagsFor({ "native-thing": { hasInstallScript: true } });
  assert.deepEqual(flags.map((f) => [f.pkg, f.kind]), [["native-thing@1.0.0", "install-script"]]);
  assert.equal(decide({ flags, labelPresent: false, approval: null }).pass, false);
  assert.equal(decide({ flags, labelPresent: true, approval: labelApproval([JOE()], reviewers), lockfile: UNCHANGED }).pass, true);
});

test("an install script on a package already in the base (a bump) is not flagged", async () => {
  const base = lock({ argon2: { version: "0.40.0", hasInstallScript: true } });
  const head = lock({ argon2: { version: "0.44.0", hasInstallScript: true } });
  const { flags } = await reviewFlags({ baseLock: base, headLock: head, reference: REFERENCE, now: NOW, publishedAt: async () => "2026-11-09T00:00:00Z" });
  assert.deepEqual(flags, []);
});

test("a typosquat name fails (well-known list and existing dependency), and passes with deps-reviewed", async () => {
  const { flags } = await flagsFor({ expres: {}, "@prisrna/client": {}, fastfy: {} });
  const kinds = flags.map((f) => `${f.pkg} ${f.kind} ${f.detail}`);
  assert.ok(kinds.some((k) => k.startsWith("expres@1.0.0 typosquat") && k.includes('"express"')), kinds.join("\n"));
  assert.ok(kinds.some((k) => k.startsWith("@prisrna/client@1.0.0 typosquat") && k.includes('"@prisma/client"')), kinds.join("\n"));
  assert.ok(kinds.some((k) => k.startsWith("fastfy@1.0.0 typosquat") && k.includes('"fastify"')), kinds.join("\n"));
  assert.equal(decide({ flags, labelPresent: false, approval: null }).pass, false);
  assert.equal(decide({ flags, labelPresent: true, approval: labelApproval([JOE()], reviewers), lockfile: UNCHANGED }).pass, true);
});

test("typosquat thresholds: short names need 1 edit, under 3 characters and same-scope siblings are skipped", () => {
  assert.deepEqual(typosquatMatches("zodd", ["zod"]).map((m) => m.near), ["zod"]);
  assert.deepEqual(typosquatMatches("zoddd", ["zod"]), []); // 2 edits on a short name
  assert.deepEqual(typosquatMatches("lodahs-x", ["lodash"]), []); // 3 edits
  assert.deepEqual(typosquatMatches("loadsh", ["lodash"]).map((m) => m.near), ["lodash"]);
  assert.deepEqual(typosquatMatches("qx", ["qs"]), []);
  assert.deepEqual(typosquatMatches("@otplib/hotp", ["@otplib/totp"]), []);
  assert.deepEqual(typosquatMatches("@0tplib/totp", ["@otplib/totp"]).map((m) => m.near), ["@otplib/totp"]);
  assert.deepEqual(typosquatMatches("Express", ["express"]), []); // equal, ignoring case
});

test("a 3-day-old version fails, a 14-day-old one passes, and deps-reviewed clears the young one", async () => {
  const published = { young: "2026-11-07T12:00:00Z", seasoned: "2026-10-27T12:00:00Z" };
  const { flags } = await flagsFor({ young: {}, seasoned: {} }, async (n) => published[n]);
  assert.deepEqual(flags.map((f) => [f.pkg, f.kind]), [["young@1.0.0", "too-new"]]);
  assert.match(flags[0].detail, /3\.0 days ago; minimum 14/);
  assert.equal(decide({ flags, labelPresent: false, approval: null }).pass, false);
  assert.equal(decide({ flags, labelPresent: true, approval: labelApproval([JOE()], reviewers), lockfile: UNCHANGED }).pass, true);
});

test("an unreadable publish date is flagged (fail closed)", async () => {
  const { flags } = await flagsFor({ ghost: {} }, async () => {
    throw new Error("E404");
  });
  assert.deepEqual(flags.map((f) => f.kind), ["too-new"]);
  assert.match(flags[0].detail, /could not be read/);
  const nullTime = await flagsFor({ ghost: {} }, async () => null);
  assert.equal(nullTime.flags.length, 1);
});

test("the label counts only when its latest add is by a listed reviewer", () => {
  assert.deepEqual(labelApproval([JOE()], reviewers), { ok: true, by: "joestella99", at: JOE().created_at });
  assert.equal(labelApproval([JOE("labeled", "claude-routine")], reviewers).ok, false);
  assert.equal(labelApproval([JOE(), JOE("unlabeled"), JOE("labeled", "someone")], reviewers).ok, false);
  assert.equal(labelApproval([JOE("labeled", "someone"), JOE("unlabeled", "someone"), JOE()], reviewers).ok, true);
  assert.equal(labelApproval([JOE(), JOE("unlabeled")], reviewers).ok, false);
  assert.equal(labelApproval([JOE("labeled", "joestella99", "ci:full")], reviewers).ok, false);
  assert.equal(labelApproval([], reviewers).ok, false);
  const flags = [{ pkg: "x@1", kind: "too-new", detail: "" }];
  assert.equal(decide({ flags, labelPresent: true, approval: labelApproval([JOE("labeled", "someone")], reviewers) }).pass, false);
});

test("issue events are read page by page with the token", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers.authorization]);
    const page = Number(new URL(url).searchParams.get("page"));
    return { ok: true, json: async () => (page === 1 ? Array.from({ length: 100 }, () => JOE("labeled", "a")) : [JOE()]) };
  };
  const events = await fetchIssueEvents({ repo: "o/r", pr: "7", token: "t", fetchImpl });
  assert.equal(events.length, 101);
  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /repos\/o\/r\/issues\/7\/events\?per_page=100&page=1/);
  assert.equal(calls[0][1], "Bearer t");
  await assert.rejects(fetchIssueEvents({ repo: "o/r", pr: "7", token: "t", fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
});

test("the shipped reference list and reviewer list are well-formed", () => {
  assert.ok(REFERENCE.length > 100);
  assert.equal(new Set(REFERENCE).size, REFERENCE.length, "duplicate names in the reference list");
  const r = JSON.parse(readFileSync(new URL("../../security/deps-reviewers.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(r.reviewers) && r.reviewers.length > 0);
});

test("this repo's own lockfile names do not flag each other beyond the reviewed pairs", () => {
  const own = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
  const names = [...new Set(Object.keys(own.packages).filter((k) => k.includes("node_modules/")).map((k) => k.slice(k.lastIndexOf("node_modules/") + 13)))];
  const hits = [];
  for (const n of names) for (const m of typosquatMatches(n, names)) if (n < m.near) hits.push(`${n}~${m.near}`);
  // A real pair is fine (both names are long-established); this guards against a threshold change that
  // would make every lockfile change noisy.
  assert.ok(hits.length <= 3, hits.join(", "));
});

// cs-012 (Joe, 2026-11-10): a push after the label that changes package-lock.json voids the label.
const run = (sha, created_at, extra = {}) => ({ event: "pull_request", head_branch: "feat", head_sha: sha, created_at, head_repository: { full_name: "o/r" }, ...extra });

test("the head at label time is the latest pull_request run on the branch at or before the label", () => {
  const runs = [
    run("c3", "2026-11-10T12:10:00Z"), // pushed after the label
    run("c2", "2026-11-10T11:59:00Z"),
    run("c1", "2026-11-10T11:00:00Z"),
    run("x9", "2026-11-10T11:59:30Z", { head_branch: "other" }),
    run("f1", "2026-11-10T11:59:40Z", { head_repository: { full_name: "fork/r" } }),
    run("p1", "2026-11-10T11:59:50Z", { event: "push" }),
  ];
  const where = { at: "2026-11-10T12:00:00Z", branch: "feat", headRepo: "o/r" };
  assert.equal(headAtLabel(runs, where), "c2");
  assert.equal(headAtLabel(runs, { ...where, at: "2026-11-10T10:00:00Z" }), null);
  assert.equal(headAtLabel(runs, { ...where, at: null }), null);
  assert.equal(headAtLabel([], where), null);
});

test("the label counts only while package-lock.json is the blob the reviewer saw", () => {
  assert.equal(lockfileUnchanged({ labelSha: "c2aaaaaa", labelBlob: "b1", headBlob: "b1" }).ok, true);
  const changed = lockfileUnchanged({ labelSha: "c2aaaaaa", labelBlob: "b1", headBlob: "b2" });
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /changed after deps-reviewed was added/);
  assert.equal(lockfileUnchanged({ labelSha: null, labelBlob: null, headBlob: "b1" }).ok, false, "no head found: fail closed");
  assert.equal(lockfileUnchanged({ labelSha: "c2aaaaaa", labelBlob: null, headBlob: "b1" }).ok, false, "unreadable: fail closed");

  const flags = [{ pkg: "x@1", kind: "too-new", detail: "" }];
  const approval = labelApproval([JOE()], reviewers);
  assert.equal(decide({ flags, labelPresent: true, approval, lockfile: changed }).pass, false);
  assert.match(decide({ flags, labelPresent: true, approval, lockfile: changed }).reason, /changed after/);
  assert.equal(decide({ flags, labelPresent: true, approval }).pass, false, "not checked: fail closed");
  assert.equal(decide({ flags, labelPresent: true, approval, lockfile: UNCHANGED }).pass, true);
  assert.equal(decide({ flags: [], labelPresent: true, approval, lockfile: changed }).pass, true, "nothing flagged needs no label");
});

test("workflow runs and lockfile blobs are read from GitHub with the token", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers.authorization]);
    if (url.includes("/actions/runs")) return { ok: true, json: async () => ({ workflow_runs: [run("c1", "2026-11-10T11:00:00Z")] }) };
    if (url.includes("ref=good")) return { ok: true, json: async () => ({ sha: "blob1" }) };
    return { ok: false, status: 404 };
  };
  const runs = await fetchRunsBefore({ repo: "o/r", branch: "feat", at: "2026-11-10T12:00:00Z", token: "t", fetchImpl });
  assert.equal(runs.length, 1);
  const q = new URL(calls[0][0]).searchParams;
  assert.equal(q.get("event"), "pull_request");
  assert.equal(q.get("branch"), "feat");
  assert.equal(q.get("created"), "<=2026-11-10T12:00:00Z");
  assert.equal(calls[0][1], "Bearer t");
  assert.equal(await fetchLockBlob({ repo: "o/r", ref: "good", token: "t", fetchImpl }), "blob1");
  assert.equal(await fetchLockBlob({ repo: "o/r", ref: "gone", token: "t", fetchImpl }), null);
  await assert.rejects(fetchRunsBefore({ repo: "o/r", branch: "feat", at: "x", token: "t", fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
});
