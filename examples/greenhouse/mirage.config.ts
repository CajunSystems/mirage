import { anthropic } from "@ai-sdk/anthropic";
import { existsSync } from "node:fs";
import { defineConfig } from "@cajunsystems/mirage-server";

// Local secrets (gitignored). Variables already set in the environment win.
const envFile = new URL("./.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  // Without a key the app still runs: every page here has a committed page.spec.json.
  model: process.env.ANTHROPIC_API_KEY ? anthropic("claude-sonnet-5-5") : undefined,
  catalog: "./catalog.ts",
  appDir: "./app",
  context: (request) => ({ gardener: request.headers.get("x-gardener") ?? "anonymous" }),
});
