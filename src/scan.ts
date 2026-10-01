/**
 * Submit one scan and wait for it, on top of the SDK's client.
 *
 * The SDK's own `scan()` gives up on the first 429, but in CI that 429 usually
 * means "another scan on this account is still running" (the API allows one at a
 * time), e.g. two pull requests pushed together. That is a queue, not a failure,
 * so this waits its turn. A daily-limit 429 is final and is reported as such.
 */

import {
  PrivacyFixed,
  PrivacyFixedError,
  RateLimitedError,
  ScanFailedError,
  ScanTimeoutError,
  type ScanJob,
} from "@privacyfixed/sdk";

export interface ConsentCompanies {
  before_consent: string[];
  after_reject: string[];
}

export type CompletedJob = ScanJob & { consent_companies?: ConsentCompanies | null };

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const QUEUE_WAIT_MS = 15_000;
export const POLL_MS = 5_000;
/** Consecutive transient poll failures tolerated before giving up. */
export const MAX_POLL_ERRORS = 5;

/** A 429 that waiting will clear: anything but the daily limit. */
function queued(err: unknown): boolean {
  return err instanceof RateLimitedError && err.code !== "daily_limit_reached";
}

/** Worth retrying: network trouble, a timeout, the scanner's maintenance pause, a 5xx. */
function transient(err: unknown): boolean {
  if (!(err instanceof PrivacyFixedError)) return false;
  if (err instanceof RateLimitedError) return queued(err);
  return err.status === 0 || err.status >= 500;
}

export async function runScan(
  client: PrivacyFixed,
  url: string,
  deadline: number,
  clock: Clock,
  log: (message: string) => void,
): Promise<CompletedJob> {
  let jobId: string | null = null;
  while (jobId === null) {
    try {
      jobId = await client.submit(url);
    } catch (err) {
      if (!transient(err) || clock.now() + QUEUE_WAIT_MS > deadline) throw err;
      log(
        queued(err)
          ? "Another scan on this account is still running. Waiting for it to finish…"
          : `The API is not available right now (${(err as PrivacyFixedError).message}). Retrying…`,
      );
      await clock.sleep(QUEUE_WAIT_MS);
    }
  }

  let errors = 0;
  for (;;) {
    await clock.sleep(POLL_MS);
    let job: CompletedJob;
    try {
      job = (await client.getJob(jobId)) as CompletedJob;
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
