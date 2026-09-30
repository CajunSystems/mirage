import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createPatch } from "diff";
import { build, createServer } from "vite";
import { SPEC_FILE, INTENT_FILE, parseIntent, type RouteInfo } from "@mirage/server";
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
      const result = await project.mirage.resolveSpec(info.path, {}, progress(info.path));
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
    const result = await project.mirage.resolveSpec(info.path, {}, progress(info.path));
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

export async function init(dir: string) {
  const target = resolve(dir);
  await writeTemplate(target);
  console.log(`Created a Mirage app in ${relative(process.cwd(), target) || "."}.\nNext: pnpm install && pnpm dev`);
}
