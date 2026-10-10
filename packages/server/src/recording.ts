import { createHash } from "node:crypto";
import { wrapLanguageModel, type LanguageModel } from "ai";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";

/**
 * Recorded model responses, keyed by a hash of the prompt. Replaying a recording reproduces
 * generation (including repair turns) without calling a model, so tests can run against real
 * model output. Any change to an intent, the catalog or the tools changes the prompt, so a stale
 * recording fails loudly instead of replaying the wrong answer.
 */
export type Recording = {
  version: 1;
  responses: Record<string, { route?: string; text: string }>;
};

export type RecordedCall = {
  key: string;
  text: string;
  usage: { inputTokens: number | undefined; outputTokens: number | undefined };
};

export const emptyRecording = (): Recording => ({ version: 1, responses: {} });

/** Stable key for a model call: the prompt messages, which `buildPrompt` derives deterministically. */
export function promptKey(prompt: LanguageModelV4CallOptions["prompt"]): string {
  return createHash("sha256").update(JSON.stringify(prompt)).digest("hex").slice(0, 32);
}

/** Wraps a model so every completed streamed response is passed to `onRecord`. */
export function recordingModel(model: LanguageModel, onRecord: (call: RecordedCall) => void): LanguageModelV4 {
  if (typeof model === "string") throw new Error("recordingModel needs a model instance, not a model id string");
  return wrapLanguageModel({
    model,
    middleware: {
      async wrapStream({ doStream, params }) {
        const result = await doStream();
        const key = promptKey(params.prompt);
        let text = "";
        const tap = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type === "text-delta") text += part.delta;
            if (part.type === "finish") {
              onRecord({
                key,
                text,
                usage: { inputTokens: part.usage.inputTokens.total, outputTokens: part.usage.outputTokens.total },
              });
            }
            controller.enqueue(part);
          },
        });
        return { ...result, stream: result.stream.pipeThrough(tap) };
      },
    },
  });
}

/** A model that answers from a recording. Unknown prompts throw, naming how to re-record. */
export function replayModel(recording: Recording, options: { chunkSize?: number; delayMs?: number } = {}): LanguageModelV4 {
  const { chunkSize = 64, delayMs = 0 } = options;
  const usage = {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
  return {
    specificationVersion: "v4",
    provider: "mirage-replay",
    modelId: "replay",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("replayModel only supports streaming");
    },
    async doStream({ prompt, abortSignal }) {
      const key = promptKey(prompt);
      const entry = recording.responses[key];
      if (!entry) {
        throw new Error(`No recorded response for prompt ${key}. The intent, catalog or tools changed since recording; re-record with \`mirage eval --record\`.`);
      }
      const chunks = entry.text.match(new RegExp(`[\\s\\S]{1,${chunkSize}}`, "g")) ?? [];
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "replay" });
          for (const delta of chunks) {
            if (abortSignal?.aborted) break;
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
            controller.enqueue({ type: "text-delta", id: "replay", delta });
          }
          controller.enqueue({ type: "text-end", id: "replay" });
          controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
          controller.close();
        },
      });
      return { stream };
    },
  };
}
