import { useEffect, useState } from "react";
import { parsePartialJson } from "ai";
import type { GenerateEvent, PartialSpec, Spec, ValidationError } from "@mirage/core";

export type SpecStatus =
  | { status: "loading"; spec: null }
  | { status: "streaming"; spec: PartialSpec }
  | { status: "done"; spec: Spec; source: string }
  | { status: "error"; spec: PartialSpec | null; message: string; errors?: ValidationError[] };

const lastKey = (o: object | undefined) => (o ? Object.keys(o).at(-1) : undefined);
const without = <T extends object>(o: T, key: string | undefined): T => {
  if (key === undefined) return o;
  const { [key]: _dropped, ...rest } = o as Record<string, unknown>;
  return rest as T;
};

/**
 * Drops entries that may still be incomplete while streaming: the last element, and the
 * last data source until `elements` has started (fields stream in schema order).
 */
export function settle(partial: PartialSpec): PartialSpec {
  const out: PartialSpec = { ...partial };
  if (partial.elements) out.elements = without(partial.elements, lastKey(partial.elements));
  else {
    if (partial.data) out.data = without(partial.data, lastKey(partial.data));
    delete out.state;
  }
  return out;
}

/** Reads an NDJSON generate stream and calls `onEvent` for each event. */
export async function readGenerateStream(res: Response, onEvent: (e: GenerateEvent) => void) {
  if (!res.body) throw new Error("empty response");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as GenerateEvent);
    }
    if (done) break;
  }
}

/** Requests a spec for a route and streams partial specs while it is generated. */
export function useGeneratedSpec(route: string, params: Record<string, string>, options: { enabled?: boolean; base?: string } = {}) {
  const { enabled = true, base = "" } = options;
  const [state, setState] = useState<SpecStatus>({ status: "loading", spec: null });
  const [nonce, setNonce] = useState(0);
  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    if (!enabled) return;
    const onRegenerate = (e: Event) => {
      if ((e as CustomEvent<{ route?: string }>).detail?.route === route) setNonce((n) => n + 1);
    };
    window.addEventListener("mirage:regenerate", onRegenerate);
    return () => window.removeEventListener("mirage:regenerate", onRegenerate);
  }, [route, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let text = "";
    let latest: PartialSpec | null = null;
    let parsing = Promise.resolve();
    setState({ status: "loading", spec: null });

    const onEvent = (e: GenerateEvent) => {
      if (e.type === "spec") setState({ status: "done", spec: e.spec, source: e.source });
      else if (e.type === "retry") text = "";
      else if (e.type === "error") setState({ status: "error", spec: latest, message: e.message, errors: e.errors });
      else if (e.type === "delta") {
        text += e.text;
        const snapshot = text;
        parsing = parsing.then(async () => {
          const { value } = await parsePartialJson(snapshot);
          if (controller.signal.aborted || !value || typeof value !== "object") return;
          latest = settle(value as PartialSpec);
          setState((s) => (s.status === "done" || s.status === "error" ? s : { status: "streaming", spec: latest! }));
        });
      }
    };

    fetch(`${base}/__mirage/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route, params }),
      signal: controller.signal,
    })
      .then((res) => readGenerateStream(res, onEvent))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", spec: latest, message: String(error) });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, paramsKey, enabled, base, nonce]);

  return state;
}
