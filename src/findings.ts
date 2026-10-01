/**
 * What one scan found, reduced to what the pass/fail rules need.
 *
 * The result is untyped JSON from the API, so every field is read strictly: a
 * missing or malformed field means "not measured", never "nothing found". A check
 * that cannot tell those apart would pass a page it never saw.
 */

import type { CompletedJob } from "./scan.js";

export interface Findings {
  /** False when the page we measured was not the site (an error page, a bot check, another host). */
  measured: boolean;
  unmeasuredReason: string | null;
  score: number | null;
  label: string | null;
  evidenceNote: string | null;
  consentMeasured: boolean;
  beforeConsent: string[];
  afterReject: string[];
  headersMeasured: boolean;
  missingHeaders: string[];
  thirdPartiesMeasured: boolean;
  thirdParties: string[];
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function obj(v: unknown): Obj {
  return isObj(v) ? v : {};
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

/** Same site for our purpose: the same host, or the host with or without "www.". */
function sameSite(a: string, b: string): boolean {
  const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");
  return bare(a) === bare(b);
}

/**
 * The host the page finally landed on: the last hop of its own top-level
 * navigation (the typed URL, each redirect, and script redirects), or null when
 * the result records none.
 */
function finalHost(requests: unknown): string | null {
  if (!Array.isArray(requests)) return null;
  let best: { ms: number; host: string } | null = null;
  for (const raw of requests) {
    const r = obj(raw);
    if (r.top_level_navigation !== true || typeof r.url !== "string") continue;
    const ms = typeof r.elapsed_ms === "number" ? r.elapsed_ms : 0;
    let host: string;
    try {
      host = new URL(r.url).hostname;
    } catch {
      continue;
    }
    if (best === null || ms >= best.ms) best = { ms, host };
  }
  return best?.host ?? null;
}

function unmeasured(job: CompletedJob, requestedHost: string): string | null {
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
    return vendor
      ? `The page showed a ${vendor} bot check instead of the site.`
      : `The page did not load as the real site${status ? ` (HTTP ${status})` : ""}.`;
  }
  if (guard.served !== true) {
    return typeof guard.refusal_reason === "string" && guard.refusal_reason
      ? guard.refusal_reason
      : "The scan could not be verified, so its findings were held back.";
  }
  const landed = finalHost(r.requests);
  if (landed === null) return "The scan didn't record which page it measured.";
  if (!sameSite(landed, requestedHost)) {
    return `The page redirected to ${landed}, so the scan measured that page instead. A login or protection page is the usual cause.`;
  }
  return null;
}

export function extract(job: CompletedJob, requestedHost: string): Findings {
  const unmeasuredReason = unmeasured(job, requestedHost);
  const r = obj(job.result);
  const grade = obj(r.grade);
  const headers = obj(r.security_headers);
  const withheld = obj(r.report_guard).withheld;
  const cc = obj(job.consent_companies);

  const consentMeasured = isStringArray(cc.before_consent) && isStringArray(cc.after_reject);
  const headersMeasured =
    headers.measured === true &&
    isStringArray(headers.missing) &&
    isStringArray(withheld) &&
    !withheld.includes("security_headers");

  const names = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((c) => typeof obj(c).company === "string")
      ? v.map((c) => obj(c).company as string)
      : null;
  const known = names(r.companies);
  const identified = r.identified_third_parties === undefined ? [] : names(r.identified_third_parties);
  const thirdPartiesMeasured = known !== null && identified !== null;

  return {
    measured: unmeasuredReason === null,
    unmeasuredReason,
    score: typeof grade.score === "number" ? grade.score : null,
    label: typeof grade.label === "string" ? grade.label : null,
    evidenceNote:
      typeof grade.evidence_note === "string" && grade.evidence_note ? grade.evidence_note : null,
    consentMeasured,
    beforeConsent: consentMeasured ? uniqueSorted(cc.before_consent as string[]) : [],
    afterReject: consentMeasured ? uniqueSorted(cc.after_reject as string[]) : [],
    headersMeasured,
    missingHeaders: headersMeasured ? uniqueSorted(headers.missing as string[]) : [],
    thirdPartiesMeasured,
    thirdParties: thirdPartiesMeasured ? uniqueSorted([...(known ?? []), ...(identified ?? [])]) : [],
  };
}
