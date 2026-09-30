import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { GenerateEvent, Spec } from "@mirage/core";
import { basicCatalog } from "@mirage/catalog-basic";
import {
  buildPrompt,
  cacheKey,
  createMirageServer,
  parseIntent,
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
    writeFileSync(specPath, JSON.stringify(validSpec));
    try {
      expect(await generate(s, "/locked")).toEqual([{ type: "spec", spec: validSpec, source: "locked" }]);
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
    expect(await (await callTool(s, "ping", { route: "/plants/:id", args: {} })).json()).toEqual({ result: "route" });
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
