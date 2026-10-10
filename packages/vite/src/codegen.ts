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

/** `virtual:mirage/routes`: route table for the client. */
export function routesModule(routes: RouteInfo[], paths: ProjectPaths): string {
  const imports: string[] = [];
  const ids = new Map<string, string>();
  const ref = (file: string, prefix: string) => {
    if (!ids.has(file)) {
      const id = `${prefix}${ids.size}`;
      ids.set(file, id);
      imports.push(`import ${id} from ${q(file)};`);
    }
    return ids.get(file)!;
  };
  const entries = routes.map((r) => {
    const layouts = r.layouts.map((l) => `{ id: ${q(relative(paths.root, l))}, component: ${ref(l, "L")} }`);
    return `  { path: ${q(r.path)}, mode: ${q(modeOf(r))}, spec: ${r.specPath ? ref(r.specPath, "S") : "undefined"}, page: ${
      r.pagePath ? ref(r.pagePath, "P") : "undefined"
    }, layouts: [${layouts.join(", ")}] },`;
  });
  return `${imports.join("\n")}
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
