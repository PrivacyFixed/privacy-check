/**
 * The runner protocol, written out rather than taken from `@actions/core`.
 *
 * The whole protocol this action needs is environment variables in, and lines on
 * stdout plus two appended files out. Doing it here keeps the action free of
 * runtime dependencies: nothing is installed at run time and the bundle carries
 * only our own code, so a customer's CI (which holds their API key) runs no one
 * else's code.
 *
 * Every line leaves through {@link Runner.line}, which removes the API key and
 * neutralises runner commands in text we did not write (a company name, an API
 * message). That single exit is what the leak tests hold.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { md } from "./summary.js";

export type Env = Record<string, string | undefined>;

/** Escape a workflow-command message (the part after `::`). */
export function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Escape a workflow-command property value (`title=…`). */
export function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/**
 * Make text we did not write safe to print as a plain log line: one line, and no
 * `::` anywhere, so it can never be read as a runner command (`::add-mask::`,
 * `::stop-commands::`, …) whatever the API or a scanned site put in it.
 */
export function plain(value: string): string {
  // Every run of colons is spread out, so ":::" can't leave a "::" behind.
  return value.replace(/[\r\n]+/g, " ").replace(/:{2,}/g, (run) => run.split("").join(" "));
}

export class Runner {
  readonly #env: Env;
  readonly #write: (line: string) => void;
  #secrets: string[] = [];

  constructor(env: Env, write: (line: string) => void) {
    this.#env = env;
    this.#write = write;
  }

  /** An action input, as the runner passes it (`INPUT_<NAME>`), trimmed. */
  input(name: string): string {
    return (this.#env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
  }

  /** Register a secret: the runner masks it, and this class removes it too. */
  mask(secret: string): void {
    if (!secret) return;
    // Too short to scrub without mangling ordinary text; still masked by the runner.
    // Also its Markdown-escaped form: the summary escapes text before writing it,
    // which turns `pfk_live_…` into `pfk\_live\_…` and would slip past the scrub.
    if (secret.length >= 8) this.#secrets.push(secret, md(secret));
    this.#write(`::add-mask::${escapeData(secret)}`);
  }

  /** Remove every registered secret from `text`. */
  scrub(text: string): string {
    let out = text;
    for (const s of this.#secrets) out = out.split(s).join("***");
    return out;
  }

  /** The one exit for stdout. Anything printed goes through the scrub. */
  line(text: string): void {
    this.#write(this.scrub(text));
  }

  info(message: string): void {
    this.line(plain(message));
  }

  annotate(level: "error" | "warning" | "notice", title: string, message: string): void {
    const t = escapeProperty(this.scrub(title));
    this.line(`::${level} title=${t}::${escapeData(this.scrub(message))}`);
  }

  group<T>(title: string, body: () => T): T {
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
  setOutput(name: string, value: string): void {
    const file = this.#env.GITHUB_OUTPUT;
    if (!file) return;
    const delimiter = `ghadelimiter_${randomUUID()}`;
    const v = this.scrub(value);
    appendFileSync(file, `${name}<<${delimiter}\n${v}\n${delimiter}\n`, "utf8");
  }

  /** Append Markdown to the job summary shown on the run and the pull request's checks. */
  summary(markdown: string): void {
    const file = this.#env.GITHUB_STEP_SUMMARY;
    if (!file) return;
    appendFileSync(file, `${this.scrub(markdown)}\n`, "utf8");
  }

  /** The triggering event's payload, or `{}` when absent or unreadable. */
  event(): Record<string, unknown> {
    const path = this.#env.GITHUB_EVENT_PATH;
    if (!path) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}
