// tw-029: tests for scripts/ci/license-check.mjs. Lockfiles in memory, the registry fallback faked, a fixed
// clock; the last test checks this repo's own allowlist file so a stale waiver fails CI here too.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allowlistProblems, classifyLicense, licenseReport, manifestLicense } from "./license-check.mjs";

const NOW = new Date("2026-11-10T12:00:00Z");
const REASON = "Used only by the build, never shipped or linked into the served app.";

/** @param {Record<string, object>} pkgs */
function lock(pkgs) {
  const packages = { "": { name: "app" }, api: { name: "api", license: "UNLICENSED" }, "node_modules/api": { link: true } };
  for (const [name, entry] of Object.entries(pkgs)) packages[`node_modules/${name}`] = { version: "1.0.0", ...entry };
  return { lockfileVersion: 3, packages };
}
const empty = { entries: [] };
const noFallback = async () => null;
const entry = (over = {}) => ({ package: "agpl-thing", license: "AGPL-3.0-only", reason: REASON, owner: "joestella99", expires: "2027-01-15", ...over });

test("permissive licences pass; GPL, AGPL and unknown fail; LGPL is reported", () => {
  for (const ok of ["MIT", "ISC", "Apache-2.0", "BSD-3-Clause", "0BSD", "CC0-1.0", "Unlicense", "MPL-2.0", "BlueOak-1.0.0", "Python-2.0"]) {
    assert.equal(classifyLicense(ok).verdict, "ok", ok);
  }
  for (const gpl of ["GPL-3.0", "GPL-2.0-only", "GPL-3.0-or-later", "GPL-2.0+", "GPL", "gpl-3.0"]) assert.deepEqual(classifyLicense(gpl), { verdict: "fail", why: "GPL" }, gpl);
  for (const agpl of ["AGPL-3.0", "AGPL-3.0-only", "AGPL-1.0-or-later"]) assert.deepEqual(classifyLicense(agpl), { verdict: "fail", why: "AGPL" }, agpl);
  for (const unk of [undefined, null, "", "UNLICENSED", "SEE LICENSE IN LICENSE.md", "Custom: see file", "(MIT", "MIT AND"]) {
    assert.deepEqual(classifyLicense(unk), { verdict: "fail", why: "unknown" }, String(unk));
  }
  for (const lgpl of ["LGPL-3.0", "LGPL-2.1-or-later"]) assert.deepEqual(classifyLicense(lgpl), { verdict: "report", why: "LGPL" }, lgpl);
});

test("SPDX expressions: OR takes the best alternative, AND the worst part, WITH keeps the licence's class", () => {
  assert.equal(classifyLicense("(MIT OR GPL-3.0)").verdict, "ok");
  assert.equal(classifyLicense("MIT OR AGPL-3.0").verdict, "ok");
  assert.equal(classifyLicense("(MIT AND GPL-3.0)").verdict, "fail");
  assert.equal(classifyLicense("(MIT AND LGPL-2.1)").verdict, "report");
  assert.equal(classifyLicense("(GPL-3.0 OR LGPL-3.0)").verdict, "report");
  assert.equal(classifyLicense("GPL-2.0-only WITH Classpath-exception-2.0").verdict, "fail");
  assert.equal(classifyLicense("Apache-2.0 WITH LLVM-exception").verdict, "ok");
  assert.equal(classifyLicense("(MIT OR (Apache-2.0 AND GPL-2.0))").verdict, "ok");
});

test("an old licenses array or object licence is read from a manifest", () => {
  assert.equal(manifestLicense({ license: "MIT" }), "MIT");
  assert.equal(manifestLicense({ license: { type: "BSD-2-Clause" } }), "BSD-2-Clause");
  assert.equal(manifestLicense({ licenses: [{ type: "MIT" }, { type: "GPL-2.0" }] }), "(MIT OR GPL-2.0)");
  assert.equal(manifestLicense({ license: ["MIT", "Apache2"] }), "(MIT OR Apache2)");
  assert.equal(manifestLicense({ license: ["GPL-3.0-only"] }), "GPL-3.0-only");
  assert.equal(manifestLicense({ license: [] }), null);
  assert.equal(manifestLicense({ license: "" }), null);
  assert.equal(manifestLicense({}), null);
  assert.equal(manifestLicense(null), null);
});

test("an AGPL package fails, and passes with a valid allowlist entry", async () => {
  const l = lock({ "agpl-thing": { license: "AGPL-3.0-only" }, fine: { license: "MIT" } });
  const failing = await licenseReport({ lock: l, allowlist: empty, now: NOW, fallbackLicense: noFallback });
  assert.deepEqual(failing.failed.map((r) => [r.name, r.why]), [["agpl-thing", "AGPL"]]);
  const passing = await licenseReport({ lock: l, allowlist: { entries: [entry()] }, now: NOW, fallbackLicense: noFallback });
  assert.deepEqual(passing.failed, []);
  assert.deepEqual(passing.problems, []);
  assert.deepEqual(passing.allowed.map((r) => r.name), ["agpl-thing"]);
});

test("the allowlist must match package, licence and (when given) version", async () => {
  const l = lock({ "agpl-thing": { license: "AGPL-3.0-only", version: "2.0.0" } });
  const wrongLicense = await licenseReport({ lock: l, allowlist: { entries: [entry({ license: "AGPL-3.0" })] }, now: NOW, fallbackLicense: noFallback });
  assert.equal(wrongLicense.failed.length, 1);
  assert.deepEqual(wrongLicense.unused, ["agpl-thing"]);
  const wrongVersion = await licenseReport({ lock: l, allowlist: { entries: [entry({ version: "1.0.0" })] }, now: NOW, fallbackLicense: noFallback });
  assert.equal(wrongVersion.failed.length, 1);
  const rightVersion = await licenseReport({ lock: l, allowlist: { entries: [entry({ version: "2.0.0" })] }, now: NOW, fallbackLicense: noFallback });
  assert.equal(rightVersion.failed.length, 0);
});

test("GPL and unknown licences fail; an unknown one passes with an allowlist entry naming (none)", async () => {
  const l = lock({ gplish: { license: "GPL-3.0" }, mystery: {}, closed: { license: "UNLICENSED" } });
  const r = await licenseReport({ lock: l, allowlist: empty, now: NOW, fallbackLicense: noFallback });
  assert.deepEqual(r.failed.map((x) => `${x.name}:${x.why}:${x.license}`).sort(), ["closed:unknown:UNLICENSED", "gplish:GPL:GPL-3.0", "mystery:unknown:(none)"]);
  const ok = await licenseReport({ lock: lock({ mystery: {} }), allowlist: { entries: [entry({ package: "mystery", license: "(none)" })] }, now: NOW, fallbackLicense: noFallback });
  assert.deepEqual(ok.failed, []);
});

test("LGPL is reported and does not fail", async () => {
  const r = await licenseReport({ lock: lock({ lgpl: { license: "LGPL-3.0-or-later" } }), allowlist: empty, now: NOW, fallbackLicense: noFallback });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.reported.map((x) => x.name), ["lgpl"]);
});

test("a licence missing from the lockfile comes from the fallback (disk or registry); workspaces are skipped", async () => {
  const asked = [];
  const r = await licenseReport({
    lock: lock({ "@esbuild/aix-ppc64": { version: "0.25.12", optional: true }, "gpl-binary": {} }),
    allowlist: empty,
    now: NOW,
    fallbackLicense: async (p) => {
      asked.push(p.name);
      return p.name === "gpl-binary" ? "GPL-2.0" : "MIT";
    },
  });
  assert.deepEqual(asked.sort(), ["@esbuild/aix-ppc64", "gpl-binary"]);
  assert.deepEqual(r.failed.map((x) => x.name), ["gpl-binary"]);
  assert.equal(r.checked, 2); // the UNLICENSED "api" workspace is ours, not a dependency
});

test("tw-030: a legacy license array in the lockfile is an OR of its parts, not unknown", async () => {
  const r = await licenseReport({
    lock: lock({ "pause-stream": { license: ["MIT", "Apache2"] }, "gpl-only": { license: ["GPL-3.0-only", "AGPL-3.0-only"] } }),
    allowlist: empty,
    now: NOW,
    fallbackLicense: async () => assert.fail("a licence recorded in the lockfile needs no fallback"),
  });
  assert.deepEqual(r.failed.map((x) => [x.name, x.license]), [["gpl-only", "(GPL-3.0-only OR AGPL-3.0-only)"]]);
  assert.equal(r.checked, 2);
});

test("a fallback that throws counts as unknown (fail closed)", async () => {
  const r = await licenseReport({ lock: lock({ x: {} }), allowlist: empty, now: NOW, fallbackLicense: async () => { throw new Error("offline"); } });
  assert.deepEqual(r.failed.map((x) => x.why), ["unknown"]);
});

test("allowlist entries follow the tw-027 rule: complete, unexpired, at most 90 days out", async () => {
  const p = (e) => allowlistProblems({ entries: [e] }, NOW).join("\n");
  assert.equal(p(entry()), "");
  assert.match(p(entry({ expires: "2026-11-09" })), /expired on 2026-11-09/);
  assert.match(p(entry({ expires: "2027-02-09" })), /more than 90 days out/);
  assert.equal(p(entry({ expires: "2027-02-08" })), "");
  assert.match(p(entry({ expires: undefined })), /missing expires/);
  assert.match(p(entry({ expires: "2027-02-30" })), /real date/);
  assert.match(p(entry({ reason: "ok" })), /reason too short/);
  assert.match(p(entry({ owner: "" })), /missing owner/);
  assert.match(p(entry({ license: undefined })), /missing license/);
  assert.match(allowlistProblems({}, NOW).join(""), /"entries" array/);
  // An invalid allowlist waives nothing, so the AGPL package still fails as well.
  const r = await licenseReport({ lock: lock({ "agpl-thing": { license: "AGPL-3.0-only" } }), allowlist: { entries: [entry({ expires: "2026-01-01" })] }, now: NOW, fallbackLicense: noFallback });
  assert.equal(r.problems.length, 1);
  assert.equal(r.failed.length, 1);
});

test("this repo's own license allowlist is valid today", () => {
  const doc = JSON.parse(readFileSync(new URL("../../security/license-allowlist.json", import.meta.url), "utf8"));
  assert.deepEqual(allowlistProblems(doc, new Date()), []);
});
