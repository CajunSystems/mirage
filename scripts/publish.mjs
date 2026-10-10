// Publishes every @cajunsystems/mirage-* package whose version is not on npm yet.
// pnpm packs each package (rewriting workspace:* to real versions) and npm publishes the tarball,
// because npm's Trusted Publishing (OIDC from GitHub Actions) is only documented for the npm CLI.
// Prints "New tag:" lines and creates the git tags, as `changeset publish` does, so
// changesets/action pushes the tags and creates GitHub releases.
// Usage: node scripts/publish.mjs [--dry-run]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const dryRun = process.argv.includes("--dry-run");
const out = mkdtempSync(join(tmpdir(), "mirage-publish-"));
const sh = (cmd, args, cwd = repo) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

function published(name, version) {
  // npm exits with E404 both for an unknown package and for an unknown version of a known one.
  const res = spawnSync("npm", ["view", `${name}@${version}`, "version"], { cwd: repo, encoding: "utf8" });
  if (res.status === 0) return res.stdout.trim() !== "";
  if (/\bE404\b/.test(res.stderr)) return false;
  throw new Error(`npm view ${name}@${version} failed:\n${res.stderr}`);
}

try {
  const pending = [];
  for (const dir of readdirSync(join(repo, "packages"))) {
    const pkgDir = join(repo, "packages", dir);
    const { name, version, private: isPrivate } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    if (isPrivate) continue;
    if (published(name, version)) console.log(`${name}@${version} is already on npm`);
    else pending.push({ name, version, pkgDir });
  }
  if (!pending.length) console.log("Nothing to publish.");

  for (const { name, version, pkgDir } of pending) {
    sh("pnpm", ["pack", "--pack-destination", out], pkgDir);
    const tarball = join(out, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`);
    const args = ["publish", tarball, "--access", "public"];
    // Prereleases (changesets pre mode) must not become `latest`.
    if (version.includes("-")) args.push("--tag", "next");
    if (dryRun) args.push("--dry-run");
    execFileSync("npm", args, { cwd: repo, stdio: "inherit" });
    if (dryRun) continue;
    sh("git", ["tag", `${name}@${version}`]);
    console.log(`New tag: ${name}@${version}`);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
