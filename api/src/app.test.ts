import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("./turnstile.js", () => ({ verifyTurnstileToken: vi.fn() }));
vi.mock("./resendContacts.js", () => ({ upsertWaitlistContact: vi.fn() }));

import { buildApp } from "./app.js";
import type { Env } from "./env.js";
import { verifyTurnstileToken } from "./turnstile.js";
import { upsertWaitlistContact } from "./resendContacts.js";

const verify = vi.mocked(verifyTurnstileToken);
const upsert = vi.mocked(upsertWaitlistContact);

const AUDIENCE = "28fba1a4-6f92-4ee5-88db-5ae20bc59e7d";
const configured: Env = {
  PORT: 4000,
  RESEND_API_KEY: "re_test",
  WAITLIST_AUDIENCE_ID: AUDIENCE,
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  RENDER_GIT_COMMIT: "abc123",
};
const FIXED = new Date("2026-10-19T12:34:56.000Z");

let app: FastifyInstance;
let ipCounter = 0;

async function make(env: Env = configured) {
  app = await buildApp({ env, now: () => FIXED });
  return app;
}

function post(body: unknown, headers: Record<string, string> = {}) {
  ipCounter += 1;
  return app.inject({
    method: "POST",
    url: "/api/v1/waitlist",
    headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${ipCounter % 250}`, ...headers },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const good = { email: "Person@Example.com ", source: "loyaltynudge", turnstile_token: "tok" };

beforeEach(() => {
  verify.mockReset().mockResolvedValue(true);
  upsert.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await app?.close();
});

describe("POST /api/v1/waitlist", () => {
  it("stores a valid signup: lowercased email, per-source property, timestamp, the audience", async () => {
    await make();
    const res = await post(good, { origin: "https://loyaltynudge.com" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(verify).toHaveBeenCalledWith("turnstile-secret", "tok", expect.stringMatching(/^203\.0\.113\./));
    expect(upsert).toHaveBeenCalledWith(
      { apiKey: "re_test", audienceId: AUDIENCE },
      { email: "person@example.com", propertyKey: "waitlist_loyaltynudge_at", signedUpAt: "2026-10-19T12:34:56.000Z" },
    );
    expect(res.headers["access-control-allow-origin"]).toBe("https://loyaltynudge.com");
  });

  it("maps hyphenated slugs to a valid Resend property key", async () => {
    await make();
    await post({ ...good, source: "waitlist-test" });
    expect(upsert.mock.calls[0][1].propertyKey).toBe("waitlist_waitlist_test_at");
  });

  it("answers the same for an address already on the list and never echoes contact data", async () => {
    await make();
    const first = await post(good);
    const second = await post(good);
    expect(first.body).toBe(second.body);
    expect(second.body).not.toContain("example.com");
  });

  it.each([
    "",
    "plainaddress",
    "@missing-local.com",
    "missing-at.com",
    "two@@at.com",
    "spaces in@x.com",
    "no-tld@localhost",
    `${"a".repeat(250)}@x.com`,
  ])("rejects malformed email %j with 400 and does not call Turnstile or Resend", async (email) => {
    await make();
    const res = await post({ ...good, email });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_email" });
    expect(verify).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects an unknown source with 400", async () => {
    await make();
    const res = await post({ ...good, source: "not-an-app" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_source" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a body with missing or non-string fields with 400", async () => {
    await make();
    expect((await post({ source: "loyaltynudge", turnstile_token: "t" })).json()).toEqual({ error: "invalid_body" });
    expect((await post({ ...good, email: 42 })).statusCode).toBe(400);
    expect((await post("not json")).statusCode).toBe(400);
  });

  it("refuses a missing Turnstile token with 403 without calling Cloudflare", async () => {
    await make();
    const { turnstile_token: _omit, ...noToken } = good;
    for (const body of [noToken, { ...good, turnstile_token: "" }, { ...good, turnstile_token: "   " }]) {
      const res = await post(body);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "captcha_failed" });
    }
    expect(verify).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses a token Cloudflare rejects with 403", async () => {
    verify.mockResolvedValue(false);
    await make();
    const res = await post(good);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "captcha_failed" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("answers 502 when Resend fails, without the address in the response", async () => {
    upsert.mockRejectedValue(Object.assign(new Error("resend upsert-contact failed with status 500"), { step: "upsert-contact", status: 500 }));
    await make();
    const res = await post(good);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "waitlist_unavailable" });
  });

  it.each(["RESEND_API_KEY", "WAITLIST_AUDIENCE_ID", "TURNSTILE_SECRET_KEY"] as const)(
    "answers 503 waitlist_not_configured while %s is unset",
    async (key) => {
      await make({ ...configured, [key]: undefined });
      const res = await post(good);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "waitlist_not_configured" });
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it("refuses a non-JSON content type", async () => {
    await make();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/waitlist",
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify(good),
    });
    expect(res.statusCode).toBe(415);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("CORS", () => {
  it.each([
    "https://loyaltynudge.com",
    "https://www.loyaltynudge.com",
    "https://optimizemeeting.com",
    "https://www.optimizemeeting.com",
    "https://fsventuresllc.com",
    "https://www.fsventuresllc.com",
  ])("allows the preflight from %s", async (origin) => {
    await make();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/waitlist",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    expect(String(res.headers["access-control-allow-methods"])).toContain("POST");
  });

  it.each(["https://evil.example", "http://loyaltynudge.com", "https://loyaltynudge.com.evil.example", "null"])(
    "gives %s no CORS headers and refuses its POST with 403",
    async (origin) => {
      await make();
      const pre = await app.inject({
        method: "OPTIONS",
        url: "/api/v1/waitlist",
        headers: { origin, "access-control-request-method": "POST" },
      });
      expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
      const res = await post(good, { origin });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "origin_not_allowed" });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(upsert).not.toHaveBeenCalled();
    },
  );
});

describe("rate limit", () => {
  it("allows 5 requests a minute per client IP, then 429, while another IP is unaffected", async () => {
    await make();
    const send = (ip: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/waitlist",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        payload: JSON.stringify(good),
      });
    for (let i = 0; i < 5; i++) expect((await send("198.51.100.7")).statusCode).toBe(200);
    const limited = await send("198.51.100.7");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate_limited" });
    expect((await send("198.51.100.8")).statusCode).toBe(200);
  });

  it("cannot be escaped by rotating X-Forwarded-For", async () => {
    await make();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      // The client writes the left entries; Render's load balancer (the socket peer) appends the
      // address it saw as the right-most one, which is what the limit keys on.
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/waitlist",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${i}, 198.51.100.50` },
        payload: JSON.stringify(good),
        remoteAddress: "192.0.2.1",
      });
      codes.push(res.statusCode);
    }
    expect(codes.at(-1)).toBe(429);
  });
});

describe("GET /api/v1/health", () => {
  it("reports the commit and whether the waitlist is configured, nothing else", async () => {
    await make();
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.json()).toEqual({ ok: true, commit: "abc123", configured: true });
  });
});
