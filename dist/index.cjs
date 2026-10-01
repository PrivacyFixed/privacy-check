"use strict";

// node_modules/@privacyfixed/sdk/dist/index.js
var __classPrivateFieldSet = function(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var __classPrivateFieldGet = function(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _PrivacyFixed_apiKey;
var _PrivacyFixed_baseUrl;
var _PrivacyFixed_timeoutMs;
var _PrivacyFixed_fetchImpl;
var DEFAULT_BASE_URL = "https://api.privacyfixed.com";
var DEFAULT_TIMEOUT_MS = 3e4;
var DEFAULT_POLL_INTERVAL_MS = 3e3;
var DEFAULT_MAX_WAIT_MS = 15e4;
var PrivacyFixedError = class extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "PrivacyFixedError";
    this.status = status;
    if (code !== void 0)
      this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var AuthError = class extends PrivacyFixedError {
  constructor(message, status, code) {
    super(message, status, code);
    this.name = "AuthError";
  }
};
var RateLimitedError = class extends PrivacyFixedError {
  constructor(message, status = 429, code) {
    super(message, status, code);
    this.name = "RateLimitedError";
  }
};
var ScanFailedError = class extends PrivacyFixedError {
  constructor(message, job) {
    super(message, job.error?.status ?? 0);
    this.name = "ScanFailedError";
    this.job = job;
  }
};
var ScanTimeoutError = class extends PrivacyFixedError {
  constructor(message, jobId) {
    super(message, 0);
    this.name = "ScanTimeoutError";
    this.jobId = jobId;
  }
};
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function assertSecureBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new PrivacyFixedError(`\`baseUrl\` is not a valid URL: ${baseUrl}`, 0, "invalid_base_url");
  }
  if (parsed.protocol === "https:")
    return baseUrl;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))
    return baseUrl;
  throw new PrivacyFixedError(`\`baseUrl\` must use https (got ${parsed.protocol}//${parsed.host}). Plain HTTP would transmit your API key in clear text.`, 0, "insecure_base_url");
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var PrivacyFixed = class {
  /**
   * Create a new client.
   * @param options - {@link PrivacyFixedOptions}. `apiKey` is required.
   */
  constructor(options) {
    _PrivacyFixed_apiKey.set(this, void 0);
    _PrivacyFixed_baseUrl.set(this, void 0);
    _PrivacyFixed_timeoutMs.set(this, void 0);
    _PrivacyFixed_fetchImpl.set(this, void 0);
    if (!options || typeof options.apiKey !== "string" || options.apiKey.length === 0) {
      throw new PrivacyFixedError("`apiKey` is required.", 0, "api_key_missing");
    }
    __classPrivateFieldSet(this, _PrivacyFixed_apiKey, options.apiKey, "f");
    __classPrivateFieldSet(this, _PrivacyFixed_baseUrl, assertSecureBaseUrl((options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")), "f");
    __classPrivateFieldSet(this, _PrivacyFixed_timeoutMs, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "f");
    const resolvedFetch = options.fetch ?? globalThis.fetch;
    if (typeof resolvedFetch !== "function") {
      throw new PrivacyFixedError("Global `fetch` is not available. Use Node >= 18, a modern browser, or pass a `fetch` implementation.", 0);
    }
    __classPrivateFieldSet(this, _PrivacyFixed_fetchImpl, resolvedFetch.bind(globalThis), "f");
  }
  /**
   * Submit a URL to be scanned.
   *
   * @param url - The absolute URL to scan (for example `https://example.com`).
   * @returns The `job_id` of the newly created scan job.
   * @throws {AuthError} on HTTP 401/403.
   * @throws {RateLimitedError} on HTTP 429.
   * @throws {PrivacyFixedError} on other non-2xx responses or transport errors.
   */
  async submit(url) {
    const body = await this.request("POST", "/v1/public/scans", { url });
    return body.job_id;
  }
  /**
   * Fetch the current state of a scan job.
   *
   * @param jobId - The `job_id` returned by {@link PrivacyFixed.submit}.
   * @returns The {@link ScanJob}.
   * @throws {AuthError} on HTTP 401/403.
   * @throws {RateLimitedError} on HTTP 429.
   * @throws {PrivacyFixedError} on other non-2xx responses or transport errors.
   */
  async getJob(jobId) {
    return this.request("GET", `/v1/public/scans/${encodeURIComponent(jobId)}`);
  }
  /**
   * What your saved scans of a live site saw over the last `days`.
   *
   * Uses scans already stored in your account (daily monitoring fills them), so
   * it costs no scan. Only scans that measured the real site count.
   *
   * @param url - The live site's URL, as you monitor or scan it.
   * @param days - The window, 1 to 90 days. Defaults to 14.
   * @throws {AuthError} on HTTP 401/403.
   * @throws {PrivacyFixedError} on other non-2xx responses or transport errors.
   */
  async baseline(url, days = 14) {
    const query = new URLSearchParams({ url, days: String(days) });
    return this.request("GET", `/v1/public/baseline?${query.toString()}`);
  }
  /**
   * Submit a URL and poll until the scan completes.
   *
   * @param url - The absolute URL to scan.
   * @param opts - {@link ScanOptions} controlling poll interval and max wait.
   * @returns The completed scan `result` object.
   * @throws {ScanFailedError} if the job finishes with status `failed`.
   * @throws {ScanTimeoutError} if the job does not complete within `maxWaitMs`.
   * @throws {AuthError | RateLimitedError | PrivacyFixedError} on API errors.
   *
   * @example
   * ```ts
   * const result = await client.scan("https://example.com", {
   *   pollIntervalMs: 3000,
   *   maxWaitMs: 150000,
   * });
   * console.log(result.compliance, result.security_headers);
   * ```
   */
  async scan(url, opts = {}) {
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const jobId = await this.submit(url);
    const deadline = Date.now() + maxWaitMs;
    for (; ; ) {
      const job = await this.getJob(jobId);
      if (job.status === "completed") {
        return job.result ?? {};
      }
      if (job.status === "failed") {
        const detail = job.error?.detail ?? "Scan failed.";
        throw new ScanFailedError(`Scan failed for job ${jobId}: ${detail}`, job);
      }
      if (Date.now() >= deadline) {
        throw new ScanTimeoutError(`Scan for job ${jobId} did not complete within ${maxWaitMs}ms.`, jobId);
      }
      await sleep(pollIntervalMs);
    }
  }
  /**
   * Perform a single HTTP request against the API, applying auth headers,
   * the per-request timeout, and status-to-error mapping.
   */
  async request(method, path, jsonBody) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), __classPrivateFieldGet(this, _PrivacyFixed_timeoutMs, "f"));
    let response;
    try {
      const headers = {
        Authorization: `Bearer ${__classPrivateFieldGet(this, _PrivacyFixed_apiKey, "f")}`,
        Accept: "application/json"
      };
      const init = { method, headers, signal: controller.signal };
      if (jsonBody !== void 0) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(jsonBody);
      }
      response = await __classPrivateFieldGet(this, _PrivacyFixed_fetchImpl, "f").call(this, `${__classPrivateFieldGet(this, _PrivacyFixed_baseUrl, "f")}${path}`, init);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new PrivacyFixedError(`Request to ${path} timed out after ${__classPrivateFieldGet(this, _PrivacyFixed_timeoutMs, "f")}ms.`, 0, "request_timeout");
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new PrivacyFixedError(`Network error requesting ${path}: ${message}`, 0, "network_error");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw await this.toError(response);
    }
    const text = await response.text();
    if (!text)
      return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new PrivacyFixedError(`Failed to parse JSON response from ${path}.`, response.status, "invalid_response");
    }
  }
  /** Map a non-2xx {@link Response} to the appropriate error instance. */
  async toError(response) {
    const { status } = response;
    let code;
    let message;
    try {
      const text = await response.text();
      if (text) {
        const parsed = JSON.parse(text);
        const detail = parsed?.detail;
        if (typeof detail === "string") {
          message = detail;
        } else if (detail && typeof detail === "object") {
          code = detail.code;
          message = detail.message;
        }
      }
    } catch {
    }
    const finalMessage = message ?? `Request failed with status ${status}.`;
    switch (status) {
      case 401:
      case 403:
        return new AuthError(finalMessage, status, code);
      case 429:
        return new RateLimitedError(finalMessage, status, code);
      default:
        return new PrivacyFixedError(finalMessage, status, code);
    }
  }
};
_PrivacyFixed_apiKey = /* @__PURE__ */ new WeakMap(), _PrivacyFixed_baseUrl = /* @__PURE__ */ new WeakMap(), _PrivacyFixed_timeoutMs = /* @__PURE__ */ new WeakMap(), _PrivacyFixed_fetchImpl = /* @__PURE__ */ new WeakMap();

// src/findings.ts
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function obj(v) {
  return isObj(v) ? v : {};
}
function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function uniqueSorted(items) {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}
function sameSite(a, b) {
  const bare = (h) => h.toLowerCase().replace(/^www\./, "");
  return bare(a) === bare(b);
}
function finalHost(requests) {
  if (!Array.isArray(requests)) return null;
  let best = null;
  for (const raw of requests) {
    const r = obj(raw);
    if (r.top_level_navigation !== true || typeof r.url !== "string") continue;
    const ms = typeof r.elapsed_ms === "number" ? r.elapsed_ms : 0;
    let host;
    try {
      host = new URL(r.url).hostname;
    } catch {
      continue;
    }
    if (best === null || ms >= best.ms) best = { ms, host };
  }
  return best?.host ?? null;
}
function unmeasured(job, requestedHost) {
  if (!isObj(job.result)) return "The scan returned no data.";
  const r = job.result;
  if (!isObj(r.page_load) || !isObj(r.report_guard)) {
    return "The scan result is incomplete, so it can't be trusted.";
  }
  const load = r.page_load;
  const guard = r.report_guard;
  if (load.blocked === true) {
    const vendor = typeof load.challenge_vendor === "string" ? load.challenge_vendor : "";
    const status = typeof load.final_status === "number" ? load.final_status : null;
    return vendor ? `The page showed a ${vendor} bot check instead of the site.` : `The page did not load as the real site${status ? ` (HTTP ${status})` : ""}.`;
  }
  if (guard.served !== true) {
    return typeof guard.refusal_reason === "string" && guard.refusal_reason ? guard.refusal_reason : "The scan could not be verified, so its findings were held back.";
  }
  const landed = finalHost(r.requests);
  if (landed === null) return "The scan didn't record which page it measured.";
  if (!sameSite(landed, requestedHost)) {
    return `The page redirected to ${landed}, so the scan measured that page instead. A login or protection page is the usual cause.`;
  }
  return null;
}
function extract(job, requestedHost) {
  const unmeasuredReason = unmeasured(job, requestedHost);
  const r = obj(job.result);
  const grade = obj(r.grade);
  const headers = obj(r.security_headers);
  const withheld = obj(r.report_guard).withheld;
  const cc = obj(job.consent_companies);
  const consentMeasured = isStringArray(cc.before_consent) && isStringArray(cc.after_reject);
  const headersMeasured = headers.measured === true && isStringArray(headers.missing) && isStringArray(withheld) && !withheld.includes("security_headers");
  const names2 = (v) => Array.isArray(v) && v.every((c) => typeof obj(c).company === "string") ? v.map((c) => obj(c).company) : null;
  const known = names2(r.companies);
  const identified = r.identified_third_parties === void 0 ? [] : names2(r.identified_third_parties);
  const thirdPartiesMeasured = known !== null && identified !== null;
  return {
    measured: unmeasuredReason === null,
    unmeasuredReason,
    score: typeof grade.score === "number" ? grade.score : null,
    label: typeof grade.label === "string" ? grade.label : null,
    evidenceNote: typeof grade.evidence_note === "string" && grade.evidence_note ? grade.evidence_note : null,
    consentMeasured,
    beforeConsent: consentMeasured ? uniqueSorted(cc.before_consent) : [],
    afterReject: consentMeasured ? uniqueSorted(cc.after_reject) : [],
    headersMeasured,
    missingHeaders: headersMeasured ? uniqueSorted(headers.missing) : [],
    thirdPartiesMeasured,
    thirdParties: thirdPartiesMeasured ? uniqueSorted([...known ?? [], ...identified ?? []]) : []
  };
}

// src/github.ts
var import_node_fs = require("node:fs");
var import_node_crypto = require("node:crypto");

// src/summary.ts
function md(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "&#124;").replace(/[\r\n]+/g, " ").replace(/([\\`*_[\]()#!~])/g, "\\$1").replace(/:\/\//g, "\\://").replace(/\b(www)\./gi, "$1\\.");
}
var STATE = {
  passed: "\u2705 Passed",
  failed: "\u274C Failed",
  unmeasured: "\u26A0\uFE0F Not measured",
  "not-applicable": "\u2796 Skipped"
};
var DISCLAIMER = "_Automated technical checks of what this page loads and sends. Not legal advice, and not a compliance certification._";
function headline(verdict) {
  const failed = verdict.checks.filter((c) => c.state === "failed").length;
  if (verdict.outcome === "failed") {
    return `\u274C ${failed} ${failed === 1 ? "check" : "checks"} failed`;
  }
  if (verdict.outcome === "unmeasured") return "\u26A0\uFE0F Couldn't measure this deploy";
  return "\u2705 No blocking issues found";
}
function renderSummary(args) {
  const { verdict, deploy, baseline, baselineNote, current } = args;
  const lines = [`## PrivacyFixed check: ${headline(verdict)}`, ""];
  lines.push(`**Deploy checked:** ${md(deploy)}  `);
  if (baseline) {
    const how = baselineNote ? ` (${md(baselineNote)})` : "";
    lines.push(`**Compared with:** ${md(baseline)}${how}  `);
  }
  if (current.measured && current.score !== null) {
    const label = current.label ? ` (${md(current.label)})` : "";
    lines.push(`**Privacy score:** ${current.score.toFixed(1)} / 10${label}  `);
  }
  if (verdict.confirmed) {
    lines.push(
      baseline ? "**Confirmed with a second scan:** a finding counts only if both scans of the deploy show it and neither scan of the baseline does." : "**Confirmed with a second scan:** a finding counts only if both scans of the deploy show it."
    );
  }
  lines.push("");
  if (verdict.reasons.length && verdict.outcome === "unmeasured") {
    lines.push("**Why it couldn't be measured**", "");
    for (const r of verdict.reasons) lines.push(`- ${md(r)}`);
    lines.push("");
  }
  if (verdict.checks.length) {
    lines.push("| Check | Result | Details |", "| --- | --- | --- |");
    for (const c of verdict.checks) {
      lines.push(`| ${md(c.title)} | ${STATE[c.state]} | ${md(c.detail)} |`);
    }
    lines.push("");
  }
  for (const c of verdict.checks.filter((x) => x.state === "failed" && x.check !== "min-score")) {
    lines.push(`### ${md(c.title)}`, "");
    for (const item of c.items) lines.push(`- ${md(item)}`);
    lines.push("");
  }
  const varying = verdict.checks.filter((c) => c.varying?.length);
  if (varying.length) {
    lines.push(
      "### Seen in one scan only (not counted)",
      "",
      "These showed up in only one of the two scans, so they don't fail the check. Ad auctions often change which companies load from one visit to the next. If one keeps appearing here, look into it.",
      ""
    );
    for (const c of varying) lines.push(`- **${md(c.title)}:** ${(c.varying ?? []).map(md).join(", ")}`);
    lines.push("");
  }
  if (current.evidenceNote) lines.push(`> ${md(current.evidenceNote)}`, "");
  lines.push(DISCLAIMER);
  return lines.join("\n");
}

// src/github.ts
function escapeData(value) {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}
function plain(value) {
  return value.replace(/[\r\n]+/g, " ").replace(/:{2,}/g, (run2) => run2.split("").join(" "));
}
var Runner = class {
  #env;
  #write;
  #secrets = [];
  constructor(env, write) {
    this.#env = env;
    this.#write = write;
  }
  /** An action input, as the runner passes it (`INPUT_<NAME>`), trimmed. */
  input(name) {
    return (this.#env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
  }
  /** Register a secret: the runner masks it, and this class removes it too. */
  mask(secret) {
    if (!secret) return;
    if (secret.length >= 8) this.#secrets.push(secret, md(secret));
    this.#write(`::add-mask::${escapeData(secret)}`);
  }
  /** Remove every registered secret from `text`. */
  scrub(text) {
    let out = text;
    for (const s of this.#secrets) out = out.split(s).join("***");
    return out;
  }
  /** The one exit for stdout. Anything printed goes through the scrub. */
  line(text) {
    this.#write(this.scrub(text));
  }
  info(message) {
    this.line(plain(message));
  }
  annotate(level, title, message) {
    const t = escapeProperty(this.scrub(title));
    this.line(`::${level} title=${t}::${escapeData(this.scrub(message))}`);
  }
  group(title, body) {
    this.line(`::group::${escapeData(plain(title))}`);
    try {
      return body();
    } finally {
      this.line("::endgroup::");
    }
  }
  /**
   * Set a step output. Uses the file protocol with a random delimiter, so a value
   * cannot end its own block early and write a second output.
   */
  setOutput(name, value) {
    const file = this.#env.GITHUB_OUTPUT;
    if (!file) return;
    const delimiter = `ghadelimiter_${(0, import_node_crypto.randomUUID)()}`;
    const v = this.scrub(value);
    (0, import_node_fs.appendFileSync)(file, `${name}<<${delimiter}
${v}
${delimiter}
`, "utf8");
  }
  /** Append Markdown to the job summary shown on the run and the pull request's checks. */
  summary(markdown) {
    const file = this.#env.GITHUB_STEP_SUMMARY;
    if (!file) return;
    (0, import_node_fs.appendFileSync)(file, `${this.scrub(markdown)}
`, "utf8");
  }
  /** The triggering event's payload, or `{}` when absent or unreadable. */
  event() {
    const path = this.#env.GITHUB_EVENT_PATH;
    if (!path) return {};
    try {
      const parsed = JSON.parse((0, import_node_fs.readFileSync)(path, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
};

// src/inputs.ts
var RULES = [
  "trackers-before-consent",
  "trackers-after-reject",
  "new-third-parties",
  "missing-security-headers"
];
var DEFAULT_FAIL_ON = [
  "trackers-before-consent",
  "trackers-after-reject",
  "new-third-parties"
];
var DEFAULT_API_URL = "https://api.privacyfixed.com";
var DEFAULT_MAX_WAIT_SECONDS = 600;
var DEFAULT_HISTORY_DAYS = 14;
var InputError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
};
var API_HOSTS = /* @__PURE__ */ new Set(["api.privacyfixed.com"]);
var LOOPBACK = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]"]);
function pageUrl(name, raw) {
  let u;
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
      `\`${name}\` contains a username or password. Remove it: the URL is sent to the scanner and stored with the scan.`
    );
  }
  return u;
}
function apiBase(raw) {
  let u;
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
      "`api-url` must be https://api.privacyfixed.com. Your API key is only ever sent to PrivacyFixed."
    );
  }
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/" && u.pathname !== "") {
    throw new InputError("`api-url` must be just the address, such as https://api.privacyfixed.com.");
  }
  return u.origin;
}
function failOn(raw) {
  if (!raw) return new Set(DEFAULT_FAIL_ON);
  const items = raw.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (items.length === 1 && items[0] === "none") return /* @__PURE__ */ new Set();
  const out = /* @__PURE__ */ new Set();
  for (const item of items) {
    if (!RULES.includes(item)) {
      throw new InputError(
        `\`fail-on\` has an unknown check "${item}". Use any of: ${RULES.join(", ")}, or none.`
      );
    }
    out.add(item);
  }
  return out;
}
function minScore(raw) {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 10) {
    throw new InputError(`\`min-score\` must be a number from 0 to 10 (got "${raw}").`);
  }
  return n;
}
function historyDays(raw) {
  if (!raw) return DEFAULT_HISTORY_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 90) {
    throw new InputError(`\`baseline-history-days\` must be a whole number from 0 to 90 (got "${raw}").`);
  }
  return n;
}
function maxWait(raw) {
  if (!raw) return DEFAULT_MAX_WAIT_SECONDS * 1e3;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 60 || n > 3600) {
    throw new InputError(`\`max-wait-seconds\` must be a whole number from 60 to 3600 (got "${raw}").`);
  }
  return n * 1e3;
}
function parseInputs(read) {
  const apiKey = read("api-key");
  if (!apiKey) {
    throw new InputError(
      "`api-key` is empty. Add your key as a repository secret named PRIVACYFIXED_API_KEY and pass `api-key: ${{ secrets.PRIVACYFIXED_API_KEY }}`."
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
    onUnmeasured
  };
}
function displayUrl(u) {
  return `${u.origin}${u.pathname}`;
}

// src/policy.ts
var TITLES = {
  "trackers-before-consent": "Trackers before consent",
  "trackers-after-reject": "Trackers after reject",
  "new-third-parties": "New third parties",
  "missing-security-headers": "Missing security headers"
};
var CONSENT_UNMEASURED = "The consent check could not run on this page.";
function added(current, baseline) {
  if (baseline === null) return current;
  const known = new Set(baseline);
  return current.filter((x) => !known.has(x));
}
function evaluate(current, baseline, failOn2, minScore2) {
  const reasons = [];
  if (!current.measured) reasons.push(`Deploy: ${current.unmeasuredReason}`);
  if (baseline && !baseline.measured) reasons.push(`Baseline: ${baseline.unmeasuredReason}`);
  if (reasons.length) return { outcome: "unmeasured", checks: [], reasons };
  const checks = [];
  const listRule = (rule, ok, pick, unmeasured2) => {
    if (!ok(current) || baseline !== null && !ok(baseline)) {
      checks.push({ check: rule, title: TITLES[rule], state: "unmeasured", items: [], detail: unmeasured2 });
      return;
    }
    const items = added(pick(current), baseline ? pick(baseline) : null);
    let detail;
    if (items.length) {
      detail = baseline ? "New in this deploy compared with the baseline." : "Found on this deploy.";
    } else {
      detail = baseline ? "Nothing new compared with the baseline." : "None found.";
    }
    checks.push({ check: rule, title: TITLES[rule], state: items.length ? "failed" : "passed", items, detail });
  };
  if (failOn2.has("trackers-before-consent")) {
    listRule("trackers-before-consent", (f) => f.consentMeasured, (f) => f.beforeConsent, CONSENT_UNMEASURED);
  }
  if (failOn2.has("trackers-after-reject")) {
    listRule("trackers-after-reject", (f) => f.consentMeasured, (f) => f.afterReject, CONSENT_UNMEASURED);
  }
  if (failOn2.has("new-third-parties")) {
    if (baseline === null) {
      checks.push({
        check: "new-third-parties",
        title: TITLES["new-third-parties"],
        state: "not-applicable",
        items: [],
        detail: "Needs `baseline-url` to know what is new."
      });
    } else {
      listRule(
        "new-third-parties",
        (f) => f.thirdPartiesMeasured,
        (f) => f.thirdParties,
        "The scan did not list the page's third parties."
      );
    }
  }
  if (failOn2.has("missing-security-headers")) {
    listRule(
      "missing-security-headers",
      (f) => f.headersMeasured,
      (f) => f.missingHeaders,
      "The page's response headers could not be read or verified."
    );
  }
  if (minScore2 !== null) {
    if (current.score === null) {
      checks.push({
        check: "min-score",
        title: "Privacy score",
        state: "unmeasured",
        items: [],
        detail: "No score was produced."
      });
    } else {
      const low = current.score < minScore2;
      checks.push({
        check: "min-score",
        title: "Privacy score",
        state: low ? "failed" : "passed",
        items: low ? [current.score.toFixed(1)] : [],
        detail: `${current.score.toFixed(1)} / 10 (minimum ${minScore2}).`
      });
    }
  }
  let outcome = "passed";
  if (checks.some((c) => c.state === "failed")) outcome = "failed";
  else if (checks.some((c) => c.state === "unmeasured")) outcome = "unmeasured";
  for (const c of checks) if (c.state === "unmeasured") reasons.push(`${c.title}: ${c.detail}`);
  return { outcome, checks, reasons };
}

// src/confirm.ts
function both(a, b) {
  const inB = new Set(b);
  return a.filter((x) => inB.has(x));
}
function either(a, b) {
  return [.../* @__PURE__ */ new Set([...a, ...b])].sort((x, y) => x.localeCompare(y));
}
function merged(a, b, pick) {
  const reason = !a.measured ? a.unmeasuredReason : !b.measured ? `Second scan: ${b.unmeasuredReason}` : null;
  return {
    measured: a.measured && b.measured,
    unmeasuredReason: reason,
    // The score clears a minimum when EITHER scan clears it, so the pair fails
    // only when both scans are below the line.
    score: a.score === null || b.score === null ? null : Math.max(a.score, b.score),
    label: a.label,
    evidenceNote: a.evidenceNote,
    consentMeasured: a.consentMeasured && b.consentMeasured,
    beforeConsent: pick(a.beforeConsent, b.beforeConsent),
    afterReject: pick(a.afterReject, b.afterReject),
    headersMeasured: a.headersMeasured && b.headersMeasured,
    missingHeaders: pick(a.missingHeaders, b.missingHeaders),
    thirdPartiesMeasured: a.thirdPartiesMeasured && b.thirdPartiesMeasured,
    thirdParties: pick(a.thirdParties, b.thirdParties)
  };
}
function seenInBoth(a, b) {
  return merged(a, b, both);
}
function seenInEither(a, b) {
  return merged(a, b, either);
}
function confirmedVerdict(deploy1, deploy2, baseline, failOn2, minScore2) {
  const stable = evaluate(seenInBoth(deploy1, deploy2), baseline, failOn2, minScore2);
  if (stable.outcome === "unmeasured" && stable.checks.length === 0) return { ...stable, confirmed: true };
  const loose = evaluate(seenInEither(deploy1, deploy2), baseline, failOn2, minScore2);
  const checks = stable.checks.map((c) => {
    const wide = loose.checks.find((x) => x.check === c.check);
    if (!wide || c.check === "min-score" || c.state === "unmeasured") return c;
    const counted = new Set(c.items);
    const varying = wide.items.filter((x) => !counted.has(x));
    if (!varying.length) return c;
    const detail = c.state === "failed" ? c.detail : "Nothing that showed up in both scans. Some companies appeared in only one; see below.";
    return { ...c, detail, varying };
  });
  const scores = [deploy1.score, deploy2.score];
  const scoreCheck = checks.find((c) => c.check === "min-score");
  if (scoreCheck && minScore2 !== null && scoreCheck.state === "passed" && scores.some((s) => s !== null && s < minScore2)) {
    scoreCheck.detail = `${scores.map((s) => s === null ? "?" : s.toFixed(1)).join(" and ")} / 10 in two scans; one cleared the minimum of ${minScore2}.`;
  }
  return { ...stable, checks, confirmed: true };
}

// src/history.ts
var MIN_HISTORY_SCANS = 3;
function names(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
}
function count(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}
function parseHistory(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;
  const scans = count(r.scans);
  const consentScans = count(r.consent_scans);
  const days = count(r.days);
  const third = names(r.third_parties);
  const before = names(r.before_consent);
  const after = names(r.after_reject);
  if (scans === null || consentScans === null || days === null || !third || !before || !after) return null;
  return { days, scans, consentScans, thirdParties: third, beforeConsent: before, afterReject: after };
}
function union(a, b) {
  return [.../* @__PURE__ */ new Set([...a, ...b])].sort((x, y) => x.localeCompare(y));
}
function withHistory(fresh, history) {
  if (!fresh.measured || history.scans === 0) return fresh;
  const consent = fresh.consentMeasured && history.consentScans > 0;
  return {
    ...fresh,
    thirdParties: fresh.thirdPartiesMeasured ? union(fresh.thirdParties, history.thirdParties) : fresh.thirdParties,
    beforeConsent: consent ? union(fresh.beforeConsent, history.beforeConsent) : fresh.beforeConsent,
    afterReject: consent ? union(fresh.afterReject, history.afterReject) : fresh.afterReject
  };
}

// src/scan.ts
var QUEUE_WAIT_MS = 15e3;
var POLL_MS = 5e3;
var MAX_POLL_ERRORS = 5;
function queued(err) {
  return err instanceof RateLimitedError && err.code !== "daily_limit_reached";
}
function transient(err) {
  if (!(err instanceof PrivacyFixedError)) return false;
  if (err instanceof RateLimitedError) return queued(err);
  return err.status === 0 || err.status >= 500;
}
async function runScan(client, url, deadline, clock, log) {
  let jobId = null;
  while (jobId === null) {
    try {
      jobId = await client.submit(url);
    } catch (err) {
      if (!transient(err) || clock.now() + QUEUE_WAIT_MS > deadline) throw err;
      log(
        queued(err) ? "Another scan on this account is still running. Waiting for it to finish\u2026" : `The API is not available right now (${err.message}). Retrying\u2026`
      );
      await clock.sleep(QUEUE_WAIT_MS);
    }
  }
  let errors = 0;
  for (; ; ) {
    await clock.sleep(POLL_MS);
    let job;
    try {
      job = await client.getJob(jobId);
      errors = 0;
    } catch (err) {
      errors += 1;
      if (!transient(err) || errors >= MAX_POLL_ERRORS) throw err;
      if (clock.now() >= deadline) {
        throw new ScanTimeoutError(`The scan did not finish in time (job ${jobId}).`, jobId);
      }
      continue;
    }
    if (job.status === "completed") return job;
    if (job.status === "failed") {
      throw new ScanFailedError(job.error?.detail ?? "The scan failed.", job);
    }
    if (clock.now() >= deadline) {
      throw new ScanTimeoutError(`The scan did not finish in time (job ${jobId}).`, jobId);
    }
  }
}

// src/main.ts
var ACTION_VERSION = "1.0.0";
var USER_AGENT = `privacyfixed-github-action/${ACTION_VERSION}`;
function isForkPullRequest(event) {
  const pr = event.pull_request;
  if (!pr?.head?.repo) return false;
  if (pr.head.repo.fork === true) return true;
  const head = pr.head.repo.full_name;
  const base = pr.base?.repo?.full_name;
  return typeof head === "string" && typeof base === "string" && head !== base;
}
function couldNotLook(err) {
  if (err instanceof ScanTimeoutError || err instanceof ScanFailedError) return true;
  if (err instanceof AuthError || err instanceof RateLimitedError) return false;
  return err instanceof PrivacyFixedError && (err.status === 0 || err.status >= 500);
}
function describe(err, inputs) {
  if (err instanceof AuthError) {
    return "PrivacyFixed refused the API key. Check the PRIVACYFIXED_API_KEY secret: the key must be active (not revoked) and belong to a Business or Agency account.";
  }
  if (err instanceof RateLimitedError) return err.message;
  if (err instanceof ScanTimeoutError) {
    return `The scan did not finish within ${inputs.maxWaitMs / 1e3} seconds. Try again, or raise \`max-wait-seconds\`.`;
  }
  if (err instanceof ScanFailedError) return `The scan failed: ${err.message}`;
  if (err instanceof PrivacyFixedError) return err.message;
  return "An unexpected error stopped the check.";
}
async function run(deps) {
  const gh = new Runner(deps.env, deps.write);
  const key = gh.input("api-key");
  gh.mask(key);
  if (!key && isForkPullRequest(gh.event())) {
    gh.annotate(
      "notice",
      "PrivacyFixed check skipped",
      "Pull requests from forks don't receive repository secrets, so the check can't run here."
    );
    gh.setOutput("status", "skipped");
    return 0;
  }
  let inputs;
  try {
    inputs = parseInputs((name) => gh.input(name));
  } catch (err) {
    const message = err instanceof InputError ? err.message : "The action's inputs could not be read.";
    gh.annotate("error", "PrivacyFixed check is misconfigured", message);
    gh.setOutput("status", "error");
    return 1;
  }
  const client = new PrivacyFixed({
    apiKey: inputs.apiKey,
    baseUrl: inputs.apiUrl,
    fetch: (url, init) => deps.fetch(url, {
      ...init,
      // Never follow a redirect: it would carry the Authorization header to
      // wherever the redirect points.
      redirect: "error",
      headers: { ...init?.headers, "User-Agent": USER_AGENT }
    })
  });
  const deadline = deps.clock.now() + inputs.maxWaitMs;
  const scanOne = async (label, url) => {
    gh.info(`Scanning ${label.toLowerCase()}: ${displayUrl(url)}`);
    const job = await runScan(client, url.href, deadline, deps.clock, (m) => gh.info(m));
    return extract(job, url.hostname);
  };
  const couldNotRun = (err) => {
    const message = describe(err, inputs);
    const soft = couldNotLook(err) && inputs.onUnmeasured === "warn";
    gh.annotate(soft ? "warning" : "error", "PrivacyFixed check could not run", message);
    gh.setOutput("status", "error");
    gh.summary(`## PrivacyFixed check: \u26A0\uFE0F Couldn't run

${md(message)}

${DISCLAIMER}`);
    return soft ? 0 : 1;
  };
  const loadHistory = async (url) => {
    if (inputs.historyDays === 0) return null;
    try {
      return parseHistory(await client.baseline(url.href, inputs.historyDays));
    } catch (err) {
      if (err instanceof AuthError) throw err;
      gh.info("Saved history of the live site isn't available right now; using fresh scans instead.");
      return null;
    }
  };
  let current;
  let fresh = [];
  let history = null;
  try {
    current = await scanOne("Deploy", inputs.url);
    if (inputs.baselineUrl) {
      history = await loadHistory(inputs.baselineUrl);
      fresh = [await scanOne("Baseline", inputs.baselineUrl)];
    }
  } catch (err) {
    return couldNotRun(err);
  }
  const learned = history !== null && history.scans >= MIN_HISTORY_SCANS;
  const combinedBaseline = () => {
    if (!fresh.length) return null;
    const scans = fresh.reduce((a, b) => seenInEither(a, b));
    return history ? withHistory(scans, history) : scans;
  };
  let baseline = combinedBaseline();
  let verdict = evaluate(current, baseline, inputs.failOn, inputs.minScore);
  let reported = current;
  if (verdict.outcome === "failed") {
    gh.info("Possible issues found. Scanning again to confirm they show up every time\u2026");
    try {
      const again = await scanOne("Deploy (second scan)", inputs.url);
      if (inputs.baselineUrl && !learned) {
        fresh.push(await scanOne("Baseline (second scan)", inputs.baselineUrl));
        fresh.push(await scanOne("Baseline (third scan)", inputs.baselineUrl));
      }
      baseline = combinedBaseline();
      verdict = confirmedVerdict(current, again, baseline, inputs.failOn, inputs.minScore);
      reported = seenInBoth(current, again);
    } catch (err) {
      return couldNotRun(err);
    }
  }
  let baselineNote = null;
  if (inputs.baselineUrl) {
    const freshCount = `${fresh.length} fresh ${fresh.length === 1 ? "scan" : "scans"}`;
    baselineNote = learned ? `learned from ${history.scans} saved scans over the last ${history.days} days, plus ${freshCount}` : `${freshCount}; no saved history of this site to learn from yet. Monitor it for a steadier baseline`;
  }
  const deploy = displayUrl(inputs.url);
  const base = inputs.baselineUrl ? displayUrl(inputs.baselineUrl) : null;
  const varying = [...new Set(verdict.checks.flatMap((c) => c.varying ?? []))].sort((a, b) => a.localeCompare(b));
  const known = baseline;
  gh.setOutput("status", verdict.outcome);
  gh.setOutput("score", current.score === null ? "" : current.score.toFixed(1));
  gh.setOutput("before-consent", reported.beforeConsent.join(", "));
  gh.setOutput("after-reject", reported.afterReject.join(", "));
  gh.setOutput("missing-security-headers", reported.missingHeaders.join(", "));
  gh.setOutput(
    "new-third-parties",
    known ? reported.thirdParties.filter((t) => !known.thirdParties.includes(t)).join(", ") : ""
  );
  gh.setOutput("varying", varying.join(", "));
  gh.setOutput("baseline-samples", inputs.baselineUrl ? String(fresh.length + (history?.scans ?? 0)) : "");
  gh.summary(renderSummary({ verdict, deploy, baseline: base, baselineNote, current }));
  for (const c of verdict.checks) {
    if (c.state === "failed") gh.annotate("error", `PrivacyFixed: ${c.title}`, `${c.detail} ${c.items.join(", ")}`);
  }
  if (varying.length) {
    gh.annotate(
      "warning",
      "PrivacyFixed: seen in one scan only (not counted)",
      `${varying.join(", ")}. These appeared in only one of two scans, so they don't fail the check. Ad auctions often change which companies load from one visit to the next.`
    );
  }
  if (verdict.outcome === "unmeasured") {
    const level = inputs.onUnmeasured === "warn" ? "warning" : "error";
    gh.annotate(level, "PrivacyFixed couldn't measure this deploy", verdict.reasons.join(" "));
    return level === "error" ? 1 : 0;
  }
  gh.info(
    verdict.outcome === "passed" ? "PrivacyFixed check passed: no blocking issues found." : "PrivacyFixed check failed. See the job summary for details."
  );
  return verdict.outcome === "failed" ? 1 : 0;
}

// src/index.ts
var sleep2 = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
run({
  env: process.env,
  write: (line) => process.stdout.write(`${line}
`),
  fetch: globalThis.fetch,
  clock: { now: () => Date.now(), sleep: sleep2 }
}).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stdout.write("::error title=PrivacyFixed check crashed::An unexpected error stopped the check.\n");
    process.exitCode = 1;
  }
);
