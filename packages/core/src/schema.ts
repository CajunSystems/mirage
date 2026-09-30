import { z as zod } from "zod";

/** Kinds of props that Mirage treats specially. */
export type MirageKind = "ref" | "action";

// A global symbol, not a module-level WeakMap: the catalog may be loaded through a different
// copy of this module (for example Vite's SSR loader) than the code that inspects it.
const KIND = Symbol.for("mirage.kind");
type Tagged = { [KIND]?: MirageKind };

// ---- Bindings ---------------------------------------------------------------

export const DataRefSchema = zod
  .object({ $data: zod.string(), path: zod.string().optional() })
  .strict()
  .meta({ description: "Reads a named data source. `path` optionally selects a field, e.g. \"name\" or \"items.0\"." });
export const StateRefSchema = zod
  .object({ $state: zod.string() })
  .strict()
  .meta({ description: "Reads local UI state at a dot path." });
export const ParamRefSchema = zod
  .object({ $param: zod.string() })
  .strict()
  .meta({ description: "Reads a route param." });
export const EventRefSchema = zod
  .object({ $event: zod.string() })
  .strict()
  .meta({ description: "Inside actions only: the value a component passes when it fires. \"\" is the whole value, \"id\" a field of it." });

export const BindingSchema = zod.union([DataRefSchema, StateRefSchema, ParamRefSchema]);

/** Free-form JSON arguments. Values may contain bindings and `$event` references. */
export const ArgsSchema = zod.record(zod.string(), zod.unknown());

// ---- Actions ----------------------------------------------------------------

export const EffectSchema = zod.union([
  zod.object({ refresh: zod.array(zod.string()) }).strict(),
  zod.object({ navigate: zod.string() }).strict(),
  zod.object({ setState: zod.object({ path: zod.string(), value: zod.unknown() }).strict() }).strict(),
]);

export const ActionSchema = zod.discriminatedUnion("$action", [
  zod
    .object({
      $action: zod.literal("tool"),
      name: zod.string(),
      args: ArgsSchema.optional(),
      then: zod.array(EffectSchema).optional(),
    })
    .strict(),
  zod.object({ $action: zod.literal("navigate"), to: zod.string() }).strict(),
  zod.object({ $action: zod.literal("setState"), path: zod.string(), value: zod.unknown() }).strict(),
]);

export const DataSourceSchema = zod.object({ tool: zod.string(), args: ArgsSchema.optional() }).strict();

// ---- Helpers exposed as z.ref() / z.action() --------------------------------

/** A prop that must be a binding (`$data`, `$state` or `$param`). The component receives a `DataResult`. */
export function ref() {
  const schema = BindingSchema.meta({
    description: "Binding: {\"$data\": name, \"path\"?: field} | {\"$state\": path} | {\"$param\": name}",
  });
  (schema as Tagged)[KIND] = "ref";
  return schema;
}

/** A prop that holds an action object. The component receives a function `(event?) => void`. */
export function action() {
  const schema = ActionSchema.meta({ description: "Action object ($action: tool | navigate | setState)" });
  (schema as Tagged)[KIND] = "action";
  return schema;
}

/** Returns the Mirage kind of a schema, looking through optional/default/nullable wrappers. */
export function kindOf(schema: zod.ZodType): MirageKind | undefined {
  let current: zod.ZodType | undefined = schema;
  for (let i = 0; current && i < 8; i++) {
    const kind = (current as Tagged)[KIND];
    if (kind) return kind;
    const inner: zod.ZodType | undefined = (current as unknown as { _zod: { def: { innerType?: zod.ZodType } } })._zod.def
      .innerType;
    current = inner;
  }
  return undefined;
}

/** True if the schema accepts `undefined` (optional or has a default). */
export function isOptional(schema: zod.ZodType): boolean {
  return schema.safeParse(undefined).success;
}
