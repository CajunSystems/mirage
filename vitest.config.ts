import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@cajunsystems/mirage-core": pkg("core"),
      "@cajunsystems/mirage-react": pkg("react"),
      "@cajunsystems/mirage-server": pkg("server"),
      "@cajunsystems/mirage-vite": pkg("vite"),
      "@cajunsystems/mirage-catalog-basic": pkg("catalog-basic"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}"],
  },
});
