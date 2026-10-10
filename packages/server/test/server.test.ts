import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { GenerateEvent, Spec } from "@mirage/core";
import { basicCatalog } from "@mirage/catalog-basic";
import {
  buildPrompt,
  cacheKey,
  createMirageServer,
  parseIntent,
  emptyRecording,
  findRoute,
  MemoryCache,
  type RouteInfo,
  recordingModel,
  replayModel,
  scanRoutes,
  toolsHash,
  type MirageConfig,
} from "@mirage/server";

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const appDir = join(fixtures, "app");

const validSpec: Spec = {
  version: 1,
  root: "page",
  data: { plants: { tool: "listPlants" } },
  elements: {
    page: { type: "Stack", children: ["title", "table"] },
    title: { type: "Heading", props: { text: "Plants" } },
    table: { type: "Table", props: { rows: { $data: "plants" }, columns: [{ key: "name", label: "Name" }] } },
  },
};
const invalidSpec = { ...validSpec, root: "missing" };

function streamOf(text: string) {
  const chunks = text.match(/.{1,40}/gs) ?? [];
  return {
    stream: convertArrayToReadableStream([
      { type: "text-start", id: "t" },
      ...chunks.map((delta) => ({ type: "text-delta", id: "t", delta })),
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
    ] as never[]),
  };
}

function mockModel(outputs: unknown[]) {
  return new MockLanguageModelV4({ doStream: outputs.map((o) => streamOf(typeof o === "string" ? o : JSON.stringify(o))) as never });
}

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "mirage-cache-"));
});
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

function server(config: MirageConfig, dev = true) {
  return createMirageServer({
    config,
    catalog: basicCatalog,
    routes: () => scanRoutes(appDir, join(fixtures, "tools.ts")),
    loadModule: (path) => import(path),
    cacheDir,
    dev,
    log: () => {},
  });
}

async function generate(s: ReturnType<typeof server>, route: string, params: Record<string, string> = {}) {
  const res = await s.app.request("/__mirage/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ route, params }),
  });
  const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as GenerateEvent);
  return events;
}

const callTool = (s: ReturnType<typeof server>, name: string, body: object) =>
  s.app.request(`/__mirage/tools/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("routes", () => {
  it("scans the app directory", () => {
    const routes = scanRoutes(appDir, join(fixtures, "tools.ts"));
    expect(routes.map((r) => [r.path, r.paramNames, r.toolsPaths.length])).toEqual([
      ["/", [], 1],
      ["/locked", [], 1],
      ["/plants", [], 2],
      ["/plants/:id", ["id"], 2],
    ]);
  });
});

describe("intent", () => {
  it("rejects unknown frontmatter keys", () => {
    expect(() => parseIntent("---\nmood: happy\n---\nHi")).toThrow(/mood/);
  });
});

describe("buildPrompt", () => {
  it("assembles a stable prompt", async () => {
    const s = server({});
    const info = s.route("/plants");
    const intent = parseIntent("---\ntitle: Plants\n---\nA list of plants.");
    const prompt = buildPrompt({
      components: basicCatalog.subset(["Stack", "Heading", "Table", "Button"]).describe(),
      tools: await s.signatures(info),
      intent,
      route: { path: info.path, params: info.paramNames },
    });
    expect(prompt).toMatchSnapshot();
  });

  it("includes repair context", () => {
    const { prompt } = buildPrompt({
      components: [],
      tools: [],
      intent: parseIntent("Hi"),
      route: { path: "/", params: [] },
      repair: { errors: [{ path: "root", message: 'root element "x" does not exist' }] },
    });
    expect(prompt).toContain('- root: root element "x" does not exist');
  });
});

describe("generation", () => {
  it("streams, validates and caches; a cache hit does not call the model", async () => {
    const model = mockModel([validSpec]);
    const s = server({ model });
    const events = await generate(s, "/plants");
    expect(events.filter((e) => e.type === "delta").length).toBeGreaterThan(1);
    expect(events.at(-1)).toEqual({ type: "spec", spec: validSpec, source: "generated" });

    const again = await generate(s, "/plants");
    expect(again).toEqual([{ type: "spec", spec: validSpec, source: "cached" }]);
    expect(model.doStreamCalls.length).toBe(1);
    // The prompt is constrained to the intent's catalog subset.
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).not.toContain("TextInput");
  });

  it("repairs invalid output with the validation errors", async () => {
    const model = mockModel(["{ not json", invalidSpec, validSpec]);
    const events = await generate(server({ model }), "/plants");
    const retries = events.filter((e) => e.type === "retry");
    expect(retries.map((e) => e.type === "retry" && e.attempt)).toEqual([2, 3]);
    expect(events.at(-1)).toMatchObject({ type: "spec", source: "generated" });
    expect(model.doStreamCalls.length).toBe(3);
    expect(JSON.stringify(model.doStreamCalls[2]!.prompt)).toContain('root element \\"missing\\" does not exist');
  });

  it("gives up after two repairs", async () => {
    const model = mockModel([invalidSpec, invalidSpec, invalidSpec, validSpec]);
    const events = await generate(server({ model }), "/plants");
    expect(model.doStreamCalls.length).toBe(3);
    expect(events.at(-1)).toMatchObject({ type: "error", errors: [{ path: "root" }] });
  });

  it("rejects unknown tools in generated specs", async () => {
    const model = mockModel(Array(3).fill({ ...validSpec, data: { plants: { tool: "listPatients" } } }));
    const events = await generate(server({ model }), "/plants");
    expect(events.at(-1)).toMatchObject({ type: "error", errors: [{ message: 'unknown tool "listPatients"' }] });
  });

  it("uses page.spec.json without a model, and enforces locked mode", async () => {
    const s = server({});
    expect((await generate(s, "/locked")).at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/mirage lock/) });
    const specPath = join(appDir, "locked", "page.spec.json");
    const locked: Spec = { version: 1, root: "t", elements: { t: { type: "Heading", props: { text: "Locked" } } } };
    writeFileSync(specPath, JSON.stringify(locked));
    try {
      expect(await generate(s, "/locked")).toEqual([{ type: "spec", spec: locked, source: "locked" }]);
    } finally {
      rmSync(specPath);
    }
  });

  it("reuses live specs within the TTL", async () => {
    const model = mockModel([validSpec, validSpec]);
    const s = server({ model });
    await generate(s, "/plants/:id", { id: "p1" });
    expect((await generate(s, "/plants/:id", { id: "p2" })).at(-1)).toMatchObject({ source: "cached" });
    expect(model.doStreamCalls.length).toBe(1);
  });

  it("stops without repairing when the request is aborted", async () => {
    const model = mockModel([validSpec, validSpec, validSpec]);
    const s = server({ model });
    const controller = new AbortController();
    const events: GenerateEvent[] = [];
    const result = await s.resolveSpec("/plants", {}, (e) => {
      events.push(e);
      if (e.type === "delta") controller.abort();
    }, { signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(model.doStreamCalls.length).toBe(1);
    expect(events.some((e) => e.type === "retry")).toBe(false);
  });

  it("reports provider errors instead of retrying them as bad JSON", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("401 invalid x-api-key");
      },
    });
    const events = await generate(server({ model }), "/plants");
    expect(model.doStreamCalls.length).toBe(1);
    expect(events.some((e) => e.type === "retry")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("401 invalid x-api-key") });
  });

  it("rejects params that do not match the route", async () => {
    const model = mockModel([validSpec]);
    const s = server({ model });
    for (const params of [{}, { id: "p1", extra: "x" }, { id: "x".repeat(201) }, { id: 5 }, ["p1"]]) {
      const res = await s.app.request("/__mirage/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "/plants/:id", params }),
      });
      expect(res.status).toBe(400);
    }
    expect(model.doStreamCalls.length).toBe(0);
  });

  it("bounds generated specs per route", async () => {
    const intentPath = join(appDir, "plants", "[id]", "page.intent.md");
    const original = readFileSync(intentPath, "utf8");
    writeFileSync(intentPath, original.replace("mode: live", "mode: live\nspecPerParams: true\nmaxSpecs: 2"));
    try {
      const model = mockModel([validSpec, validSpec, validSpec]);
      const s = server({ model });
      await generate(s, "/plants/:id", { id: "a" });
      await generate(s, "/plants/:id", { id: "b" });
      expect((await generate(s, "/plants/:id", { id: "a" })).at(-1)).toMatchObject({ source: "cached" });
      expect((await generate(s, "/plants/:id", { id: "c" })).at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/limit of 2/) });
      expect(model.doStreamCalls.length).toBe(2);
    } finally {
      writeFileSync(intentPath, original);
    }
  });

  it("lets the CLI resolve a dynamic route without params", async () => {
    const result = await server({ model: mockModel([validSpec]) }).resolveSpec("/plants/:id", {}, () => {});
    expect(result).toMatchObject({ ok: true, source: "generated" });
  });

  it("lets the CLI generate for a locked route with no spec", async () => {
    const plain: Spec = { version: 1, root: "t", elements: { t: { type: "Heading", props: { text: "Locked" } } } };
    const s = server({ model: mockModel([plain]) });
    expect((await s.resolveSpec("/locked", {}, () => {})).ok).toBe(false);
    const result = await s.resolveSpec("/locked", {}, () => {}, { allowLocked: true });
    expect(result).toMatchObject({ ok: true, source: "generated" });
  });

  it("changes the cache key when inputs change", () => {
    const base = { intentSource: "a", catalogHash: "c", toolsHash: toolsHash([]) };
    expect(cacheKey(base)).toBe(cacheKey({ ...base }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, intentSource: "b" }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, params: { id: "1" } }));
  });
});

describe("tools endpoint", () => {
  it("validates input and returns output", async () => {
    const s = server({});
    const ok = await callTool(s, "listPlants", { route: "/plants", args: { query: "Fe" } });
    expect(await ok.json()).toEqual({ result: [{ id: "p1", name: "Fern" }] });
    const bad = await callTool(s, "listPlants", { route: "/plants", args: { query: 5 } });
    expect(bad.status).toBe(400);
  });

  it("only exposes tools visible to the route; nearest wins", async () => {
    const s = server({});
    expect((await callTool(s, "listPlants", { route: "/", args: {} })).status).toBe(404);
    expect(await (await callTool(s, "ping", { route: "/", args: {} })).json()).toEqual({ result: "global" });
    expect(await (await callTool(s, "ping", { route: "/plants/:id", params: { id: "p1" }, args: {} })).json()).toEqual({ result: "route" });
  });

  it("never returns output that fails the output schema", async () => {
    expect((await callTool(server({}), "broken", { route: "/plants" })).status).toBe(500);
    const prod = await callTool(server({}, false), "broken", { route: "/plants" });
    expect(prod.status).toBe(500);
    expect(await prod.json()).toEqual({ error: "Tool failed" });
  });

  it("builds ctx from the config context hook", async () => {
    const s = server({ context: (req) => ({ user: req.headers.get("x-user") }) });
    const res = await s.app.request("/__mirage/tools/whoami", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": "ada" },
      body: JSON.stringify({ route: "/" }),
    });
    expect(await res.json()).toEqual({ result: "ada" });
  });
});

describe("record and replay", () => {
  it("replays a recorded generation, repair turns included, without calling a model", async () => {
    const model = mockModel([invalidSpec, validSpec]);
    const recording = emptyRecording();
    const recorded = await server({ model }).resolveSpec("/plants", {}, () => {}, {
      force: true,
      wrapModel: (m) => recordingModel(m, (call) => (recording.responses[call.key] = { route: "/plants", text: call.text })),
    });
    expect(recorded).toMatchObject({ ok: true, spec: validSpec });
    expect(Object.keys(recording.responses)).toHaveLength(2);
    rmSync(cacheDir, { recursive: true, force: true }); // the recording run cached its spec

    const events = await generate(server({ model: replayModel(recording) }), "/plants");
    expect(events.filter((e) => e.type === "retry")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "spec", spec: validSpec, source: "generated" });
    expect(model.doStreamCalls.length).toBe(2);
  });

  it("does not cache a generation when writeCache is false", async () => {
    const model = mockModel([validSpec, validSpec]);
    const s = server({ model });
    expect(await s.resolveSpec("/plants", {}, () => {}, { force: true, writeCache: false })).toMatchObject({ ok: true });
    expect((await generate(s, "/plants")).at(-1)).toMatchObject({ type: "spec", source: "generated" });
    expect(model.doStreamCalls.length).toBe(2);
  });

  it("fails loudly when the prompt was not recorded", async () => {
    const events = await generate(server({ model: replayModel(emptyRecording()) }), "/plants");
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("mirage eval --record") });
  });
});

describe("hardening (follow-up review on #2)", () => {
  const post = (s: ReturnType<typeof server>, url: string, body: object, headers: Record<string, string> = {}) =>
    s.app.request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const plain: Spec = { version: 1, root: "t", elements: { t: { type: "Heading", props: { text: "Hi" } } } };

  async function withIntent(dir: string[], edit: (src: string) => string, fn: () => Promise<void>) {
    const intentPath = join(appDir, ...dir, "page.intent.md");
    const original = readFileSync(intentPath, "utf8");
    writeFileSync(intentPath, edit(original));
    try {
      await fn();
    } finally {
      writeFileSync(intentPath, original);
    }
  }

  // 1. CSRF
  it("rejects tool and generate requests that are not JSON (CORS-simple requests)", async () => {
    const s = server({ model: mockModel([plain]) });
    for (const url of ["/__mirage/tools/whoami", "/__mirage/generate"]) {
      const res = await post(s, url, { route: "/", params: {}, args: {} }, { "content-type": "text/plain" });
      expect(res.status).toBe(415);
    }
  });

  it("rejects cross-site tool and generate requests", async () => {
    const s = server({ model: mockModel([plain]) });
    for (const site of ["cross-site", "same-site"]) {
      for (const url of ["/__mirage/tools/whoami", "/__mirage/generate"]) {
        expect((await post(s, url, { route: "/", params: {}, args: {} }, { "sec-fetch-site": site })).status).toBe(403);
      }
    }
    expect((await post(s, "/__mirage/tools/whoami", { route: "/", params: {}, args: {} }, { "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  // 3. params on the tool endpoint
  it("validates params on the tool endpoint like the generate endpoint", async () => {
    const s = server({});
    for (const params of [{ id: 5 }, { id: "p1", extra: "x" }, {}, "p1"]) {
      expect((await post(s, "/__mirage/tools/ping", { route: "/plants/:id", params, args: {} })).status).toBe(400);
    }
    expect((await post(s, "/__mirage/tools/ping", { route: "/plants/:id", params: { id: "p1" }, args: {} })).status).toBe(200);
  });

  // 4. error redaction
  it("does not stream raw error messages in production", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("401 invalid x-api-key sk-secret at /srv/app");
      },
    });
    const events = await generate(server({ model }, false), "/plants");
    expect(events.at(-1)).toEqual({ type: "error", message: "Generation failed" });
  });

  // 5. locked and cached specs are validated
  it("reports a corrupt or invalid page.spec.json clearly instead of serving it", async () => {
    const s = server({});
    const specPath = join(appDir, "locked", "page.spec.json");
    try {
      writeFileSync(specPath, "{ not json");
      expect((await generate(s, "/locked")).at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/page\.spec\.json is not valid JSON/) });
      writeFileSync(specPath, JSON.stringify(validSpec)); // listPlants is not available on /locked
      expect((await generate(s, "/locked")).at(-1)).toMatchObject({
        type: "error",
        message: expect.stringMatching(/page\.spec\.json is invalid/),
        errors: [{ message: 'unknown tool "listPlants"' }],
      });
    } finally {
      rmSync(specPath);
    }
  });

  it("regenerates when a cached spec is no longer valid", async () => {
    const model = mockModel([validSpec, validSpec]);
    const s = server({ model });
    await generate(s, "/plants");
    for (const f of readdirSync(cacheDir)) writeFileSync(join(cacheDir, f), JSON.stringify({ ...validSpec, root: "gone" }));
    expect((await generate(s, "/plants")).at(-1)).toMatchObject({ type: "spec", source: "generated" });
    expect(model.doStreamCalls.length).toBe(2);
  });

  // 6. dedupe and bounded regeneration
  it("shares one model call between concurrent requests for the same spec", async () => {
    const model = mockModel([validSpec, validSpec]);
    const s = server({ model });
    const [a, b] = await Promise.all([generate(s, "/plants"), generate(s, "/plants")]);
    expect(a.at(-1)).toMatchObject({ type: "spec", spec: validSpec });
    expect(b.at(-1)).toMatchObject({ type: "spec", spec: validSpec });
    expect(model.doStreamCalls.length).toBe(1);
  });

  it("lets a waiting request generate its own spec when the shared one was aborted", async () => {
    const model = mockModel([validSpec, validSpec]);
    const s = server({ model });
    const controller = new AbortController();
    // The second request starts while the first one's generation is streaming, then the first aborts.
    let second: ReturnType<typeof s.resolveSpec> | undefined;
    const first = await s.resolveSpec(
      "/plants",
      {},
      (e) => {
        if (e.type !== "delta" || second) return;
        second = s.resolveSpec("/plants", {}, () => {});
        controller.abort();
      },
      { signal: controller.signal },
    );
    expect(first.ok).toBe(false);
    expect(await second).toMatchObject({ ok: true, spec: validSpec });
    expect(model.doStreamCalls.length).toBe(2);
  });

  it("bounds regeneration of the same key (live mode with ttl 0)", async () => {
    await withIntent(["plants", "[id]"], (src) => src.replace("mode: live", "mode: live\nttl: 0\nmaxSpecs: 2"), async () => {
      const model = mockModel([validSpec, validSpec, validSpec]);
      const s = server({ model });
      for (let i = 0; i < 2; i++) await generate(s, "/plants/:id", { id: "p1" });
      expect((await generate(s, "/plants/:id", { id: "p1" })).at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/limit/) });
      expect(model.doStreamCalls.length).toBe(2);
    });
  });

  // 7. specPerParams
  it("gives the model the param values when specs are generated per param value", async () => {
    await withIntent(["plants", "[id]"], (src) => src.replace("mode: live", "mode: cached\nspecPerParams: true"), async () => {
      const model = mockModel([validSpec]);
      await generate(server({ model }), "/plants/:id", { id: "basil" });
      expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain("basil");
    });
  });

  // 8. route matching
  it("prefers a static route over a dynamic sibling", () => {
    const r = (path: string) => ({ path }) as RouteInfo;
    const routes = [r("/plants/:id"), r("/plants/new"), r("/plants/:id/edit"), r("/plants/new/edit")];
    expect(findRoute(routes, "/plants/new")?.path).toBe("/plants/new");
    expect(findRoute(routes, "/plants/new/edit")?.path).toBe("/plants/new/edit");
    expect(findRoute(routes, "/plants/basil")?.path).toBe("/plants/:id");
  });

  // 9. MemoryCache eviction
  it("evicts expired live-mode entries without waiting for a read", () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoryCache();
      for (let i = 0; i < 50; i++) cache.set(`k${i}`, plain, 1);
      vi.advanceTimersByTime(2000);
      cache.set("fresh", plain, 60);
      expect(cache.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
