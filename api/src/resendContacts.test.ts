import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureProperty, ResendError, resetPropertyCacheForTests, upsertWaitlistContact } from "./resendContacts.js";

const cfg = { apiKey: "re_test", audienceId: "28fba1a4-6f92-4ee5-88db-5ae20bc59e7d" };

type Call = { url: string; method: string; body?: unknown; auth?: string };

function fakeFetch(responses: Array<{ status: number; json?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.Authorization,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return new Response(JSON.stringify(next.json ?? {}), { status: next.status, headers: next.headers });
  });
  return { f: f as unknown as typeof fetch, calls };
}

beforeEach(() => resetPropertyCacheForTests());

describe("upsertWaitlistContact", () => {
  it("creates a missing property, then upserts the contact into the audience", async () => {
    const { f, calls } = fakeFetch([
      { status: 200, json: { object: "list", data: [{ key: "other_at" }] } },
      { status: 201, json: { object: "contact_property", id: "p1" } },
      { status: 201, json: { object: "contact", id: "c1" } },
    ]);
    await upsertWaitlistContact(cfg, { email: "a@b.co", propertyKey: "waitlist_loyaltynudge_at", signedUpAt: "2026-10-19T00:00:00.000Z" }, f);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.resend.com/contact-properties",
      "POST https://api.resend.com/contact-properties",
      "POST https://api.resend.com/contacts",
    ]);
    expect(calls[1].body).toEqual({ key: "waitlist_loyaltynudge_at", type: "string" });
    expect(calls[2].body).toEqual({
      email: "a@b.co",
      properties: { waitlist_loyaltynudge_at: "2026-10-19T00:00:00.000Z" },
      segments: [{ id: cfg.audienceId }],
    });
    expect(calls.every((c) => c.auth === "Bearer re_test")).toBe(true);
  });

  it("never sends `unsubscribed`, so an unsubscribed contact stays unsubscribed", async () => {
    const { f, calls } = fakeFetch([
      { status: 200, json: { data: [{ key: "waitlist_x_at" }] } },
      { status: 201, json: {} },
    ]);
    await upsertWaitlistContact(cfg, { email: "a@b.co", propertyKey: "waitlist_x_at", signedUpAt: "t" }, f);
    expect(calls[1].body).not.toHaveProperty("unsubscribed");
  });

  it("only touches the contacts and contact-properties APIs (never sends email)", async () => {
    const { f, calls } = fakeFetch([
      { status: 200, json: { data: [] } },
      { status: 201, json: {} },
      { status: 201, json: {} },
    ]);
    await upsertWaitlistContact(cfg, { email: "a@b.co", propertyKey: "waitlist_x_at", signedUpAt: "t" }, f);
    for (const c of calls) expect(c.url).toMatch(/^https:\/\/api\.resend\.com\/(contacts|contact-properties)$/);
  });

  it("caches a known property: the second signup is one call", async () => {
    const { f, calls } = fakeFetch([
      { status: 200, json: { data: [{ key: "waitlist_x_at" }] } },
      { status: 201, json: {} },
      { status: 201, json: {} },
    ]);
    await upsertWaitlistContact(cfg, { email: "a@b.co", propertyKey: "waitlist_x_at", signedUpAt: "t" }, f);
    await upsertWaitlistContact(cfg, { email: "c@d.co", propertyKey: "waitlist_x_at", signedUpAt: "t" }, f);
    expect(calls).toHaveLength(3);
  });

  it("retries once on a 429, then succeeds", async () => {
    const { f, calls } = fakeFetch([
      { status: 200, json: { data: [{ key: "waitlist_x_at" }] } },
      { status: 429, headers: { "retry-after": "0" } },
      { status: 201, json: {} },
    ]);
    await upsertWaitlistContact(cfg, { email: "a@b.co", propertyKey: "waitlist_x_at", signedUpAt: "t" }, f);
    expect(calls).toHaveLength(3);
  });

  it("throws a ResendError with the step and status, never the address", async () => {
    const { f } = fakeFetch([
      { status: 200, json: { data: [{ key: "waitlist_x_at" }] } },
      { status: 422, json: { message: "bad" } },
    ]);
    const err = await upsertWaitlistContact(cfg, { email: "secret@b.co", propertyKey: "waitlist_x_at", signedUpAt: "t" }, f).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ResendError);
    expect((err as ResendError).step).toBe("upsert-contact");
    expect((err as ResendError).status).toBe(422);
    expect(String((err as Error).message)).not.toContain("secret@b.co");
  });
});

describe("ensureProperty", () => {
  it("accepts a property that a concurrent request created first (409/422 on create)", async () => {
    const { f } = fakeFetch([
      { status: 200, json: { data: [] } },
      { status: 409, json: {} },
    ]);
    await expect(ensureProperty(cfg, "waitlist_x_at", f)).resolves.toBeUndefined();
  });

  it("throws when the property cannot be created", async () => {
    const { f } = fakeFetch([
      { status: 200, json: { data: [] } },
      { status: 401, json: {} },
    ]);
    await expect(ensureProperty(cfg, "waitlist_x_at", f)).rejects.toBeInstanceOf(ResendError);
  });

  it("throws when the property list cannot be read", async () => {
    const { f } = fakeFetch([{ status: 500, json: {} }]);
    await expect(ensureProperty(cfg, "waitlist_x_at", f)).rejects.toMatchObject({ step: "list-properties", status: 500 });
  });
});
