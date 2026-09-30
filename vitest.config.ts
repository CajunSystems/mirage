import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@mirage/core": pkg("core"),
      "@mirage/react": pkg("react"),
      "@mirage/server": pkg("server"),
      "@mirage/vite": pkg("vite"),
      "@mirage/catalog-basic": pkg("catalog-basic"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.{ts,tsx}"],
  },
});
