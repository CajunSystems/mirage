# Mirage

> Write the intent. Ship the mirage.

Mirage is a minimal generative-UI framework for React. It feels like Next.js: folders are routes, special files have special meaning, and server functions sit next to pages. The difference is that a page is an **intent** instead of a component. A model turns the intent into a **declarative UI spec** built only from a **catalog** of React components you control. Once you like what it made, you **lock** the spec and generation stops.

```bash
pnpm install && pnpm build
cd examples/greenhouse
pnpm dev                     # http://localhost:5173
```

The example is a greenhouse plant tracker. It has a daily watering overview, a searchable plant list with a "New plant" form, and a care page for each plant. Every page has a committed `page.spec.json`, so it runs without an API key. Set `ANTHROPIC_API_KEY` and delete a spec (`mirage unlock /plants`) to watch that page generate and stream in.

Design decisions and deviations from the original brief are recorded in [`docs/decisions.md`](docs/decisions.md). The build order, what shipped in v1, and what comes next are in [`docs/milestones.md`](docs/milestones.md).

---

## 1. Goals and non-goals

### Goals
- A Next.js-like developer experience: folders are routes, conventions over config.
- The model never writes code. It emits a validated JSON spec that references catalog components and named tools.
- Generation is a build-time-ish step by default: generate, cache, lock. Live generation is opt-in.
- Streaming, progressive rendering from partial specs.
- Fully typed: catalog, tools, and spec types are inferred from zod schemas.
- Small surface: about 2.8k lines of TypeScript across packages.

### Non-goals (v1)
- No SSR / RSC. Rendering is client-side, and a Node server handles generation and tools.
- No multi-provider abstraction beyond what the Vercel AI SDK already provides.
- No visual editor, no auth system, no deployment adapters.
- No generation of arbitrary JS/JSX. Ever.

---

## 2. Mental model

```
page.intent.md  ──►  generator (LLM, streamed)  ──►  spec (flat JSON)  ──►  renderer  ──►  React tree
                          ▲                                 │
                catalog + tool signatures                   └── lock ──► page.spec.json (committed)
```

| Next.js | Mirage |
|---|---|
| `page.tsx` | `page.intent.md` → spec |
| `layout.tsx` | `layout.tsx` (plain React, renders `<Outlet />`) |
| Server actions | `tools.ts` (named server functions the spec can call) |
| `loading.tsx` | Streaming partial specs (progressive rendering) |
| Static vs dynamic rendering | `mode: locked \| cached \| live` |
| Eject | `mirage eject` emits `page.tsx` from a spec |

---

## 3. Project layout (user app)

```
greenhouse/
  mirage.config.ts
  vite.config.ts                # react() + mirage()
  index.html, src/main.tsx      # <MirageApp routes={routes} catalog={catalog} />
  catalog.ts                    # defineCatalog(...) registry
  components/                   # your own catalog components
    MoistureMeter.tsx
  tools.ts                      # global tools (optional)
  app/
    layout.tsx                  # root layout, plain React
    tools.ts                    # tools for "/" and everything below it
    page.intent.md              # route "/"
    plants/
      page.intent.md            # route "/plants"
      page.spec.json            # written by `mirage lock` (committed)
      tools.ts                  # tools for "/plants" and its children
      [id]/
        page.intent.md          # route "/plants/:id"
        tools.ts
  .mirage/
    specs/                      # generation cache (gitignored)
```

Conventions:
- A directory that contains `page.intent.md` (or an ejected `page.tsx`) is a route. `[param]` segments are dynamic.
- `tools.ts` files are inherited down the tree. A route sees its own tools plus its ancestors' tools, and the nearest definition wins on a name conflict.
- If `page.spec.json` exists and the mode is not `live`, it is used as-is and nothing is generated.
- `layout.tsx` files are regular React components and render `<Outlet />`. They nest from the root down.

---

## 4. The intent file

`page.intent.md` is Markdown with YAML frontmatter.

```md
---
title: Plants
mode: cached            # locked | cached | live   (default: cached)
catalog: [Stack, Row, Heading, Text, Table, Button, Dialog, Form, TextInput]   # optional subset
---

A searchable list of every plant in the greenhouse.

- Show name, species, location, and whether it needs water.
- A search box filters by name, species or location as you type.
- Clicking a row opens the plant's page.
- A primary "New plant" button opens a form in a dialog: name, species, location, water every N days (default 7).
- Keep it dense and calm. No decorative elements.
```

Frontmatter keys: `title`, `mode`, `params` (for example `{ id: string }`, informational for the model), `catalog`, `specPerParams` (use a separate spec for each param value), `maxSpecs` (the cap on specs generated per route, default 100), and `ttl` (the reuse window for live pages, in seconds).

Rules:
- The body is free-form. It is passed verbatim to the model as the page brief.
- Frontmatter is validated with zod. Unknown keys are an error.
- The intent's content is part of the cache key (see section 10).

---

## 5. Catalog

The catalog is the **only vocabulary** the model has. Each entry pairs a React component with a zod prop schema and a description the model reads.

```ts
// catalog.ts
import { defineCatalog, z } from "@mirage/core";   // zod v4 + z.ref() / z.action()
import { basicCatalog } from "@mirage/catalog-basic";
import { MoistureMeter } from "./components/MoistureMeter";

export const catalog = defineCatalog({
  ...basicCatalog.entries,
  MoistureMeter: {
    description: "Soil moisture (0-100) as a bar. Below 30 is dry, above 80 is waterlogged.",
    props: z.object({ label: z.string().default("Soil moisture"), value: z.number().nullable() }),
    component: MoistureMeter,
  },
});
```

A table entry, for example, looks like this:

```ts
Table: {
  description: "Tabular data. `rows` must be a binding to an array.",
  props: z.object({
    rows: z.ref(),                                   // component receives { data, loading, error }
    columns: z.array(z.object({ key: z.string(), label: z.string() })),
    onRowClick: z.action().optional(),               // component receives (event?) => void
  }),
  component: Table,
},
```

- `defineCatalog` returns `entries`, `describe()` (a JSON Schema and description for each component, used in the prompt), `specSchema`, and `subset(names)`.
- `children: true` marks container components. Non-container components are rejected if they receive children.
- `@mirage/catalog-basic` ships `Stack`, `Row`, `Grid`, `Heading`, `Text`, `Card`, `Table`, `Button`, `Form`, `TextInput`, `Select`, `Badge`, `Stat`, `Tabs`, and `Dialog`. They use plain CSS with `--mi-*` variables (import `@mirage/catalog-basic/styles.css`).

---

## 6. The spec

### 6.1 Shape: flat, not nested

A spec is a **flat element map**, not a recursive tree. Structured-output providers support recursive JSON Schema poorly. A flat map also streams well, because each element is complete as soon as its object closes, and it diffs cleanly.

```ts
type Spec = {
  version: 1;
  root: string;                         // element id
  data?: Record<string, DataSource>;    // named data sources (6.2)
  state?: Record<string, unknown>;      // initial local UI state (6.3)
  elements: Record<string, Element>;
};

type Element = { type: string; props?: Record<string, unknown>; children?: string[] };
```

`catalog.specSchema` makes each value in `elements` a `z.discriminatedUnion("type", …)` over the catalog entries. The same schema constrains the model's output and validates the final spec.

### 6.2 Data bindings

Elements never contain fetched data. They reference **named data sources**, and each data source names a **tool** and its args.

```json
{
  "data": { "plants": { "tool": "listPlants", "args": { "query": { "$state": "search" } } } },
  "elements": {
    "table": { "type": "Table", "props": { "rows": { "$data": "plants" }, "columns": [ ... ] } },
    "title": { "type": "Heading", "props": { "text": { "$data": "plant", "path": "name" } } }
  }
}
```

- `{ "$data": name, "path"?: "a.b" }` reads a data source. `z.ref()` props receive `{ data, loading, error }`. Other props receive the value, and the element shows a skeleton while that value loads.
- `{ "$state": "a.b" }` and `{ "$param": "id" }` work in props and in args. When state changes, data sources whose args depend on it are fetched again.
- A spec may only name tools visible to its route. The validator rejects unknown tools, and it rejects mutation tools used as data sources.

### 6.3 Local state

`state` holds initial values such as search text, dialog flags, and form drafts. `{ "$state": path }` reads a value, and actions write values. Each page instance has its own small `useSyncExternalStore`-backed store.

### 6.4 Actions

```ts
type Action =
  | { $action: "tool"; name: string; args?: Args; then?: Effect[] }
  | { $action: "navigate"; to: string }                      // "/plants/:id": ":id" from the event, then route params
  | { $action: "setState"; path: string; value: unknown };   // value may be { "$event": "" }

type Effect = { refresh: string[] } | { navigate: string } | { setState: { path: string; value: unknown } };
```

- `{ "$event": "" }` is the whole value a component passes when it fires, for example a table row or an input's text. `{ "$event": "id" }` is one field of it.
- Components receive `(event?) => void` for action props. They never receive callbacks from the spec directly.
- There is no `eval` and no string-to-code. `navigate` accepts same-origin paths only.

---

## 7. Tools

Tools are the only way a spec can touch the outside world, like server actions in Next.js.

```ts
// app/plants/[id]/tools.ts
import { defineTool, z } from "@mirage/core";

export const waterPlant = defineTool({
  description: "Record that a plant was watered today.",
  mutation: true,                       // never fired from `data`, only from actions
  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string(), lastWatered: z.string().nullable() }),
  handler: async ({ id }, ctx) => db.water(id),   // ctx: request, params, + mirage.config context()
});
```

- `POST /__mirage/tools/:name` takes `{ route, params, args }`. The server checks that the tool is visible to the route, validates the input, and validates the output (in dev an invalid output is an error, in production it is logged).
- The model sees each tool's name, description, input JSON Schema, and output JSON Schema. It never sees handler code.
- `mirage.config.ts` `context(request)` adds auth or user info to `ctx`. The model cannot influence it.

---

## 8. Renderer (`@mirage/react`)

```tsx
<MirageView spec={spec} catalog={catalog} params={params} callTool={...} navigate={...} />
```

- It walks from `spec.root`, resolves bindings, and validates the resolved props with `safeParse`. A failure shows an inline dev error chip, or nothing in production.
- Every element is wrapped in an error boundary, so one bad element never takes the page down.
- **Partial specs:** elements render as they arrive, and missing children render as skeletons. This replaces `loading.tsx`. Element ids are the React keys, so nothing remounts while streaming.
- `MirageApp` / `MiragePage` wire this up to React Router and to the `virtual:mirage/routes` table. A page uses its committed spec when one exists. Otherwise it streams one from `/__mirage/generate` and shows a dev overlay on failure.
- `useMirage()` is the same runtime without the renderer. Ejected pages use it.

---

## 9. Generation (`@mirage/server`)

- `POST /__mirage/generate` with `{ route, params }` returns an NDJSON stream of `delta`, `retry`, `spec`, and `error` events.
- `buildPrompt(input) => { system, prompt }` is a pure function covering the rules, the catalog (the intent's subset, if one is set), the visible tool signatures, the intent, the route, and, on retries, the validation errors from the previous attempt.
- Generation uses AI SDK `streamText` with plain text output. The prompt lists every component's and tool's JSON Schema; no schema is sent as a provider-side constraint (see `docs/decisions.md`). The result is validated against the schema and then semantically: the root exists, children exist, there are no cycles, and all tools, `$data` names, `$state` roots, and `$param` names exist. On failure Mirage retries up to twice with the errors, then reports them.

```ts
// mirage.config.ts
import { anthropic } from "@ai-sdk/anthropic";
import { defineConfig } from "@mirage/server";

export default defineConfig({
  model: anthropic("claude-sonnet-5-5"),   // any AI SDK LanguageModel; optional for fully locked apps
  catalog: "./catalog.ts",
  appDir: "./app",
  context: (request) => ({ user: getUser(request) }),
});
```

---

## 10. Modes, caching, and locking

| Mode | Behavior |
|---|---|
| `locked` | Requires `page.spec.json` and never calls the model. It is an error if the file is missing. |
| `cached` (default) | Uses `page.spec.json` if it exists. Otherwise it checks `.mirage/specs/<hash>.json`. Otherwise it generates the spec, streams it, and caches it on success. |
| `live` | Generates on every request, with an in-memory reuse window (`ttl`). |

Cache key = `sha256(intent file + catalog schema + tool signatures + params (only with specPerParams) + spec version + generator version)`. Editing the intent, the catalog, or a tool signature invalidates the cache automatically.

CLI:
- `mirage dev`: the Vite dev server with the Mirage API mounted. Editing an intent regenerates the open page.
- `mirage build`: builds `dist/client` and `dist/server/index.js`. Run the server with `node dist/server/index.js`.
- `mirage lock [route] [--all]`: writes the cached or freshly generated spec to `page.spec.json`.
- `mirage unlock <route>`: deletes `page.spec.json`.
- `mirage regen <route> [--write]`: generates again, ignoring caches, and prints a diff against `page.spec.json`.
- `mirage eject <route> [--keep-intent]`: writes a `page.tsx` that renders the same tree with plain JSX.
- `mirage init [dir]`: scaffolds a new app.
- `mirage eval [route] [--runs n] [--record file] [--report file]`: generates each route `n` times (default 3), ignoring caches, and reports how many specs were valid on the first try, valid after repair, or failed, with the most common validation errors and token use. `--record` saves the model responses from successful runs.

### Testing against real model output

`mirage eval --record` writes a recording: model responses keyed by a hash of the prompt. `replayModel(recording)` from `@mirage/server` is a model that answers from it, so tests exercise real generation (streaming, repairs, validation) without a model or API key:

```ts
import { readFileSync } from "node:fs";
import { defineConfig, replayModel } from "@mirage/server";

export default defineConfig({
  model: replayModel(JSON.parse(readFileSync("./fixtures/app.recording.json", "utf8"))),
});
```

The prompt includes the intent, catalog and tool signatures, so changing any of them makes the recording stale. Replay then fails with a message to re-record rather than serving an outdated answer. `recordingModel(model, onRecord)` is the wrapper `eval` uses, for custom harnesses.

In this repo, `pnpm e2e` runs the Playwright suite in `e2e/` twice: against the production build with committed specs, and (once `e2e/fixtures/greenhouse.recording.json` exists) against a copy with no committed specs that generates every page from the recording. `pnpm eval` and `pnpm eval:record` run `mirage eval` on the greenhouse example; both need `ANTHROPIC_API_KEY`, which the example's config reads from the environment or from a gitignored `examples/greenhouse/.env`.

---

## 11. Packages

```
packages/
  core/            defineCatalog, defineTool, z.ref/z.action, spec types, validator
  react/           MirageView, runtime (state, data, actions), streaming hook, MirageApp
  server/          Hono app: /generate, /tools/:name, prompt builder, repair loop, cache
  vite/            Vite plugin: route scan, virtual:mirage/routes, dev middleware, HMR
  cli/             the `mirage` binary
  catalog-basic/   default components
examples/
  greenhouse/      plant tracker: overview, list + new-plant form, per-plant care page
docs/
  decisions.md
  milestones.md
```

Package names are placeholders (`@mirage/*`). The unscoped name `mirage` is taken on npm by Mirage JS, so pick the final scope before publishing.

Development:

```bash
pnpm install
pnpm build        # tsc -b across packages
pnpm test         # vitest: core, renderer, server (mock model), vite codegen, eject
pnpm typecheck    # packages + the example app
```

---

## 12. Security notes

- The spec is data. No code path evaluates strings from the model.
- Tools are an allowlist per route. Every call is validated again on the server with zod, whatever the client sends.
- `navigate` accepts same-origin paths only (control characters and backslashes are rejected), and this is checked both when validating the spec and at dispatch.
- Route params sent to the generate endpoint are validated, and each route has a cap on generated specs.
- Tool output that fails its output schema is never sent to the client.
- Model output never reaches `dangerouslySetInnerHTML`. Catalog components treat all string props as text.
- The tool `ctx` is built on the server from the real request.
- Tool outputs are not logged. Validation failures log only the issue paths.

## License

Apache-2.0
