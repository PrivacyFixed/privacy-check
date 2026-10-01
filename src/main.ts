/**
 * The action: scan the deploy (and the baseline, if given), decide, report.
 *
 * `run` takes its environment, output, network and clock as arguments so the
 * tests drive the real flow end to end without a runner, a network or waiting.
 * It never throws: every failure becomes an annotation and an exit code.
 */

import {
  AuthError,
  PrivacyFixed,
  PrivacyFixedError,
  RateLimitedError,
  ScanFailedError,
  ScanTimeoutError,
} from "@privacyfixed/sdk";
import { type Findings, extract } from "./findings.js";
import { type Env, Runner } from "./github.js";
import { type Inputs, InputError, displayUrl, parseInputs } from "./inputs.js";
import { confirmedVerdict, seenInBoth, seenInEither } from "./confirm.js";
import { type History, MIN_HISTORY_SCANS, parseHistory, withHistory } from "./history.js";
import { evaluate } from "./policy.js";
import { type Clock, runScan } from "./scan.js";
import { DISCLAIMER, md, renderSummary } from "./summary.js";

export const ACTION_VERSION = "1.0.0";
export const USER_AGENT = `privacyfixed-github-action/${ACTION_VERSION}`;

export interface Deps {
  env: Env;
  write: (line: string) => void;
  fetch: typeof fetch;
  clock: Clock;
}

/** A pull request from a fork: GitHub gives it no repository secrets. */
export function isForkPullRequest(event: Record<string, unknown>): boolean {
  const pr = event.pull_request as
    | { head?: { repo?: { fork?: unknown; full_name?: unknown } }; base?: { repo?: { full_name?: unknown } } }
    | undefined;
  if (!pr?.head?.repo) return false;
  if (pr.head.repo.fork === true) return true;
  const head = pr.head.repo.full_name;
  const base = pr.base?.repo?.full_name;
  return typeof head === "string" && typeof base === "string" && head !== base;
}

/**
 * Errors that mean "we could not look", which `on-unmeasured` governs, as opposed
 * to errors the user must fix (a refused key, a used-up daily allowance).
 */
function couldNotLook(err: unknown): boolean {
  if (err instanceof ScanTimeoutError || err instanceof ScanFailedError) return true;
  if (err instanceof AuthError || err instanceof RateLimitedError) return false;
  return err instanceof PrivacyFixedError && (err.status === 0 || err.status >= 500);
}

function describe(err: unknown, inputs: Inputs): string {
  if (err instanceof AuthError) {
    return (
      "PrivacyFixed refused the API key. Check the PRIVACYFIXED_API_KEY secret: the key must be active " +
      "(not revoked) and belong to a Business or Agency account."
    );
  }
  if (err instanceof RateLimitedError) return err.message;
  if (err instanceof ScanTimeoutError) {
    return `The scan did not finish within ${inputs.maxWaitMs / 1000} seconds. Try again, or raise \`max-wait-seconds\`.`;
  }
  if (err instanceof ScanFailedError) return `The scan failed: ${err.message}`;
  if (err instanceof PrivacyFixedError) return err.message;
  return "An unexpected error stopped the check.";
}

export async function run(deps: Deps): Promise<number> {
  const gh = new Runner(deps.env, deps.write);
  const key = gh.input("api-key");
  gh.mask(key);

  if (!key && isForkPullRequest(gh.event())) {
    gh.annotate(
      "notice",
      "PrivacyFixed check skipped",
      "Pull requests from forks don't receive repository secrets, so the check can't run here.",
    );
    gh.setOutput("status", "skipped");
    return 0;
  }

  let inputs: Inputs;
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
    fetch: (url, init) =>
      deps.fetch(url, {
        ...init,
        // Never follow a redirect: it would carry the Authorization header to
        // wherever the redirect points.
        redirect: "error",
        headers: { ...(init?.headers as Record<string, string>), "User-Agent": USER_AGENT },
      }),
  });

  const deadline = deps.clock.now() + inputs.maxWaitMs;
  const scanOne = async (label: string, url: URL): Promise<Findings> => {
    gh.info(`Scanning ${label.toLowerCase()}: ${displayUrl(url)}`);
    const job = await runScan(client, url.href, deadline, deps.clock, (m) => gh.info(m));
    return extract(job, url.hostname);
  };

  /** Report a scan that could not complete. Returns the exit code. */
  const couldNotRun = (err: unknown): number => {
    const message = describe(err, inputs);
    const soft = couldNotLook(err) && inputs.onUnmeasured === "warn";
    gh.annotate(soft ? "warning" : "error", "PrivacyFixed check could not run", message);
    gh.setOutput("status", "error");
    gh.summary(`## PrivacyFixed check: ⚠️ Couldn't run\n\n${md(message)}\n\n${DISCLAIMER}`);
    return soft ? 0 : 1;
  };

  /**
   * The live site's saved history (history.ts), or null when there is none, it is
   * switched off, or it can't be read. Never fatal: without it the check falls
   * back to fresh baseline scans. A refused key still stops the run.
   */
  const loadHistory = async (url: URL): Promise<History | null> => {
    if (inputs.historyDays === 0) return null;
    try {
      return parseHistory(await client.baseline(url.href, inputs.historyDays));
    } catch (err) {
      if (err instanceof AuthError) throw err;
      gh.info("Saved history of the live site isn't available right now; using fresh scans instead.");
      return null;
    }
  };

  let current: Findings;
  let fresh: Findings[] = [];
  let history: History | null = null;
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
  /** Every sample of the live site so far: fresh scans, widened by saved history. */
  const combinedBaseline = (): Findings | null => {
    if (!fresh.length) return null;
    const scans = fresh.reduce((a, b) => seenInEither(a, b));
    return history ? withHistory(scans, history) : scans;
  };

  let baseline = combinedBaseline();
  let verdict = evaluate(current, baseline, inputs.failOn, inputs.minScore);
  // What the outputs report: the first scan, or what both deploy scans agree on.
  let reported = current;

  // A failure from one page load is one sample; confirm it before failing the
  // pull request (confirm.ts). A pass needs no second look. Without enough saved
  // history, the live site gets two more fresh scans so the baseline still has
  // three samples (measured: false failures fall as baseline samples grow).
  if (verdict.outcome === "failed") {
    gh.info("Possible issues found. Scanning again to confirm they show up every time…");
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

  let baselineNote: string | null = null;
  if (inputs.baselineUrl) {
    const freshCount = `${fresh.length} fresh ${fresh.length === 1 ? "scan" : "scans"}`;
    baselineNote = learned
      ? `learned from ${history!.scans} saved scans over the last ${history!.days} days, plus ${freshCount}`
      : `${freshCount}; no saved history of this site to learn from yet. Monitor it for a steadier baseline`;
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
    known ? reported.thirdParties.filter((t) => !known.thirdParties.includes(t)).join(", ") : "",
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
      `${varying.join(", ")}. These appeared in only one of two scans, so they don't fail the check. Ad auctions often change which companies load from one visit to the next.`,
    );
  }
  if (verdict.outcome === "unmeasured") {
    const level = inputs.onUnmeasured === "warn" ? "warning" : "error";
    gh.annotate(level, "PrivacyFixed couldn't measure this deploy", verdict.reasons.join(" "));
    return level === "error" ? 1 : 0;
  }
  gh.info(
    verdict.outcome === "passed"
      ? "PrivacyFixed check passed: no blocking issues found."
      : "PrivacyFixed check failed. See the job summary for details.",
  );
  return verdict.outcome === "failed" ? 1 : 0;
}
