# @mirage/server

Part of [Mirage](https://github.com/CajunSystems/mirage), a generative-UI framework for React: write a page's intent in Markdown, and a model turns it into a validated JSON spec that renders with your own components.

Generates specs from `page.intent.md` files with any AI SDK model, serves the tool endpoint, and handles caching and locking. Also `recordingModel` / `replayModel` for testing against recorded model output.

```ts
import { defineConfig } from "@mirage/server";
```

See the [main README](https://github.com/CajunSystems/mirage#readme) for the full guide. Licensed under Apache-2.0.
