import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toolsFromModule, validateSpec, type Catalog } from "@cajunsystems/mirage-core";
import { parseIntent } from "@cajunsystems/mirage-server";
import { projectPaths, projectRoutes, routesModule, serverModule } from "@cajunsystems/mirage-vite";

const example = resolve(dirname(fileURLToPath(import.meta.url)), "../../../examples/greenhouse");
const paths = projectPaths(example, {});
const routes = projectRoutes(paths);
const rel = (s: string) => s.split(example).join("<root>");

describe("greenhouse example", () => {
  it("has the expected routes", () => {
    expect(routes.map((r) => ({ path: r.path, tools: r.toolsPaths.map((t) => relative(example, t)), spec: !!r.specPath }))).toEqual([
      { path: "/", tools: ["app/tools.ts"], spec: true },
      { path: "/plants", tools: ["app/tools.ts", "app/plants/tools.ts"], spec: true },
      { path: "/plants/:id", tools: ["app/tools.ts", "app/plants/tools.ts", "app/plants/[id]/tools.ts"], spec: true },
    ]);
  });

  it.each(routes.map((r) => [r.path, r] as const))("committed spec for %s validates against its catalog and tools", async (_path, route) => {
    const catalog = (await import(paths.catalogFile)).catalog as Catalog;
    const intent = parseIntent(readFileSync(route.intentPath!, "utf8"));
    const tools = {};
    for (const file of route.toolsPaths) Object.assign(tools, toolsFromModule(await import(file)));
    const result = validateSpec(JSON.parse(readFileSync(route.specPath!, "utf8")), {
      catalog: intent.frontmatter.catalog ? catalog.subset(intent.frontmatter.catalog) : catalog,
      tools,
      params: route.paramNames,
    });
    expect(result.ok ? [] : result.errors).toEqual([]);
  });
});

describe("codegen", () => {
  it("emits the client route table", () => {
    expect(rel(routesModule(routes, paths))).toMatchSnapshot();
  });

  it("emits a self-contained server module", () => {
    const code = rel(serverModule(routes, paths));
    expect(code).toContain('import * as T0 from "<root>/app/tools.ts";');
    expect(code).toContain("dev: false");
    expect(code).toContain("A morning check for whoever is on watering duty.");
  });
});
