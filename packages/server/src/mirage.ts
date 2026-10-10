import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { LanguageModel } from "ai";
import {
  toolSignature,
  toolsFromModule,
  type Catalog,
  type GenerateEvent,
  type Spec,
  type Tool,
  type ToolSignature,
} from "@mirage/core";
import { cacheKey, catalogHash, MemoryCache, SpecCache, toolsHash } from "./cache.js";
import type { MirageConfig } from "./config.js";
import { generateSpec } from "./generate.js";
import { parseIntent, type Intent } from "./intent.js";
import { findRoute, type RouteInfo } from "./routes.js";

export type MirageServerOptions = {
  config: MirageConfig;
  catalog: Catalog;
  /** Routes, or a function returning them (dev rescans on every request). */
  routes: RouteInfo[] | (() => RouteInfo[]);
  /** Loads a tools module (Vite's ssrLoadModule in dev, a static map in production). */
  loadModule: (path: string) => Promise<Record<string, unknown>>;
  /** Reads intent and spec files. Defaults to the file system. */
  readText?: (path: string) => Promise<string | undefined>;
  cacheDir: string;
  /** Dev mode: tool output validation throws instead of logging. */
  dev: boolean;
  log?: (message: string) => void;
};

export type ResolveOptions = {
  /** Skip page.spec.json and caches, always call the model (for `mirage regen`). */
  force?: boolean;
  /** Allow generating for `mode: locked` routes that have no page.spec.json (for `mirage lock` / `eject`). */
  allowLocked?: boolean;
  /** Wraps the configured model for this call (for `mirage eval`, which records responses and usage). */
  wrapModel?: (model: LanguageModel) => LanguageModel;
  signal?: AbortSignal;
};

export type ResolveResult =
  | { ok: true; spec: Spec; source: "locked" | "cached" | "generated" }
  | { ok: false; message: string; status: number };

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_PARAM_LENGTH = 200;

const defaultRead = async (path: string) => (existsSync(path) ? readFile(path, "utf8") : undefined);

export function createMirageServer(options: MirageServerOptions) {
  const { config, catalog, loadModule, dev } = options;
  const readText = options.readText ?? defaultRead;
  const log = options.log ?? ((m: string) => console.log(`[mirage] ${m}`));
  const fileCache = new SpecCache(options.cacheDir);
  const memory = new MemoryCache();
  const routes = () => (typeof options.routes === "function" ? options.routes() : options.routes);
  const generatedKeys = new Map<string, Set<string>>();

  /** Params come from the client: they must be exactly the route's params, as short strings. */
  function checkParams(info: RouteInfo, params: Record<string, string>) {
    const names = Object.keys(params);
    const valid =
      names.length === info.paramNames.length &&
      info.paramNames.every((n) => typeof params[n] === "string" && params[n]!.length > 0 && params[n]!.length <= MAX_PARAM_LENGTH);
    if (!valid) throw new HttpError(400, `Invalid params for "${info.path}": expected ${info.paramNames.join(", ") || "none"}`);
  }

  function route(path: string): RouteInfo {
    const found = findRoute(routes(), path);
    if (!found) throw new HttpError(404, `No route matches "${path}"`);
    return found;
  }

  /** Tools visible to a route: ancestors first, so the nearest definition wins. */
  async function routeTools(info: RouteInfo): Promise<Record<string, Tool>> {
    const merged: Record<string, Tool> = {};
    for (const path of info.toolsPaths) Object.assign(merged, toolsFromModule(await loadModule(path)));
    return merged;
  }

  async function signatures(info: RouteInfo): Promise<ToolSignature[]> {
    return Object.entries(await routeTools(info)).map(([name, tool]) => toolSignature(name, tool));
  }

  async function intentOf(info: RouteInfo): Promise<Intent> {
    const source = info.intentPath ? await readText(info.intentPath) : undefined;
    if (source === undefined) throw new HttpError(404, `Route "${info.path}" has no page.intent.md`);
    return parseIntent(source, info.intentPath);
  }

  async function resolveSpec(
    path: string,
    params: Record<string, string>,
    emit: (event: GenerateEvent) => void,
    opts: ResolveOptions = {},
  ): Promise<ResolveResult> {
    try {
      const info = route(path);
      const intent = await intentOf(info);
      const { mode } = intent.frontmatter;
      const done = (spec: Spec, source: "locked" | "cached" | "generated"): ResolveResult => {
        emit({ type: "spec", spec, source });
        return { ok: true, spec, source };
      };

      if (!opts.force && mode !== "live" && info.specPath) {
        const text = await readText(info.specPath);
        if (text !== undefined) return done(JSON.parse(text) as Spec, "locked");
      }
      if (mode === "locked" && !opts.force && !opts.allowLocked) {
        throw new HttpError(409, `Route "${info.path}" is locked but has no page.spec.json. Run \`mirage lock ${info.path}\`.`);
      }

      const pageCatalog = intent.frontmatter.catalog ? catalog.subset(intent.frontmatter.catalog) : catalog;
      const tools = await signatures(info);
      const key = cacheKey({
        intentSource: intent.source,
        catalogHash: catalogHash(pageCatalog),
        toolsHash: toolsHash(tools),
        params: intent.frontmatter.specPerParams ? params : undefined,
      });
      if (!opts.force) {
        const hit = mode === "live" ? memory.get(key) : await fileCache.get(key);
        if (hit) return done(hit, "cached");
      }

      if (!config.model) throw new HttpError(503, `No model configured; cannot generate "${info.path}".`);
      // Bound model calls per route: with specPerParams, every distinct param value is a new spec.
      const keys = generatedKeys.get(info.path) ?? new Set<string>();
      if (!keys.has(key) && keys.size >= intent.frontmatter.maxSpecs && !opts.force) {
        throw new HttpError(429, `Route "${info.path}" reached its limit of ${intent.frontmatter.maxSpecs} generated specs.`);
      }
      log(`generating ${info.path}`);
      const result = await generateSpec({
        model: opts.wrapModel ? opts.wrapModel(config.model) : config.model,
        catalog: pageCatalog,
        tools,
        intent,
        route: { path: info.path, params: info.paramNames },
        onDelta: (text) => emit({ type: "delta", text }),
        onRetry: (attempt, errors) => {
          log(`repairing ${info.path} (attempt ${attempt}, ${errors.length} error(s))`);
          emit({ type: "retry", attempt, errors });
        },
        abortSignal: opts.signal,
      });
      if (!result.ok) {
        emit({ type: "error", message: `Generation failed after ${result.attempts} attempts`, errors: result.errors });
        return { ok: false, message: "generation failed", status: 422 };
      }
      keys.add(key);
      generatedKeys.set(info.path, keys);
      if (mode === "live") memory.set(key, result.spec, intent.frontmatter.ttl);
      else await fileCache.set(key, result.spec).catch((e: unknown) => log(`could not write cache: ${String(e)}`));
      return done(result.spec, "generated");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", message });
      return { ok: false, message, status };
    }
  }

  const app = new Hono();

  app.post("/__mirage/generate", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { route?: unknown; params?: unknown };
    if (typeof body.route !== "string") return c.json({ error: "route is required" }, 400);
    if (body.params !== undefined && (typeof body.params !== "object" || body.params === null || Array.isArray(body.params))) {
      return c.json({ error: "params must be an object" }, 400);
    }
    const params = (body.params ?? {}) as Record<string, string>;
    try {
      checkParams(route(body.route), params);
    } catch (error) {
      if (error instanceof HttpError) return c.json({ error: error.message }, error.status as 400);
      throw error;
    }
    const encoder = new TextEncoder();
    const signal = c.req.raw.signal;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: GenerateEvent) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          } catch {
            /* client went away */
          }
        };
        await resolveSpec(body.route as string, params, emit, { signal });
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
  });

  app.post("/__mirage/tools/:name", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => ({}))) as { route?: unknown; params?: unknown; args?: unknown };
    try {
      if (typeof body.route !== "string") throw new HttpError(400, "route is required");
      const info = route(body.route);
      const tool = (await routeTools(info))[name];
      if (!tool) throw new HttpError(404, `Tool "${name}" is not available on route "${info.path}"`);
      const input = tool.input.safeParse(body.args ?? {});
      if (!input.success) {
        return c.json({ error: "Invalid tool input", issues: input.error.issues }, 400);
      }
      const params = (typeof body.params === "object" && body.params ? body.params : {}) as Record<string, string>;
      const extra = config.context ? await config.context(c.req.raw) : {};
      const result = await tool.handler(input.data, { ...extra, request: c.req.raw, params });
      const output = tool.output.safeParse(result);
      if (!output.success) {
        // Outputs are redacted from logs by default: log only the issue paths.
        const paths = output.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
        log(`tool "${name}" returned invalid output at: ${paths}`);
        throw new HttpError(500, dev ? `Tool "${name}" returned invalid output at: ${paths}` : "Tool failed");
      }
      return c.json({ result: output.data });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError || dev ? (error as Error).message : "Tool failed";
      if (!(error instanceof HttpError)) log(`tool "${name}" failed: ${(error as Error).message}`);
      return c.json({ error: message }, status as 400);
    }
  });

  return { app, resolveSpec, routeTools, signatures, route, routes };
}

export type MirageServer = ReturnType<typeof createMirageServer>;
