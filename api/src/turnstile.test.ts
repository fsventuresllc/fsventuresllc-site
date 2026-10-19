import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTurnstileToken } from "./turnstile.js";

function stubFetch(impl: () => Promise<Response>) {
  const f = vi.fn(impl);
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe("verifyTurnstileToken", () => {
  it("passes only on success: true, sending secret, token and remoteip", async () => {
    const f = stubFetch(async () => new Response(JSON.stringify({ success: true })));
    expect(await verifyTurnstileToken("sec", "tok", "203.0.113.9")).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("secret")).toBe("sec");
    expect(body.get("response")).toBe("tok");
    expect(body.get("remoteip")).toBe("203.0.113.9");
  });

  it("fails on success: false", async () => {
    stubFetch(async () => new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] })));
    expect(await verifyTurnstileToken("sec", "bad")).toBe(false);
  });

  it("fails closed on a non-2xx answer or a network error", async () => {
    stubFetch(async () => new Response("oops", { status: 500 }));
    expect(await verifyTurnstileToken("sec", "tok")).toBe(false);
    stubFetch(async () => {
      throw new Error("ECONNRESET");
    });
    expect(await verifyTurnstileToken("sec", "tok")).toBe(false);
  });

  it("never calls Cloudflare for an empty token", async () => {
    const f = stubFetch(async () => new Response(JSON.stringify({ success: true })));
    expect(await verifyTurnstileToken("sec", "")).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
