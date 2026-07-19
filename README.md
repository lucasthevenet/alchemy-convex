# alchemy-convex

A Bun monorepo for integrating [Convex](https://www.convex.dev) with
[Alchemy v2](https://alchemy.run).

## Workspaces

- [`packages/alchemy-convex`](./packages/alchemy-convex) — the publishable
  `alchemy-convex` provider.
- [`examples/basic`](./examples/basic) — a runnable Alchemy stack and Convex
  application.

## Development

```sh
bun install
bun run format:check
bun run lint
bun run check
bun run test
bun run build
```

Run every verification step with `bun run ci`.

Plan the example from the repository root with:

```sh
bun run example:plan -- --stage local
```

See the [package README](./packages/alchemy-convex/README.md) for installation,
authentication, and resource documentation.
