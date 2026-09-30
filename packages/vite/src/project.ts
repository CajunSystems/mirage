import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { configDefaults, scanRoutes, type MirageConfig, type RouteInfo } from "@mirage/server";

export type ProjectPaths = {
  root: string;
  configFile?: string;
  appDir: string;
  catalogFile: string;
  catalogExport: string;
  toolsFile: string;
  cacheDir: string;
};

export const CONFIG_FILES = ["mirage.config.ts", "mirage.config.js", "mirage.config.mjs"];

export function findConfigFile(root: string, explicit?: string): string | undefined {
  if (explicit) return resolve(root, explicit);
  return CONFIG_FILES.map((f) => resolve(root, f)).find((f) => existsSync(f));
}

export function projectPaths(root: string, config: MirageConfig, configFile?: string): ProjectPaths {
  return {
    root,
    configFile,
    appDir: resolve(root, config.appDir ?? configDefaults.appDir),
    catalogFile: resolve(root, config.catalog ?? configDefaults.catalog),
    catalogExport: config.catalogExport ?? configDefaults.catalogExport,
    toolsFile: resolve(root, config.tools ?? configDefaults.tools),
    cacheDir: resolve(root, config.cacheDir ?? configDefaults.cacheDir),
  };
}

export function projectRoutes(paths: ProjectPaths): RouteInfo[] {
  return existsSync(paths.appDir) ? scanRoutes(paths.appDir, paths.toolsFile) : [];
}
