// cs-waitlist: which teaser pages may post to the shared waitlist, and from where.
//
// A source is an app slug. Each source gets ONE Resend contact property, `waitlist_<slug>_at`
// (hyphens become underscores; Resend keys allow only letters, digits and underscores), holding
// the ISO-8601 UTC time of that contact's most recent signup for that app. A contact who joins
// two waitlists carries both properties. Every contact is also in the one "Waitlist" audience.
//
// Adding a teaser app: add its slug here and its domain to ALLOWED_ORIGINS, and add the domain to
// the Turnstile widget's hostnames. The property is created in Resend on first use.
export const SOURCES = [
  "loyaltynudge",
  "optimizemeeting",
  // Used by the cs-waitlist exit check and any later smoke test; test contacts are deleted after.
  "waitlist-test",
] as const;

export type Source = (typeof SOURCES)[number];

export function isSource(value: string): value is Source {
  return (SOURCES as readonly string[]).includes(value);
}

export function propertyKeyFor(source: Source): string {
  return `waitlist_${source.replace(/-/g, "_")}_at`;
}

// Teaser domains plus this company site's own domains. Exact match, https only.
export const ALLOWED_ORIGINS: readonly string[] = [
  "https://loyaltynudge.com",
  "https://www.loyaltynudge.com",
  "https://optimizemeeting.com",
  "https://www.optimizemeeting.com",
  "https://fsventuresllc.com",
  "https://www.fsventuresllc.com",
];

export function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.includes(origin);
}
