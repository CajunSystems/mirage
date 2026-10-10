import type { LanguageModel } from "ai";

export type MirageConfig = {
  /** Any AI SDK language model. Optional for fully locked apps. */
  model?: LanguageModel;
  /** Module exporting the catalog. Default "./catalog.ts". */
  catalog?: string;
  /** Export name of the catalog in that module. Default "catalog". */
  catalogExport?: string;
  /** Default "./app". */
  appDir?: string;
  /** Project-level tools visible to every route. Default "./tools.ts" (if it exists). */
  tools?: string;
  /** Generation cache directory. Default "./.mirage/specs". */
  cacheDir?: string;
  /** Builds extra tool context (auth, user) from the real request. */
  context?: (request: Request) => Record<string, unknown> | Promise<Record<string, unknown>>;
};

export function defineConfig(config: MirageConfig): MirageConfig {
  return config;
}

export const configDefaults = {
  catalog: "./catalog.ts",
  catalogExport: "catalog",
  appDir: "./app",
  tools: "./tools.ts",
  cacheDir: "./.mirage/specs",
} as const;
