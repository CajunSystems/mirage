// Prepares a copy of examples/greenhouse with no committed specs, whose model replays the recording
// in e2e/fixtures. Pages then go through real generation (streaming, validation, caching) on first visit.
// The copy lives inside the example so its imports resolve from the example's node_modules.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const example = join(here, "../examples/greenhouse");
const target = join(example, ".e2e/replay");
const recording = join(here, "fixtures/greenhouse.recording.json");
if (!existsSync(recording)) throw new Error(`Missing ${recording}. Record it with: pnpm eval:record`);

rmSync(target, { recursive: true, force: true });
const skip = new Set(["node_modules", "dist", ".mirage", ".e2e", ".env", "page.spec.json"]);
mkdirSync(target, { recursive: true });
// Entry by entry: cpSync refuses to copy a directory into its own subdirectory, even with a filter.
for (const entry of readdirSync(example)) {
  if (!skip.has(entry)) cpSync(join(example, entry), join(target, entry), { recursive: true, filter: (src) => !skip.has(basename(src)) });
}
cpSync(join(example, "mirage.config.ts"), join(target, "mirage.config.base.ts"));
writeFileSync(
  join(target, "mirage.config.ts"),
  `import { readFileSync } from "node:fs";
import { defineConfig, replayModel } from "@mirage/server";
import base from "./mirage.config.base";

const recording = JSON.parse(readFileSync(${JSON.stringify(recording)}, "utf8"));
export default defineConfig({ ...base, model: replayModel(recording, { delayMs: 5 }) });
`,
);
console.log(`[e2e] prepared ${target}`);
