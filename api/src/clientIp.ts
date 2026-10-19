import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";

// Ported from template-web tw-009 (GrantClose gc-021): which address is "the client" for the
// per-IP rate limit and Turnstile's remoteip. On Render every request passes Render's Cloudflare
// edge, which sets CF-Connecting-IP and overwrites a client's value. Without it, fall back to
// request.ip under trustOneHop (the right-most X-Forwarded-For hop, which the client cannot
// write). Never `trustProxy: true` (left-most XFF, client-controlled) and never a number
// (Fastify 5 treats a number as "trust nothing").
//
// Observed live on this service (cs-waitlist, 2026-10-19, fsventuresllc-waitlist.onrender.com):
// Render DOES pass CF-Connecting-IP (and True-Client-IP) to the process, equal to the left-most
// XFF entry; XFF is "<client>, <cloudflare edge>, <10.x internal hop>", so request.ip alone would
// be a rotating internal address and the fallback must not be relied on there.
export function trustOneHop(_address: string, hop: number): boolean {
  return hop < 1;
}

type RequestLike = { headers: Record<string, string | string[] | undefined>; ip: string };

export function clientIp(request: RequestLike): string {
  const raw = request.headers["cf-connecting-ip"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (value && isIP(value)) return value;
  return request.ip;
}

export const rateLimitKey = { keyGenerator: (request: FastifyRequest) => clientIp(request) };
