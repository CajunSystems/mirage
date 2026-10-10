import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const files: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "my-mirage-app",
      private: true,
      type: "module",
      scripts: { dev: "mirage dev", build: "mirage build", start: "node dist/server/index.js", lock: "mirage lock --all" },
      dependencies: {
        "@ai-sdk/anthropic": "^4.0.0",
        "@cajunsystems/mirage-catalog-basic": "^0.1.0",
        "@cajunsystems/mirage-cli": "^0.1.0",
        "@cajunsystems/mirage-core": "^0.1.0",
        "@cajunsystems/mirage-react": "^0.1.0",
        "@cajunsystems/mirage-server": "^0.1.0",
        "@cajunsystems/mirage-vite": "^0.1.0",
        react: "^19.1.0",
        "react-dom": "^19.1.0",
        "react-router": "^7.9.0",
        ai: "^7.0.0",
        zod: "^4.1.0",
      },
      devDependencies: {
        "@types/node": "^22.10.0",
        "@types/react": "^19.1.0",
        "@types/react-dom": "^19.1.0",
        "@vitejs/plugin-react": "^5.0.0",
        typescript: "^5.9.0",
        vite: "^7.1.0",
      },
    },
    null,
    2,
  ),
  ".gitignore": "node_modules\ndist\n.mirage\n.env\n",
  "vite.config.ts": `import react from "@vitejs/plugin-react";
import { mirage } from "@cajunsystems/mirage-vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [react(), mirage()] });
`,
  "mirage.config.ts": `import { anthropic } from "@ai-sdk/anthropic";
import { defineConfig } from "@cajunsystems/mirage-server";

export default defineConfig({
  model: anthropic("claude-sonnet-5-5"),
  catalog: "./catalog.ts",
  appDir: "./app",
});
`,
  "catalog.ts": `import { basicCatalog } from "@cajunsystems/mirage-catalog-basic";

// Add your own components with defineCatalog({ ...basicCatalog.entries, MyThing: { ... } }).
export const catalog = basicCatalog;
`,
  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mirage app</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  "src/main.tsx": `/// <reference types="@cajunsystems/mirage-vite/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MirageApp } from "@cajunsystems/mirage-react";
import { routes } from "virtual:mirage/routes";
import "@cajunsystems/mirage-catalog-basic/styles.css";
import { catalog } from "../catalog";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MirageApp routes={routes} catalog={catalog} />
  </StrictMode>,
);
`,
  "app/layout.tsx": `import { Outlet } from "@cajunsystems/mirage-react";

export default function RootLayout() {
  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
      <Outlet />
    </main>
  );
}
`,
  "app/tools.ts": `import { defineTool, z } from "@cajunsystems/mirage-core";

export const getGreeting = defineTool({
  description: "Returns a greeting for the current time of day.",
  input: z.object({}),
  output: z.object({ greeting: z.string() }),
  handler: () => ({ greeting: new Date().getHours() < 12 ? "Good morning" : "Good afternoon" }),
});
`,
  "app/page.intent.md": `---
title: Home
---

A welcome page.

- Show the greeting from getGreeting as the heading.
- One sentence explaining that this page was generated from app/page.intent.md.
`,
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        types: ["node", "vite/client"],
      },
      include: ["app", "src", "catalog.ts", "mirage.config.ts", "vite.config.ts"],
    },
    null,
    2,
  ),
};

export async function writeTemplate(target: string) {
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} is not empty`);
  for (const [name, content] of Object.entries(files)) {
    const path = join(target, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content.endsWith("\n") ? content : content + "\n");
  }
}
