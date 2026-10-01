import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { USER_AGENT, run } from "../src/main.js";
import { KEY, type ScanShape, completedJob, jsonResponse } from "./fixtures.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect: RequestRedirect | undefined;
}

/**
 * A fake API. `scans` maps a scanned URL to what its job returns; `submitErrors`
 * are answered to the first POSTs, in order, before any succeeds.
 */
function fakeApi(opts: {
  /** Per scanned URL: one shape for every scan, or a list used in order (the nth scan gets the nth). */
  scans?: Record<string, ScanShape | ScanShape[]>;
  submitErrors?: Array<[number, unknown]>;
  pollStatus?: "running" | "failed";
  /** GET /v1/public/baseline: a body (200), or a status to fail with. Default: no saved scans. */
  history?: Record<string, unknown> | number;
}) {
  const calls: Call[] = [];
  const jobs = new Map<string, { url: string; nth: number }>();
  const seen = new Map<string, number>();
  const errors = [...(opts.submitErrors ?? [])];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      redirect: init?.redirect,
    });
    if (init?.method === "POST") {
      const next = errors.shift();
      if (next) return jsonResponse(next[0], next[1]);
      const scanned = (JSON.parse(String(init.body)) as { url: string }).url;
      const id = `job-${jobs.size + 1}`;
      const nth = seen.get(scanned) ?? 0;
      seen.set(scanned, nth + 1);
      jobs.set(id, { url: scanned, nth });
      return jsonResponse(202, { job_id: id, status: "pending", poll_url: `/v1/public/scans/${id}` });
    }
    if (url.includes("/v1/public/baseline")) {
      const h = opts.history ?? { url: "", days: 14, scans: 0, consent_scans: 0, third_parties: [], before_consent: [], after_reject: [] };
      return typeof h === "number" ? jsonResponse(h, { detail: "nope" }) : jsonResponse(200, h);
    }
    const id = url.split("/").pop()!;
    if (opts.pollStatus === "running") return jsonResponse(200, { job_id: id, status: "running", result: null, error: null });
    if (opts.pollStatus === "failed") {
      return jsonResponse(200, { job_id: id, status: "failed", result: null, error: { status: 502, detail: "The site did not respond." } });
    }
    const { url: scanned, nth } = jobs.get(id)!;
    const plan = opts.scans?.[scanned];
    const shape = Array.isArray(plan) ? plan[Math.min(nth, plan.length - 1)] : plan;
    return jsonResponse(200, completedJob(id, { landed: scanned, ...shape }));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function harness(inputs: Record<string, string>, api: ReturnType<typeof fakeApi>, event?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "pf-run-"));
  const out = join(dir, "out");
  const sum = join(dir, "sum");
  writeFileSync(out, "");
  writeFileSync(sum, "");
  const env: Record<string, string> = { GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum };
  if (event) {
    env.GITHUB_EVENT_PATH = join(dir, "event.json");
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event));
  }
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  const lines: string[] = [];
  let now = 0;
  const go = () =>
    run({
      env,
      write: (l) => lines.push(l),
      fetch: api.fetchImpl,
      clock: { now: () => now, sleep: async (ms) => void (now += ms) },
    });
  const outputs = () => {
    const text = readFileSync(out, "utf8");
    const map: Record<string, string> = {};
    const re = /^([\w-]+)<<(ghadelimiter_[\w-]+)\n([\s\S]*?)\n\2$/gm;
    for (const m of text.matchAll(re)) map[m[1]!] = m[3]!;
    return map;
  };
  const everything = () => [lines.join("\n"), readFileSync(out, "utf8"), readFileSync(sum, "utf8")].join("\n");
  return { go, lines, outputs, summary: () => readFileSync(sum, "utf8"), everything, elapsed: () => now };
}

const base = { "api-key": KEY, url: "https://preview.example.com/?_vercel_share=SHARETOKEN" };

/** The key appears once, in the mask command, and nowhere else. */
function assertNoLeak(h: ReturnType<typeof harness>): void {
  expect(h.lines[0]).toBe(`::add-mask::${KEY}`);
  expect(h.everything().split(KEY)).toHaveLength(2);
}

describe("run", () => {
  it("passes a clean deploy and only ever talks to the API over the key's host", async () => {
    const api = fakeApi({});
    const h = harness(base, api);
    expect(await h.go()).toBe(0);
    expect(h.outputs().status).toBe("passed");
    expect(h.summary()).toContain("No blocking issues found");
    for (const c of api.calls) {
      expect(c.url.startsWith("https://api.privacyfixed.com/v1/public/scans")).toBe(true);
      expect(c.headers.Authorization).toBe(`Bearer ${KEY}`);
      expect(c.headers["User-Agent"]).toBe(USER_AGENT);
      expect(c.redirect).toBe("error");
    }
    assertNoLeak(h);
    expect(h.everything()).not.toContain("SHARETOKEN");
  });

  it("fails on a tracker the deploy added, naming it, and passes what the live site already had", async () => {
    const api = fakeApi({
      scans: {
        "https://preview.example.com/?_vercel_share=SHARETOKEN": { before: ["Google", "Hotjar"], companies: ["Google", "Hotjar"] },
        "https://example.com/": { before: ["Google"], companies: ["Google"] },
      },
    });
    const h = harness({ ...base, "baseline-url": "https://example.com/" }, api);
    expect(await h.go()).toBe(1);
    const o = h.outputs();
    expect(o.status).toBe("failed");
    expect(o["new-third-parties"]).toBe("Hotjar");
    expect(o["before-consent"]).toBe("Google, Hotjar");
    expect(h.summary()).toMatch(/### Trackers before consent\n\n- Hotjar\n/);
    expect(h.summary()).not.toMatch(/- Google/);
    assertNoLeak(h);
  });

  it("waits its turn when another scan on the account is running", async () => {
    const busy: [number, unknown] = [429, { detail: "A scan is already running on this account. Wait for it to finish." }];
    const api = fakeApi({ submitErrors: [busy, busy] });
    const h = harness(base, api);
    expect(await h.go()).toBe(0);
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(3);
    expect(h.lines.join("\n")).toMatch(/still running/);
  });

  it("stops at once on the daily limit, with the API's message", async () => {
    const api = fakeApi({
      submitErrors: [[429, { detail: { code: "daily_limit_reached", message: "You've used today's 500 scans." } }]],
    });
    const h = harness({ ...base, "on-unmeasured": "warn" }, api);
    expect(await h.go()).toBe(1);
    expect(api.calls).toHaveLength(1);
    expect(h.lines.join("\n")).toMatch(/today's 500 scans/);
    assertNoLeak(h);
  });

  it("explains a refused key without printing it, even under on-unmeasured: warn", async () => {
    const api = fakeApi({ submitErrors: [[401, { detail: { code: "api_key_invalid", message: `bad key ${KEY}` } }]] });
    const h = harness({ ...base, "on-unmeasured": "warn" }, api);
    expect(await h.go()).toBe(1);
    expect(h.outputs().status).toBe("error");
    expect(h.lines.join("\n")).toMatch(/refused the API key/);
    assertNoLeak(h);
  });

  it("times out at max-wait-seconds, and on-unmeasured decides the exit", async () => {
    const strict = harness({ ...base, "max-wait-seconds": "60" }, fakeApi({ pollStatus: "running" }));
    expect(await strict.go()).toBe(1);
    expect(strict.elapsed()).toBeLessThanOrEqual(65_000);
    const soft = harness({ ...base, "max-wait-seconds": "60", "on-unmeasured": "warn" }, fakeApi({ pollStatus: "running" }));
    expect(await soft.go()).toBe(0);
    expect(soft.lines.join("\n")).toMatch(/::warning/);
  });

  it("a failed scan is reported, not passed", async () => {
    const h = harness(base, fakeApi({ pollStatus: "failed" }));
    expect(await h.go()).toBe(1);
    expect(h.lines.join("\n")).toMatch(/did not respond/);
  });

  it("a bot-walled deploy fails as unmeasured by default and warns when asked", async () => {
    const scans = { [base.url]: { blocked: true, vendor: "Cloudflare" } };
    const strict = harness(base, fakeApi({ scans }));
    expect(await strict.go()).toBe(1);
    expect(strict.outputs().status).toBe("unmeasured");
    const soft = harness({ ...base, "on-unmeasured": "warn" }, fakeApi({ scans }));
    expect(await soft.go()).toBe(0);
  });

  it("skips a fork's pull request, which has no secrets, without failing it", async () => {
    const api = fakeApi({});
    const event = { pull_request: { head: { repo: { fork: true, full_name: "someone/site" } }, base: { repo: { full_name: "acme/site" } } } };
    const h = harness({ ...base, "api-key": "" }, api, event);
    expect(await h.go()).toBe(0);
    expect(h.outputs().status).toBe("skipped");
    expect(api.calls).toHaveLength(0);
  });

  it("a missing key on the repo's own pull request is an error, not a skip", async () => {
    const event = { pull_request: { head: { repo: { fork: false, full_name: "acme/site" } }, base: { repo: { full_name: "acme/site" } } } };
    const h = harness({ ...base, "api-key": "" }, fakeApi({}), event);
    expect(await h.go()).toBe(1);
    expect(h.lines.join("\n")).toMatch(/PRIVACYFIXED_API_KEY/);
  });

  it("refuses a non-PrivacyFixed api-url before sending anything", async () => {
    const api = fakeApi({});
    const h = harness({ ...base, "api-url": "https://collector.evil.example" }, api);
    expect(await h.go()).toBe(1);
    expect(api.calls).toHaveLength(0);
    assertNoLeak(h);
  });

  it("names from the API cannot inject runner commands or Markdown", async () => {
    const evil = "Acme\n::add-mask::x\n<script>alert(1)</script>](https://evil.example)";
    const api = fakeApi({ scans: { [base.url]: { before: [evil] } } });
    const h = harness(base, api);
    expect(await h.go()).toBe(1);
    expect(h.lines.slice(1).some((l) => l.startsWith("::add-mask::"))).toBe(false);
    expect(h.summary()).not.toContain("<script>");
    expect(h.summary()).not.toContain("](https://evil.example)");
  });
});

describe("confirm with a second scan (live finding 2026-09-26: the same news site, 56 then 43 companies)", () => {
  const DEPLOY = "https://preview.example.com/";
  const LIVE = "https://example.com/";
  const withBase = { "api-key": KEY, url: DEPLOY, "baseline-url": LIVE };
  const posts = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method === "POST").length;

  it("the same site compared with itself passes when an ad bidder shows up on one load only", async () => {
    const api = fakeApi({
      scans: {
        [DEPLOY]: [{ before: ["Google", "33Across"], companies: ["Google", "33Across"] }, { before: ["Google"], companies: ["Google"] }],
        [LIVE]: [{ before: ["Google"], companies: ["Google"] }, { before: ["Google"], companies: ["Google"] }],
      },
    });
    const h = harness(withBase, api);
    expect(await h.go()).toBe(0);
    const o = h.outputs();
    expect(o.status).toBe("passed");
    expect(o.varying).toBe("33Across");
    expect(o["new-third-parties"]).toBe("");
    // No saved history: deploy x2, and the live site gets three fresh samples.
    expect(posts(api)).toBe(5);
    expect(h.summary()).toMatch(/Seen in one scan only \(not counted\)/);
    expect(h.summary()).toMatch(/Confirmed with a second scan/);
    expect(h.lines.join("\n")).toMatch(/::warning title=PrivacyFixed%3A seen in one scan only/);
    assertNoLeak(h);
  });

  it("a tracker the deploy really added (in both deploy scans, in neither baseline scan) fails", async () => {
    const api = fakeApi({
      scans: {
        [DEPLOY]: { before: ["Google", "Hotjar"], companies: ["Google", "Hotjar"] },
        [LIVE]: { before: ["Google"], companies: ["Google"] },
      },
    });
    const h = harness(withBase, api);
    expect(await h.go()).toBe(1);
    expect(h.outputs().status).toBe("failed");
    expect(h.outputs()["new-third-parties"]).toBe("Hotjar");
    expect(h.outputs().varying).toBe("");
    // No saved history: deploy x2, and the live site gets three fresh samples.
    expect(posts(api)).toBe(5);
  });

  it("a company the live site loads on SOME visits is never reported as new", async () => {
    const api = fakeApi({
      scans: {
        [DEPLOY]: { before: ["Google", "Criteo"], companies: ["Google", "Criteo"] },
        [LIVE]: [{ before: ["Google"], companies: ["Google"] }, { before: ["Google", "Criteo"], companies: ["Google", "Criteo"] }],
      },
    });
    const h = harness(withBase, api);
    expect(await h.go()).toBe(0);
    expect(h.outputs().status).toBe("passed");
  });

  it("without a baseline, a tracker seen once is a warning and one seen twice fails", async () => {
    const once = fakeApi({ scans: { [DEPLOY]: [{ before: ["Taboola"] }, { before: [] }] } });
    const a = harness({ "api-key": KEY, url: DEPLOY }, once);
    expect(await a.go()).toBe(0);
    expect(a.outputs().varying).toBe("Taboola");

    const twice = fakeApi({ scans: { [DEPLOY]: [{ before: ["Taboola", "Meta"] }, { before: ["Meta"] }] } });
    const b = harness({ "api-key": KEY, url: DEPLOY }, twice);
    expect(await b.go()).toBe(1);
    expect(b.outputs()["before-consent"]).toBe("Meta");
    expect(b.outputs().varying).toBe("Taboola");
    expect(posts(twice)).toBe(2);
  });

  it("a passing first result costs no extra scan", async () => {
    const api = fakeApi({});
    const h = harness(withBase, api);
    expect(await h.go()).toBe(0);
    expect(posts(api)).toBe(2);
    expect(h.summary()).not.toMatch(/Confirmed with a second scan/);
  });

  it("min-score fails only when both scans are below the line", async () => {
    const split = fakeApi({ scans: { [DEPLOY]: [{ score: 6.5 }, { score: 7.4 }] } });
    const a = harness({ "api-key": KEY, url: DEPLOY, "fail-on": "none", "min-score": "7" }, split);
    expect(await a.go()).toBe(0);
    expect(a.summary()).toMatch(/6\.5 and 7\.4 \/ 10 in two scans/);

    const low = fakeApi({ scans: { [DEPLOY]: [{ score: 6.5 }, { score: 6.8 }] } });
    const b = harness({ "api-key": KEY, url: DEPLOY, "fail-on": "none", "min-score": "7" }, low);
    expect(await b.go()).toBe(1);
  });

  it("a second scan that can't measure the page is 'not measured', never a pass", async () => {
    const api = fakeApi({ scans: { [DEPLOY]: [{ before: ["Meta"] }, { blocked: true, vendor: "Cloudflare" }] } });
    const h = harness({ "api-key": KEY, url: DEPLOY }, api);
    expect(await h.go()).toBe(1);
    expect(h.outputs().status).toBe("unmeasured");
    expect(h.summary()).toMatch(/Second scan: The page showed a Cloudflare bot check/);
  });
});

describe("learned baseline (GET /v1/public/baseline; study 2026-09-26)", () => {
  const DEPLOY = "https://preview.example.com/";
  const LIVE = "https://example.com/";
  const withBase = { "api-key": KEY, url: DEPLOY, "baseline-url": LIVE };
  const posts = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method === "POST").length;
  const history = (over: Record<string, unknown> = {}) => ({
    url: LIVE, days: 14, scans: 12, consent_scans: 12,
    third_parties: ["Google"], before_consent: ["Google"], after_reject: [], ...over,
  });

  it("a company the live site loaded on some past visit is not new, even if today's scan missed it", async () => {
    const api = fakeApi({
      scans: {
        [DEPLOY]: { before: ["Google", "Meta"], companies: ["Google", "Meta"] },
        [LIVE]: { before: ["Google"], companies: ["Google"] },
      },
      history: history({ third_parties: ["Google", "Meta"], before_consent: ["Google", "Meta"] }),
    });
    const h = harness(withBase, api);
    expect(await h.go()).toBe(0);
    expect(h.outputs().status).toBe("passed");
    expect(posts(api)).toBe(2);
    expect(h.outputs()["baseline-samples"]).toBe("13");
    expect(h.summary()).toMatch(/learned from 12 saved scans over the last 14 days, plus 1 fresh scan/);
  });

  it("a real new tracker still fails, and history means no extra live-site scans", async () => {
    const api = fakeApi({
      scans: {
        [DEPLOY]: { before: ["Google", "Hotjar"], companies: ["Google", "Hotjar"] },
        [LIVE]: { before: ["Google"], companies: ["Google"] },
      },
      history: history(),
    });
    const h = harness(withBase, api);
    expect(await h.go()).toBe(1);
    expect(h.outputs()["new-third-parties"]).toBe("Hotjar");
    expect(posts(api)).toBe(3);
  });

  it("too little history (under 3 saved scans) falls back to three fresh live-site scans", async () => {
    const api = fakeApi({
      scans: {
        [DEPLOY]: { before: ["Google", "Hotjar"], companies: ["Google", "Hotjar"] },
        [LIVE]: { before: ["Google"], companies: ["Google"] },
      },
      history: history({ scans: 2 }),
    });
    const h = harness(withBase, api);
    expect(await h.go()).toBe(1);
    expect(posts(api)).toBe(5);
    expect(h.summary()).toMatch(/3 fresh scans; no saved history of this site to learn from yet/);
  });

  it("history the API can't serve (500) is skipped, not fatal", async () => {
    const api = fakeApi({ history: 500 });
    const h = harness(withBase, api);
    expect(await h.go()).toBe(0);
    expect(h.lines.join("\n")).toMatch(/Saved history of the live site isn't available/);
  });

  it("a refused key on the history call stops the run", async () => {
    const api = fakeApi({ history: 401 });
    const h = harness(withBase, api);
    expect(await h.go()).toBe(1);
    expect(h.lines.join("\n")).toMatch(/refused the API key/);
    assertNoLeak(h);
  });

  it("malformed history is ignored rather than trusted", async () => {
    const api = fakeApi({
      scans: {
        [DEPLOY]: { before: ["Google", "Hotjar"], companies: ["Google", "Hotjar"] },
        [LIVE]: { before: ["Google"], companies: ["Google"] },
      },
      history: history({ scans: "12", third_parties: "Hotjar" }),
    });
    const h = harness(withBase, api);
    expect(await h.go()).toBe(1);
    expect(h.outputs()["new-third-parties"]).toBe("Hotjar");
  });

  it("consent names from history count only when saved scans ran the consent check", async () => {
    const api = fakeApi({
      scans: {
        [DEPLOY]: { before: ["Google", "Meta"], companies: ["Google", "Meta"] },
        [LIVE]: { before: ["Google"], companies: ["Google", "Meta"] },
      },
      history: history({ consent_scans: 0, before_consent: ["Google", "Meta"] }),
    });
    const h = harness({ ...withBase, "fail-on": "trackers-before-consent" }, api);
    expect(await h.go()).toBe(1);
    expect(h.outputs()["before-consent"]).toBe("Google, Meta");
  });

  it("baseline-history-days: 0 never calls the history endpoint", async () => {
    const api = fakeApi({ history: history() });
    const h = harness({ ...withBase, "baseline-history-days": "0" }, api);
    expect(await h.go()).toBe(0);
    expect(api.calls.some((c) => c.url.includes("/v1/public/baseline"))).toBe(false);
  });

  it("asks for the configured window, with the site URL as one encoded value", async () => {
    const api = fakeApi({ history: history() });
    const h = harness({ ...withBase, "baseline-url": "https://example.com/?x=1&days=90", "baseline-history-days": "30" }, api);
    await h.go();
    const call = api.calls.find((c) => c.url.includes("/v1/public/baseline"))!;
    const q = new URL(call.url).searchParams;
    expect(q.get("days")).toBe("30");
    expect(q.get("url")).toBe("https://example.com/?x=1&days=90");
    expect(call.redirect).toBe("error");
  });
});
