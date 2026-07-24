# Convex

An Alchemy provider for creating Convex projects and deploying production,
development, and preview environments.

`alchemy-convex` manages project and deployment lifecycles, environment
variables, and authentication. The official Convex CLI continues to handle
typechecking, code generation, bundling, and code deployment.

## Installation

```sh
bun add alchemy-convex "alchemy@next" convex "effect@beta" \
  "@effect/platform-bun@beta" "@effect/platform-node@beta"
```

## Authentication

Configure a Convex credential through Alchemy:

```sh
bun alchemy login --configure
```

The provider supports three authentication methods:

- **Environment Variable** reads `CONVEX_ACCESS_TOKEN` and is selected
  automatically when `CI=1`.
- **OAuth** opens Convex in the browser and stores an application token in the
  active Alchemy profile.
- **Access Token** securely prompts for a Convex team access token and stores
  it in `~/.alchemy/credentials/<profile>/`.

Create team access tokens from the Convex Team Settings access-token page. A
token has the permissions of the member who created it, so use a dedicated
service account for automation.

OAuth uses the provider's registered Convex application and the localhost
redirect URI `http://localhost:9976/auth/callback`; no client credentials are
required.

The provider never stores `CONVEX_DEPLOY_KEY`. During reconciliation it obtains
a deployment-scoped key from Convex. Team-token keys expire after one hour and
are revoked when the CLI exits. OAuth deployment credentials remain backed by
the OAuth grant. Neither deployment credential is written to resource
properties, outputs, Alchemy state, profiles, or CLI arguments.

## Creating a Stack

Register the Convex providers, create a project, and deploy it:

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

    const deployment = yield* Convex.Deployment("BackendDeployment", {
      project,
      env: {
        APP_ENV: "production",
      },
    });

    return {
      convexUrl: deployment.url,
      convexHttpActionsUrl: deployment.httpActionsUrl,
    };
  }),
);
```

Deploy the stack:

```sh
bun alchemy deploy
```

## Project

> Source: `src/Project.ts`

A Convex project that can be created, adopted, updated, and removed through an
Alchemy stack. Deploy code to the project with a child
[`Deployment`](#deployment) resource.

### Creating a Project

Create a project with a generated physical name:

```ts
const project = yield* Convex.Project("Backend");
```

Alchemy derives the name from the stack, stage, and resource ID. Set `name` to
use a specific Convex project name:

```ts
const project = yield* Convex.Project("Backend", {
  name: "my-backend",
});
```

### Configuring the Project Root

`rootDir` identifies the directory containing the project's `package.json` and
Convex configuration. It defaults to `"."`, the stack's working directory.

```ts
const project = yield* Convex.Project("Backend", {
  rootDir: "./apps/backend",
});
```

Each child deployment runs the Convex CLI installed in this directory. No
global Convex CLI installation is required. Override the executable when
registering providers:

```ts
providers: Convex.providers({
  binary: "/path/to/convex",
});
```

### Customizing Source Hashing

Alchemy hashes the project source and skips deployment when both the resource
properties and source are unchanged. Secrets, dependencies, build outputs,
Alchemy state, and `convex/_generated` are excluded by default.

Use `source.include` and `source.exclude` to customize hashing in a monorepo:

```ts
const project = yield* Convex.Project("Backend", {
  rootDir: "./apps/backend",
  source: {
    include: ["convex/**", "packages/domain/**", "package.json", "bun.lock"],
    exclude: ["packages/domain/test/**"],
  },
});
```

## Deployment

> Source: `src/Deployment.ts`

A production, development, or preview deployment within a
[`Project`](#project). It reconciles environment variables before invoking the
project's local Convex CLI.

### Deploying to Production

`reference` defaults to `"production"`:

```ts
const deployment = yield* Convex.Deployment("BackendDeployment", {
  project,
});

deployment.url;
deployment.httpActionsUrl;
```

The default production deployment is attached automatically because Convex
creates it with the parent project.

### Creating Development and Preview Deployments

Use a stable `dev/<name>` or `preview/<name>` reference:

```ts
const development = yield* Convex.Deployment("AgentDeployment", {
  project,
  reference: "dev/agent-1",
});

const preview = yield* Convex.Deployment("PullRequest", {
  project,
  reference: "preview/pr-123",
  expiresAt: "2030-01-01T00:00:00Z",
});
```

`expiresAt` is only valid for preview deployments and accepts an ISO timestamp
or Unix milliseconds. Convex's generated physical deployment name is available
as `deployment.name`.

### Configuring a Deployment

Control Convex CLI behavior for an individual deployment:

```ts
const deployment = yield* Convex.Deployment("BackendDeployment", {
  project,
  typecheck: "enable",
  codegen: true,
  message: "Deploy from Alchemy",
});
```

`typecheck` accepts `"enable"`, `"try"`, or `"disable"` and defaults to
`"try"`. `codegen` defaults to `true`. Set `alwaysDeploy: true` to run the CLI
even when the resource properties and source hash are unchanged.

### Setting Environment Variables

Pass literal values or outputs from other Alchemy resources through `env`:

```ts
const web = yield* Cloudflare.Worker("Web", {
  main: "./src/worker.ts",
});

const deployment = yield* Convex.Deployment("BackendDeployment", {
  project,
  env: {
    APP_ENV: "production",
    SITE_URL: web.url,
  },
});
```

Alchemy resolves nested outputs before reconciliation. Variables removed from
`env` are removed from Convex on the next deployment.

## Adopting Existing Resources

Alchemy requires explicit adoption when a named project or a development or
preview reference already exists outside the stack:

```ts
import { adopt } from "alchemy/AdoptPolicy";

const project = yield* Convex.Project("Backend", {
  name: "existing-project",
  rootDir: "./apps/backend",
}).pipe(adopt());

const deployment = yield* Convex.Deployment("ExistingPreview", {
  project,
  reference: "preview/pr-123",
}).pipe(adopt());
```

You can also deploy with the `--adopt` CLI flag.

## Removal Behavior

Destroying a `Convex.Deployment` deletes that deployment, including its data
and files. Destroying a `Convex.Project` deletes the project and cascades to all
of its deployments. Alchemy destroys dependencies first, so deployments are
deleted before their parent project.

Use `retain()` when a remote resource should survive stack removal:

```ts
import { retain } from "alchemy/RemovalPolicy";

const project = yield* Convex.Project("Backend", {
  rootDir: "./apps/backend",
}).pipe(retain());

const deployment = yield* Convex.Deployment("BackendDeployment", {
  project,
}).pipe(retain());
```

## Runtime Model

`Deployment` uses Alchemy's `Platform` API with a Convex-specific runtime
context. Alchemy resolves outputs nested in deployment properties before
passing the source tree and environment to the Convex CLI.

The provider deploys standard Convex functions. It does not translate Effect
HTTP handlers into Convex queries, mutations, or actions.

## Development

```sh
bun install
bun run format:check
bun run lint
bun run check
bun run test
bun run build
```

Provider tests inject `ConvexCli` and `ConvexManagementApi` layers, exercising
Alchemy's create, no-op, update, and destroy lifecycle without accessing a real
Convex deployment or local profile.
