import { z } from "zod";

// cs-waitlist: the shared waitlist endpoint's configuration. Every integration value is optional
// so the service always boots; until all three waitlist values are set, POST /api/v1/waitlist
// answers 503 waitlist_not_configured instead of crashing or silently accepting signups.
//
// The three-place env var rule applies to every entry here: api/.env.example, this file, and
// render.yaml (sync: false). RENDER_GIT_COMMIT is the one deliberate exception: Render injects it
// on every service, and a sync: false entry in render.yaml could shadow it with a blank.

// A blank .env line (KEY=) sets process.env.KEY to "", not undefined. Coerce it to undefined so
// copying .env.example to .env verbatim does not fail validation.
function optionalString(inner: z.ZodString = z.string()) {
  return z.preprocess((value) => (value === "" ? undefined : value), inner.optional());
}

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  // Resend API key (the factory's RESEND_API_KEY, full-access scope: contact properties and
  // contacts need more than a sending-only key). Used only to upsert contacts; this service never
  // sends an email.
  RESEND_API_KEY: optionalString(z.string().min(1)),
  // The Resend audience (Resend now calls audiences "segments"; the same id works on both APIs)
  // every waitlist contact is added to. Created by cs-waitlist on 2026-10-19: "Waitlist",
  // 28fba1a4-6f92-4ee5-88db-5ae20bc59e7d.
  WAITLIST_AUDIENCE_ID: optionalString(z.string().uuid()),
  // Secret key of the Cloudflare Turnstile widget "F&S waitlist (teaser pages)" (site key
  // 0x4AAAAAAFbtrCIwCZhASyIy, domains fsventuresllc.com, loyaltynudge.com, optimizemeeting.com).
  // Unlike the house apps, an unset secret does NOT skip verification: the endpoint refuses (503).
  TURNSTILE_SECRET_KEY: optionalString(z.string().min(1)),
  // Injected by Render; reported by GET /api/v1/health so deploy checks can prove the commit.
  RENDER_GIT_COMMIT: optionalString(z.string().min(1)),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return schema.parse(source);
}

export const env: Env = loadEnv();

export function isWaitlistConfigured(e: Env = env): boolean {
  return Boolean(e.RESEND_API_KEY && e.WAITLIST_AUDIENCE_ID && e.TURNSTILE_SECRET_KEY);
}
