import { jsonSchema, Output, streamText, type LanguageModel } from "ai";
import { z } from "zod";
import { validateSpec, type Catalog, type Spec, type ToolSignature, type ValidationError } from "@mirage/core";
import { buildPrompt, type PromptInput } from "./prompt.js";

export type GenerateOptions = {
  model: LanguageModel;
  catalog: Catalog;
  tools: ToolSignature[];
  intent: PromptInput["intent"];
  route: PromptInput["route"];
  /** Repair attempts after the first try. Default 2. */
  maxRepairs?: number;
  onDelta?: (text: string) => void;
  onRetry?: (attempt: number, errors: ValidationError[]) => void;
  abortSignal?: AbortSignal;
};

export type GenerateResult = { ok: true; spec: Spec; attempts: number } | { ok: false; errors: ValidationError[]; attempts: number };

/** Streams a spec from the model, validates it, and retries with the errors (up to `maxRepairs` times). */
export async function generateSpec(options: GenerateOptions): Promise<GenerateResult> {
  const { model, catalog, tools, intent, route, maxRepairs = 2 } = options;
  const schema = jsonSchema(z.toJSONSchema(catalog.specSchema, { unrepresentable: "any" }) as Parameters<typeof jsonSchema>[0]);
  const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
  let repair: PromptInput["repair"];
  let errors: ValidationError[] = [];

  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    if (attempt > 1) options.onRetry?.(attempt, errors);
    const { system, prompt } = buildPrompt({ components: catalog.describe(), tools, intent, route, repair });
    const result = streamText({
      model,
      system,
      prompt,
      output: Output.object({ schema, name: "mirage_spec" }),
      abortSignal: options.abortSignal,
    });
    let text = "";
    for await (const delta of result.textStream) {
      text += delta;
      options.onDelta?.(delta);
    }

    if (options.abortSignal?.aborted) {
      return { ok: false, errors: [{ path: "(root)", message: "generation aborted" }], attempts: attempt };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      errors = [{ path: "(root)", message: `output is not valid JSON: ${(error as Error).message}` }];
      repair = { errors, previous: text };
      continue;
    }
    const validation = validateSpec(parsed, { catalog, tools: toolMap, params: route.params });
    if (validation.ok) return { ok: true, spec: validation.spec, attempts: attempt };
    errors = validation.errors;
    repair = { errors, previous: text };
  }
  return { ok: false, errors, attempts: maxRepairs + 1 };
}
