import { describe, expect, it } from "vitest";

import { confirmedVerdict, seenInBoth, seenInEither } from "../src/confirm.js";
import { extract } from "../src/findings.js";
import type { CompletedJob } from "../src/scan.js";
import { completedJob } from "./fixtures.js";

const f = (s: Parameters<typeof completedJob>[1] = {}) =>
  extract(completedJob("j", s) as unknown as CompletedJob, "example.com");

describe("combining two scans", () => {
  it("seenInBoth keeps only what both deploy scans found", () => {
    const x = seenInBoth(f({ before: ["A", "B"], companies: ["A", "B"] }), f({ before: ["B", "C"], companies: ["B"] }));
    expect(x.beforeConsent).toEqual(["B"]);
    expect(x.thirdParties).toEqual(["B"]);
  });

  it("seenInEither keeps what either baseline scan found", () => {
    const x = seenInEither(f({ before: ["A"] }), f({ before: ["C"] }));
    expect(x.beforeConsent).toEqual(["A", "C"]);
  });

  it("the pair is measured only when both scans are, and says which one wasn't", () => {
    const x = seenInBoth(f(), f({ blocked: true, vendor: "Akamai" }));
    expect(x.measured).toBe(false);
    expect(x.unmeasuredReason).toMatch(/^Second scan: .*Akamai/);
    expect(seenInBoth(f({ consentMeasured: false }), f()).consentMeasured).toBe(false);
  });

  it("the score clears the minimum when either scan does", () => {
    expect(seenInBoth(f({ score: 6 }), f({ score: 8 })).score).toBe(8);
  });
});

describe("confirmedVerdict", () => {
  const rules = new Set(["trackers-before-consent", "new-third-parties"] as const);

  it("reports what varied, without failing on it", () => {
    const v = confirmedVerdict(
      f({ before: ["X"], companies: ["X"] }),
      f(),
      f(),
      rules,
      null,
    );
    expect(v.outcome).toBe("passed");
    expect(v.confirmed).toBe(true);
    expect(v.checks.find((c) => c.check === "trackers-before-consent")!.varying).toEqual(["X"]);
  });

  it("fails on what is stable, and lists the rest as varying beside it", () => {
    const v = confirmedVerdict(f({ before: ["S", "X"] }), f({ before: ["S"] }), null, rules, null);
    const c = v.checks.find((x) => x.check === "trackers-before-consent")!;
    expect(v.outcome).toBe("failed");
    expect(c.items).toEqual(["S"]);
    expect(c.varying).toEqual(["X"]);
  });

  it("an unmeasured second scan makes the whole result unmeasured", () => {
    expect(confirmedVerdict(f({ before: ["S"] }), f({ served: false }), null, rules, null).outcome).toBe("unmeasured");
  });
});

describe("history", () => {
  it("parses strictly and folds in only names, never measurement", async () => {
    const { parseHistory, withHistory } = await import("../src/history.js");
    expect(parseHistory({ scans: 3 })).toBeNull();
    expect(parseHistory({ days: 14, scans: -1, consent_scans: 0, third_parties: [], before_consent: [], after_reject: [] })).toBeNull();
    const h = parseHistory({ days: 14, scans: 5, consent_scans: 5, third_parties: ["Z"], before_consent: ["Z"], after_reject: [] })!;
    expect(withHistory(f({ companies: ["A"] }), h).thirdParties).toEqual(["A", "Z"]);
    const blocked = f({ blocked: true });
    expect(withHistory(blocked, h)).toBe(blocked);
  });
});
