import { readFileSync } from "node:fs";
import { cac } from "cac";
import * as commands from "./commands.js";

export function run(argv = process.argv) {
  const cli = cac("mirage");
  const root = (o: { root?: string }) => o.root ?? process.cwd();

  cli.option("--root <dir>", "Project root (default: current directory)");
  cli
    .command("dev", "Start the dev server")
    .option("--port <port>", "Port")
    .option("--host [host]", "Expose on the network")
    .action((o) => commands.dev(root(o), { port: o.port, host: o.host }));
  cli.command("build", "Build the client and the production server").action((o) => commands.buildApp(root(o)));
  cli
    .command("lock [route]", "Write the cached or freshly generated spec to page.spec.json")
    .option("--all", "Lock every route")
    .action((route: string | undefined, o) => commands.lock(root(o), route, { all: o.all }));
  cli.command("unlock <route>", "Delete a route's page.spec.json").action((route: string, o) => commands.unlock(root(o), route));
  cli
    .command("regen <route>", "Generate again, ignoring caches, and diff against page.spec.json")
    .option("--write", "Also overwrite page.spec.json")
    .action((route: string, o) => commands.regen(root(o), route, { write: o.write }));
  cli
    .command("eject <route>", "Emit a page.tsx that renders the spec with plain JSX")
    .option("--keep-intent", "Keep page.intent.md (and page.spec.json)")
    .action((route: string, o) => commands.eject(root(o), route, { keepIntent: o.keepIntent }));
  cli
    .command("eval [route]", "Generate each route several times and report how often the model produces a valid spec")
    .option("--all", "Evaluate every route (the default when no route is given)")
    .option("--runs <n>", "Generations per route", { default: 3 })
    .option("--record <file>", "Save responses from successful runs, for replayModel()")
    .option("--report <file>", "Write per-run results as JSON")
    .action((route: string | undefined, o) => commands.evaluate(root(o), route, { all: o.all, runs: o.runs, record: o.record, report: o.report }));
  cli.command("init [dir]", "Create a new Mirage app").action((dir: string | undefined) => commands.init(dir ?? "."));
  cli.help();
  cli.version((JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version);

  cli.parse(argv, { run: false });
  Promise.resolve(cli.runMatchedCommand()).catch((error: unknown) => {
    console.error(`mirage: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
