import { describe, expect, it } from "vitest";
import { ALLOWED_ORIGINS, SOURCES, isAllowedOrigin, isSource, propertyKeyFor } from "./sources.js";

describe("sources", () => {
  it("gives every source a Resend-valid property key (letters, digits, underscores, max 50)", () => {
    for (const s of SOURCES) expect(propertyKeyFor(s)).toMatch(/^[A-Za-z0-9_]{1,50}$/);
  });

  it("accepts only listed slugs", () => {
    expect(isSource("loyaltynudge")).toBe(true);
    expect(isSource("optimizemeeting")).toBe(true);
    expect(isSource("LoyaltyNudge")).toBe(false);
    expect(isSource("")).toBe(false);
  });

  it("allows only https teaser and company-site origins, exactly", () => {
    for (const o of ALLOWED_ORIGINS) expect(o).toMatch(/^https:\/\/(www\.)?(loyaltynudge|optimizemeeting|fsventuresllc)\.com$/);
    expect(isAllowedOrigin("https://loyaltynudge.com/")).toBe(false);
    expect(isAllowedOrigin("*")).toBe(false);
  });
});

describe("env", () => {
  it("is in all three places (api/.env.example, env.ts, render.yaml sync: false)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const example = readFileSync(join(here, "..", ".env.example"), "utf8");
    const envTs = readFileSync(join(here, "env.ts"), "utf8");
    const render = readFileSync(join(here, "..", "..", "render.yaml"), "utf8");
    for (const key of ["RESEND_API_KEY", "WAITLIST_AUDIENCE_ID", "TURNSTILE_SECRET_KEY"]) {
      expect(example).toMatch(new RegExp(`^${key}=`, "m"));
      expect(envTs).toContain(`${key}:`);
      expect(render).toMatch(new RegExp(`- key: ${key}\\n\\s+sync: false`));
    }
    // Render injects RENDER_GIT_COMMIT; a sync: false entry could shadow it with a blank.
    expect(render).not.toContain("RENDER_GIT_COMMIT");
  });
});
