import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { MirageServer } from "@mirage/server";

/** Serves the built client and the Mirage API. Used by the server bundle `mirage build` emits. */
export async function startProductionServer(options: { mirage: MirageServer; clientDir: string; port?: number }) {
  const { mirage, clientDir } = options;
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const html = await readFile(join(clientDir, "index.html"), "utf8");
  const app = new Hono();
  app.route("/", mirage.app);
  app.use("/*", serveStatic({ root: clientDir }));
  app.get("*", (c) => c.html(html)); // client-side routing
  const server = serve({ fetch: app.fetch, port });
  console.log(`[mirage] listening on http://localhost:${port}`);
  return server;
}
