import { resolve } from "node:path";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { mirage, type MiragePluginApi } from "@cajunsystems/mirage-vite";
import type { MirageServer } from "@cajunsystems/mirage-server";
import type { Catalog } from "@cajunsystems/mirage-core";
import type { ProjectPaths } from "@cajunsystems/mirage-vite";

export type Project = {
  vite: ViteDevServer;
  mirage: MirageServer;
  paths: ProjectPaths;
  catalog: Catalog;
  close(): Promise<void>;
};

/** Finds the mirage plugin in a Vite server, adding one when vite.config does not. */
export function miragePlugin(vite: ViteDevServer): Plugin & { api: MiragePluginApi } {
  const found = vite.config.plugins.find((p) => p.name === "mirage") as (Plugin & { api: MiragePluginApi }) | undefined;
  return found ?? mirage();
}

/** Opens the project through Vite (so TS/TSX config, catalog and tools load) without listening. */
export async function openProject(root: string): Promise<Project> {
  const vite = await createServer({
    root: resolve(root),
    logLevel: "error",
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    // Only server-side modules are loaded here. Without this, Vite starts scanning browser deps
    // and logs errors when the short-lived server closes mid-scan.
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { mirage: server, paths } = await miragePlugin(vite).api.server(vite);
  const catalog = (await vite.ssrLoadModule(paths.catalogFile))[paths.catalogExport] as Catalog;
  return { vite, mirage: server, paths, catalog, close: () => vite.close() };
}
