import type { z } from "zod";
import type { Catalog } from "./catalog.js";
import { isAction, isBinding, isDataRef, isEventRef, isParamRef, isSafePath, isStateRef, type Action, type Effect, type Spec } from "./spec.js";

export type ValidationError = { path: string; message: string };
export type ValidationResult = { ok: true; spec: Spec } | { ok: false; errors: ValidationError[] };

export type ValidateOptions = {
  catalog: Catalog;
  /** Tools visible to the route. Omit to skip tool checks. With `input`, literal args are checked against it. */
  tools?: Record<string, { mutation?: boolean; input?: z.ZodType }>;
  /** Route param names. Omit to skip `$param` checks. */
  params?: readonly string[];
};

const fmt = (path: readonly PropertyKey[]) =>
  path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join("") || "(root)";

/** Visits every object in a JSON-ish value with its path. */
function walk(value: unknown, path: PropertyKey[], visit: (v: Record<string, unknown>, path: PropertyKey[]) => void) {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, i], visit));
  else if (value && typeof value === "object") {
    visit(value as Record<string, unknown>, path);
    for (const [k, v] of Object.entries(value)) walk(v, [...path, k], visit);
  }
}

/** Validates a complete spec: schema first, then semantic checks. */
export function validateSpec(input: unknown, options: ValidateOptions): ValidationResult {
  const parsed = options.catalog.specSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => ({ path: fmt(i.path), message: i.message })) };
  }
  const spec = parsed.data;
  const errors: ValidationError[] = [];
  const err = (path: PropertyKey[], message: string) => errors.push({ path: fmt(path), message });
  const { tools, params } = options;

  // Structure: root exists, children exist, single parent, no cycles.
  if (!spec.elements[spec.root]) err(["root"], `root element "${spec.root}" does not exist`);
  const parentOf = new Map<string, string>();
  for (const [id, el] of Object.entries(spec.elements)) {
    el.children?.forEach((child, i) => {
      const path = ["elements", id, "children", i];
      if (!spec.elements[child]) err(path, `child "${child}" does not exist`);
      else if (parentOf.has(child)) err(path, `child "${child}" already has parent "${parentOf.get(child)}"`);
      else parentOf.set(child, id);
    });
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, trail: string[]) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      err(["elements", id], `cycle detected: ${[...trail, id].join(" -> ")}`);
      return;
    }
    state.set(id, "visiting");
    for (const child of spec.elements[id]?.children ?? []) if (spec.elements[child]) visit(child, [...trail, id]);
    state.set(id, "done");
  };
  for (const id of Object.keys(spec.elements)) visit(id, []);

  // Every element must be reachable from root; the renderer would silently drop the rest.
  if (spec.elements[spec.root]) {
    const reachable = new Set<string>();
    const queue = [spec.root];
    while (queue.length) {
      const id = queue.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const child of spec.elements[id]?.children ?? []) if (spec.elements[child]) queue.push(child);
    }
    for (const id of Object.keys(spec.elements)) if (!reachable.has(id)) err(["elements", id], `element "${id}" is not reachable from root`);
  }

  // Collect writable state roots (setState actions and effects).
  const writable = new Set(Object.keys(spec.state ?? {}));
  walk(spec, [], (obj) => {
    if (obj.$action === "setState" && typeof obj.path === "string") writable.add(obj.path.split(".")[0]!);
    const effect = obj.setState as { path?: unknown } | undefined;
    if (effect && typeof effect.path === "string") writable.add(effect.path.split(".")[0]!);
  });

  const dataNames = new Set(Object.keys(spec.data ?? {}));
  const checkTool = (path: PropertyKey[], name: string) => {
    if (tools && !tools[name]) err(path, `unknown tool "${name}"`);
  };

  // Literal args are checked against the tool's input schema. Bindings and $event values are only
  // known at runtime, so they (and anything nested under them) are skipped.
  const checkArgs = (path: PropertyKey[], name: string, args: Record<string, unknown> | undefined) => {
    const input = tools?.[name]?.input;
    if (!input) return;
    const dynamic: PropertyKey[][] = [];
    const strip = (value: unknown, at: PropertyKey[]): unknown => {
      if (isBinding(value) || isEventRef(value)) {
        dynamic.push(at);
        return undefined;
      }
      if (Array.isArray(value)) return value.map((v, i) => strip(v, [...at, i]));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strip(v, [...at, k])]));
      return value;
    };
    const result = input.safeParse(strip(args ?? {}, []));
    if (result.success) return;
    for (const issue of result.error.issues) {
      const covered = dynamic.some((d) => d.every((key, i) => issue.path[i] === key));
      if (!covered) err([...path, "args", ...issue.path], issue.message);
    }
  };

  // Data sources: tools exist and are not mutations.
  for (const [name, source] of Object.entries(spec.data ?? {})) {
    checkTool(["data", name, "tool"], source.tool);
    if (tools?.[source.tool]?.mutation) err(["data", name, "tool"], `tool "${source.tool}" is a mutation and cannot be a data source`);
    else checkArgs(["data", name], source.tool, source.args);
  }

  // Bindings and actions anywhere in data, props.
  const scan = (root: unknown, base: PropertyKey[]) =>
    walk(root, base, (obj, path) => {
      if (isDataRef(obj) && !dataNames.has(obj.$data)) err(path, `unknown data source "${obj.$data}"`);
      if (isStateRef(obj) && !writable.has(obj.$state.split(".")[0]!))
        err(path, `state "${obj.$state}" is neither declared in \`state\` nor written by any action`);
      if (isParamRef(obj) && params && !params.includes(obj.$param)) err(path, `unknown route param "${obj.$param}"`);
      if (isAction(obj)) checkAction(obj, path);
    });
  const checkEffects = (effects: Effect[], path: PropertyKey[]) =>
    effects.forEach((e, i) => {
      if ("refresh" in e)
        e.refresh.forEach((n, j) => {
          if (!dataNames.has(n)) err([...path, i, "refresh", j], `unknown data source "${n}"`);
        });
      if ("navigate" in e && !isSafePath(e.navigate)) err([...path, i, "navigate"], `navigate must be a same-origin path`);
    });
  const checkAction = (action: Action, path: PropertyKey[]) => {
    if (action.$action === "tool") {
      checkTool([...path, "name"], action.name);
      checkArgs(path, action.name, action.args);
      if (action.then) checkEffects(action.then, [...path, "then"]);
    }
    if (action.$action === "navigate" && !isSafePath(action.to)) err([...path, "to"], `navigate must be a same-origin path`);
  };
  scan(spec.data, ["data"]);
  for (const [id, el] of Object.entries(spec.elements)) scan(el.props, ["elements", id, "props"]);

  return errors.length ? { ok: false, errors } : { ok: true, spec };
}

export function formatErrors(errors: ValidationError[]): string {
  return errors.map((e) => `- ${e.path}: ${e.message}`).join("\n");
}
