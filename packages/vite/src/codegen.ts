import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { parseIntent, type RouteInfo } from "@cajunsystems/mirage-server";
import type { ProjectPaths } from "./project.js";

const q = (s: string) => JSON.stringify(s);
const modeOf = (route: RouteInfo) => {
  if (!route.intentPath) return "locked";
  try {
    return parseIntent(readFileSync(route.intentPath, "utf8"), route.intentPath).frontmatter.mode;
  } catch {
    return "cached"; // the server reports frontmatter errors
  }
};

/**
 * `virtual:mirage/routes`: route table for the client. Layouts, committed specs and ejected pages
 * are dynamic imports, so the bundler splits them per route and the client fetches a route's
 * files when it is first visited. Shared layouts are one loader, so one chunk.
 */
export function routesModule(routes: RouteInfo[], paths: ProjectPaths): string {
  const loaders: string[] = [];
  const ids = new Map<string, string>();
  const ref = (file: string, prefix: string) => {
    if (!ids.has(file)) {
      const id = `${prefix}${ids.size}`;
      ids.set(file, id);
      loaders.push(`const ${id} = () => import(${q(file)});`);
    }
    return ids.get(file)!;
  };
  const entries = routes.map((r) => {
    const mode = modeOf(r);
    const fields = [`path: ${q(r.path)}`, `mode: ${q(mode)}`];
    if (r.pagePath) fields.push(`loadPage: ${ref(r.pagePath, "P")}`);
    // Live routes always generate, so their committed spec is not shipped to the client at all.
    else if (r.specPath && mode !== "live") fields.push(`loadSpec: ${ref(r.specPath, "S")}`);
    const layouts = r.layouts.map((l) => `{ id: ${q(relative(paths.root, l))}, load: ${ref(l, "L")} }`);
    fields.push(`layouts: [${layouts.join(", ")}]`);
    return `  { ${fields.join(", ")} },`;
  });
  return `${loaders.join("\n")}
export const routes = [
${entries.join("\n")}
];
if (import.meta.hot) {
  import.meta.hot.on("mirage:regenerate", (detail) => window.dispatchEvent(new CustomEvent("mirage:regenerate", { detail })));
}
`;
}

/** `virtual:mirage/server`: a self-contained production server factory. */
export function serverModule(routes: RouteInfo[], paths: ProjectPaths): string {
  const imports: string[] = [];
  const modules: string[] = [];
  const files: Record<string, string> = {};
  const toolFiles = [...new Set(routes.flatMap((r) => r.toolsPaths))];
  toolFiles.forEach((file, i) => {
    imports.push(`import * as T${i} from ${q(file)};`);
    modules.push(`  ${q(file)}: T${i},`);
  });
  for (const r of routes) {
    for (const f of [r.intentPath, r.specPath]) if (f) files[f] = readFileSync(f, "utf8");
  }
  return `import { createMirageServer } from "@cajunsystems/mirage-server";
${paths.configFile ? `import config from ${q(paths.configFile)};` : "const config = {};"}
import * as catalogModule from ${q(paths.catalogFile)};
${imports.join("\n")}
const modules = {
${modules.join("\n")}
};
const files = ${JSON.stringify(files)};
export const routes = ${JSON.stringify(routes)};
export function createServer(options = {}) {
  return createMirageServer({
    config,
    catalog: catalogModule[${q(paths.catalogExport)}],
    routes,
    loadModule: async (path) => modules[path] ?? {},
    readText: async (path) => files[path],
    cacheDir: options.cacheDir ?? ".mirage/specs",
    dev: false,
  });
}
`;
}
