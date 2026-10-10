// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { GenerateEvent, Spec } from "@cajunsystems/mirage-core";
import { parsePartialJson, useGeneratedSpec } from "@cajunsystems/mirage-react";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("parsePartialJson", () => {
  it("returns complete documents as-is", () => {
    expect(parsePartialJson('{"a":[1,2]}')).toEqual({ a: [1, 2] });
  });

  it("keeps only completed values from a prefix", () => {
    expect(parsePartialJson('{"root":"page","elements":{"a":{"type":"Sta')).toEqual({ root: "page", elements: { a: {} } });
    expect(parsePartialJson('{"a":1,"b":')).toEqual({ a: 1 });
    expect(parsePartialJson('{"a":[1,2,3')).toEqual({ a: [1, 2] });
    expect(parsePartialJson('{"a":tru')).toEqual({});
    expect(parsePartialJson('{"s":"a \\"quoted\\" word","t')).toEqual({ s: 'a "quoted" word' });
    expect(parsePartialJson("")).toBeUndefined();
  });

  it("is consistent at every prefix of a real spec", () => {
    const text = JSON.stringify({ version: 1, root: "p", elements: { p: { type: "Stack", children: ["x"] }, x: { type: "Text", props: { text: "hi, {there}" } } } });
    for (let i = 0; i <= text.length; i++) expect(() => parsePartialJson(text.slice(0, i))).not.toThrow();
  });
});

function streamResponse(events: GenerateEvent[]) {
  const body = events.map((e) => JSON.stringify(e) + "\n").join("");
  const chunks = body.match(/[\s\S]{1,17}/g)!;
  return new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    }),
  );
}

function Probe() {
  const s = useGeneratedSpec("/plants", {});
  return <pre data-testid="out">{JSON.stringify({ status: s.status, root: s.spec?.root, ids: Object.keys(s.spec?.elements ?? {}) })}</pre>;
}

describe("useGeneratedSpec", () => {
  const spec: Spec = { version: 1, root: "page", elements: { page: { type: "Stack" } } };

  it("streams deltas, resets on retry, and finishes with the validated spec", async () => {
    const text = JSON.stringify(spec);
    const fetchMock = vi.fn(async () =>
      streamResponse([
        { type: "delta", text: text.slice(0, 20) },
        { type: "retry", attempt: 2, errors: [] },
        { type: "delta", text },
        { type: "spec", spec, source: "generated" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("out").textContent).toContain('"status":"done"'));
    expect(JSON.parse(screen.getByTestId("out").textContent!)).toEqual({ status: "done", root: "page", ids: ["page"] });
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ route: "/plants", params: {} });
  });

  it("reports a non-OK response", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "route is required" }), { status: 400 }));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("out").textContent).toContain('"status":"error"'));
  });

  it("reports a stream that ends without a spec", async () => {
    vi.stubGlobal("fetch", async () => streamResponse([{ type: "delta", text: '{"root":"page"' }]));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("out").textContent).toContain('"status":"error"'));
  });

  it("previews fenced model output while it streams", async () => {
    // No spec event: the error state keeps the last streamed preview, so it can be inspected.
    vi.stubGlobal("fetch", async () =>
      streamResponse([{ type: "delta", text: '```json\n{"version":1,"root":"page","elements":{"a":{"type":"Stack"},"b":{"type":"Te' }]),
    );
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("out").textContent).toContain('"status":"error"'));
    expect(JSON.parse(screen.getByTestId("out").textContent!)).toEqual({ status: "error", root: "page", ids: ["a"] });
  });

  it("surfaces errors", async () => {
    vi.stubGlobal("fetch", async () => streamResponse([{ type: "error", message: "nope", errors: [{ path: "root", message: "bad" }] }]));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("out").textContent).toContain('"status":"error"'));
  });
});
