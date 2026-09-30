import { z } from "zod";

export type ToolContext = {
  request: Request;
  params: Record<string, string>;
  [key: string]: unknown;
};

export type ToolDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = {
  description: string;
  input: I;
  output: O;
  /** Mutations are never fired from `$data` sources, only from actions. */
  mutation?: boolean;
  handler: (input: z.output<I>, ctx: ToolContext) => Promise<z.input<O>> | z.input<O>;
};

export type Tool<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = ToolDefinition<I, O> & {
  readonly kind: "mirage-tool";
};

export type ToolSignature = {
  name: string;
  description: string;
  mutation: boolean;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
};

export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: ToolDefinition<I, O>): Tool<I, O> {
  return { ...def, kind: "mirage-tool" };
}

export function isTool(value: unknown): value is Tool {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "mirage-tool";
}

/** Collects the tools exported by a `tools.ts` module. The export name is the tool name. */
export function toolsFromModule(mod: Record<string, unknown>): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const [name, value] of Object.entries(mod)) if (isTool(value)) tools[name] = value;
  return tools;
}

const toJson = (schema: z.ZodType) => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { unrepresentable: "any" });
  return rest;
};

/** What the model is allowed to see about a tool. Never the handler. */
export function toolSignature(name: string, tool: Tool): ToolSignature {
  return {
    name,
    description: tool.description,
    mutation: Boolean(tool.mutation),
    input: toJson(tool.input),
    output: toJson(tool.output),
  };
}
