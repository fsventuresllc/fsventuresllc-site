import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// cs-013 (security CI 8): the waitlist service deploys only after CI passes. render.yaml is not
// read by Render (no Blueprint), so this holds the documented setting to what was applied live
// through the Render API; it is read as text to avoid a YAML dependency.
const renderYaml = readFileSync(fileURLToPath(new URL("../../render.yaml", import.meta.url)), "utf8");

function serviceBlock(name: string): string {
  const start = renderYaml.indexOf(`name: ${name}`);
  expect(start, `service ${name} in render.yaml`).toBeGreaterThan(-1);
  const next = renderYaml.indexOf("\n  - type:", start);
  return next === -1 ? renderYaml.slice(start) : renderYaml.slice(start, next);
}

describe("render.yaml deploy gate", () => {
  const block = serviceBlock("fsventuresllc-waitlist");

  it("deploys the waitlist service only after checks pass", () => {
    expect(block).toMatch(/^\s+autoDeployTrigger: checksPass\s*$/m);
  });

  it("does not also carry the legacy autoDeploy flag that deploys every commit", () => {
    expect(block).not.toMatch(/^\s+autoDeploy:/m);
  });

  it("stays on the free plan", () => {
    expect(block).toMatch(/^\s+plan: free\s*$/m);
  });
});
