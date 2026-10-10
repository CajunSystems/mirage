import { streamText, type LanguageModel } from "ai";
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
      // Plain text, no provider-side schema: constrained decoding cannot express the spec's id-keyed
      // maps (Anthropic forces them empty). The prompt carries every component and tool schema, and
      // validateSpec plus the repair loop enforce them.
      abortSignal: options.abortSignal,
      onError: () => {}, // surfaced through fullStream below
    });
    // fullStream, not textStream: textStream ends quietly on provider errors (auth, rate limits),
    // which would look like truncated JSON and burn repair attempts.
    let text = "";
    for await (const part of result.fullStream) {
      if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(String(part.error));
      if (part.type === "text-delta") {
        text += part.text;
        options.onDelta?.(part.text);
      }
    }

    if (options.abortSignal?.aborted) {
      return { ok: false, errors: [{ path: "(root)", message: "generation aborted" }], attempts: attempt };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(text));
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

/** Some models wrap JSON in a Markdown fence despite instructions. */
function stripFences(text: string): string {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return match ? match[1]! : text;
}
