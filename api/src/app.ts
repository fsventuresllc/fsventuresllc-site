import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { env as defaultEnv, isWaitlistConfigured, type Env } from "./env.js";
import { clientIp, rateLimitKey, trustOneHop } from "./clientIp.js";
import { isAllowedOrigin, isSource, propertyKeyFor } from "./sources.js";
import { verifyTurnstileToken } from "./turnstile.js";
import { upsertWaitlistContact } from "./resendContacts.js";

// cs-waitlist (Michael 2026-10-18): ONE waitlist endpoint for every paused app's teaser page.
//
//   POST /api/v1/waitlist  {email, source, turnstile_token}  (application/json)
//     200 {ok: true}                       stored (also when the address was already on the list)
//     400 {error: invalid_body|invalid_email|invalid_source}
//     403 {error: captcha_failed}          missing or rejected Turnstile token
//     403 {error: origin_not_allowed}      a browser Origin that is not a teaser domain
//     429 {error: rate_limited}            per client IP
//     502 {error: waitlist_unavailable}    Resend refused or was unreachable
//     503 {error: waitlist_not_configured} RESEND_API_KEY / WAITLIST_AUDIENCE_ID / TURNSTILE_SECRET_KEY unset
//
// Never echoes the list, the contact or whether the address was already there. Never sends email.

export const WAITLIST_RATE_LIMIT = { max: 5, timeWindow: "1 minute" } as const;

const bodySchema = z.object({
  email: z.string(),
  source: z.string(),
  turnstile_token: z.string().optional(),
});

const emailSchema = z.string().trim().toLowerCase().max(254).email();

export type BuildOptions = { env?: Env; now?: () => Date; logger?: boolean };

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? defaultEnv;
  const now = options.now ?? (() => new Date());

  const app = Fastify({
    trustProxy: trustOneHop,
    bodyLimit: 4 * 1024,
    logger: options.logger ?? false,
  });

  // JSON only. text/plain is a CORS "simple" content type a browser sends without a preflight,
  // so Fastify's default text/plain parser is removed: such a POST is a 415.
  app.removeContentTypeParser("text/plain");

  await app.register(cors, {
    // Browsers get CORS headers only for the teaser domains. The preHandler below also refuses a
    // request whose Origin is anything else, so the POST is not processed either.
    origin: (origin, cb) => cb(null, origin !== undefined && isAllowedOrigin(origin)),
    methods: ["POST"],
    allowedHeaders: ["Content-Type"],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: false,
    ...rateLimitKey,
    errorResponseBuilder: () => ({ statusCode: 429, error: "rate_limited" }),
  });

  app.setErrorHandler((error: { statusCode?: number; error?: string }, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 429) return reply.code(429).send({ error: "rate_limited" });
    if (status === 415) return reply.code(415).send({ error: "unsupported_media_type" });
    if (status === 413) return reply.code(413).send({ error: "body_too_large" });
    if (status >= 400 && status < 500) return reply.code(400).send({ error: "invalid_body" });
    app.log.error({ status }, "unhandled error");
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get("/api/v1/health", async () => ({
    ok: true,
    commit: env.RENDER_GIT_COMMIT ?? null,
    configured: isWaitlistConfigured(env),
  }));

  app.post(
    "/api/v1/waitlist",
    {
      config: { rateLimit: WAITLIST_RATE_LIMIT },
      preHandler: async (request, reply) => {
        // TEMPORARY cs-waitlist diagnostic: which proxy headers reach the process on Render.
        request.log.info(
          {
            diag: {
              names: Object.keys(request.headers).sort(),
              xff: request.headers["x-forwarded-for"],
              cf: request.headers["cf-connecting-ip"],
              tci: request.headers["true-client-ip"],
              xri: request.headers["x-real-ip"],
              ip: request.ip,
              ips: request.ips,
            },
          },
          "diag",
        );
        const origin = request.headers.origin;
        if (origin !== undefined && !isAllowedOrigin(origin)) {
          return reply.code(403).send({ error: "origin_not_allowed" });
        }
      },
    },
    async (request, reply) => {
      if (!isWaitlistConfigured(env)) return reply.code(503).send({ error: "waitlist_not_configured" });

      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const email = emailSchema.safeParse(parsed.data.email);
      if (!email.success) return reply.code(400).send({ error: "invalid_email" });
      const source = parsed.data.source.trim();
      if (!isSource(source)) return reply.code(400).send({ error: "invalid_source" });

      const token = parsed.data.turnstile_token?.trim() ?? "";
      const ip = clientIp(request);
      if (!token || !(await verifyTurnstileToken(env.TURNSTILE_SECRET_KEY!, token, ip))) {
        return reply.code(403).send({ error: "captcha_failed" });
      }

      try {
        await upsertWaitlistContact(
          { apiKey: env.RESEND_API_KEY!, audienceId: env.WAITLIST_AUDIENCE_ID! },
          { email: email.data, propertyKey: propertyKeyFor(source), signedUpAt: now().toISOString() },
        );
      } catch (err) {
        // Log the step and status only: never the address.
        const e = err as { step?: string; status?: number };
        request.log.warn({ source, step: e.step, status: e.status }, "waitlist upsert failed");
        return reply.code(502).send({ error: "waitlist_unavailable" });
      }

      request.log.info({ source }, "waitlist signup stored");
      return reply.code(200).send({ ok: true });
    },
  );

  return app;
}
