// Tests pass their own Env to buildApp(); keep the module-level env free of real values.
process.env.RESEND_API_KEY = "";
process.env.WAITLIST_AUDIENCE_ID = "";
process.env.TURNSTILE_SECRET_KEY = "";
