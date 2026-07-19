# alchemy-convex

`alchemy-convex` is an experimental Alchemy v2 provider for deploying a
standard Convex project from an Alchemy stack.

The MVP contains four pieces:

- `Convex.Project`, an Alchemy resource that creates or adopts a Convex
  project.
- `Convex.Deployment`, an Alchemy `Platform` that deploys a project directory
  to a production, development, or preview reference.
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

OAuth uses the provider's registered Convex application and the localhost
redirect URI `http://localhost:9976/auth/callback`; no client credential setup
is required. The MVP always requests a team-scoped application token.

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
    const project = yield* Convex.Project("Backend");

    const backend = yield* Convex.Deployment("BackendDeployment", {
      project,
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

`Project.name` and `Project.dir` are optional. When `name` is omitted, the
provider derives a stable name from the Alchemy stack, stage, and resource ID.
`dir` defaults to `"."`, the stack's working directory. With a team-scoped
token the provider resolves the name in the authorized team and creates the
project when none exists. If that name already belongs to a project outside
the stack, Alchemy requires explicit adoption with `--adopt` or `adopt()`.

`Deployment.reference` selects the deployment and defaults to `"production"`.
Development and preview references carry their deployment type in the
reference itself:

```ts
const preview = yield* Convex.Deployment("PullRequest", {
  project,
  reference: "preview/pr-123",
  expiresAt: "2030-01-01T00:00:00Z",
});
```

Supported references are `"production"`, `"dev/<name>"`, and
`"preview/<name>"`. The stable reference is desired configuration; Convex's
generated deployment name is exposed as `deployment.name`.
An existing development or preview reference also requires explicit adoption;
the default production deployment is attached automatically because Convex
creates it with the parent project.

The authenticated token must be allowed to access the project. `Project.dir`
must contain the project's `package.json`; each child deployment invokes that
project's installed Convex CLI, so no global CLI is required. Override the
executable with `Convex.providers({ binary: "/path/to/convex" })`.

## Use resource outputs as environment variables

Pass outputs from other Alchemy resources directly in `env`, just like other
Alchemy resources do:

```ts
const web = yield* Cloudflare.Worker("Web", {
  main: "./src/worker.ts",
});

const project = yield* Convex.Project("Backend", {
  dir: "./apps/backend",
});

const backend = yield* Convex.Deployment("BackendDeployment", {
  project,
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
const project = yield* Convex.Project("Backend", {
  dir: "./apps/backend",
  source: {
    include: ["convex/**", "packages/domain/**", "package.json", "bun.lock"],
    exclude: ["packages/domain/test/**"],
  },
});

yield* Convex.Deployment("BackendDeployment", { project });
```

`Deployment.alwaysDeploy: true` disables memoization.

Both resources use Alchemy's normal removal policy. Destroying a
`Convex.Deployment` deletes that deployment, including its data and files.
Destroying a `Convex.Project` deletes the project and cascades to every
deployment in it. Dependencies are destroyed first, so a stack containing both
resources deletes the deployment before its parent project.

Use Alchemy's `retain()` when remote data should survive stack removal:

```ts
import { retain } from "alchemy/RemovalPolicy";

const project = yield* Convex.Project("Backend", {
  dir: "./apps/backend",
}).pipe(retain());

const deployment = yield* Convex.Deployment("BackendDeployment", {
  project,
}).pipe(retain());
```

Adopt an existing named project explicitly when you intend the stack to own
and eventually delete it:

```ts
import { adopt } from "alchemy/AdoptPolicy";

const project = yield* Convex.Project("Backend", {
  name: "existing-project",
  dir: "./apps/backend",
}).pipe(adopt());
```

## What “custom runtime” means here

`Deployment` uses Alchemy's `Platform` API with a Convex-specific
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
