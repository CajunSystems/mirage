import { useMemo, type ComponentType } from "react";
import { createBrowserRouter, Outlet, RouterProvider, useNavigate, useParams, type RouteObject } from "react-router";
import type { Catalog, Spec, ValidationError } from "@cajunsystems/mirage-core";
import { MirageView } from "./MirageView.js";
import { httpCallTool } from "./runtime.js";
import { useGeneratedSpec } from "./stream.js";

export type Mode = "locked" | "cached" | "live";

/** A dynamic import, e.g. `() => import("./page.spec.json")`. */
export type Lazy<T> = () => Promise<{ default: T }>;

/**
 * One entry of `virtual:mirage/routes`. The generated table uses the `load*` fields, so each
 * route's spec, page and layouts are separate chunks fetched when the route is first visited.
 * The eager fields are for routes built in code; when both are set, the eager one wins.
 */
export type MirageRoute = {
  /** React Router path, e.g. "/plants/:id". */
  path: string;
  mode: Mode;
  /** Committed `page.spec.json`, when present. */
  spec?: Spec;
  loadSpec?: Lazy<Spec>;
  /** Ejected `page.tsx`, when present. */
  page?: ComponentType;
  loadPage?: Lazy<ComponentType>;
  /** Layouts from the root down. `id` is stable and shared by every route under the layout. */
  layouts: { id: string; component?: ComponentType; load?: Lazy<ComponentType> }[];
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

/**
 * Rendered while the first page's lazy files load (React Router warns without one). The files are
 * small, so nothing is shown rather than a flash of loading UI.
 */
const HydrateFallback = () => null;

/** The leaf route for a page: an ejected component, or a spec (committed or generated). */
function pageRoute(route: MirageRoute, catalog: Catalog): RouteObject {
  const { path } = route;
  if (route.page) {
    const Page = route.page;
    return { path, element: <Page /> };
  }
  if (route.loadPage) {
    const load = route.loadPage;
    return { path, HydrateFallback, lazy: async () => ({ Component: (await load()).default }) };
  }
  // Live routes always generate, so their committed spec is never fetched.
  if (route.spec === undefined && route.loadSpec && route.mode !== "live") {
    const load = route.loadSpec;
    return {
      path,
      HydrateFallback,
      lazy: async () => {
        const spec = (await load()).default;
        return { element: <MiragePage route={{ ...route, spec }} catalog={catalog} /> };
      },
    };
  }
  return { path, element: <MiragePage route={route} catalog={catalog} /> };
}

/** Builds nested React Router routes: one pathless route per layout, pages as leaves. */
export function createMirageRoutes(routes: MirageRoute[], catalog: Catalog, depth = 0): RouteObject[] {
  const out: RouteObject[] = [];
  const groups = new Map<string, { layout: MirageRoute["layouts"][number]; routes: MirageRoute[] }>();
  for (const route of routes) {
    const layout = route.layouts[depth];
    if (!layout) {
      out.push(pageRoute(route, catalog));
      continue;
    }
    const group = groups.get(layout.id) ?? { layout, routes: [] };
    group.routes.push(route);
    groups.set(layout.id, group);
  }
  for (const [id, { layout, routes: children }] of groups) {
    const nested = createMirageRoutes(children, catalog, depth + 1);
    if (layout.component) {
      const Layout = layout.component;
      out.push({ id, element: <Layout />, children: nested });
    } else if (layout.load) {
      const load = layout.load;
      out.push({ id, HydrateFallback, lazy: async () => ({ Component: (await load()).default }), children: nested });
    } else {
      throw new Error(`Layout "${id}" has neither a component nor a loader`);
    }
  }
  return out;
}

export function MirageApp({ routes, catalog }: { routes: MirageRoute[]; catalog: Catalog }) {
  const router = useMemo(() => createBrowserRouter(createMirageRoutes(routes, catalog)), [routes, catalog]);
  return <RouterProvider router={router} />;
}

export { Outlet };
