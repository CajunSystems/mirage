import {
  getPath,
  isDataRef,
  isEventRef,
  isParamRef,
  isSafePath,
  isStateRef,
  setPath,
  type Action,
  type DataResult,
  type DataSource,
  type Effect,
} from "@cajunsystems/mirage-core";

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type RuntimeOptions = {
  params: Record<string, string>;
  callTool: CallTool;
  navigate: (to: string) => void;
  onError?: (error: unknown) => void;
};

const NO_EVENT = Symbol("no-event");
const idle: DataResult = { data: undefined, loading: true, error: null };

/**
 * Per-page state: local UI state, data source results and action dispatch.
 * One instance per mounted page; components subscribe via useSyncExternalStore.
 */
export class MirageRuntime {
  state: Record<string, unknown> = {};
  data: Record<string, DataResult> = {};
  version = 0;
  private sources: Record<string, DataSource> = {};
  private fetchedKeys: Record<string, string> = {};
  private requestIds: Record<string, number> = {};
  private listeners = new Set<() => void>();

  constructor(public options: RuntimeOptions) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** Adds data sources and initial state from a (possibly partial) spec. Existing state is kept. */
  update(sources: Record<string, DataSource> | undefined, initialState: Record<string, unknown> | undefined) {
    let changed = false;
    for (const [key, value] of Object.entries(initialState ?? {})) {
      if (!(key in this.state)) {
        this.state = { ...this.state, [key]: value };
        changed = true;
      }
    }
    this.sources = sources ?? {};
    if (changed) this.emit();
    this.sync();
  }

  setState(path: string, value: unknown) {
    this.state = setPath(this.state, path, value);
    this.emit();
    this.sync();
  }

  /** Fetches every data source whose resolved args changed since the last fetch. */
  sync() {
    for (const [name, source] of Object.entries(this.sources)) {
      if (typeof source?.tool !== "string") continue;
      const args = (this.resolve(source.args ?? {}) ?? {}) as Record<string, unknown>;
      const key = `${source.tool}:${JSON.stringify(args)}`;
      if (this.fetchedKeys[name] !== key) {
        this.fetchedKeys[name] = key;
        void this.fetch(name, source.tool, args);
      }
    }
  }

  refresh(names: string[]) {
    for (const name of names) delete this.fetchedKeys[name];
    this.sync();
  }

  private async fetch(name: string, tool: string, args: Record<string, unknown>) {
    const id = (this.requestIds[name] = (this.requestIds[name] ?? 0) + 1);
    const previous = this.data[name];
    this.data = { ...this.data, [name]: { data: previous?.data, loading: true, error: null } };
    this.emit();
    let result: DataResult;
    try {
      result = { data: await this.options.callTool(tool, args), loading: false, error: null };
    } catch (error) {
      result = { data: undefined, loading: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (this.requestIds[name] !== id) return; // a newer request superseded this one
    this.data = { ...this.data, [name]: result };
    this.emit();
  }

  /** The DataResult a `z.ref()` prop receives. */
  resolveRef(binding: unknown): DataResult {
    if (isDataRef(binding)) {
      const result = this.data[binding.$data] ?? idle;
      return { ...result, data: getPath(result.data, binding.path) };
    }
    return { data: this.resolve(binding), loading: false, error: null };
  }

  /** True if the value reads a data source that has not resolved yet. */
  isPending(value: unknown): boolean {
    if (isDataRef(value)) return (this.data[value.$data] ?? idle).loading && this.data[value.$data]?.data === undefined;
    if (Array.isArray(value)) return value.some((v) => this.isPending(v));
    if (value && typeof value === "object") return Object.values(value).some((v) => this.isPending(v));
    return false;
  }

  /** Deeply replaces `$data`, `$state`, `$param` (and `$event`, when an event is given) with values. */
  resolve(value: unknown, event: unknown = NO_EVENT): unknown {
    if (isDataRef(value)) return getPath(this.data[value.$data]?.data, value.path);
    if (isStateRef(value)) return getPath(this.state, value.$state);
    if (isParamRef(value)) return this.options.params[value.$param];
    if (isEventRef(value) && event !== NO_EVENT) return getPath(event, value.$event);
    if (Array.isArray(value)) return value.map((v) => this.resolve(v, event));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.resolve(v, event)]));
    }
    return value;
  }

  /** Fills `:name` segments from the event, then route params. */
  private path(to: string, event: unknown) {
    return to.replace(/:([A-Za-z_][\w]*)/g, (match, name: string) => {
      const value = getPath(event, name) ?? this.options.params[name];
      return value === undefined || value === null ? match : encodeURIComponent(String(value));
    });
  }

  private go(to: string, event: unknown) {
    const target = this.path(to, event);
    if (isSafePath(target)) this.options.navigate(target);
    else this.options.onError?.(new Error(`Blocked navigation to "${target}"`));
  }

  private applyEffect(effect: Effect, event: unknown) {
    if ("refresh" in effect) this.refresh(effect.refresh);
    else if ("navigate" in effect) this.go(effect.navigate, event);
    else if ("setState" in effect) this.setState(effect.setState.path, this.resolve(effect.setState.value, event));
  }

  dispatch = async (action: Action, event?: unknown) => {
    try {
      if (action.$action === "navigate") this.go(action.to, event);
      else if (action.$action === "setState") this.setState(action.path, this.resolve(action.value, event));
      else if (action.$action === "tool") {
        const args = (this.resolve(action.args ?? {}, event) ?? {}) as Record<string, unknown>;
        await this.options.callTool(action.name, args);
        for (const effect of action.then ?? []) this.applyEffect(effect, event);
      }
    } catch (error) {
      (this.options.onError ?? console.error)(error);
    }
  };
}

/** The default tool caller: `POST /__mirage/tools/:name`. */
export function httpCallTool(route: string, params: Record<string, string>, base = ""): CallTool {
  return async (name, args) => {
    const res = await fetch(`${base}/__mirage/tools/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route, params, args }),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok) throw new Error(body.error ?? `Tool "${name}" failed with ${res.status}`);
    return body.result;
  };
}
