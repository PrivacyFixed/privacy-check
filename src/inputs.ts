/** The action's inputs, validated before anything touches the network. */

export const RULES = [
  "trackers-before-consent",
  "trackers-after-reject",
  "new-third-parties",
  "missing-security-headers",
] as const;
export type Rule = (typeof RULES)[number];

export const DEFAULT_FAIL_ON: readonly Rule[] = [
  "trackers-before-consent",
  "trackers-after-reject",
  "new-third-parties",
];

export const DEFAULT_API_URL = "https://api.privacyfixed.com";
export const DEFAULT_MAX_WAIT_SECONDS = 600;
export const DEFAULT_HISTORY_DAYS = 14;

export interface Inputs {
  apiKey: string;
  url: URL;
  baselineUrl: URL | null;
  failOn: ReadonlySet<Rule>;
  minScore: number | null;
  apiUrl: string;
  maxWaitMs: number;
  /** Days of saved scans of the live site to learn the baseline from; 0 = off. */
  historyDays: number;
  onUnmeasured: "fail" | "warn";
}

/** A setting the user must change. The message says which and how. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** The only hosts the key may be sent to. */
export const API_HOSTS = new Set(["api.privacyfixed.com"]);

/** Loopback, over plain HTTP, for local testing only. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function pageUrl(name: string, raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new InputError(`\`${name}\` must be a full URL such as https://example.com.`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new InputError(`\`${name}\` must start with https:// or http://.`);
  }
  if (u.username || u.password) {
    throw new InputError(
      `\`${name}\` contains a username or password. Remove it: the URL is sent to the scanner and stored with the scan.`,
    );
  }
  return u;
}

/**
 * Where the API key may be sent. Only PrivacyFixed's own API hosts over HTTPS
 * (exact names, so a forgotten subdomain can never receive keys), or a loopback
 * address for local testing — so a typo or an edited workflow input
 * cannot hand the key to another host.
 */
export function apiBase(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new InputError(`\`api-url\` is not a valid URL.`);
  }
  const host = u.hostname.toLowerCase();
  const ours = API_HOSTS.has(host);
  const local = u.protocol === "http:" && LOOPBACK.has(host);
  if (!(u.protocol === "https:" && ours) && !local) {
    throw new InputError(
      "`api-url` must be https://api.privacyfixed.com. Your API key is only ever sent to PrivacyFixed.",
    );
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) {
    throw new InputError("`api-url` must be just the address, such as https://api.privacyfixed.com.");
  }
  return u.origin;
}

function failOn(raw: string): Set<Rule> {
  if (!raw) return new Set(DEFAULT_FAIL_ON);
  const items = raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (items.length === 1 && items[0] === "none") return new Set();
  const out = new Set<Rule>();
  for (const item of items) {
    if (!(RULES as readonly string[]).includes(item)) {
      throw new InputError(
        `\`fail-on\` has an unknown check "${item}". Use any of: ${RULES.join(", ")}, or none.`,
      );
    }
    out.add(item as Rule);
  }
  return out;
}

function minScore(raw: string): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 10) {
    throw new InputError(`\`min-score\` must be a number from 0 to 10 (got "${raw}").`);
  }
  return n;
}

function historyDays(raw: string): number {
  if (!raw) return DEFAULT_HISTORY_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 90) {
    throw new InputError(`\`baseline-history-days\` must be a whole number from 0 to 90 (got "${raw}").`);
  }
  return n;
}

function maxWait(raw: string): number {
  if (!raw) return DEFAULT_MAX_WAIT_SECONDS * 1000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 60 || n > 3600) {
    throw new InputError(`\`max-wait-seconds\` must be a whole number from 60 to 3600 (got "${raw}").`);
  }
  return n * 1000;
}

export function parseInputs(read: (name: string) => string): Inputs {
  const apiKey = read("api-key");
  if (!apiKey) {
    throw new InputError(
      "`api-key` is empty. Add your key as a repository secret named PRIVACYFIXED_API_KEY and pass `api-key: ${{ secrets.PRIVACYFIXED_API_KEY }}`.",
    );
  }
  const rawUrl = read("url");
  if (!rawUrl) throw new InputError("`url` is required: the address of the deploy to check.");
  const baseline = read("baseline-url");
  const onUnmeasured = (read("on-unmeasured") || "fail").toLowerCase();
  if (onUnmeasured !== "fail" && onUnmeasured !== "warn") {
    throw new InputError('`on-unmeasured` must be "fail" or "warn".');
  }
  return {
    apiKey,
    url: pageUrl("url", rawUrl),
    baselineUrl: baseline ? pageUrl("baseline-url", baseline) : null,
    failOn: failOn(read("fail-on")),
    minScore: minScore(read("min-score")),
    apiUrl: apiBase(read("api-url") || DEFAULT_API_URL),
    maxWaitMs: maxWait(read("max-wait-seconds")),
    historyDays: historyDays(read("baseline-history-days")),
    onUnmeasured,
  };
}

/** A URL as it may appear in logs: no query string or fragment (preview share tokens live there). */
export function displayUrl(u: URL): string {
  return `${u.origin}${u.pathname}`;
}
