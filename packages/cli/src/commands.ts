import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createPatch } from "diff";
import { build, createServer } from "vite";
import {
  SPEC_FILE,
  INTENT_FILE,
  emptyRecording,
  parseIntent,
  recordingModel,
  type RecordedCall,
  type Recording,
  type RouteInfo,
} from "@mirage/server";
import { SERVER_MAIN_ID } from "@mirage/vite";
import type { GenerateEvent, Spec } from "@mirage/core";
import { ejectSpec } from "./eject.js";
import { openProject, type Project } from "./project.js";
import { writeTemplate } from "./template.js";

const specJson = (spec: Spec) => JSON.stringify(spec, null, 2) + "\n";

function pickRoutes(project: Project, route: string | undefined, all: boolean): RouteInfo[] {
  const routes = project.mirage.routes().filter((r) => r.intentPath);
  if (all) return routes;
  if (!route) throw new Error("Pass a route (e.g. /plants) or --all");
  return [project.mirage.route(route)];
}

/** Streams generation progress to stderr. */
function progress(route: string) {
  let chars = 0;
  return (e: GenerateEvent) => {
    if (e.type === "delta") {
      chars += e.text.length;
      if (process.stderr.isTTY) process.stderr.write(`\r  ${route}: generating… ${chars} chars`);
    } else if (e.type === "retry") {
      process.stderr.write(`\n  ${route}: repairing (attempt ${e.attempt}): ${e.errors.map((x) => `${x.path} ${x.message}`).join("; ")}\n`);
    } else if (chars && process.stderr.isTTY) {
      process.stderr.write("\n");
      chars = 0;
    }
  };
}

async function withProject<T>(root: string, fn: (p: Project) => Promise<T>): Promise<T> {
  const project = await openProject(root);
  try {
    return await fn(project);
  } finally {
    await project.close();
  }
}

export async function dev(root: string, options: { port?: number; host?: string | boolean }) {
  const vite = await createServer({ root: resolve(root), server: { port: options.port, host: options.host } });
  if (!vite.config.plugins.some((p) => p.name === "mirage")) {
    await vite.close();
    throw new Error("vite.config.ts must include the mirage() plugin from @mirage/vite");
  }
  await vite.listen();
  vite.printUrls();
}

export async function buildApp(root: string) {
  root = resolve(root);
  const outDir = join(root, "dist");
  // Committed specs are inlined into the client and served without the server's checks, so a
  // hand-edited or stale page.spec.json must fail the build instead of shipping.
  await withProject(root, async (project) => {
    const problems: string[] = [];
    for (const info of project.mirage.routes().filter((r) => r.specPath && r.intentPath && !r.pagePath)) {
      if (parseIntent(readFileSync(info.intentPath!, "utf8")).frontmatter.mode === "live") continue;
      const errors: string[] = [];
      const result = await project.mirage.resolveSpec(info.path, {}, (e) => {
        if (e.type === "error") errors.push(e.message, ...(e.errors ?? []).map((x) => `  ${x.path}: ${x.message}`));
      });
      if (!result.ok || result.source !== "locked") problems.push(...(errors.length ? errors : [`${info.path}: could not load page.spec.json`]));
    }
    if (problems.length) throw new Error(`invalid committed specs:\n${problems.join("\n")}`);
  });
  await build({ root, build: { outDir: join(outDir, "client"), emptyOutDir: true } });
  await build({
    root,
    // Only app code is bundled; packages (including linked @mirage/*) resolve from node_modules.
    ssr: { external: true },
    build: {
      ssr: true,
      outDir: join(outDir, "server"),
      emptyOutDir: true,
      rollupOptions: { input: SERVER_MAIN_ID, output: { entryFileNames: "index.js" } },
    },
  });
  // Report which routes will need a model at runtime.
  await withProject(root, async (project) => {
    const needsModel = project.mirage
      .routes()
      .filter((r) => r.intentPath && !r.pagePath)
      .filter((r) => !r.specPath || parseIntent(readFileSync(r.intentPath!, "utf8")).frontmatter.mode === "live");
    if (needsModel.length) console.log(`[mirage] routes that generate at runtime (need a model): ${needsModel.map((r) => r.path).join(", ")}`);
    else console.log("[mirage] every route is locked: the server needs no model");
  });
  console.log(`[mirage] built ${relative(process.cwd(), outDir) || "."}; run: node ${relative(process.cwd(), join(outDir, "server/index.js"))}`);
}

export async function lock(root: string, route: string | undefined, options: { all?: boolean }) {
  await withProject(root, async (project) => {
    for (const info of pickRoutes(project, route, Boolean(options.all))) {
      const target = join(info.dir, SPEC_FILE);
      const result = await project.mirage.resolveSpec(info.path, {}, progress(info.path), { allowLocked: true });
      if (!result.ok) throw new Error(`${info.path}: ${result.message}`);
      if (result.source === "locked") {
        console.log(`${info.path}: already locked (${relative(root, target)})`);
        continue;
      }
      await writeFile(target, specJson(result.spec));
      console.log(`${info.path}: locked ${result.source} spec -> ${relative(root, target)}`);
    }
  });
}

export async function unlock(root: string, route: string) {
  await withProject(root, async (project) => {
    const info = project.mirage.route(route);
    const target = join(info.dir, SPEC_FILE);
    if (!existsSync(target)) return console.log(`${info.path}: not locked`);
    await rm(target);
    console.log(`${info.path}: removed ${relative(root, target)}`);
  });
}

export async function regen(root: string, route: string, options: { write?: boolean }) {
  await withProject(root, async (project) => {
    const info = project.mirage.route(route);
    const result = await project.mirage.resolveSpec(info.path, {}, progress(info.path), { force: true });
    if (!result.ok) throw new Error(`${info.path}: ${result.message}`);
    const target = join(info.dir, SPEC_FILE);
    const before = existsSync(target) ? await readFile(target, "utf8") : "";
    const after = specJson(result.spec);
    console.log(before === after ? "No changes." : createPatch(relative(root, target), before, after, "current", "regenerated"));
    if (options.write) {
      await writeFile(target, after);
      console.log(`${info.path}: wrote ${relative(root, target)}`);
    }
  });
}

export async function eject(root: string, route: string, options: { keepIntent?: boolean }) {
  await withProject(root, async (project) => {
    const info = project.mirage.route(route);
    if (info.pagePath) throw new Error(`${info.path} is already ejected (${relative(root, info.pagePath)})`);
    const result = await project.mirage.resolveSpec(info.path, {}, progress(info.path), { allowLocked: true });
    if (!result.ok) throw new Error(`${info.path}: ${result.message}`);
    let catalogImport = relative(info.dir, project.paths.catalogFile).replace(/\\/g, "/").replace(/\.tsx?$/, "");
    if (!catalogImport.startsWith(".")) catalogImport = `./${catalogImport}`;
    const source = ejectSpec(result.spec, {
      catalog: project.catalog,
      route: info.path,
      catalogImport,
      catalogExport: project.paths.catalogExport,
    });
    const target = join(info.dir, "page.tsx");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
    console.log(`${info.path}: wrote ${relative(root, target)}`);
    if (!options.keepIntent) {
      for (const file of [INTENT_FILE, SPEC_FILE]) {
        const path = join(info.dir, file);
        if (existsSync(path)) {
          await rm(path);
          console.log(`${info.path}: removed ${relative(root, path)}`);
        }
      }
    }
  });
}

type EvalRun = {
  route: string;
  outcome: "first-try" | "repaired" | "failed" | "error";
  attempts: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  errors: { path: string; message: string }[];
  message?: string;
};

/** Generates each route `runs` times against the configured model and reports how reliably it produces valid specs. */
export async function evaluate(
  root: string,
  route: string | undefined,
  options: { all?: boolean; runs?: number; record?: string; report?: string },
) {
  const runs = Number(options.runs ?? 3);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  const recordPath = options.record ? resolve(options.record) : undefined;
  const recording: Recording = recordPath && existsSync(recordPath) ? (JSON.parse(await readFile(recordPath, "utf8")) as Recording) : emptyRecording();
  const results: EvalRun[] = [];
  const refreshed = new Set<string>();

  await withProject(root, async (project) => {
    const routes = pickRoutes(project, route, !route || Boolean(options.all)).filter((r) => !r.pagePath);
    for (const info of routes) {
      for (let i = 1; i <= runs; i++) {
        const calls: RecordedCall[] = [];
        const run: EvalRun = { route: info.path, outcome: "error", attempts: 1, ms: 0, inputTokens: 0, outputTokens: 0, errors: [] };
        const started = Date.now();
        const result = await project.mirage.resolveSpec(
          info.path,
          {},
          (e) => {
            if (e.type === "retry") {
              run.attempts = e.attempt;
              run.errors.push(...e.errors);
            } else if (e.type === "error") {
              run.message = e.message;
              run.errors.push(...(e.errors ?? []));
            }
          },
          { force: true, writeCache: false, wrapModel: (model) => recordingModel(model, (call) => calls.push(call)) },
        );
        run.ms = Date.now() - started;
        run.inputTokens = calls.reduce((n, c) => n + (c.usage.inputTokens ?? 0), 0);
        run.outputTokens = calls.reduce((n, c) => n + (c.usage.outputTokens ?? 0), 0);
        if (result.ok) run.outcome = run.attempts === 1 ? "first-try" : "repaired";
        else if (result.status === 422) run.outcome = "failed";
        else if (result.status === 503) throw new Error(result.message);
        results.push(run);
        // Only successful runs are recorded, so replaying never reproduces a failed generation.
        if (result.ok) {
          // The first success for a route replaces that route's old responses, so keys from
          // earlier prompts do not pile up. Routes with no success this time keep theirs.
          if (!refreshed.has(info.path)) {
            for (const [key, entry] of Object.entries(recording.responses)) if (entry.route === info.path) delete recording.responses[key];
            refreshed.add(info.path);
          }
          for (const call of calls) recording.responses[call.key] = { route: info.path, text: call.text };
        }
        console.log(`${info.path} run ${i}/${runs}: ${run.outcome}${run.attempts > 1 ? ` (${run.attempts} attempts)` : ""}, ${(run.ms / 1000).toFixed(1)}s${run.message && run.outcome === "error" ? `: ${run.message}` : ""}`);
      }
    }
  });

  console.log("\n" + evalTable(results));
  const common = new Map<string, number>();
  for (const r of results) for (const e of r.errors) common.set(`${r.route} ${e.path}: ${e.message}`, (common.get(`${r.route} ${e.path}: ${e.message}`) ?? 0) + 1);
  if (common.size) {
    console.log("\nValidation errors seen (count):");
    for (const [msg, n] of [...common].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${n}x ${msg}`);
  }
  if (recordPath) {
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(recordPath, JSON.stringify(recording, null, 2) + "\n");
    console.log(`\nRecorded ${Object.keys(recording.responses).length} response(s) -> ${relative(process.cwd(), recordPath)}`);
  }
  if (options.report) {
    await writeFile(resolve(options.report), JSON.stringify({ runs: results }, null, 2) + "\n");
    console.log(`Report -> ${options.report}`);
  }
  // Non-zero when any run ended without a valid spec, so `mirage eval` can gate CI or scripts.
  if (results.some((r) => r.outcome === "error" || r.outcome === "failed")) process.exitCode = 1;
  return results;
}

/** Plain-text summary table, one row per route plus a total. */
export function evalTable(results: EvalRun[]): string {
  const groups = new Map<string, EvalRun[]>();
  for (const r of results) groups.set(r.route, [...(groups.get(r.route) ?? []), r]);
  if (groups.size > 1) groups.set("total", results);
  const header = ["route", "runs", "first-try", "repaired", "failed", "errors", "avg attempts", "avg out tokens", "avg secs"];
  const rows = [...groups].map(([name, rs]) => {
    const count = (o: EvalRun["outcome"]) => rs.filter((r) => r.outcome === o).length;
    const avg = (f: (r: EvalRun) => number, digits: number) => (rs.reduce((n, r) => n + f(r), 0) / rs.length).toFixed(digits);
    return [name, String(rs.length), String(count("first-try")), String(count("repaired")), String(count("failed")), String(count("error")), avg((r) => r.attempts, 2), avg((r) => r.outputTokens, 0), avg((r) => r.ms / 1000, 1)];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

export async function init(dir: string) {
  const target = resolve(dir);
  await writeTemplate(target);
  console.log(`Created a Mirage app in ${relative(process.cwd(), target) || "."}.\nNext: pnpm install && pnpm dev`);
}
