# Mirage — notes for Claude

Mirage is a **generative-UI framework for React**. Each route is a Markdown intent (`page.intent.md`);
a model turns it into a JSON **spec** built only from a typed component **catalog** and the route's
**tools**, and the renderer draws that spec. Specs can be cached, committed (`page.spec.json`,
"locked") or ejected to plain TSX. `README.md` is the design brief, `docs/milestones.md` the build
order (one milestone per PR), and `docs/decisions.md` the reasoning for every choice that differs
from the brief or is not obvious. Packages publish as `@cajunsystems/mirage-*`; the CLI binary is
`mirage`.

## Build & test

```bash
pnpm install
pnpm build        # tsc -b across packages (in dependency order)
pnpm test         # vitest: core, renderer, server (mock model), vite codegen, eject
pnpm typecheck    # packages + examples/greenhouse
pnpm e2e          # Playwright against the greenhouse example (needs `pnpm build`)
pnpm smoke:pack   # pack every package, install outside the monorepo, build and serve
```

CI (`ci.yml`) runs `test` (typecheck + unit), `e2e` and `pack`. **No test or CI job calls a model**:
the server tests use mock models, the E2E suite uses committed specs and a recorded fixture. Only
`pnpm eval` / `pnpm eval:record` hit a real provider, and only with `ANTHROPIC_API_KEY` set
(`examples/greenhouse/.env`, gitignored — never commit or echo a key).

pnpm 10: overrides and allowed build scripts live in `pnpm-workspace.yaml`, not `package.json`.

## Architecture (where things live)

- `packages/core` — `defineCatalog`, `defineTool`, the `z` export (zod v4 plus `z.ref()` /
  `z.action()`, tagged with `Symbol.for("mirage.kind")` so a catalog loaded through another copy of
  core still works), spec types, `specSchema` derivation, `validateSpec` (component names, props,
  children, cycles, reachability, tools, literal tool args, bindings, same-origin `navigate`),
  `stripJsonFence`. Pure: no React, no I/O.
- `packages/catalog-basic` — default components and `styles.css` (`--mi-*` tokens). Components
  treat every string prop as text.
- `packages/react` — `MirageView` (renders a spec; one bad element shows an error chip, siblings
  keep rendering), the runtime (`$data` / `$state` / `$param`, actions), `useGeneratedSpec` (NDJSON
  stream + `parsePartialJson` preview), `MirageApp` / `createMirageRoutes` on React Router 7
  (lazy routes from `loadSpec` / `loadPage` / layout `load`; eager `spec` / `page` still work).
- `packages/server` — Hono app with `/__mirage/generate` and `/__mirage/tools/:name`, the prompt
  builder, `generateSpec` (plain-text `streamText`, validate, repair up to 2 times), the spec cache,
  in-flight dedup, rate limit, and `recordingModel` / `replayModel`.
- `packages/vite` — route scan, `virtual:mirage/routes` codegen (dynamic imports, so each route's
  spec, ejected page and layouts are a chunk loaded on first visit), dev middleware, HMR on intent
  and spec edits.
- `packages/cli` — `mirage dev | build | lock | unlock | regen | eject | init | eval`. Loads the
  user's project through Vite's SSR loader.
- `examples/greenhouse` — the reference app (`/`, `/plants`, `/plants/:id`); E2E runs against it.
- `scripts/publish.mjs` (release), `scripts/pack-smoke.mjs` (the `pack` job).

## Key invariants

- **The spec is data.** No code path evaluates a string from the model; model output never reaches
  `dangerouslySetInnerHTML`.
- **Every spec is validated before it is served** — generated, cached, and committed alike. An
  invalid cache entry is regenerated; an invalid `page.spec.json` is an error, never silently
  regenerated. `mirage build` validates committed specs because the client inlines them.
- **Modes:** `locked` never calls the model (missing spec is an error); `cached` prefers
  `page.spec.json`, then the cache, then generates; `live` always generates (with a `ttl` reuse
  window) and must not ship its committed spec to the client (no `loadSpec` in its route entry).
- **Cache key** = hash of intent + catalog schema + tool signatures (+ params with `specPerParams`)
  + spec and generator version. Anything the prompt depends on belongs in it. The prompt contains no
  file paths, so recordings replay in any checkout.
- **Tools are a per-route allowlist** and the server re-validates every call's args with zod;
  output that fails its schema is never returned. Handlers are server-only: tool signatures sent
  anywhere never include `handler`.
- **Endpoint hardening:** both endpoints require `Content-Type: application/json` (415) and reject
  `Sec-Fetch-Site: cross-site | same-site` (403); route params must be exactly the route's params
  (non-empty, ≤200 chars); `maxSpecs` caps generations per route per hour; production redacts
  unexpected errors (Mirage's own messages pass through).
- **Concurrent requests share one generation**, keyed by cache key and held until the cache is
  written. An aborted generation belongs to the request that started it; `force` never shares.
- **Generation reads `fullStream`**, so provider errors are thrown, not mistaken for truncated JSON.
  A client disconnect aborts generation.
- **Packaging:** `zod`, `ai`, `react`, `react-router`, `vite` are peer dependencies (one copy shared
  with the app). All six packages share one version (Changesets `fixed` group). The example and the
  `mirage init` template declare everything they import — `pnpm smoke:pack` builds outside the
  monorepo to catch that.
- **No framework code exists only for tests.** The replay E2E run uses a copy of the example
  without committed specs rather than a flag.

## Acceptance tests (keep green if you touch the area)

- **Validator** — `packages/core/test/core.test.ts`: each rejection has a precise error path; the
  JSON Schema and catalog description are snapshot-tested (update snapshots only on intended changes).
- **Renderer** — `packages/react/test/view.test.tsx` (progressive partial specs, error chip
  isolation), `stream.test.tsx` (NDJSON stream, retry reset, fenced preview), `routes.test.tsx`
  (route files load only on visit, a shared layout loads once, live routes never load a spec).
- **Server** — `packages/server/test/server.test.ts`: repair loop, cache hit skips the model,
  dedup/abort, CSRF and param checks, rate limit, redaction, record/replay. The prompt snapshot
  changes the cache key and invalidates recordings — re-record (`pnpm eval:record`) when it moves.
- **Codegen / eject** — `packages/vite/test/example.test.ts`, `packages/cli/test/eject.test.tsx`
  (ejected TSX renders the same DOM as the spec renderer).
- **E2E** — `e2e/greenhouse.spec.ts` runs twice: `locked` (production build, committed specs, no
  model) and `replay` (generated from `e2e/fixtures/greenhouse.recording.json`). Assertions follow
  the intents, not the layout. The console test fails on any console warning or error, and the
  `locked` run checks that a route's chunk is fetched only when it is visited.
- **Packaging** — `pnpm smoke:pack`.

## Working conventions

- One milestone per PR, on a `claude/<topic>` branch. Update `docs/milestones.md` (status +
  progress) and record non-obvious choices in `docs/decisions.md` in the same PR.
- A behavioural fix comes with a test that fails without it.
- Changes to published packages need a changeset (`pnpm changeset`). Merging the "Version
  packages" PR publishes through npm Trusted Publishing (`release.yml`, OIDC — no npm token).
- Match the surrounding code: terse comments that explain *why*, no speculative abstractions.
