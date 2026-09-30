import {
  Component,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { isAction, kindOf, type Action, type Catalog, type PartialSpec, type Spec } from "@mirage/core";
import { MirageRuntime, type CallTool } from "./runtime.js";

declare const process: { env: { NODE_ENV?: string } };
const defaultDev = (() => {
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return true;
  }
})();

type ViewContext = { spec: PartialSpec; catalog: Catalog; runtime: MirageRuntime; dev: boolean };
const Ctx = createContext<ViewContext | null>(null);

export type MirageViewProps = {
  spec: Spec | PartialSpec;
  catalog: Catalog;
  params?: Record<string, string>;
  /** How tools are called. Defaults to a no-op that rejects; MiragePage wires the HTTP caller. */
  callTool?: CallTool;
  navigate?: (to: string) => void;
  /** Show inline error chips. Defaults to true outside production builds. */
  dev?: boolean;
  onError?: (error: unknown) => void;
};

const noTools: CallTool = async (name) => {
  throw new Error(`No tool caller configured (tried "${name}")`);
};

export function Skeleton() {
  return <div className="mi-skeleton" data-mirage-skeleton="" aria-busy="true" />;
}

export function ErrorChip({ label, message }: { label: string; message: string }) {
  return (
    <span className="mi-error-chip" role="alert" data-mirage-error="">
      {label}: {message}
    </span>
  );
}

class ElementBoundary extends Component<{ id: string; dev: boolean; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { children: ReactNode }) {
    // Streaming or HMR may fix the element; retry on the next change.
    if (this.state.error && prev.children !== this.props.children) this.setState({ error: null });
  }
  render() {
    if (this.state.error) return this.props.dev ? <ErrorChip label={this.props.id} message={this.state.error.message} /> : null;
    return this.props.children;
  }
}

function MirageElement({ id }: { id: string }): ReactNode {
  const ctx = useContext(Ctx)!;
  const { spec, catalog, runtime, dev } = ctx;
  const el = spec.elements?.[id];
  if (!el || typeof el.type !== "string") return <Skeleton />;
  const entry = catalog.entries[el.type];
  if (!entry) return dev ? <ErrorChip label={id} message={`unknown component "${el.type}"`} /> : null;

  const shape = entry.props.shape as Record<string, Parameters<typeof kindOf>[0]>;
  const rawProps = el.props ?? {};
  const props: Record<string, unknown> = {};
  let pending = false;
  for (const [key, value] of Object.entries(rawProps)) {
    const kind = shape[key] ? kindOf(shape[key]) : undefined;
    if (kind === "action" && isAction(value)) props[key] = (event?: unknown) => runtime.dispatch(value as Action, event);
    else if (kind === "ref") props[key] = runtime.resolveRef(value);
    else {
      if (runtime.isPending(value)) pending = true;
      props[key] = runtime.resolve(value);
    }
  }
  if (pending) return <Skeleton />;

  const parsed = catalog.runtimePropsSchema(el.type)!.safeParse(props);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return dev ? <ErrorChip label={`${id} (${el.type})`} message={`${issue.path.join(".") || "props"}: ${issue.message}`} /> : null;
  }

  const Comp = entry.component as ComponentType<Record<string, unknown>>;
  if (!entry.children) return <Comp {...(parsed.data as Record<string, unknown>)} />;
  const children = (el.children ?? []).map((childId) => <ElementSlot key={childId} id={childId} />);
  return <Comp {...(parsed.data as Record<string, unknown>)}>{children}</Comp>;
}

function ElementSlot({ id }: { id: string }) {
  const { dev } = useContext(Ctx)!;
  return (
    <ElementBoundary id={id} dev={dev}>
      <MirageElement id={id} />
    </ElementBoundary>
  );
}

/** Renders a (possibly partial) spec with components from the catalog. */
export function MirageView({ spec, catalog, params = {}, callTool = noTools, navigate, dev = defaultDev, onError }: MirageViewProps) {
  const runtimeRef = useRef<MirageRuntime | null>(null);
  const options = {
    params,
    callTool,
    navigate: navigate ?? ((to: string) => window.location.assign(to)),
    onError,
  };
  if (!runtimeRef.current) runtimeRef.current = new MirageRuntime(options);
  const runtime = runtimeRef.current;
  runtime.options = options;

  const dataKey = JSON.stringify(spec.data ?? {});
  const stateKey = JSON.stringify(spec.state ?? {});
  const paramsKey = JSON.stringify(params);
  useEffect(() => {
    runtime.update(spec.data as Spec["data"], spec.state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, dataKey, stateKey, paramsKey]);

  useSyncExternalStore(runtime.subscribe, runtime.getVersion, runtime.getVersion);
  const ctx = useMemo(() => ({ spec, catalog, runtime, dev }), [spec, catalog, runtime, dev, runtime.version]);

  if (!spec.root) return <Skeleton />;
  return (
    <Ctx.Provider value={ctx}>
      <ElementSlot id={spec.root} />
    </Ctx.Provider>
  );
}
