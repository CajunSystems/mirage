---
"@cajunsystems/mirage-react": minor
"@cajunsystems/mirage-vite": minor
---

Routes are code-split: each route's committed spec, ejected page and layouts load when the route is first visited, instead of all in the initial bundle. `MirageRoute` gains `loadSpec`, `loadPage` and layout `load` (eager `spec`, `page` and `component` still work). Live routes no longer ship their committed spec to the client.
