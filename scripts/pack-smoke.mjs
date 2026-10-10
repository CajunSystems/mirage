// M8 acceptance check: packs every package, installs the tarballs into a fresh project outside the
// monorepo (a copy of examples/greenhouse), then typechecks, builds and runs it with no model.
// Usage: node scripts/pack-smoke.mjs [--keep]
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "mirage-pack-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ANTHROPIC_API_KEY: "" } });
const step = (msg) => console.log(`\n[pack-smoke] ${msg}`);

try {
  step("building and packing");
  run("pnpm", ["build"], repo);
  const tarballs = join(work, "tarballs");
  const packages = {};
  for (const dir of readdirSync(join(repo, "packages"))) {
    const pkgDir = join(repo, "packages", dir);
    const { name } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    run("pnpm", ["pack", "--pack-destination", tarballs], pkgDir);
    const file = readdirSync(tarballs).find((f) => f.startsWith(name.replace("@", "").replace("/", "-") + "-"));
    packages[name] = `file:${join(tarballs, file)}`;
  }
  console.log(packages);

  step("creating an app outside the monorepo");
  const app = join(work, "app");
  const skip = new Set(["node_modules", "dist", ".mirage", ".e2e", ".env"]);
  cpSync(join(repo, "examples/greenhouse"), app, { recursive: true, filter: (src) => !skip.has(basename(src)) });
  const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  for (const deps of [manifest.dependencies, manifest.devDependencies]) {
    for (const name of Object.keys(deps)) if (packages[name]) deps[name] = packages[name];
  }
  // Tarballs depend on each other by version (pnpm rewrites workspace:*); point those at the tarballs too.
  writeFileSync(join(app, "package.json"), JSON.stringify(manifest, null, 2));
  // A workspace file of its own keeps pnpm from finding the monorepo; overrides live there in pnpm 10.
  const overrides = Object.entries(packages).map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`);
  writeFileSync(join(app, "pnpm-workspace.yaml"), `packages: []\nallowBuilds:\n  esbuild: true\noverrides:\n${overrides.join("\n")}\n`);
  run("pnpm", ["install"], app);

  step("typechecking against the published types");
  run("pnpm", ["exec", "tsc", "--noEmit"], app);

  step("building with the published CLI");
  run("pnpm", ["exec", "mirage", "build"], app);

  step("starting the production server with no model");
  const port = 4199;
  const server = spawn("node", ["dist/server/index.js"], { cwd: app, env: { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: "" }, stdio: "inherit" });
  try {
    const base = `http://localhost:${port}`;
    for (let i = 0; ; i++) {
      try {
        await fetch(base);
        break;
      } catch {
        if (i > 50) throw new Error("server did not start");
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const post = (path, body) =>
      fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const html = await (await fetch(`${base}/plants`)).text();
    if (!html.includes('id="root"')) throw new Error("index.html not served for /plants");
    const events = (await (await post("/__mirage/generate", { route: "/plants", params: {} })).text()).trim().split("\n").map((l) => JSON.parse(l));
    const last = events.at(-1);
    if (last.type !== "spec" || last.source !== "locked") throw new Error(`expected a locked spec, got ${JSON.stringify(last)}`);
    const tool = await (await post("/__mirage/tools/listPlants", { route: "/plants", params: {}, args: {} })).json();
    if (!Array.isArray(tool.result) || !tool.result.length) throw new Error(`listPlants failed: ${JSON.stringify(tool)}`);
    step(`ok: served /plants, a locked spec with ${Object.keys(last.spec.elements).length} elements, and ${tool.result.length} plants from a tool`);
  } finally {
    server.kill();
  }
} finally {
  if (process.argv.includes("--keep")) console.log(`[pack-smoke] kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
