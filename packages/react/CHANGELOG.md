# @cajunsystems/mirage-react

## 0.2.0

### Minor Changes

- 79d59f2: Routes are code-split: each route's committed spec, ejected page and layouts load when the route is first visited, instead of all in the initial bundle. `MirageRoute` gains `loadSpec`, `loadPage` and layout `load` (eager `spec`, `page` and `component` still work). Live routes no longer ship their committed spec to the client.

### Patch Changes

- @cajunsystems/mirage-core@0.2.0

## 0.1.0

### Minor Changes

- d8b6216: First public release: intent files, the spec renderer, generation with any AI SDK model, lock/regen/eject/eval, and the basic catalog.

### Patch Changes

- Updated dependencies [d8b6216]
  - @cajunsystems/mirage-core@0.1.0
