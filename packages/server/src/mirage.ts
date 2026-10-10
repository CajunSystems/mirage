import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Hono, type Context } from "hono";
import type { LanguageModel } from "ai";
import {
  toolSignature,
  toolsFromModule,
  validateSpec,
  type ValidationError,
  type Catalog,
  type GenerateEvent,
  type Spec,
  type Tool,
  type ToolSignature,
} from "@cajunsystems/mirage-core";
import { cacheKey, catalogHash, MemoryCache, SpecCache, toolsHash } from "./cache.js";
import type { MirageConfig } from "./config.js";
import { generateSpec, type GenerateResult } from "./generate.js";
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
  /** Dev mode: errors are reported to the client in full instead of redacted. */
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
  /** Write a successful generation to the cache. Default true; `mirage eval` turns it off. */
  writeCache?: boolean;
  signal?: AbortSignal;
};

export type ResolveResult =
  | { ok: true; spec: Spec; source: "locked" | "cached" | "generated" }
  | { ok: false; message: string; status: number };

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public errors?: ValidationError[],
  ) {
    super(message);
  }
}

const MAX_PARAM_LENGTH = 200;
/** Window for `maxSpecs`: generations per route per hour. */
const SPEC_WINDOW_MS = 60 * 60 * 1000;

const defaultRead = async (path: string) => (existsSync(path) ? readFile(path, "utf8") : undefined);

/**
 * CSRF guard for the Mirage endpoints. Requiring a JSON content type makes every cross-origin
 * request non-simple, so the browser sends a CORS preflight that this server never approves.
 * `Sec-Fetch-Site` additionally rejects cross-site and same-site requests in browsers that send it.
 * Requests without it (curl, server-side callers) are allowed: they carry no victim's cookies.
 */
function rejectUnsafeRequest(c: Context): Response | undefined {
  const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return c.json({ error: "Content-Type must be application/json" }, 415);
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return c.json({ error: "Cross-site requests are not allowed" }, 403);
  return undefined;
}

export function createMirageServer(options: MirageServerOptions) {
  const { config, catalog, loadModule, dev } = options;
  const readText = options.readText ?? defaultRead;
  const log = options.log ?? ((m: string) => console.log(`[mirage] ${m}`));
  const fileCache = new SpecCache(options.cacheDir);
  const memory = new MemoryCache();
  const routes = () => (typeof options.routes === "function" ? options.routes() : options.routes);
  /** Generation timestamps per route, for `maxSpecs`. */
  const generations = new Map<string, number[]>();
  /** Generations in flight by cache key, so concurrent requests share one model call. */
  const inflight = new Map<string, Promise<GenerateResult>>();

  /** Params come from the client: they must be exactly the route's params, as short strings. */
  function checkParams(info: RouteInfo, params: unknown): Record<string, string> {
    const record = (typeof params === "object" && params !== null && !Array.isArray(params) ? params : null) as Record<string, unknown> | null;
    const valid =
      record !== null &&
      Object.keys(record).length === info.paramNames.length &&
      info.paramNames.every((n) => {
        const v = record[n];
        return typeof v === "string" && v.length > 0 && v.length <= MAX_PARAM_LENGTH;
      });
    if (!valid) throw new HttpError(400, `Invalid params for "${info.path}": expected ${info.paramNames.join(", ") || "none"}`);
    return record as Record<string, string>;
  }

  function route(path: string): RouteInfo {
    const found = findRoute(routes(), path);
    if (!found) throw new HttpError(404, `No route matches "${path}"`);
    return found;
  }

  /** Tools visible to a route: ancestors first, so the nearest definition wins. */
  async function routeTools(info: RouteInfo): Promise<Record<string, Tool>> {
    return (await toolsOf(info)).tools;
  }

  // Signatures and hashes are memoized per set of loaded tool modules. In dev, Vite returns a new
  // module object after an edit, which misses the memo; the catalog is fixed for a server's life.
  const toolsMemo = new Map<string, { modules: unknown[]; tools: Record<string, Tool>; signatures: ToolSignature[]; hash: string }>();
  async function toolsOf(info: RouteInfo) {
    const modules = await Promise.all(info.toolsPaths.map((p) => loadModule(p)));
    const hit = toolsMemo.get(info.path);
    if (hit && hit.modules.length === modules.length && hit.modules.every((m, i) => m === modules[i])) return hit;
    const tools: Record<string, Tool> = {};
    for (const mod of modules) Object.assign(tools, toolsFromModule(mod));
    const signatures = Object.entries(tools).map(([name, tool]) => toolSignature(name, tool));
    const entry = { modules, tools, signatures, hash: toolsHash(signatures) };
    toolsMemo.set(info.path, entry);
    return entry;
  }

  async function signatures(info: RouteInfo): Promise<ToolSignature[]> {
    return (await toolsOf(info)).signatures;
  }

  const catalogMemo = new Map<string, { catalog: Catalog; hash: string }>();
  function pageCatalog(names: string[] | undefined) {
    const key = names ? JSON.stringify(names) : "*";
    let entry = catalogMemo.get(key);
    if (!entry) {
      const picked = names ? catalog.subset(names) : catalog;
      entry = { catalog: picked, hash: catalogHash(picked) };
      catalogMemo.set(key, entry);
    }
    return entry;
  }

  async function intentOf(info: RouteInfo): Promise<Intent> {
    const source = info.intentPath ? await readText(info.intentPath) : undefined;
    if (source === undefined) throw new HttpError(404, `Route "${info.path}" has no page.intent.md`);
    return parseIntent(source, info.intentPath);
  }

  /** Counts a generation against `maxSpecs` (per route, per hour), or refuses it. */
  function takeGeneration(info: RouteInfo, max: number) {
    const now = Date.now();
    const recent = (generations.get(info.path) ?? []).filter((t) => now - t < SPEC_WINDOW_MS);
    if (recent.length >= max) {
      generations.set(info.path, recent);
      throw new HttpError(429, `Route "${info.path}" reached its limit of ${max} generated specs per hour.`);
    }
    recent.push(now);
    generations.set(info.path, recent);
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
      const page = pageCatalog(intent.frontmatter.catalog);
      const tools = await toolsOf(info);
      const check = (spec: unknown) => validateSpec(spec, { catalog: page.catalog, tools: tools.tools, params: info.paramNames });

      if (!opts.force && mode !== "live" && info.specPath) {
        const text = await readText(info.specPath);
        if (text !== undefined) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new HttpError(500, `"${info.path}": page.spec.json is not valid JSON`);
          }
          const result = check(parsed);
          if (!result.ok) throw new HttpError(500, `"${info.path}": page.spec.json is invalid`, result.errors);
          return done(result.spec, "locked");
        }
      }
      if (mode === "locked" && !opts.force && !opts.allowLocked) {
        throw new HttpError(409, `Route "${info.path}" is locked but has no page.spec.json. Run \`mirage lock ${info.path}\`.`);
      }

      const perParams = intent.frontmatter.specPerParams;
      const key = cacheKey({
        intentSource: intent.source,
        catalogHash: page.hash,
        toolsHash: tools.hash,
        params: perParams ? params : undefined,
      });
      // Live entries were validated when generated; files on disk may have been edited or gone stale.
      const lookup = async (): Promise<Spec | undefined> => {
        if (mode === "live") return memory.get(key);
        const hit = await fileCache.get(key);
        if (!hit) return undefined;
        const result = check(hit);
        if (result.ok) return result.spec;
        log(`cached spec for ${info.path} is invalid; regenerating`);
        return undefined;
      };
      // Cache, then in-flight generations. The last in-flight check and claiming the key below run
      // without an await in between, so concurrent requests share one model call. A generation can
      // finish (cache written, entry removed) between our cache read and that check, so a miss on
      // both is confirmed by a second round before generating.
      for (let round = 0; !opts.force; ) {
        const hit = await lookup();
        if (hit) return done(hit, "cached");
        const shared = inflight.get(key);
        if (shared) {
          const result = await shared;
          if (result.ok) return done(result.spec, "generated");
          // An aborted generation belongs to the request that started it: try again ourselves.
          if (!result.aborted) {
            emit({ type: "error", message: `Generation failed after ${result.attempts} attempts`, errors: result.errors });
            return { ok: false, message: "generation failed", status: 422 };
          }
          round = 0;
        } else if (++round === 2) break;
      }

      if (!config.model) throw new HttpError(503, `No model configured; cannot generate "${info.path}".`);
      // Bound model calls per route: live mode with a short ttl and specPerParams can otherwise
      // turn every request into a model call.
      if (!opts.force) takeGeneration(info, intent.frontmatter.maxSpecs);
      log(`generating ${info.path}`);
      const model = config.model;
      const generation = (async () => {
        const result = await generateSpec({
          model: opts.wrapModel ? opts.wrapModel(model) : model,
          catalog: page.catalog,
          tools: tools.signatures,
          toolDefs: tools.tools,
          intent,
          route: { path: info.path, params: info.paramNames, values: perParams ? params : undefined },
          onDelta: (text) => emit({ type: "delta", text }),
          onRetry: (attempt, errors) => {
            log(`repairing ${info.path} (attempt ${attempt}, ${errors.length} error(s))`);
            emit({ type: "retry", attempt, errors });
          },
          abortSignal: opts.signal,
        });
        if (!result.ok || opts.writeCache === false) return result;
        if (mode === "live") memory.set(key, result.spec, intent.frontmatter.ttl);
        else await fileCache.set(key, result.spec).catch((e: unknown) => log(`could not write cache: ${String(e)}`));
        return result;
      })();
      // Shared until the cache is written, so a later request finds one or the other.
      if (!opts.force) {
        inflight.set(key, generation);
        void generation.catch(() => {}).finally(() => inflight.get(key) === generation && inflight.delete(key));
      }
      const result = await generation;
      if (!result.ok) {
        emit({ type: "error", message: `Generation failed after ${result.attempts} attempts`, errors: result.errors });
        return { ok: false, message: "generation failed", status: 422 };
      }
      return done(result.spec, "generated");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const raw = error instanceof Error ? error.message : String(error);
      // Our own HttpErrors are written for the client. Anything else (provider errors, file errors)
      // may carry keys, paths or internals, so production only says that generation failed.
      const message = error instanceof HttpError || dev ? raw : "Generation failed";
      if (!(error instanceof HttpError)) log(`generation for ${path} failed: ${raw}`);
      const errors = error instanceof HttpError ? error.errors : undefined;
      emit(errors ? { type: "error", message, errors } : { type: "error", message });
      return { ok: false, message, status };
    }
  }

  const app = new Hono();

  app.post("/__mirage/generate", async (c) => {
    const rejected = rejectUnsafeRequest(c);
    if (rejected) return rejected;
    const body = (await c.req.json().catch(() => ({}))) as { route?: unknown; params?: unknown };
    if (typeof body.route !== "string") return c.json({ error: "route is required" }, 400);
    let params: Record<string, string>;
    try {
      params = checkParams(route(body.route), body.params ?? {});
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
    const rejected = rejectUnsafeRequest(c);
    if (rejected) return rejected;
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => ({}))) as { route?: unknown; params?: unknown; args?: unknown };
    try {
      if (typeof body.route !== "string") throw new HttpError(400, "route is required");
      const info = route(body.route);
      const params = checkParams(info, body.params ?? {});
      const tool = (await routeTools(info))[name];
      if (!tool) throw new HttpError(404, `Tool "${name}" is not available on route "${info.path}"`);
      const input = tool.input.safeParse(body.args ?? {});
      if (!input.success) {
        return c.json({ error: "Invalid tool input", issues: input.error.issues }, 400);
      }
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
