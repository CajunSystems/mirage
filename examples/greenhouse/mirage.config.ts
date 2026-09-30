import { anthropic } from "@ai-sdk/anthropic";
import { defineConfig } from "@mirage/server";

export default defineConfig({
  // Without a key the app still runs: every page here has a committed page.spec.json.
  model: process.env.ANTHROPIC_API_KEY ? anthropic("claude-sonnet-5-5") : undefined,
  catalog: "./catalog.ts",
  appDir: "./app",
  context: (request) => ({ gardener: request.headers.get("x-gardener") ?? "anonymous" }),
});
