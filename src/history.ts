/**
 * The learned baseline: what the live site loaded across the account's saved
 * scans (GET /v1/public/baseline), folded into a fresh scan.
 *
 * A company only counts as "new" if the live site never loaded it in any sample,
 * so more samples mean fewer false alarms. Measured (6 sites x 6 scans,
 * 2026-09-26): comparing against 2 live-site samples failed unchanged pages up to
 * 19% of the time, 4 samples up to 7%. Daily monitoring stores 14 samples in two
 * weeks at no extra scan.
 */

import type { Findings } from "./findings.js";

/** Fewer saved scans than this and the history can't be trusted to be steady. */
export const MIN_HISTORY_SCANS = 3;

export interface History {
  days: number;
  scans: number;
  consentScans: number;
  thirdParties: string[];
  beforeConsent: string[];
  afterReject: string[];
}

function names(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** Read the API's answer strictly: anything malformed means "no history". */
export function parseHistory(raw: unknown): History | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const scans = count(r.scans);
  const consentScans = count(r.consent_scans);
  const days = count(r.days);
  const third = names(r.third_parties);
  const before = names(r.before_consent);
  const after = names(r.after_reject);
  if (scans === null || consentScans === null || days === null || !third || !before || !after) return null;
  return { days, scans, consentScans, thirdParties: third, beforeConsent: before, afterReject: after };
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort((x, y) => x.localeCompare(y));
}

/**
 * A fresh baseline scan widened by what the saved scans saw. History only ever
 * ADDS known names (it can never make the baseline look measured when the fresh
 * scan wasn't), and consent names only come from saved scans whose consent check
 * ran. Security headers stay the fresh scan's own: they describe today's server.
 */
export function withHistory(fresh: Findings, history: History): Findings {
  if (!fresh.measured || history.scans === 0) return fresh;
  const consent = fresh.consentMeasured && history.consentScans > 0;
  return {
    ...fresh,
    thirdParties: fresh.thirdPartiesMeasured ? union(fresh.thirdParties, history.thirdParties) : fresh.thirdParties,
    beforeConsent: consent ? union(fresh.beforeConsent, history.beforeConsent) : fresh.beforeConsent,
    afterReject: consent ? union(fresh.afterReject, history.afterReject) : fresh.afterReject,
  };
}
