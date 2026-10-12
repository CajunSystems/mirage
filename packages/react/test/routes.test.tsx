// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import type { Spec } from "@cajunsystems/mirage-core";
import { basicCatalog } from "@cajunsystems/mirage-catalog-basic";
import { createMirageRoutes, type MirageRoute } from "@cajunsystems/mirage-react";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const heading = (text: string): Spec => ({ version: 1, root: "h", elements: { h: { type: "Heading", props: { text } } } });
const lazy = <T,>(value: T) => vi.fn(async () => ({ default: value }));

function Layout() {
  return (
    <main>
      <p>layout</p>
      <Outlet />
    </main>
  );
}

describe("createMirageRoutes", () => {
  it("loads a route's spec, page and layout only when the route is visited", async () => {
    const layout = lazy(Layout);
    const homeSpec = lazy(heading("Home"));
    const plantSpec = lazy(heading("Plant"));
    const ejected = lazy(() => <h1>Ejected</h1>);
    const routes: MirageRoute[] = [
      { path: "/", mode: "cached", loadSpec: homeSpec, layouts: [{ id: "app/layout.tsx", load: layout }] },
      { path: "/plants/:id", mode: "cached", loadSpec: plantSpec, layouts: [{ id: "app/layout.tsx", load: layout }] },
      { path: "/about", mode: "locked", loadPage: ejected, layouts: [{ id: "app/layout.tsx", load: layout }] },
    ];
    const router = createMemoryRouter(createMirageRoutes(routes, basicCatalog), { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
    expect(screen.getByText("layout")).toBeTruthy();
    expect([homeSpec, plantSpec, ejected].map((f) => f.mock.calls.length)).toEqual([1, 0, 0]);

    await act(() => router.navigate("/plants/p1"));
    expect(await screen.findByRole("heading", { name: "Plant" })).toBeTruthy();
    await act(() => router.navigate("/about"));
    expect(await screen.findByRole("heading", { name: "Ejected" })).toBeTruthy();
    expect([homeSpec, plantSpec, ejected].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    expect(layout.mock.calls.length).toBe(1); // one shared layout route
  });

  it("never fetches the committed spec of a live route", async () => {
    const loadSpec = lazy(heading("Committed"));
    const spec = heading("Generated");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ type: "spec", spec, source: "generated" }) + "\n"));
    const router = createMemoryRouter(createMirageRoutes([{ path: "/", mode: "live", loadSpec, layouts: [] }], basicCatalog));
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("heading", { name: "Generated" })).toBeTruthy();
    expect(loadSpec).not.toHaveBeenCalled();
  });

  it("still accepts eager specs, pages and layouts", async () => {
    const routes: MirageRoute[] = [{ path: "/", mode: "cached", spec: heading("Eager"), layouts: [{ id: "l", component: Layout }] }];
    render(<RouterProvider router={createMemoryRouter(createMirageRoutes(routes, basicCatalog))} />);
    expect(await screen.findByRole("heading", { name: "Eager" })).toBeTruthy();
    expect(screen.getByText("layout")).toBeTruthy();
  });
});
