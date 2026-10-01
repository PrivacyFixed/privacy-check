/**
 * Confirm a failure with a second scan before failing a pull request.
 *
 * One page load is one sample. Pages that run an ad auction load a different set
 * of companies each time (a live test of one news site found 56 companies before
 * consent on one load and 43 on the next), so a check that fails on a single scan
 * fails pull requests that changed nothing, and teams switch it off.
 *
 * The standard answer to a flaky signal is to confirm it: when the first result
 * would fail, scan again, and count a finding only if it is STABLE —
 *   - on the deploy: seen in both deploy scans (intersection);
 *   - against the baseline: seen in neither baseline scan (union), so a company
 *     the live site loads on some visits is never reported as "new".
 * What showed up only once is reported as varying, not as a failure. A real change
 * (a tracker someone added) loads every time, so it is still caught.
 */

import type { Findings } from "./findings.js";
import type { Rule } from "./inputs.js";
import { type CheckResult, type Verdict, evaluate } from "./policy.js";

function both(a: string[], b: string[]): string[] {
  const inB = new Set(b);
  return a.filter((x) => inB.has(x));
}

function either(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort((x, y) => x.localeCompare(y));
}

function merged(a: Findings, b: Findings, pick: (x: string[], y: string[]) => string[]): Findings {
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
    thirdParties: pick(a.thirdParties, b.thirdParties),
  };
}

/** What two scans of the deploy agree on. */
export function seenInBoth(a: Findings, b: Findings): Findings {
  return merged(a, b, both);
}

/** Everything two scans of the baseline saw. */
export function seenInEither(a: Findings, b: Findings): Findings {
  return merged(a, b, either);
}

/**
 * The verdict from two scans of the deploy against the baseline, when comparing.
 * `baseline` is already every sample of the live site combined (fresh scans via
 * `seenInEither`, saved history via history.ts). Each check's `varying` lists what
 * only one deploy scan showed, so it didn't count.
 */
export function confirmedVerdict(
  deploy1: Findings,
  deploy2: Findings,
  baseline: Findings | null,
  failOn: ReadonlySet<Rule>,
  minScore: number | null,
): Verdict {
  const stable = evaluate(seenInBoth(deploy1, deploy2), baseline, failOn, minScore);
  if (stable.outcome === "unmeasured" && stable.checks.length === 0) return { ...stable, confirmed: true };

  // What a single scan would have failed on, so the difference is what varied.
  const loose = evaluate(seenInEither(deploy1, deploy2), baseline, failOn, minScore);
  const checks: CheckResult[] = stable.checks.map((c) => {
    const wide = loose.checks.find((x) => x.check === c.check);
    if (!wide || c.check === "min-score" || c.state === "unmeasured") return c;
    const counted = new Set(c.items);
    const varying = wide.items.filter((x) => !counted.has(x));
    if (!varying.length) return c;
    const detail =
      c.state === "failed"
        ? c.detail
        : "Nothing that showed up in both scans. Some companies appeared in only one; see below.";
    return { ...c, detail, varying };
  });

  // A score on both sides of the line: one scan failed it, the other didn't.
  const scores = [deploy1.score, deploy2.score];
  const scoreCheck = checks.find((c) => c.check === "min-score");
  if (scoreCheck && minScore !== null && scoreCheck.state === "passed" && scores.some((s) => s !== null && s < minScore)) {
    scoreCheck.detail = `${scores.map((s) => (s === null ? "?" : s.toFixed(1))).join(" and ")} / 10 in two scans; one cleared the minimum of ${minScore}.`;
  }
  return { ...stable, checks, confirmed: true };
}
