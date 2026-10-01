/**
 * The job summary: the report a reviewer reads on the pull request's checks.
 *
 * Every value that came from the API or a scanned page is escaped before it goes
 * into Markdown, so a company or header name cannot inject links, HTML or table
 * cells into the report.
 */

import type { Findings } from "./findings.js";
import type { CheckResult, Verdict } from "./policy.js";

/** Escape text for a Markdown table cell or list item. */
export function md(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;")
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_[\]()#!~])/g, "\\$1")
    // GitHub turns bare web addresses into links; break the patterns it looks for.
    .replace(/:\/\//g, "\\://")
    .replace(/\b(www)\./gi, "$1\\.");
}

const STATE: Record<CheckResult["state"], string> = {
  passed: "✅ Passed",
  failed: "❌ Failed",
  unmeasured: "⚠️ Not measured",
  "not-applicable": "➖ Skipped",
};

export const DISCLAIMER =
  "_Automated technical checks of what this page loads and sends. Not legal advice, and not a compliance certification._";

function headline(verdict: Verdict): string {
  const failed = verdict.checks.filter((c) => c.state === "failed").length;
  if (verdict.outcome === "failed") {
    return `❌ ${failed} ${failed === 1 ? "check" : "checks"} failed`;
  }
  if (verdict.outcome === "unmeasured") return "⚠️ Couldn't measure this deploy";
  return "✅ No blocking issues found";
}

export function renderSummary(args: {
  verdict: Verdict;
  deploy: string;
  baseline: string | null;
  /** How the baseline was built, e.g. "learned from 12 saved scans…". */
  baselineNote?: string | null;
  current: Findings;
}): string {
  const { verdict, deploy, baseline, baselineNote, current } = args;
  const lines: string[] = [`## PrivacyFixed check: ${headline(verdict)}`, ""];
  lines.push(`**Deploy checked:** ${md(deploy)}  `);
  if (baseline) {
    const how = baselineNote ? ` (${md(baselineNote)})` : "";
    lines.push(`**Compared with:** ${md(baseline)}${how}  `);
  }
  if (current.measured && current.score !== null) {
    const label = current.label ? ` (${md(current.label)})` : "";
    lines.push(`**Privacy score:** ${current.score.toFixed(1)} / 10${label}  `);
  }
  if (verdict.confirmed) {
    lines.push(
      baseline
        ? "**Confirmed with a second scan:** a finding counts only if both scans of the deploy show it and neither scan of the baseline does."
        : "**Confirmed with a second scan:** a finding counts only if both scans of the deploy show it.",
    );
  }
  lines.push("");

  if (verdict.reasons.length && verdict.outcome === "unmeasured") {
    lines.push("**Why it couldn't be measured**", "");
    for (const r of verdict.reasons) lines.push(`- ${md(r)}`);
    lines.push("");
  }

  if (verdict.checks.length) {
    lines.push("| Check | Result | Details |", "| --- | --- | --- |");
    for (const c of verdict.checks) {
      lines.push(`| ${md(c.title)} | ${STATE[c.state]} | ${md(c.detail)} |`);
    }
    lines.push("");
  }

  for (const c of verdict.checks.filter((x) => x.state === "failed" && x.check !== "min-score")) {
    lines.push(`### ${md(c.title)}`, "");
    for (const item of c.items) lines.push(`- ${md(item)}`);
    lines.push("");
  }

  const varying = verdict.checks.filter((c) => c.varying?.length);
  if (varying.length) {
    lines.push(
      "### Seen in one scan only (not counted)",
      "",
      "These showed up in only one of the two scans, so they don't fail the check. Ad auctions often change which companies load from one visit to the next. If one keeps appearing here, look into it.",
      "",
    );
    for (const c of varying) lines.push(`- **${md(c.title)}:** ${(c.varying ?? []).map(md).join(", ")}`);
    lines.push("");
  }

  if (current.evidenceNote) lines.push(`> ${md(current.evidenceNote)}`, "");
  lines.push(DISCLAIMER);
  return lines.join("\n");
}
