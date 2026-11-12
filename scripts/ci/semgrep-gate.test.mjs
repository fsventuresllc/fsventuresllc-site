// tw-028: tests for scripts/ci/semgrep-gate.mjs. Pure inputs (a Semgrep --json report, a baseline, a
// fake source reader); the last test checks this repo's own security/semgrep-baseline.json.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baselineProblems, gate } from "./semgrep-gate.mjs";

const REASON = "Fastify reply.send() of a plain object is JSON, not HTML.";
const entry = (over = {}) => ({
  rule: "ajinabraham.njsscan.xss.xss_node.express_xss",
  path: "api/src/routes/billing.ts",
  code: 'app.get("/api/v1/billing/status", async (request, reply) => {',
  reason: REASON,
  reviewedBy: "joe",
  reviewedOn: "2026-11-10",
  ...over,
});
const result = (over = {}) => ({
  check_id: "ajinabraham.njsscan.xss.xss_node.express_xss",
  path: "api/src/routes/billing.ts",
  start: { line: 31 },
  extra: { message: "Untrusted user input in response" },
  ...over,
});
const SOURCE = {
  "api/src/routes/billing.ts": { 31: '  app.get("/api/v1/billing/status", async (request, reply) => {', 90: "  same();" },
  "api/src/seed.ts": { 4: "    return eval(request.body);" },
};
const read = (file, line) => SOURCE[file]?.[line] ?? "";

test("a finding in the baseline passes; one that is not fails", () => {
  const ok = gate({ results: [result()] }, { findings: [entry()] }, read);
  assert.equal(ok.unbaselined.length, 0);
  assert.equal(ok.accepted.length, 1);

  const seeded = gate(
    { results: [result(), result({ check_id: "house-dynamic-code-execution", path: "api/src/seed.ts", start: { line: 4 } })] },
    { findings: [entry()] },
    read,
  );
  assert.deepEqual(
    seeded.unbaselined.map((f) => [f.rule, f.path, f.line, f.code]),
    [["house-dynamic-code-execution", "api/src/seed.ts", 4, "return eval(request.body);"]],
  );
});

test("matching survives a line move but not an edit of the flagged line", () => {
  const moved = { ...SOURCE["api/src/routes/billing.ts"], 31: "", 40: SOURCE["api/src/routes/billing.ts"][31] };
  const readMoved = (f, l) => (f === "api/src/routes/billing.ts" ? moved[l] ?? "" : read(f, l));
  assert.equal(gate({ results: [result({ start: { line: 40 } })] }, { findings: [entry()] }, readMoved).unbaselined.length, 0);
  const edited = gate({ results: [result()] }, { findings: [entry({ code: "something else" })] }, read);
  assert.equal(edited.unbaselined.length, 1);
  assert.equal(edited.stale.length, 1);
});

test("a different rule or path on the same code is not covered", () => {
  assert.equal(gate({ results: [result({ check_id: "other.rule" })] }, { findings: [entry()] }, read).unbaselined.length, 1);
});

test("each entry absorbs one finding", () => {
  const two = { results: [result(), result()] };
  assert.equal(gate(two, { findings: [entry()] }, read).unbaselined.length, 1);
  assert.equal(gate(two, { findings: [entry(), entry()] }, read).unbaselined.length, 0);
});

test("an entry that matches nothing is reported stale", () => {
  const out = gate({ results: [] }, { findings: [entry()] }, read);
  assert.equal(out.stale.length, 1);
  assert.equal(out.problems.length, 0);
});

test("Semgrep errors fail, parse warnings do not", () => {
  const out = gate(
    {
      results: [],
      errors: [
        { level: "error", message: "invalid configuration file found" },
        { level: "warn", message: "Syntax error at line x.test.ts:9" },
      ],
    },
    { findings: [] },
    read,
  );
  assert.equal(out.errors.length, 1);
  assert.equal(out.warnings.length, 1);
});

test("an incomplete baseline entry fails", () => {
  for (const field of ["rule", "path", "code", "reason", "reviewedBy", "reviewedOn"]) {
    const { [field]: _dropped, ...rest } = entry();
    assert.match(baselineProblems({ findings: [rest] }).join("\n"), new RegExp(`missing ${field}`));
  }
  assert.match(baselineProblems({ findings: [entry({ reason: "fine" })] }).join("\n"), /reason too short/);
  assert.match(baselineProblems({ findings: [entry({ reviewedOn: "2026-02-30" })] }).join("\n"), /real YYYY-MM-DD/);
  assert.match(baselineProblems({}).join("\n"), /expected/);
  // A broken baseline accepts nothing, so every finding is reported too.
  assert.equal(gate({ results: [result()] }, { findings: [entry({ reason: "" })] }, read).unbaselined.length, 1);
});

test("this repo's baseline is complete", () => {
  const doc = JSON.parse(readFileSync(new URL("../../security/semgrep-baseline.json", import.meta.url), "utf8"));
  assert.deepEqual(baselineProblems(doc), []);
});
