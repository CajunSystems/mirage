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
- **`streamText` + `Output.object` instead of `streamObject`.** `streamObject` is deprecated in AI SDK 7. The provider still gets the catalog-derived JSON Schema as a structured-output constraint. Mirage runs its own validation (zod plus the semantic checks) so it controls the repair loop.
- **The generate endpoint streams NDJSON events**, not the AI SDK object stream: `delta` (raw text), `retry` (the partial spec restarts after a failed validation), `spec` (final, validated), and `error`. A repair attempt needs a reset signal, and cached or locked responses skip the model entirely. The AI SDK stream format has no event for either case. The client parses partial JSON with its own small parser, which exposes only completed values, and drops the trailing element that may still be incomplete. This keeps the AI SDK out of the browser bundle.
- **Generation stops when the client disconnects.** A truncated response would otherwise look like invalid JSON and use up repair attempts.
- **Extra frontmatter keys:** `specPerParams` (default `false`) makes param values part of the cache key, so each value gets its own spec. `ttl` (seconds, default 60) sets the in-memory reuse window for `live` pages.
- **Extra config keys:** `catalogExport` (default `"catalog"`), `tools` (project-level tools file, default `./tools.ts`), and `cacheDir`. `model` is optional, so a fully locked app can omit it.
- **The tool endpoint body is `{ route, params, args }`.** The server needs the route to enforce the per-route tool allowlist. The params are passed to handlers as `ctx.params`.
- **`Dialog`** was added to the basic catalog. The brief's list has no way to show a form on demand, such as a "New plant" form. `Tabs` keeps its selected tab in component state.
- **`mirage regen --write`** also overwrites `page.spec.json`. Without the flag, `regen` only refreshes the cache and prints the diff.
- **`mirage eject`** removes both `page.intent.md` and `page.spec.json` (keep both with `--keep-intent`). When a route has both a `page.tsx` and an intent, the `page.tsx` wins.
- **Routes are eagerly imported** in `virtual:mirage/routes` (layouts, committed specs, ejected pages). Code splitting per route is a later optimization.

## Production

`mirage build` produces `dist/client` (Vite) and `dist/server/index.js`. The server bundle contains the app's config, catalog, tools, intents, and specs. Packages stay external. The server serves the client, the tools endpoint, and generation. Committed specs are inlined into the client, so locked routes never call `/__mirage/generate` and need no model or API key.
