# alchemy-convex

`alchemy-convex` is an experimental Alchemy v2 provider for deploying a
standard Convex project from an Alchemy stack.

The MVP deliberately keeps Convex as the source of truth for backend code. It
adds two pieces:

- `Convex.Deployment`, an Alchemy `Platform` resource that participates in the
  Alchemy plan, binding, state, and provider lifecycle.
- `ConvexCli`, a replaceable Effect service that reconciles environment
  variables and runs the project's local `convex deploy` command.

The Convex CLI still performs typechecking, code generation, bundling, and the
actual push. This follows Convex's recommendation to use the CLI for pushing
code instead of rebuilding its deployment protocol in an integration.

## Status

This is an MVP built against:

- Alchemy `2.0.0-beta.63`
- Effect `4.0.0-beta.99`
- Convex `1.42.3`

Alchemy v2 and Effect 4 are prereleases, so minor compatibility adjustments
may be needed as their APIs stabilize.

## Install

```sh
bun add alchemy-convex "alchemy@next" convex "effect@beta" \
  "@effect/platform-bun@beta" "@effect/platform-node@beta"
```

Create a production deploy key with the `deployment:deploy` permission in the
Convex dashboard and expose it to Alchemy as `CONVEX_DEPLOY_KEY`. The key is
passed to the child process through its environment and is never placed in CLI
arguments or resource outputs.

## Use

```ts
import * as Alchemy from "alchemy";
import * as Convex from "alchemy-convex";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Convex.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const deployKey = yield* Config.redacted("CONVEX_DEPLOY_KEY");

    const backend = yield* Convex.Deployment("Backend", {
      projectDir: ".",
      deployKey,
      env: {
        APP_ENV: "production",
      },
    });

    return {
      convexUrl: backend.url,
      convexHttpActionsUrl: backend.httpActionsUrl,
    };
  }),
);
```

Run the stack normally:

```sh
bun alchemy deploy
```

`projectDir` must contain the Convex project's `package.json`. The runtime
resolves and invokes that project's installed Convex CLI, so no global CLI is
required. An explicit executable can be configured with
`Convex.providers({ binary: "/path/to/convex" })`.

## Bind outputs as Convex environment variables

Use `bindEnvironment` to connect values produced by other Alchemy resources:

```ts
const backend = yield* Convex.Deployment("Backend", {
  projectDir: "./apps/backend",
  deployKey,
});

yield* Convex.bindEnvironment(backend, {
  API_ORIGIN: api.url,
});
```

Bindings are merged with `env`; explicit `env` entries win on a name conflict.
Managed environment variables removed from the stack are removed from Convex
on the next deployment.

## Previews

A preview deploy key can claim or reuse a named preview deployment:

```ts
const backend = yield* Convex.Deployment("PreviewBackend", {
  projectDir: ".",
  deployKey: previewDeployKey,
  preview: {
    name: "pull-123",
    recreate: false,
  },
});
```

Set `recreate: true` to use Convex's `--preview-create` behavior instead of
`--preview-name`.

Managed `env`/`bindEnvironment` values are not supported with preview deploy
keys in this MVP. Convex must first claim a preview before that deployment can
be selected by its environment commands. Supporting that safely requires a
separate preview-provisioning phase rather than a potentially broken first
code push.

## Change detection and lifecycle

The provider hashes the project tree and skips `convex deploy` when both props
and source are unchanged. It excludes secrets, dependencies, build outputs,
Alchemy state, and `convex/_generated` by default. For a monorepo, customize
the hash inputs:

```ts
yield* Convex.Deployment("Backend", {
  projectDir: ".",
  deployKey,
  source: {
    include: ["convex/**", "packages/domain/**", "package.json", "bun.lock"],
    exclude: ["packages/domain/test/**"],
  },
});
```

`alwaysDeploy: true` disables this memoization.

Destroying the Alchemy resource intentionally does **not** delete the Convex
cloud deployment, its functions, or its data. The MVP models deployment of a
code revision, not ownership of the Convex project. Project/deployment creation
through the Convex Management API belongs in a future resource with explicit,
safe deletion semantics.

## What “custom runtime” means in this MVP

`Deployment` is constructed with Alchemy's `Platform` API and has a
Convex-specific `BaseRuntimeContext`. At plan time, it captures Alchemy Outputs
and bindings into the deployment environment. Its provider then hands the
source tree to the Convex CLI, which packages code for the real managed Convex
runtime.

It does not yet translate arbitrary Effect HTTP handlers into Convex queries,
mutations, or actions. A deeper runtime will require a stable function manifest
or code-generation boundary—ideally shared with Confect—before it can be
implemented without coupling to private Convex or Confect internals.

## Development

```sh
bun install
bun run check
bun run test
bun run build
```

Provider tests use an injected `ConvexCli` Layer, so they exercise Alchemy's
create/no-op/destroy lifecycle without accessing a real Convex deployment.
