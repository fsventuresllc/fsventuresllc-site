const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Server-side Turnstile check. Fails closed: no token, a non-2xx answer, a network error or
// anything but `success: true` is a refusal. Never skipped (the caller refuses with 503 when no
// secret is configured, before it gets here).
export async function verifyTurnstileToken(secret: string, token: string, remoteIp?: string): Promise<boolean> {
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: unknown };
    return data.success === true;
  } catch {
    return false;
  }
}
