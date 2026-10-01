import { run } from "./main.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

run({
  env: process.env,
  write: (line) => process.stdout.write(`${line}\n`),
  fetch: globalThis.fetch,
  clock: { now: () => Date.now(), sleep },
}).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // run() handles its own errors; reaching here is a bug. Print nothing from the
    // error itself, which could hold request details.
    process.stdout.write("::error title=PrivacyFixed check crashed::An unexpected error stopped the check.\n");
    process.exitCode = 1;
  },
);
