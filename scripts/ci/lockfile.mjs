// tw-029: shared helpers for the dependency-review and license checks. Reads npm's package-lock.json
// (lockfileVersion 2 or 3, the `packages` map) and nothing else: no npm ci, no node_modules needed.

/**
 * The package name a lockfile path installs. `node_modules/a/node_modules/@s/b` -> `@s/b`.
 * @param {string} lockPath
 * @returns {string | null} null for the root and the workspaces (paths with no node_modules/ segment)
 */
export function nameFromPath(lockPath) {
  const i = lockPath.lastIndexOf("node_modules/");
  if (i === -1) return null;
  return lockPath.slice(i + "node_modules/".length) || null;
}

/**
 * Every installed (non-workspace, non-link) package in a lockfile.
 * @param {any} lock parsed package-lock.json
 * @returns {{ path: string, name: string, version: string, entry: any }[]}
 */
export function lockPackages(lock) {
  if (!lock || typeof lock !== "object" || !lock.packages || typeof lock.packages !== "object") {
    throw new Error("package-lock.json has no `packages` map (lockfileVersion 2 or 3 is required)");
  }
  const out = [];
  for (const [p, entry] of Object.entries(lock.packages)) {
    const pathName = nameFromPath(p);
    if (!pathName || !entry || entry.link) continue;
    // An aliased install (`"foo": "npm:bar@1"`) records the real package in `name`.
    const name = typeof entry.name === "string" && entry.name ? entry.name : pathName;
    out.push({ path: p, name, version: String(entry.version ?? ""), entry });
  }
  return out;
}

/** @param {string} text @param {string} label */
export function parseLock(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label}: not valid JSON (${/** @type {Error} */ (err).message})`);
  }
}

/** @param {string} s @returns {number | null} UTC midnight of a real YYYY-MM-DD date, else null */
export function parseDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
  return t;
}

/**
 * Run `fn` over `items` with at most `limit` in flight; results keep the input order.
 * @template T, R
 * @param {T[]} items @param {number} limit @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** The registry document for one published version, or null when it cannot be read. */
export async function fetchVersionManifest(name, version, fetchImpl = fetch) {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}/${encodeURIComponent(version)}`;
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
