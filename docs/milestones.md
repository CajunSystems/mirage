# Milestones

The build order for Mirage. Each milestone has a scope and an **Accept** line, and is done only when its acceptance criteria are covered by passing tests (or, where a test can't cover it, a recorded manual check). Choices made along the way go in `docs/decisions.md`.

| Milestone | Status |
|---|---|
| M1: Core | Done (v1) |
| M2: Renderer | Done (v1) |
| M3: Server + generation | Done (v1) |
| M4: Vite plugin + routing + dev | Done (v1) |
| M5: Lock / unlock / regen / eject + build | Done (v1) |
| M6: Polish | Done (v1) |
| M7: Real-model generation | Done |
| M8: Publishable packages | Done: 0.1.0 published |
| M9: Per-route code splitting | Next |
| M10: Starter app from `mirage init` | Planned |
| M11: Catalog expansion | Planned |
| M12: Stable element ids | Planned |

---

## v1 (merged in #1)

The v1 brief used a clinic example. The repo ships `examples/greenhouse` instead, with the same three-route shape (`/`, `/plants`, `/plants/:id`).

**M1: Core (no LLM)**
- `defineCatalog`, `defineTool`, `z.ref`, `z.action`, spec types, `specSchema` derivation, semantic validator.
- Accept: a hand-written spec validates; invalid component names, bad props, dangling children, cycles, and unknown tools are each rejected with a clear error path. JSON Schema output is snapshot-tested.

**M2: Renderer (no LLM)**
- `MirageView` renders a hand-written spec with the basic catalog; `$data`, `$state`, `$param`, and actions work against mock tools.
- Accept: partial specs render progressively with skeletons; one invalid element shows a dev error chip and does not break siblings.

**M3: Server + generation**
- Hono app with `/tools/:name` and `/generate`, prompt builder, generation with a repair loop, cache.
- Accept: prompt builder snapshot tests; with a mocked model, invalid output triggers up to 2 repairs; a cache hit returns without calling the model.
- Note: used `streamText` + `Output.object` rather than the deprecated `streamObject`. M7 replaced the provider-side schema with plain text output (see `decisions.md`).

**M4: Vite plugin + routing + dev**
- Route scan, virtual module, dev middleware, HMR on intent change.
- Accept: `mirage dev` in `examples/greenhouse` serves `/`, `/plants`, `/plants/:id`; editing an intent regenerates the open page.

**M5: Lock / unlock / regen / eject + build**
- CLI commands, `page.spec.json` precedence, `locked` mode enforcement, `eject` TSX output, production build.
- Accept: a fully locked example runs in production with no API key set; `eject` output compiles with `tsc` and renders the same DOM as the spec renderer.

**M6: Polish**
- `mirage init` template, error overlay, docs, the greenhouse example end to end.
- Accept: met by manual checks in Chromium. The optional Playwright E2E suite from the brief was not committed; it moves to M7, which produces the recorded fixtures it needs.

---

## Done since v1

**M7: Real-model generation**
- Run generation against a real provider for every greenhouse route and fix what breaks: prompt wording, catalog and tool descriptions, repair-message clarity.
- Record the real model responses as fixtures, and add the Playwright E2E suite (`examples/greenhouse`, replaying the fixtures so CI never calls a model).
- Add an opt-in eval script (for example `pnpm eval`, skipped without an API key) that regenerates each route N times and reports: valid on first try, valid after repair, failed, and mean repairs.
- Accept: each greenhouse route produces a valid spec on at least one major provider, with first-try validity recorded in `docs/decisions.md`; the E2E suite passes in CI against the recorded fixtures.
- Needs: an API key in the environment's secrets.
- Progress:
  - [x] `recordingModel` / `replayModel` in `@cajunsystems/mirage-server`, keyed by prompt hash, with record/replay tests.
  - [x] `mirage eval [route] --runs n --record file --report file`, plus `pnpm eval` / `pnpm eval:record` for the greenhouse.
  - [x] Playwright suite in `e2e/`: the `locked` run (production build, committed specs) passes and runs in CI. The `replay` run turns on when the recording exists; checked locally against a throwaway recording that was not committed.
  - [x] Record `e2e/fixtures/greenhouse.recording.json` from a real model (`pnpm eval:record`, Anthropic `claude-sonnet-5-5`). Both E2E runs pass (12/12).
  - [x] Run `pnpm eval`: 9/9 valid on the first try after two fixes (no provider-side schema; the prompt states `"version": 1`). Results in `decisions.md`.
- Not covered: a second provider. The accept line asks for "at least one major provider", which is met; adding another to `pnpm eval` is cheap once a key exists.

**M8: Publishable packages**
- Final package names and scope, `exports`/`files`/`types` fields, peer dependencies (`react`, `react-router`, `ai`, `zod`, `vite`), a changeset-based release flow, and a publish job in CI.
- Accept: `pnpm pack` for each package installs into a fresh project outside the monorepo, which builds and runs a locked page; a tagged release publishes all packages from CI.
- Progress:
  - [x] Package metadata: description, repository, keywords, `engines`, `sideEffects`, `publishConfig` (public access; CI adds provenance), README and LICENSE in every package.
  - [x] Peer dependencies: `zod` and `ai` (shared with the app, so their schemas and types are the same objects), `react`, `react-router`, `vite`. Packages that depend on core or server pass these peers along.
  - [x] Changesets with all `@cajunsystems/mirage-*` packages versioned together; versions start at `0.0.0` so the first release is `0.1.0`.
  - [x] `release.yml`: on `main`, opens a "Version packages" PR; merging it publishes to npm with provenance.
  - [x] `pnpm smoke:pack` (and a `pack` CI job): packs every package, installs the tarballs into a copy of the greenhouse app outside the monorepo, then typechecks, builds and serves a locked page and a tool with no model.
  - [x] First publish: 0.1.0 of all six packages, published from a maintainer machine with 2FA (so without provenance). Trusted Publishing is linked for each package.
  - [x] CI publishes through npm Trusted Publishing (OIDC): no npm token is stored, and provenance is automatic. `scripts/publish.mjs` packs with pnpm and publishes with `npm`.

---

## Next

**M9: Per-route code splitting**
- `virtual:mirage/routes` emits dynamic imports for layouts, committed specs, and ejected pages instead of eager imports; React Router `lazy` loads them.
- Accept: the production build emits one chunk per route; loading `/` does not fetch the `/plants/:id` spec or page chunk; existing renderer and eject tests still pass.

**M10: Starter app from `mirage init`**
- `mirage init <dir>` writes a runnable app: config, layout, catalog, a sample tool, one intent, and a committed spec, so it runs with no API key.
- Accept: in CI, `mirage init` into a temp dir, then install, build, and start the server; the start page returns 200 and renders its heading.

**M11: Catalog expansion**
- Add to `@cajunsystems/mirage-catalog-basic` the components that M7 shows models reaching for and not finding. Likely candidates: Chart, DatePicker, Pagination, Toast/Alert.
- Accept: each new component has a zod schema with descriptions, renderer tests, and eject parity; JSON Schema snapshots are updated; the prompt stays within an agreed token budget (measured and recorded).

**M12: Stable element ids**
- Resolves open question 3 in `decisions.md` using M7 data: either normalize ids after generation or keep model ids and diff structurally in `mirage regen`.
- Accept: regenerating an unchanged intent twice yields a `regen` diff limited to real content changes on the recorded fixtures; the choice is recorded in `decisions.md`.

---

## Still out of scope

From the v1 non-goals, unchanged until a milestone above says otherwise: SSR/RSC, a multi-provider layer beyond the AI SDK, a visual editor, auth, deployment adapters, and generation of arbitrary JS/JSX (never).
