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
  cli.command("init [dir]", "Create a new Mirage app").action((dir: string | undefined) => commands.init(dir ?? "."));
  cli.help();
  cli.version("0.1.0");

  cli.parse(argv, { run: false });
  Promise.resolve(cli.runMatchedCommand()).catch((error: unknown) => {
    console.error(`mirage: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
