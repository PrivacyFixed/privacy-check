/** Shapes the public API returns, built the way the tests need them. */

export const KEY = "pfk_live_TESTKEY_0123456789abcdefABCDEF";

export interface ScanShape {
  before?: string[];
  after?: string[];
  companies?: string[];
  missingHeaders?: string[];
  score?: number;
  blocked?: boolean;
  vendor?: string;
  served?: boolean;
  consentMeasured?: boolean;
  headersWithheld?: boolean;
  /** Where the page's own navigation ended. Defaults to https://example.com/. */
  landed?: string;
}

export function completedJob(jobId: string, s: ScanShape = {}): Record<string, unknown> {
  return {
    job_id: jobId,
    status: "completed",
    error: null,
    consent_companies:
      s.consentMeasured === false ? null : { before_consent: s.before ?? [], after_reject: s.after ?? [] },
    result: {
      url: "https://example.com/",
      requests: [{ url: s.landed ?? "https://example.com/", top_level_navigation: true, elapsed_ms: 0 }],
      page_load: { blocked: s.blocked ?? false, challenge_vendor: s.vendor ?? "", final_status: 200 },
      report_guard: {
        served: s.served ?? true,
        refusal_reason: s.served === false ? "We couldn't verify this report." : null,
        withheld: s.headersWithheld ? ["security_headers"] : [],
      },
      grade: { score: s.score ?? 8.2, label: "Low Exposure", tier: "low", evidence_note: "" },
      security_headers: { measured: true, missing: s.missingHeaders ?? [] },
      companies: (s.companies ?? []).map((company) => ({ company })),
      identified_third_parties: [],
    },
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
