// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ComponentType } from "react";
import type { Catalog, Spec } from "@mirage/core";
import { MirageView, httpCallTool } from "@mirage/react";
import { createMirageServer, scanRoutes } from "@mirage/server";
import { ejectSpec } from "../src/eject.js";

const here = dirname(fileURLToPath(import.meta.url));
const example = resolve(here, "../../../examples/greenhouse");
const outDir = join(example, ".mirage", "eject-test");
const cases = [
  { name: "home", route: "/", url: "/", params: {}, spec: "app/page.spec.json" },
  { name: "plants", route: "/plants", url: "/plants", params: {}, spec: "app/plants/page.spec.json" },
  { name: "plant", route: "/plants/:id", url: "/plants/basil", params: { id: "basil" }, spec: "app/plants/[id]/page.spec.json" },
];

let catalog: Catalog;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  catalog = (await import(join(example, "catalog.ts"))).catalog;
  const server = createMirageServer({
    config: {},
    catalog,
    routes: scanRoutes(join(example, "app")),
    loadModule: (p) => import(p),
    cacheDir: join(outDir, "cache"),
    dev: true,
    log: () => {},
  });
  // Route the browser-side tool calls to the example's real tools.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    server.app.request(String(input), init)) as typeof fetch;
  rmSync(outDir, { recursive: true, force: true });
  for (const c of cases) {
    const spec = JSON.parse(readFileSync(join(example, c.spec), "utf8")) as Spec;
    mkdirSync(join(outDir, c.name), { recursive: true });
    writeFileSync(join(outDir, c.name, "page.tsx"), ejectSpec(spec, { catalog, route: c.route, catalogImport: "../../../catalog" }));
  }
});

afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(outDir, { recursive: true, force: true });
});

const settled = (container: HTMLElement) =>
  waitFor(() => {
    expect(container.querySelector("[data-mirage-skeleton]")).toBeNull();
    expect(container.textContent).not.toContain("Loading…");
  });

describe("eject", () => {
  it("emits TSX that type-checks with tsc", () => {
    writeFileSync(
      join(outDir, "tsconfig.json"),
      JSON.stringify({ extends: "../../tsconfig.json", include: cases.map((c) => `${c.name}/page.tsx`) }),
    );
    const tsc = resolve(here, "../../../node_modules/typescript/bin/tsc");
    const run = () => {
      try {
        return execFileSync(process.execPath, [tsc, "--noEmit", "-p", join(outDir, "tsconfig.json")], { encoding: "utf8" });
      } catch (error) {
        return (error as { stdout: string }).stdout || String(error);
      }
    };
    expect(run()).toBe("");
  }, 60_000);

  it.each(cases)("renders the same DOM as the spec renderer ($name)", async (c) => {
    const spec = JSON.parse(readFileSync(join(example, c.spec), "utf8")) as Spec;
    const viewed = render(
      <MemoryRouter initialEntries={[c.url]}>
        <MirageView spec={spec} catalog={catalog} params={c.params} callTool={httpCallTool(c.route, c.params)} dev />
      </MemoryRouter>,
    );
    await settled(viewed.container);
    const expected = viewed.container.innerHTML;
    cleanup();

    const Page = (await import(join(outDir, c.name, "page.tsx"))).default as ComponentType;
    const ejected = render(
      <MemoryRouter initialEntries={[c.url]}>
        <Routes>
          <Route path={c.route} element={<Page />} />
        </Routes>
      </MemoryRouter>,
    );
    await settled(ejected.container);
    expect(ejected.container.innerHTML).toBe(expected);
    expect(expected).toMatchSnapshot();
    cleanup();
  });
});
