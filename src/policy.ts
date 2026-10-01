/**
 * Pass or fail, from the findings and the rules the workflow chose.
 *
 * With a baseline (the live site), a rule fails only on what the deploy ADDED, so
 * a site with a known issue can still adopt the check and stop it getting worse.
 * Without one, a rule fails on anything it finds.
 *
 * Three outcomes, never two: "unmeasured" is kept apart from "passed", because a
 * page we could not see has not passed anything.
 */

import type { Findings } from "./findings.js";
import type { Rule } from "./inputs.js";

export type Outcome = "passed" | "failed" | "unmeasured";

export interface CheckResult {
  check: Rule | "min-score";
  title: string;
  state: "passed" | "failed" | "unmeasured" | "not-applicable";
  /** What failed it: company or header names, or the score. */
  items: string[];
  detail: string;
  /** Seen in only one of two scans, so not counted (see confirm.ts). */
  varying?: string[];
}

export interface Verdict {
  outcome: Outcome;
  checks: CheckResult[];
  /** Why the outcome is "unmeasured", when it is. */
  reasons: string[];
  /** True when a second scan confirmed the result (confirm.ts). */
  confirmed?: boolean;
}

export const TITLES: Record<Rule, string> = {
  "trackers-before-consent": "Trackers before consent",
  "trackers-after-reject": "Trackers after reject",
  "new-third-parties": "New third parties",
  "missing-security-headers": "Missing security headers",
};

const CONSENT_UNMEASURED = "The consent check could not run on this page.";

function added(current: string[], baseline: string[] | null): string[] {
  if (baseline === null) return current;
  const known = new Set(baseline);
  return current.filter((x) => !known.has(x));
}

export function evaluate(
  current: Findings,
  baseline: Findings | null,
  failOn: ReadonlySet<Rule>,
  minScore: number | null,
): Verdict {
  const reasons: string[] = [];
  if (!current.measured) reasons.push(`Deploy: ${current.unmeasuredReason}`);
  if (baseline && !baseline.measured) reasons.push(`Baseline: ${baseline.unmeasuredReason}`);
  if (reasons.length) return { outcome: "unmeasured", checks: [], reasons };

  const checks: CheckResult[] = [];

  const listRule = (
    rule: Rule,
    ok: (f: Findings) => boolean,
    pick: (f: Findings) => string[],
    unmeasured: string,
  ): void => {
    if (!ok(current) || (baseline !== null && !ok(baseline))) {
      checks.push({ check: rule, title: TITLES[rule], state: "unmeasured", items: [], detail: unmeasured });
      return;
    }
    const items = added(pick(current), baseline ? pick(baseline) : null);
    let detail: string;
    if (items.length) {
      detail = baseline ? "New in this deploy compared with the baseline." : "Found on this deploy.";
    } else {
      detail = baseline ? "Nothing new compared with the baseline." : "None found.";
    }
    checks.push({ check: rule, title: TITLES[rule], state: items.length ? "failed" : "passed", items, detail });
  };

  if (failOn.has("trackers-before-consent")) {
    listRule("trackers-before-consent", (f) => f.consentMeasured, (f) => f.beforeConsent, CONSENT_UNMEASURED);
  }
  if (failOn.has("trackers-after-reject")) {
    listRule("trackers-after-reject", (f) => f.consentMeasured, (f) => f.afterReject, CONSENT_UNMEASURED);
  }
  if (failOn.has("new-third-parties")) {
    if (baseline === null) {
      checks.push({
        check: "new-third-parties",
        title: TITLES["new-third-parties"],
        state: "not-applicable",
        items: [],
        detail: "Needs `baseline-url` to know what is new.",
      });
    } else {
      listRule(
        "new-third-parties",
        (f) => f.thirdPartiesMeasured,
        (f) => f.thirdParties,
        "The scan did not list the page's third parties.",
      );
    }
  }
  if (failOn.has("missing-security-headers")) {
    listRule(
      "missing-security-headers",
      (f) => f.headersMeasured,
      (f) => f.missingHeaders,
      "The page's response headers could not be read or verified.",
    );
  }

  if (minScore !== null) {
    if (current.score === null) {
      checks.push({
        check: "min-score",
        title: "Privacy score",
        state: "unmeasured",
        items: [],
        detail: "No score was produced.",
      });
    } else {
      const low = current.score < minScore;
      checks.push({
        check: "min-score",
        title: "Privacy score",
        state: low ? "failed" : "passed",
        items: low ? [current.score.toFixed(1)] : [],
        detail: `${current.score.toFixed(1)} / 10 (minimum ${minScore}).`,
      });
    }
  }

  let outcome: Outcome = "passed";
  if (checks.some((c) => c.state === "failed")) outcome = "failed";
  else if (checks.some((c) => c.state === "unmeasured")) outcome = "unmeasured";
  for (const c of checks) if (c.state === "unmeasured") reasons.push(`${c.title}: ${c.detail}`);
  return { outcome, checks, reasons };
}
