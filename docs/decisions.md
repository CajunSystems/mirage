# Decisions

Choices made while building v1, including answers to the open questions in the README (§16) and the places where the implementation differs from the original brief.

## Open questions (§16)

1. **Polling or subscriptions for `$data`?** No. A data source fetches when it first appears, when its resolved args change (for example a `$state` it reads), and when an action's `{ "refresh": [...] }` effect names it. Nothing else.
2. **Includes or partials in intent files?** No. An intent is one self-contained Markdown file. Shared structure belongs in `layout.tsx`.
3. **Element ids across regenerations.** Ids come from the model, which is told to use short kebab-case ids. They are not normalized after generation. The renderer keys React elements by id, so a streamed element never remounts inside one generation. Across regenerations `mirage regen` shows a plain JSON diff. Normalizing ids (for example hashing each element's position) would make those diffs quieter, but it would also make ids opaque to the people reading the spec. Revisit if diffs turn out noisy in practice.
4. **Design tokens in intents?** No. Tokens live in CSS variables (`--mi-*` in `@mirage/catalog-basic/styles.css`), and the layout or app CSS overrides them.

## Deviations from the brief

- **`z.ref()` and `z.action()`** live on the `z` exported by `@mirage/core` (`import { z } from "@mirage/core"`). That `z` is zod v4 plus the two helpers. Zod's own `z` is left untouched.
- **Kind tagging uses `Symbol.for("mirage.kind")`** on the schema object, not a module-private map. The user's catalog can be loaded through a different copy of `@mirage/core` than the code that inspects it. Vite's SSR loader does this in the CLI and dev server.
- **Bindings in any prop.** In a spec, every non-action prop accepts either its declared type or a binding (`$data` / `$state` / `$param`). So a heading can show `{ "$data": "plant", "path": "name" }`. Props declared `z.ref()` must be bindings, and the component receives a `DataResult` (`{ data, loading, error }`) for them. Other props receive the plain resolved value. The element renders as a skeleton while a `$data` value it reads is still loading.
- **`$data` bindings take an optional `path`** (`{ "$data": "plant", "path": "name" }`) so one data source can feed several elements.
- **Defaults are applied at render time, not during validation.** A validated spec is exactly what the model wrote. `mirage eject` writes the schema defaults into the emitted JSX, so the ejected page renders the same DOM as the spec renderer.
- **`streamText` with plain text output, no provider-side schema.** `streamObject` is deprecated in AI SDK 7. v1 passed the catalog-derived JSON Schema through `Output.object`, but constrained decoding cannot express the spec's id-keyed maps: on Anthropic, `elements` and `data` came back as `{}` on every attempt, so no page could ever generate (found in M7). The prompt already lists every component's props and every tool's input and output as JSON Schema, and Mirage runs its own validation (zod plus the semantic checks) and repair loop. Changing the spec to arrays would make it constrainable but also harder to stream and diff, so the format stays as is.
- **The generate endpoint streams NDJSON events**, not the AI SDK object stream: `delta` (raw text), `retry` (the partial spec restarts after a failed validation), `spec` (final, validated), and `error`. A repair attempt needs a reset signal, and cached or locked responses skip the model entirely. The AI SDK stream format has no event for either case. The client parses partial JSON with its own small parser, which exposes only completed values, and drops the trailing element that may still be incomplete. This keeps the AI SDK out of the browser bundle.
- **Generation stops when the client disconnects.** A truncated response would otherwise look like invalid JSON and use up repair attempts.
- **Extra frontmatter keys:** `specPerParams` (default `false`) makes param values part of the cache key, so each value gets its own spec. `ttl` (seconds, default 60) sets the in-memory reuse window for `live` pages. `maxSpecs` (default 100) caps model generations per route per hour in one server process. It counts generations, not distinct specs, so it also bounds `live` pages with a short `ttl` and repeated cache misses. This bounds model cost when client-supplied params feed the cache key. With `specPerParams`, the prompt includes the param values, JSON-encoded and marked as data; they are client-supplied, so they are length-limited, and the generated spec still goes through full validation.
- **Client-supplied params are validated** on both `/__mirage/generate` and `/__mirage/tools/:name`. They must be exactly the route's params, as non-empty strings of at most 200 characters.
- **CSRF: JSON content type plus `Sec-Fetch-Site`**, not tokens or an `Origin` allowlist. Requiring `application/json` makes every cross-origin request non-simple, so it needs a preflight the server never approves. `Sec-Fetch-Site` rejects cross-site and same-site requests in browsers that send it. An `Origin` check against `Host` would break behind proxies that rewrite the host, and tokens would need a page-load handshake that locked, client-only pages don't have.
- **Concurrent requests share one generation.** In-flight generations are keyed by cache key and kept until the cache is written. An aborted generation belongs to the request that started it, so a request waiting on it generates its own. `force` (`regen`, `eval`) never shares.
- **Committed and cached specs are validated** with the same checks as generated ones. An invalid `page.spec.json` is an error (it is never regenerated behind the author's back); an invalid cache entry is regenerated. `mirage build` validates committed specs too, because the client bundle inlines them and serves them without the server.
- **Literal tool args are validated** against the tool's input schema, and every element must be reachable from the root. Bindings and `$event` values are skipped; the server still validates the real args on every call.
- **Production redacts unexpected errors** from the generate stream, as the tool endpoint already did. Mirage's own errors (no route, locked without a spec, rate limit, invalid committed spec) are written for the client and pass through.
- **Tool output that fails its schema is never returned.** Dev and production both answer 500. Production hides the detail, and the server logs only the failing paths.
- **Provider errors are reported, not retried.** Generation reads the AI SDK `fullStream`, because `textStream` ends quietly on errors such as a bad key or a rate limit.
- **Extra config keys:** `catalogExport` (default `"catalog"`), `tools` (project-level tools file, default `./tools.ts`), and `cacheDir`. `model` is optional, so a fully locked app can omit it.
- **The tool endpoint body is `{ route, params, args }`.** The server needs the route to enforce the per-route tool allowlist. The params are passed to handlers as `ctx.params`.
- **`Dialog`** was added to the basic catalog. The brief's list has no way to show a form on demand, such as a "New plant" form. `Tabs` keeps its selected tab in component state.
- **`mirage regen --write`** also overwrites `page.spec.json`. Without the flag, `regen` only refreshes the cache and prints the diff.
- **`mirage eject`** removes both `page.intent.md` and `page.spec.json` (keep both with `--keep-intent`). When a route has both a `page.tsx` and an intent, the `page.tsx` wins.
- **Routes are eagerly imported** in `virtual:mirage/routes` (layouts, committed specs, ejected pages). Code splitting per route is a later optimization.

## Model evaluation (M7)

- **Recordings are keyed by a hash of the prompt messages**, not by route or call order. Replay is then exact for every prompt that was recorded, including repair turns (whose prompt contains the previous output and its errors), and a stale recording fails loudly. The prompt contains no file paths, so a recording made in one checkout replays in another.
- **`mirage eval --record` keeps only successful runs.** Replaying a recording therefore never reproduces a failed generation. When a route is run several times, the last successful run's responses win. A route's first successful run replaces its old responses, so keys from earlier prompts do not pile up; a route with no successful run keeps its old ones.
- **`mirage eval` measures without side effects:** it writes nothing to the spec cache, and it exits non-zero when any run ends without a valid spec (`failed` or `error`), so it can gate a script or CI job.
- **Fence stripping is shared.** `stripJsonFence` in `@mirage/core` runs on the server before parsing and in the client's streaming preview, so a model that wraps its JSON in a Markdown fence still streams progressively.
- **The replay E2E run uses a copy of the example** (`examples/greenhouse/.e2e/replay`, gitignored) with the committed specs removed, rather than a flag that makes Mirage ignore committed specs. No framework code exists only for tests. The copy sits inside the example so its imports resolve from the example's `node_modules`.
- **E2E assertions follow the intents, not the layout.** The same suite runs against committed and generated specs, which may differ in structure.
- **Results, Anthropic `claude-sonnet-5-5`, 2026-10-10** (`pnpm eval`, 3 runs per route):

  | Route | Runs | Valid first try | Repaired | Failed | Avg output tokens | Avg time |
  |---|---|---|---|---|---|---|
  | `/` | 3 | 3 | 0 | 0 | 609 | 3.8s |
  | `/plants` | 3 | 3 | 0 | 0 | 1549 | 9.2s |
  | `/plants/:id` | 3 | 3 | 0 | 0 | 829 | 4.8s |

  The first real run failed every attempt, because of the structured-output problem above. After that was fixed, the only error was a missing `"version": 1`, which the prompt never asked for; the prompt now states the top-level shape. The recorded responses (`e2e/fixtures/greenhouse.recording.json`) pass the full E2E suite, so the generated pages do what the intents ask, not just validate. Three runs per route on one provider is a small sample: rerun `pnpm eval` with more runs after prompt or catalog changes.

## Packaging (M8)

- **npm scope `@mirage`.** The unscoped `mirage` belongs to Mirage JS. The CLI binary is `mirage`.
- **`zod` and `ai` are peer dependencies.** The app's catalog and tools are built with the app's zod, and its model comes from the app's AI SDK provider. Two copies would make zod schemas and model types incompatible across the boundary (the reason kinds are tagged with `Symbol.for`). `@ai-sdk/provider` stays a regular dependency because only its types are used.
- **One version for all packages** (a Changesets `fixed` group). They are released and tested together, and the CLI, Vite plugin and server must agree on the spec and endpoints.
- **The first publish is manual setup, not code:** it needs the npm org and an `NPM_TOKEN` secret. After that, releases go through the "Version packages" PR.
- **The example and `mirage init` declare everything they import**, including `@types/react`. Before M8 they relied on the monorepo root for it; `pnpm smoke:pack` builds the example outside the monorepo to catch that class of mistake.

## Production

`mirage build` produces `dist/client` (Vite) and `dist/server/index.js`. The server bundle contains the app's config, catalog, tools, intents, and specs. Packages stay external. The server serves the client, the tools endpoint, and generation. Committed specs are inlined into the client, so locked routes never call `/__mirage/generate` and need no model or API key.
