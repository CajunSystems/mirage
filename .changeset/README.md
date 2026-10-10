# Changesets

Every change that affects a published `@cajunsystems/mirage-*` package needs a changeset. Run `pnpm changeset`, pick the bump, and describe the change for the changelog. All `@cajunsystems/mirage-*` packages share one version (they are released together).

On `main`, the release workflow opens a "Version packages" PR that applies pending changesets. Merging that PR publishes to npm.
