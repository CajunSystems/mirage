import { relative } from "node:path";
import { getRequestListener } from "@hono/node-server";
import type { Plugin, ViteDevServer } from "vite";
import { createMirageServer, type MirageConfig, type MirageServer } from "@cajunsystems/mirage-server";
import type { Catalog } from "@cajunsystems/mirage-core";
import { routesModule, serverModule } from "./codegen.js";
import { findConfigFile, projectPaths, projectRoutes, type ProjectPaths } from "./project.js";

export type MiragePluginOptions = {
  /** Path to mirage.config.ts, relative to the Vite root. */
  config?: string;
};

export type MiragePluginApi = {
  /** Loads config, catalog and tools through Vite and returns a Mirage server. */
  server(vite: ViteDevServer): Promise<{ mirage: MirageServer; paths: ProjectPaths }>;
};

const ROUTES_ID = "virtual:mirage/routes";
const SERVER_ID = "virtual:mirage/server";
/** Entry of the production server bundle built by `mirage build`. */
export const SERVER_MAIN_ID = "virtual:mirage/server-main";
const SERVER_MAIN = `import { createServer } from "${SERVER_ID}";
import { startProductionServer } from "@cajunsystems/mirage-vite/node";
import { fileURLToPath } from "node:url";
startProductionServer({ mirage: createServer(), clientDir: fileURLToPath(new URL("../client", import.meta.url)) });
`;
const WATCHED = /(^|[\\/])(page\.intent\.md|page\.spec\.json|page\.tsx|page\.jsx|layout\.tsx|layout\.jsx|tools\.ts|tools\.js)$/;

export function mirage(options: MiragePluginOptions = {}): Plugin & { api: MiragePluginApi } {
  let root = process.cwd();
  let paths: ProjectPaths | undefined;
  let cached: { config: MirageConfig; catalog: Catalog; mirage: MirageServer } | undefined;

  const loadPaths = async (load: (file: string) => Promise<Record<string, unknown>>) => {
    const configFile = findConfigFile(root, options.config);
    const config = (configFile ? (await load(configFile)).default : {}) as MirageConfig;
    paths = projectPaths(root, config, configFile);
    return config;
  };

  const api: MiragePluginApi = {
    async server(vite) {
      root = vite.config.root;
      const load = (file: string) => vite.ssrLoadModule(file) as Promise<Record<string, unknown>>;
      const config = await loadPaths(load);
      const p = paths!;
      const catalog = (await load(p.catalogFile))[p.catalogExport] as Catalog | undefined;
      if (!catalog) throw new Error(`${relative(root, p.catalogFile)} does not export "${p.catalogExport}"`);
      // Reuse the server (and its live-mode memory cache) while config and catalog are unchanged.
      if (!cached || cached.config !== config || cached.catalog !== catalog) {
        const mirage = createMirageServer({
          config,
          catalog,
          routes: () => projectRoutes(p),
          loadModule: load,
          cacheDir: p.cacheDir,
          dev: true,
        });
        cached = { config, catalog, mirage };
      }
      return { mirage: cached.mirage, paths: p };
    },
  };

  return {
    name: "mirage",
    api,
    configResolved(config) {
      root = config.root;
    },
    resolveId(id) {
      if (id === ROUTES_ID || id === SERVER_ID || id === SERVER_MAIN_ID) return "\0" + id;
    },
    async load(id) {
      if (id === "\0" + SERVER_MAIN_ID) return SERVER_MAIN;
      if (id !== "\0" + ROUTES_ID && id !== "\0" + SERVER_ID) return;
      if (!paths) {
        // Build mode: no dev server, read the config file through Vite's own loader.
        const { loadConfigFromFile } = await import("vite");
        const configFile = findConfigFile(root, options.config);
        const loaded = configFile ? await loadConfigFromFile({ command: "build", mode: "production" }, configFile, root) : null;
        paths = projectPaths(root, (loaded?.config ?? {}) as MirageConfig, configFile);
      }
      const routes = projectRoutes(paths);
      for (const r of routes) if (r.intentPath) this.addWatchFile(r.intentPath);
      return id === "\0" + ROUTES_ID ? routesModule(routes, paths) : serverModule(routes, paths);
    },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/__mirage/")) return next();
        try {
          const { mirage } = await api.server(vite);
          await getRequestListener(mirage.app.fetch)(req, res);
        } catch (error) {
          vite.ssrFixStacktrace(error as Error);
          next(error);
        }
      });

      const invalidateRoutes = () => {
        const mod = vite.moduleGraph.getModuleById("\0" + ROUTES_ID);
        if (mod) vite.moduleGraph.invalidateModule(mod);
      };
      const onStructure = (file: string) => {
        if (!WATCHED.test(file)) return;
        invalidateRoutes();
        vite.ws.send({ type: "full-reload" });
      };
      vite.watcher.on("add", onStructure);
      vite.watcher.on("unlink", onStructure);
      vite.watcher.on("change", async (file) => {
        if (!file.endsWith("page.intent.md") || !paths) return;
        // The intent is part of the cache key, so the next request regenerates.
        invalidateRoutes();
        const route = projectRoutes(paths).find((r) => r.intentPath === file);
        if (route) vite.ws.send({ type: "custom", event: "mirage:regenerate", data: { route: route.path } });
      });
    },
    handleHotUpdate(ctx) {
      // Intent edits are handled by the regenerate event; don't reload the page for them.
      if (ctx.file.endsWith("page.intent.md")) return [];
    },
  };
}

export default mirage;
export { projectPaths, projectRoutes, findConfigFile, type ProjectPaths } from "./project.js";
export { routesModule, serverModule } from "./codegen.js";
