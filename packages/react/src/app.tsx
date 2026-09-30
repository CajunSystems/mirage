import { useMemo, type ComponentType } from "react";
import { createBrowserRouter, Outlet, RouterProvider, useNavigate, useParams, type RouteObject } from "react-router";
import type { Catalog, Spec, ValidationError } from "@mirage/core";
import { MirageView } from "./MirageView.js";
import { httpCallTool } from "./runtime.js";
import { useGeneratedSpec } from "./stream.js";

export type Mode = "locked" | "cached" | "live";

/** One entry of `virtual:mirage/routes`. */
export type MirageRoute = {
  /** React Router path, e.g. "/plants/:id". */
  path: string;
  mode: Mode;
  /** Committed `page.spec.json`, when present. */
  spec?: Spec;
  /** Ejected `page.tsx`, when present. */
  page?: ComponentType;
  /** Layouts from the root down, as `{ id, component }`. */
  layouts: { id: string; component: ComponentType }[];
};

declare const process: { env: { NODE_ENV?: string } };
const isDev = (() => {
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return true;
  }
})();

export function MirageErrorOverlay({ message, errors }: { message: string; errors?: ValidationError[] }) {
  if (!isDev) return <p role="alert">This page could not be loaded.</p>;
  return (
    <div role="alert" className="mi-error-overlay" style={{ border: "1px solid #b3362f", borderRadius: 8, padding: 16, fontFamily: "ui-monospace, monospace", fontSize: 13, whiteSpace: "pre-wrap" }}>
      <strong>Mirage: {message}</strong>
      {errors?.length ? (
        <ul>
          {errors.map((e, i) => (
            <li key={i}>
              {e.path}: {e.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Renders one route: the committed spec when there is one, otherwise a generated (streamed) spec. */
export function MiragePage({ route, catalog }: { route: MirageRoute; catalog: Catalog }) {
  const params = useParams() as Record<string, string>;
  const navigate = useNavigate();
  const useStatic = route.spec !== undefined && route.mode !== "live";
  const generated = useGeneratedSpec(route.path, params, { enabled: !useStatic });
  const callTool = useMemo(() => httpCallTool(route.path, params), [route.path, JSON.stringify(params)]);

  const spec = useStatic ? route.spec! : generated.spec;
  return (
    <>
      {!useStatic && generated.status === "error" && <MirageErrorOverlay message={generated.message} errors={generated.errors} />}
      {spec && <MirageView key={route.path} spec={spec} catalog={catalog} params={params} callTool={callTool} navigate={navigate} />}
    </>
  );
}

/** Builds nested React Router routes: one pathless route per layout, pages as leaves. */
export function createMirageRoutes(routes: MirageRoute[], catalog: Catalog, depth = 0): RouteObject[] {
  const out: RouteObject[] = [];
  const groups = new Map<string, { layout: ComponentType; routes: MirageRoute[] }>();
  for (const route of routes) {
    const layout = route.layouts[depth];
    if (!layout) {
      const Page = route.page;
      out.push({ path: route.path, element: Page ? <Page /> : <MiragePage route={route} catalog={catalog} /> });
      continue;
    }
    const group = groups.get(layout.id) ?? { layout: layout.component, routes: [] };
    group.routes.push(route);
    groups.set(layout.id, group);
  }
  for (const [id, { layout: Layout, routes: children }] of groups) {
    out.push({ id, element: <Layout />, children: createMirageRoutes(children, catalog, depth + 1) });
  }
  return out;
}

export function MirageApp({ routes, catalog }: { routes: MirageRoute[]; catalog: Catalog }) {
  const router = useMemo(() => createBrowserRouter(createMirageRoutes(routes, catalog)), [routes, catalog]);
  return <RouterProvider router={router} />;
}

export { Outlet };
