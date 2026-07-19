# alchemy-convex

`alchemy-convex` is an experimental Alchemy v2 provider for deploying a
standard Convex project from an Alchemy stack.

The MVP contains four pieces:

- `Convex.Project`, an Alchemy `Platform` resource participating in plan,
  binding, state, and provider lifecycles.
- `ConvexCli`, a replaceable Effect service that reconciles environment
  variables and invokes the project's local Convex CLI.
- `ConvexAuth`, an Alchemy Auth Provider supporting a Convex team access token
  or an OAuth application token.
- `ConvexManagementApi`, which turns those durable credentials into a
  deployment-scoped key only while reconciliation is running.

The Convex CLI still owns typechecking, code generation, bundling, and the code
push. This follows Convex's recommendation to use its CLI rather than reproduce
the private deployment protocol in an integration.

## Status

This is an MVP built against Alchemy `2.0.0-beta.63`, Effect
`4.0.0-beta.99`, and Convex `1.42.3`. Alchemy v2 and Effect 4 are prereleases,
so compatibility adjustments may be needed while their APIs stabilize.

## Install

```sh
bun add alchemy-convex "alchemy@next" convex "effect@beta" \
  "@effect/platform-bun@beta" "@effect/platform-node@beta"
```

## Authentication

Run Alchemy's profile configuration:

```sh
bun alchemy login --configure
```

The Convex provider offers three methods:

- **Environment Variable** reads an access token from
  `CONVEX_ACCESS_TOKEN`. This is selected automatically when `CI=1`.
- **OAuth** opens Convex in the browser and stores the resulting application
  token under the active Alchemy profile.
- **Access Token** prompts securely and stores the token under
  `~/.alchemy/credentials/<profile>/`.

Create team access tokens from the Convex Team Settings access-token page. A
token remains constrained by the permissions of the member who created it, so
a dedicated service account is recommended for automation.

OAuth requires a Convex OAuth application. Register a localhost redirect URI
of `http://localhost:9977/auth/callback`, then provide the application
credentials only to the login process:

```sh
CONVEX_OAUTH_CLIENT_ID='...' \
CONVEX_OAUTH_CLIENT_SECRET='...' \
bun alchemy login --configure
```

OAuth uses the team authorization flow by default. To request a project-scoped
token or use another registered localhost redirect URI:

```ts
providers: Convex.providers({
  oauth: {
    scope: "project",
    redirectUri: "http://localhost:9980/auth/callback",
  },
}),
```

Register that exact redirect URI in the Convex application first. `clientId`
and `clientSecret` can also be supplied through the `oauth` object, but
environment variables avoid putting the application secret in source code.

`CONVEX_DEPLOY_KEY` is intentionally not an Auth Provider credential. During a
reconciliation, `ConvexManagementApi` asks Convex for a deploy-key view of the
target deployment. With a team access token this is a least-privilege,
one-hour key that is revoked after the CLI exits; the expiry limits exposure if
cleanup cannot run. With OAuth, Convex returns a deployment-scoped view backed
by the same OAuth grant, so the provider does not attempt to revoke it as a
deploy key. No deploy key is written to Alchemy profiles, resource props,
outputs, state, or CLI arguments.

## Use

```ts
import * as Alchemy from "alchemy";
import * as Convex from "alchemy-convex";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Convex.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const backend = yield* Convex.Project("Backend", {
      projectDir: ".",
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

`name` is optional. When both `name` and `projectId` are omitted, the provider
derives a stable project name from the Alchemy stack, stage, and resource ID.
With a team-scoped token it resolves that name in the authorized team and
creates the project when none exists. `teamId` can override the team inferred
from the token.

To adopt an existing project, provide its numeric project ID:

```ts
yield* Convex.Project("ExistingBackend", {
  projectId: 42,
  projectDir: ".",
});
```

Project-scoped OAuth tokens automatically adopt their authorized project. The
provider ensures that the project has a default production deployment and uses
that deployment as the internal CLI target. Deployments are not exposed as
independently managed resources in this MVP.

The authenticated token must be allowed to access the project. `projectDir`
must contain the project's `package.json`; the runtime invokes that project's
installed Convex CLI, so no global CLI is required. Override the executable with
`Convex.providers({ binary: "/path/to/convex" })`.

## Use resource outputs as environment variables

Pass outputs from other Alchemy resources directly in `env`, just like other
Alchemy resources do:

```ts
const web = yield* Cloudflare.Worker("Web", {
  main: "./src/worker.ts",
});

const backend = yield* Convex.Project("Backend", {
  projectDir: "./apps/backend",
  env: {
    APP_ENV: "production",
    SITE_URL: web.url,
  },
});
```

Alchemy resolves nested outputs before the Convex provider reconciles the
project, so no separate binding helper is needed. Managed variables removed
from `env` are removed from Convex on the next deployment.

## Change detection and lifecycle

The provider hashes the project tree and skips `convex deploy` when both props
and source are unchanged. It excludes secrets, dependencies, build outputs,
Alchemy state, and `convex/_generated` by default. Monorepos can customize hash
inputs:

```ts
yield* Convex.Project("Backend", {
  projectDir: ".",
  source: {
    include: ["convex/**", "packages/domain/**", "package.json", "bun.lock"],
    exclude: ["packages/domain/test/**"],
  },
});
```

`alwaysDeploy: true` disables memoization.

Destroying the Alchemy resource does not delete the Convex project, its
deployments, functions, or data. Destructive project ownership and independently
managed dev, preview, or custom deployments need explicit lifecycle semantics
before they are added.

## What “custom runtime” means here

`Project` uses Alchemy's `Platform` API with a Convex-specific
`BaseRuntimeContext`. Alchemy resolves Outputs nested in its props, including
Convex environment variables, before reconciliation. Its provider then gives
the source tree to the Convex CLI, which packages functions for Convex's
managed runtime.

It does not translate arbitrary Effect HTTP handlers into Convex queries,
mutations, or actions. That deeper runtime needs a stable function manifest or
code-generation boundary, ideally shared with Confect, before depending on
private Convex or Confect internals.

## Development

```sh
bun install
bun run check
bun run test
bun run build
```

Provider tests inject `ConvexCli` and `ConvexManagementApi` Layers, so they
exercise Alchemy's create/no-op/update/destroy lifecycle without touching a
real Convex deployment or local profile.
