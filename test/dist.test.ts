/**
 * The shipped file, run the way the runner runs it: `node dist/index.cjs` with
 * inputs as `INPUT_*` environment variables (GitHub upper-cases the name and keeps
 * its hyphens), against a real HTTP server on loopback.
 *
 * This is the test that the bundle works, as opposed to the sources: a stale or
 * broken dist would pass every other test in this folder.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KEY, completedJob } from "./fixtures.js";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.cjs");

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  agent: string | undefined;
}

const seen: Seen[] = [];
let origin = "";
const server = createHttpServer((req: IncomingMessage, res) => {
  seen.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, agent: req.headers["user-agent"] });
  res.setHeader("Content-Type", "application/json");
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    res.statusCode = 401;
    res.end(JSON.stringify({ detail: { code: "api_key_invalid", message: "Invalid API key." } }));
    return;
  }
  if (req.method === "POST") {
    res.statusCode = 202;
    res.end(JSON.stringify({ job_id: "job-1", status: "pending", poll_url: "/v1/public/scans/job-1" }));
    return;
  }
  res.end(JSON.stringify(completedJob("job-1", { before: ["Hotjar"], landed: "https://preview.example.com/" })));
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function runDist(inputs: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "pf-dist-"));
  const out = join(dir, "out");
  const sum = join(dir, "sum");
  writeFileSync(out, "");
  writeFileSync(sum, "");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    GITHUB_OUTPUT: out,
    GITHUB_STEP_SUMMARY: sum,
  };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  return new Promise<{ code: number | null; stdout: string; stderr: string; out: string; sum: string }>((resolve) => {
    const child = spawn(process.execPath, [DIST], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) =>
      resolve({ code, stdout, stderr, out: readFileSync(out, "utf8"), sum: readFileSync(sum, "utf8") }),
    );
  });
}

describe("dist/index.cjs", () => {
  it("scans, fails on a tracker before consent, and reports it", async () => {
    seen.length = 0;
    const r = await runDist({ "api-key": KEY, url: "https://preview.example.com", "api-url": origin });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("");
    expect(r.out).toMatch(/^status<<ghadelimiter_[\w-]+\nfailed\n/m);
    expect(r.sum).toContain("- Hotjar");
    // A failing first result is confirmed with a second scan before it fails the run.
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /v1/public/scans",
      "GET /v1/public/scans/job-1",
      "POST /v1/public/scans",
      "GET /v1/public/scans/job-1",
    ]);
    expect(r.sum).toContain("Confirmed with a second scan");
    expect(seen.every((s) => s.agent?.startsWith("privacyfixed-github-action/"))).toBe(true);
    // The key appears once, in the mask command, and nowhere else.
    expect([r.stdout, r.stderr, r.out, r.sum].join("\n").split(KEY)).toHaveLength(2);
    expect(r.stdout.split("\n")[0]).toBe(`::add-mask::${KEY}`);
  }, 30_000);

  it("a refused key exits 1 with the fix and without the key", async () => {
    const wrong = "pfk_live_WRONGKEY_9999999999999999";
    const r = await runDist({ "api-key": wrong, url: "https://preview.example.com", "api-url": origin });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/refused the API key/);
    expect([r.stdout, r.stderr, r.out, r.sum].join("\n").split(wrong)).toHaveLength(2);
  }, 30_000);

  it("a non-PrivacyFixed api-url sends nothing", async () => {
    const trap = createServer();
    await new Promise<void>((resolve) => trap.listen(0, "0.0.0.0", resolve));
    let connections = 0;
    trap.on("connection", (s) => {
      connections += 1;
      s.destroy();
    });
    const port = (trap.address() as AddressInfo).port;
    const r = await runDist({ "api-key": KEY, url: "https://preview.example.com", "api-url": `https://localtest.me:${port}` });
    trap.close();
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/only ever sent to PrivacyFixed/);
    expect(connections).toBe(0);
  }, 30_000);
});
