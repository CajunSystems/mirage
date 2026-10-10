import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type RouteInfo = {
  /** React Router style path, e.g. "/plants/:id". */
  path: string;
  dir: string;
  intentPath?: string;
  specPath?: string;
  /** An ejected `page.tsx`. */
  pagePath?: string;
  /** `layout.tsx` files from the root down. */
  layouts: string[];
  /** `tools.ts` files from the root down (nearest last, so it wins). */
  toolsPaths: string[];
  paramNames: string[];
};

const firstExisting = (dir: string, names: string[]) => names.map((n) => join(dir, n)).find((p) => existsSync(p));

export const INTENT_FILE = "page.intent.md";
export const SPEC_FILE = "page.spec.json";

/** Scans `appDir` for routes. `globalTools` is an optional project-level tools file. */
export function scanRoutes(appDir: string, globalTools?: string): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const visit = (dir: string, layouts: string[], tools: string[]) => {
    const layout = firstExisting(dir, ["layout.tsx", "layout.jsx"]);
    const toolsFile = firstExisting(dir, ["tools.ts", "tools.js"]);
    const nextLayouts = layout ? [...layouts, layout] : layouts;
    const nextTools = toolsFile ? [...tools, toolsFile] : tools;
    const intentPath = firstExisting(dir, [INTENT_FILE]);
    const pagePath = firstExisting(dir, ["page.tsx", "page.jsx"]);
    if (intentPath || pagePath) {
      const segments = relative(appDir, dir).split(sep).filter(Boolean);
      routes.push({
        path: "/" + segments.map((s) => s.replace(/^\[(.+)\]$/, ":$1")).join("/"),
        dir,
        intentPath,
        pagePath,
        specPath: firstExisting(dir, [SPEC_FILE]),
        layouts: nextLayouts,
        toolsPaths: nextTools,
        paramNames: segments.filter((s) => /^\[.+\]$/.test(s)).map((s) => s.slice(1, -1)),
      });
    }
    for (const name of readdirSync(dir).sort()) {
      const child = join(dir, name);
      if (!name.startsWith(".") && name !== "node_modules" && statSync(child).isDirectory()) visit(child, nextLayouts, nextTools);
    }
  };
  visit(appDir, [], globalTools && existsSync(globalTools) ? [globalTools] : []);
  return routes;
}

/** Finds the route whose path pattern equals `path`, or that matches a concrete URL path. */
export function findRoute(routes: RouteInfo[], path: string): RouteInfo | undefined {
  const exact = routes.find((r) => r.path === path);
  if (exact) return exact;
  const parts = path.split("/").filter(Boolean);
  return routes.find((r) => {
    const pattern = r.path.split("/").filter(Boolean);
    return pattern.length === parts.length && pattern.every((p, i) => p.startsWith(":") || p === parts[i]);
  });
}
