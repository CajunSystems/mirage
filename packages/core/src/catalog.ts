import { z } from "zod";
import { BindingSchema, DataSourceSchema, isOptional, kindOf } from "./schema.js";
import type { Spec } from "./spec.js";

export type PropsSchema = z.ZodObject<z.ZodRawShape>;

export type CatalogEntry<P extends PropsSchema = PropsSchema, C = unknown> = {
  description: string;
  props: P;
  component: C;
  /** Marks a container component that accepts `children`. */
  children?: boolean;
};

export type ComponentDescription = {
  name: string;
  description: string;
  container: boolean;
  props: Record<string, unknown>;
};

export type Catalog<E extends Record<string, CatalogEntry> = Record<string, CatalogEntry>> = {
  entries: E;
  /** Names of every entry. */
  names: (keyof E & string)[];
  /** JSON Schema + description per component, for the prompt. */
  describe(): ComponentDescription[];
  /** The zod schema of a complete spec built from this catalog. */
  specSchema: z.ZodType<Spec>;
  /** Per-type schema for props as they appear in a spec (bindings allowed). */
  specPropsSchema(type: string): z.ZodType | undefined;
  /** Per-type schema for props after resolution (what the component receives). */
  runtimePropsSchema(type: string): z.ZodType | undefined;
  /** Returns a catalog restricted to the given names (unknown names are ignored). */
  subset(names: readonly string[]): Catalog;
};

const fnSchema = z.custom<(...args: unknown[]) => void>((v) => typeof v === "function", "expected an action handler");

function specProp(schema: z.ZodType): z.ZodType {
  if (kindOf(schema)) return schema;
  // Specs are data: defaults are applied when rendering, not when validating.
  const base = schema instanceof z.ZodDefault ? (schema.unwrap() as z.ZodType) : schema;
  const union = z.union([base, BindingSchema]);
  return isOptional(schema) ? union.optional() : union;
}

function runtimeProp(schema: z.ZodType): z.ZodType {
  const kind = kindOf(schema);
  if (kind === "ref") return z.any();
  if (kind === "action") return isOptional(schema) ? fnSchema.optional() : fnSchema;
  return schema;
}

function mapShape(props: PropsSchema, fn: (s: z.ZodType) => z.ZodType) {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries(props.shape)) shape[key] = fn(value as z.ZodType);
  return z.object(shape).strict();
}

export function defineCatalog<E extends Record<string, CatalogEntry>>(entries: E): Catalog<E> {
  const names = Object.keys(entries) as (keyof E & string)[];
  if (names.length === 0) throw new Error("defineCatalog: the catalog must have at least one entry");

  const specProps = new Map<string, z.ZodType>();
  const runtimeProps = new Map<string, z.ZodType>();
  const elementSchemas = names.map((name) => {
    const entry = entries[name]!;
    const props = mapShape(entry.props, specProp);
    specProps.set(name, props);
    runtimeProps.set(name, mapShape(entry.props, runtimeProp));
    const propsOptional = Object.values(entry.props.shape).every((s) => isOptional(s as z.ZodType));
    const shape: Record<string, z.ZodType> = {
      type: z.literal(name),
      props: propsOptional ? props.optional() : props,
    };
    if (entry.children) shape.children = z.array(z.string()).optional();
    return z.object(shape).strict().meta({ description: entry.description });
  });

  const elementSchema =
    elementSchemas.length === 1
      ? elementSchemas[0]!
      : z.discriminatedUnion("type", elementSchemas as [z.ZodObject, ...z.ZodObject[]]);

  // Field order matters for streaming: root and data first, elements last.
  const specSchema = z
    .object({
      version: z.literal(1),
      root: z.string(),
      data: z.record(z.string(), DataSourceSchema).optional(),
      state: z.record(z.string(), z.unknown()).optional(),
      elements: z.record(z.string(), elementSchema),
    })
    .strict() as unknown as z.ZodType<Spec>;

  return {
    entries,
    names,
    specSchema,
    specPropsSchema: (type) => specProps.get(type),
    runtimePropsSchema: (type) => runtimeProps.get(type),
    describe: () =>
      names.map((name) => {
        const entry = entries[name]!;
        const { $schema: _ignored, ...props } = z.toJSONSchema(entry.props, {
          io: "input",
          unrepresentable: "any",
          // Keep bindings and actions compact; the prompt explains their shapes once.
          override: ({ zodSchema, jsonSchema }) => {
            const kind = kindOf(zodSchema as unknown as z.ZodType);
            if (!kind) return;
            for (const key of Object.keys(jsonSchema)) delete (jsonSchema as Record<string, unknown>)[key];
            Object.assign(jsonSchema, { "x-mirage": kind === "ref" ? "binding" : "action" });
          },
        });
        return { name, description: entry.description, container: Boolean(entry.children), props };
      }),
    subset(subsetNames) {
      const picked: Record<string, CatalogEntry> = {};
      for (const name of subsetNames) if (entries[name]) picked[name] = entries[name]!;
      return defineCatalog(picked);
    },
  };
}
