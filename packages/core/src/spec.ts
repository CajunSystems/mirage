export const SPEC_VERSION = 1 as const;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type DataRef = { $data: string; path?: string };
export type StateRef = { $state: string };
export type ParamRef = { $param: string };
export type EventRef = { $event: string };
export type Binding = DataRef | StateRef | ParamRef;

export type Args = Record<string, unknown>;

export type Effect =
  | { refresh: string[] }
  | { navigate: string }
  | { setState: { path: string; value: unknown } };

export type Action =
  | { $action: "tool"; name: string; args?: Args; then?: Effect[] }
  | { $action: "navigate"; to: string }
  | { $action: "setState"; path: string; value: unknown };

export type DataSource = { tool: string; args?: Args };

export type Element = {
  type: string;
  props?: Record<string, unknown>;
  children?: string[];
};

export type Spec = {
  version: typeof SPEC_VERSION;
  root: string;
  elements: Record<string, Element>;
  data?: Record<string, DataSource>;
  state?: Record<string, unknown>;
};

/** Deeply partial spec, as seen while streaming. */
export type PartialSpec = {
  version?: number;
  root?: string;
  elements?: Record<string, Partial<Element> | undefined>;
  data?: Record<string, Partial<DataSource> | undefined>;
  state?: Record<string, unknown>;
};

/** What a component receives for a `z.ref()` prop. */
export type DataResult<T = unknown> = { data: T | undefined; loading: boolean; error: string | null };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const isDataRef = (v: unknown): v is DataRef => isObj(v) && typeof v.$data === "string";
export const isStateRef = (v: unknown): v is StateRef => isObj(v) && typeof v.$state === "string";
export const isParamRef = (v: unknown): v is ParamRef => isObj(v) && typeof v.$param === "string";
export const isEventRef = (v: unknown): v is EventRef => isObj(v) && typeof v.$event === "string";
export const isBinding = (v: unknown): v is Binding => isDataRef(v) || isStateRef(v) || isParamRef(v);
export const isAction = (v: unknown): v is Action => isObj(v) && typeof v.$action === "string";

/** Reads a dot path ("a.b.0") from a value. An empty path returns the value itself. */
export function getPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current = value;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Returns a copy of `target` with `value` written at the dot path. */
export function setPath<T>(target: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  if (head === undefined || head === "") return value as T;
  const base: Record<string, unknown> = Array.isArray(target)
    ? ([...target] as unknown as Record<string, unknown>)
    : isObj(target)
      ? { ...target }
      : {};
  base[head] = rest.length ? setPath(base[head], rest.join("."), value) : value;
  return base as T;
}

/** Same-origin path check used for every `navigate`. */
export function isSafePath(to: string): boolean {
  return to.startsWith("/") && !to.startsWith("//") && !to.includes("\\") && !/^\/*[a-z]+:/i.test(to);
}

/** Events sent by `POST /__mirage/generate`, one JSON object per line. */
export type GenerateEvent =
  | { type: "spec"; spec: Spec; source: "locked" | "cached" | "generated" }
  | { type: "delta"; text: string }
  | { type: "retry"; attempt: number; errors: { path: string; message: string }[] }
  | { type: "error"; message: string; errors?: { path: string; message: string }[] };
