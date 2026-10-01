import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extract } from "../src/findings.js";
import { Runner, plain } from "../src/github.js";
import { API_HOSTS, DEFAULT_FAIL_ON, InputError, apiBase, displayUrl, parseInputs } from "../src/inputs.js";
import { evaluate } from "../src/policy.js";
import type { CompletedJob } from "../src/scan.js";
import { md, renderSummary } from "../src/summary.js";
import { KEY, completedJob } from "./fixtures.js";

const f = (s: Parameters<typeof completedJob>[1] = {}) =>
  extract(completedJob("j", s) as unknown as CompletedJob, "example.com");

describe("api-url: the key only goes to PrivacyFixed", () => {
  it.each([
    "https://evil.example",
    "https://privacyfixed.com.evil.example",
    "https://evilprivacyfixed.com",
    "http://api.privacyfixed.com",
    "https://api.privacyfixed.com/v1",
    "https://user:pw@api.privacyfixed.com",
    "https://api.privacyfixed.com?x=1",
    "https://other.privacyfixed.com",
    "http://10.0.0.5",
    "not a url",
  ])("refuses %s", (raw) => {
    expect(() => apiBase(raw)).toThrow(InputError);
  });

  it("sends the key to the production API and nowhere else", () => {
    expect([...API_HOSTS]).toEqual(["api.privacyfixed.com"]);
  });

  it.each([
    ["https://api.privacyfixed.com", "https://api.privacyfixed.com"],
    ["http://127.0.0.1:8123", "http://127.0.0.1:8123"],
  ])("accepts %s", (raw, origin) => {
    expect(apiBase(raw)).toBe(origin);
  });
});

describe("inputs", () => {
  const read = (over: Record<string, string>) => (name: string) =>
    ({ "api-key": KEY, url: "https://preview.example.com", ...over })[name] ?? "";

  it("defaults the rules, wait and unmeasured handling", () => {
    const i = parseInputs(read({}));
    expect([...i.failOn]).toEqual([...DEFAULT_FAIL_ON]);
    expect(i.maxWaitMs).toBe(600_000);
    expect(i.onUnmeasured).toBe("fail");
    expect(i.apiUrl).toBe("https://api.privacyfixed.com");
  });

  it("accepts none and rejects unknown rules by name", () => {
    expect(parseInputs(read({ "fail-on": "none" })).failOn.size).toBe(0);
    expect(() => parseInputs(read({ "fail-on": "trackers-before-consent, typo" }))).toThrow(/typo/);
  });

  it("rejects an empty key with the fix", () => {
    expect(() => parseInputs(read({ "api-key": "" }))).toThrow(/PRIVACYFIXED_API_KEY/);
  });

  it.each([
    ["min-score", "11"],
    ["min-score", "abc"],
    ["max-wait-seconds", "10"],
    ["max-wait-seconds", "99999"],
    ["on-unmeasured", "ignore"],
    ["url", "ftp://example.com"],
    ["url", "https://me:secret@example.com"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => parseInputs(read({ [name]: value }))).toThrow(InputError);
  });

  it("never shows a URL's query or fragment", () => {
    expect(displayUrl(new URL("https://p.example.com/a?_vercel_share=TOKEN#x"))).toBe("https://p.example.com/a");
  });
});

describe("runner protocol", () => {
  it("neutralises runner commands in text it did not write", () => {
    const lines: string[] = [];
    const gh = new Runner({}, (l) => lines.push(l));
    gh.info("Acme\n::add-mask::x ::stop-commands::y");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/::/);
    expect(plain("a::b")).toBe("a: :b");
  });

  it("keeps an annotation to one command line", () => {
    const lines: string[] = [];
    const gh = new Runner({}, (l) => lines.push(l));
    gh.annotate("error", "t:1,2", "one\n::error::two %");
    expect(lines).toEqual(["::error title=t%3A1%2C2::one%0A::error::two %25"]);
  });

  it("a value cannot close its output block and write a second output", () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-out-"));
    const out = join(dir, "out");
    writeFileSync(out, "");
    const gh = new Runner({ GITHUB_OUTPUT: out }, () => {});
    gh.setOutput("status", "x\nEOF\nstatus<<EOF\npassed\nEOF");
    const text = readFileSync(out, "utf8");
    const delimiter = text.split("\n")[0]!.replace("status<<", "");
    expect(delimiter).toMatch(/^ghadelimiter_[0-9a-f-]{36}$/);
    expect(text.split("\n").filter((l) => l === delimiter)).toHaveLength(1);
  });

  it("removes the key from every channel", () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-out-"));
    const out = join(dir, "out");
    const sum = join(dir, "sum");
    const lines: string[] = [];
    const gh = new Runner({ GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum }, (l) => lines.push(l));
    gh.mask(KEY);
    gh.info(`k=${KEY}`);
    gh.annotate("error", KEY, KEY);
    gh.setOutput("o", KEY);
    gh.summary(KEY);
    const all = [...lines.slice(1), readFileSync(out, "utf8"), readFileSync(sum, "utf8")].join("\n");
    expect(lines[0]).toBe(`::add-mask::${KEY}`);
    expect(all).not.toContain(KEY);
  });
});

describe("findings", () => {
  it("a blocked page is not measured, and names the bot check", () => {
    const x = f({ blocked: true, vendor: "Cloudflare" });
    expect(x.measured).toBe(false);
    expect(x.unmeasuredReason).toMatch(/Cloudflare/);
  });

  it("a report the guard refused is not measured", () => {
    expect(f({ served: false }).measured).toBe(false);
  });

  it("no consent names means the consent check did not run, not that nothing fired", () => {
    expect(f({ consentMeasured: false }).consentMeasured).toBe(false);
  });

  it("withheld security headers are not measured", () => {
    expect(f({ headersWithheld: true, missingHeaders: ["CSP"] }).headersMeasured).toBe(false);
  });
});

describe("policy", () => {
  const all = new Set(["trackers-before-consent", "trackers-after-reject", "new-third-parties", "missing-security-headers"] as const);

  it("with a baseline, fails only on what the deploy added", () => {
    const v = evaluate(
      f({ before: ["Google", "Hotjar"], companies: ["Google", "Hotjar"] }),
      f({ before: ["Google"], companies: ["Google"] }),
      all,
      null,
    );
    expect(v.outcome).toBe("failed");
    expect(v.checks.find((c) => c.check === "trackers-before-consent")!.items).toEqual(["Hotjar"]);
    expect(v.checks.find((c) => c.check === "new-third-parties")!.items).toEqual(["Hotjar"]);
  });

  it("without a baseline, fails on anything found and skips new-third-parties", () => {
    const v = evaluate(f({ before: ["Google"] }), null, all, null);
    expect(v.outcome).toBe("failed");
    expect(v.checks.find((c) => c.check === "new-third-parties")!.state).toBe("not-applicable");
  });

  it("an unmeasured deploy is never a pass", () => {
    expect(evaluate(f({ blocked: true }), null, all, null).outcome).toBe("unmeasured");
    expect(evaluate(f(), f({ served: false }), all, null).outcome).toBe("unmeasured");
    expect(evaluate(f({ consentMeasured: false }), null, all, null).outcome).toBe("unmeasured");
  });

  it("an unmeasured rule that was not chosen does not matter", () => {
    const v = evaluate(f({ consentMeasured: false }), null, new Set(["missing-security-headers"] as const), null);
    expect(v.outcome).toBe("passed");
  });

  it("a clean deploy passes", () => {
    expect(evaluate(f(), f(), all, null).outcome).toBe("passed");
  });

  it("min-score fails below and passes at the line", () => {
    expect(evaluate(f({ score: 6.9 }), null, new Set(), 7).outcome).toBe("failed");
    expect(evaluate(f({ score: 7 }), null, new Set(), 7).outcome).toBe("passed");
  });
});

describe("summary", () => {
  it("escapes names so they cannot inject Markdown or HTML", () => {
    expect(md("<img src=x onerror=alert(1)>")).not.toContain("<");
    expect(md("[click](https://evil.example)")).toBe("\\[click\\]\\(https\\://evil.example\\)");
    expect(md("a|b")).not.toContain("|");
  });

  it("never claims compliance", () => {
    const text = renderSummary({
      verdict: evaluate(f(), null, new Set(DEFAULT_FAIL_ON), null),
      deploy: "https://p.example.com/",
      baseline: null,
      current: f(),
    });
    expect(text).toContain("No blocking issues found");
    expect(text).toMatch(/not a compliance certification/);
    expect(text).not.toMatch(/\bcompliant\b/i);
  });
});

describe("audit findings (2026-09-25)", () => {
  const job = (over: Record<string, unknown>, cc: unknown = { before_consent: [], after_reject: [] }) => {
    const j = completedJob("j") as Record<string, unknown>;
    return { ...j, consent_companies: cc, result: { ...(j.result as object), ...over } } as unknown as CompletedJob;
  };

  it("a page that redirected to another host (a login page) is not measured", () => {
    const x = f({ landed: "https://vercel.com/login?next=/preview" });
    expect(x.measured).toBe(false);
    expect(x.unmeasuredReason).toMatch(/redirected to vercel\.com/);
  });

  it("a redirect between the bare host and www is the same site", () => {
    expect(f({ landed: "https://www.example.com/" }).measured).toBe(true);
  });

  it("a result that doesn't record the page it measured is not measured", () => {
    expect(extract(job({ requests: [] }), "example.com").measured).toBe(false);
  });

  it("a result missing its guard or page-load record is not measured", () => {
    expect(extract(job({ report_guard: undefined }), "example.com").measured).toBe(false);
    expect(extract(job({ page_load: undefined }), "example.com").measured).toBe(false);
    expect(extract(job({ report_guard: { withheld: [] } }), "example.com").measured).toBe(false);
  });

  it("malformed consent names mean the consent check is not measured", () => {
    for (const cc of [{}, [], { before_consent: "Hotjar", after_reject: [] }, { before_consent: [1], after_reject: [] }]) {
      expect(extract(job({}, cc), "example.com").consentMeasured).toBe(false);
    }
  });

  it("a missing third-party list is not 'nothing new'", () => {
    const current = extract(job({ companies: undefined }), "example.com");
    const v = evaluate(current, f(), new Set(["new-third-parties"] as const), null);
    expect(v.outcome).toBe("unmeasured");
  });

  it("the key is removed from the summary even after Markdown escaping", () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-out-"));
    const sum = join(dir, "sum");
    const gh = new Runner({ GITHUB_STEP_SUMMARY: sum }, () => {});
    gh.mask(KEY);
    gh.summary(md(`message with ${KEY}`));
    const text = readFileSync(sum, "utf8");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(md(KEY));
  });

  it("no run of colons leaves a runner command behind", () => {
    for (const s of [":::x", "::::y", "a:::::b"]) expect(plain(s)).not.toMatch(/::/);
  });

  it("web addresses in names don't become links", () => {
    expect(md("www.evil.example")).not.toMatch(/www\.evil/);
    expect(md("https://evil.example")).not.toContain("https://");
  });

  it("the key only goes to PrivacyFixed's exact API hosts", () => {
    for (const raw of ["https://old.privacyfixed.com", "https://privacyfixed.com", "https://x.api.privacyfixed.com"]) {
      expect(() => apiBase(raw)).toThrow(InputError);
    }
  });

  it("an invalid url is reported without repeating it", () => {
    let message = "";
    try {
      parseInputs((n) => ({ "api-key": KEY, url: "preview.example.com/?_vercel_share=SECRETSHARE" })[n] ?? "");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/must be a full URL/);
    expect(message).not.toContain("SECRETSHARE");
  });
});
