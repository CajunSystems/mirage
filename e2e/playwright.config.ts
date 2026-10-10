import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const recorded = existsSync(new URL("./fixtures/greenhouse.recording.json", import.meta.url));
const cli = "node packages/cli/dist/bin.js";

// Two runs of the same suite:
// - locked: the production build of examples/greenhouse with its committed specs (no model).
// - replay: a copy without committed specs, generating every page from recorded model responses.
//   Skipped until e2e/fixtures/greenhouse.recording.json exists (`pnpm eval:record`).
export default defineConfig({
  testDir: ".",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
  projects: [
    { name: "locked", use: { baseURL: "http://localhost:4173" } },
    ...(recorded ? [{ name: "replay", use: { baseURL: "http://localhost:4174" } }] : []),
  ],
  webServer: [
    {
      command: `${cli} build --root examples/greenhouse && PORT=4173 node examples/greenhouse/dist/server/index.js`,
      cwd: "..",
      url: "http://localhost:4173",
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
    ...(recorded
      ? [
          {
            command: `node e2e/prepare-replay.mjs && ${cli} dev --root examples/greenhouse/.e2e/replay --port 4174`,
            cwd: "..",
            url: "http://localhost:4174",
            timeout: 120_000,
            reuseExistingServer: !process.env.CI,
          },
        ]
      : []),
  ],
});
