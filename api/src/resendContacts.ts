// cs-waitlist: the only Resend calls this service makes. It upserts a contact and makes sure the
// per-source property exists. It never sends an email, never lists contacts and never returns
// anything Resend says about a contact to the caller.
//
// Verified live against the Resend API on 2026-10-19:
// - POST /contacts is an upsert: an existing email answers 201 with the same id, and the
//   properties sent are MERGED into the contact's existing properties (others are kept).
// - `segments: [{id}]` on that POST adds the contact to the audience, also when it exists already.
// - A property key that was never declared is `422 "One or more properties do not exist"`, so the
//   key is created first through POST /contact-properties.
// - Emails are case-sensitive in Resend (Foo@x.com and foo@x.com are two contacts), so the
//   caller lowercases first.

const API = "https://api.resend.com";

export class ResendError extends Error {
  constructor(
    readonly status: number,
    readonly step: string,
  ) {
    super(`resend ${step} failed with status ${status}`);
    this.name = "ResendError";
  }
}

export type ResendConfig = { apiKey: string; audienceId: string };

type Fetch = typeof fetch;

const knownProperties = new Set<string>();

export function resetPropertyCacheForTests(): void {
  knownProperties.clear();
}

async function call(cfg: ResendConfig, path: string, init: RequestInit, step: string, f: Fetch): Promise<Response> {
  const doFetch = () =>
    f(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  let res = await doFetch();
  // Resend's team-wide API limit is a few requests per second, shared with every app on the
  // key. One short retry absorbs a burst; a second 429 is the caller's 502.
  if (res.status === 429) {
    const wait = Math.min(Number(res.headers.get("retry-after") ?? "1") || 1, 2) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    res = await doFetch();
  }
  if (!res.ok && step !== "create-property") throw new ResendError(res.status, step);
  return res;
}

export async function ensureProperty(cfg: ResendConfig, key: string, f: Fetch = fetch): Promise<void> {
  if (knownProperties.has(key)) return;
  const list = await call(cfg, "/contact-properties", { method: "GET" }, "list-properties", f);
  const body = (await list.json()) as { data?: Array<{ key?: string }> };
  for (const p of body.data ?? []) if (p.key) knownProperties.add(p.key);
  if (knownProperties.has(key)) return;
  const created = await call(
    cfg,
    "/contact-properties",
    { method: "POST", body: JSON.stringify({ key, type: "string" }) },
    "create-property",
    f,
  );
  // A concurrent request may have created it between the list and the create: 409/422 is fine.
  if (!created.ok && created.status !== 409 && created.status !== 422) {
    throw new ResendError(created.status, "create-property");
  }
  knownProperties.add(key);
}

export async function upsertWaitlistContact(
  cfg: ResendConfig,
  input: { email: string; propertyKey: string; signedUpAt: string },
  f: Fetch = fetch,
): Promise<void> {
  await ensureProperty(cfg, input.propertyKey, f);
  // `unsubscribed` is deliberately not sent: a contact who unsubscribed stays unsubscribed.
  await call(
    cfg,
    "/contacts",
    {
      method: "POST",
      body: JSON.stringify({
        email: input.email,
        properties: { [input.propertyKey]: input.signedUpAt },
        segments: [{ id: cfg.audienceId }],
      }),
    },
    "upsert-contact",
    f,
  );
}
