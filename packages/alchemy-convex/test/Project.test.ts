import { expect } from "@effect/vitest";
import * as Output from "alchemy/Output";
import { adopt } from "alchemy/AdoptPolicy";
import { retain } from "alchemy/RemovalPolicy";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  ConvexCli,
  ConvexManagementApi,
  Deployment,
  Project,
  providersWithRuntime,
  type ConvexDeployRequest,
  type DeploymentMetadata,
  type EnsureDeploymentInput,
  type EnsureProjectInput,
  type ProjectMetadata,
} from "../src/index.js";

const calls: ConvexDeployRequest[] = [];
const leases: string[] = [];
const projectEnsures: EnsureProjectInput[] = [];
const deploymentEnsures: EnsureDeploymentInput[] = [];
const deletions: string[] = [];
let releases = 0;
let existingProject: ProjectMetadata | undefined;
let existingDeployment: DeploymentMetadata | undefined;

const FakeCli = Layer.succeed(
  ConvexCli,
  ConvexCli.of({
    deploy: (request) =>
      Effect.sync(() => {
        calls.push(request);
        const key = Redacted.value(request.deployKey);
        const deploymentName = key.split("|")[0]!.split(":").at(-1)!;
        return {
          deploymentName,
          deploymentType: key.startsWith("preview:")
            ? ("preview" as const)
            : key.startsWith("dev:")
              ? ("dev" as const)
              : ("prod" as const),
          url: `https://${deploymentName}.convex.cloud`,
          httpActionsUrl: `https://${deploymentName}.convex.site`,
          stdout: "deployed",
          stderr: "",
        };
      }),
  }),
);

const FakeManagement = Layer.succeed(
  ConvexManagementApi,
  ConvexManagementApi.of({
    findProject: () => Effect.sync(() => existingProject),
    ensureProject: (input) =>
      Effect.sync(() => {
        projectEnsures.push(input);
        return {
          projectId: input.projectId ?? 42,
          name: input.name,
          slug: input.name,
          teamId: 7,
          teamSlug: "alchemy-team",
          defaultProductionDeploymentName: "kind-otter-123",
          createdProject: input.projectId === undefined,
          createdDeployment: input.projectId === undefined,
          managedProject: true,
        };
      }),
    findDeployment: () => Effect.sync(() => existingDeployment),
    ensureDeployment: (input) =>
      Effect.sync(() => {
        deploymentEnsures.push(input);
        const name =
          input.type === "prod"
            ? "kind-otter-123"
            : input.type === "dev"
              ? "clever-badger-234"
              : "quick-fox-456";
        return {
          deploymentId: 99,
          projectId: input.projectId,
          name,
          type: input.type,
          reference:
            input.reference ?? (input.type === "prod" ? "production" : ""),
          isDefault: input.type === "prod",
          url: `https://${name}.convex.cloud`,
          expiresAt: input.expiresAt ?? null,
          createdDeployment: input.type !== "prod",
          managedDeployment: input.type !== "prod",
        };
      }),
    deleteProject: (projectId) =>
      Effect.sync(() => {
        deletions.push(`project:${projectId}`);
      }),
    deleteDeployment: (name) =>
      Effect.sync(() => {
        deletions.push(`deployment:${name}`);
      }),
    leaseDeploymentKey: ({ deploymentName }) =>
      Effect.sync(() => {
        leases.push(deploymentName);
        const prefix =
          deploymentName === "kind-otter-123"
            ? "prod"
            : deploymentName === "quick-fox-456"
              ? "preview"
              : "dev";
        return {
          deployKey: Redacted.make(`${prefix}:${deploymentName}|secret`),
          release: Effect.sync(() => {
            releases += 1;
          }),
        };
      }),
  }),
);

const { test, beforeEach } = Test.make({
  providers: providersWithRuntime(FakeCli, FakeManagement),
});

const referencedPreviewProgram = (shouldAdopt: boolean) =>
  Effect.gen(function* () {
    const project = yield* Project("Backend", {
      name: "backend-project",
      dir: "test/fixtures/project",
    });
    const deployment = Deployment("Preview", {
      project,
      reference: "preview/pr-123",
    });
    return yield* shouldAdopt ? deployment.pipe(adopt()) : deployment;
  });

beforeEach(
  Effect.sync(() => {
    calls.length = 0;
    leases.length = 0;
    projectEnsures.length = 0;
    deploymentEnsures.length = 0;
    deletions.length = 0;
    releases = 0;
    existingProject = undefined;
    existingDeployment = undefined;
  }),
);

test.provider(
  "requires explicit adoption for an existing named project",
  (stack) =>
    Effect.gen(function* () {
      existingProject = {
        projectId: 42,
        name: "existing-backend",
        slug: "existing-backend",
        teamId: 7,
        teamSlug: "alchemy-team",
        defaultProductionDeploymentName: "kind-otter-123",
      };
      const props = {
        name: "existing-backend",
        dir: "test/fixtures/project",
      } as const;

      const rejected = yield* Effect.exit(
        stack.deploy(Project("ExistingBackend", props)),
      );
      expect(Exit.isFailure(rejected)).toBe(true);

      const adopted = yield* stack.deploy(
        Project("ExistingBackend", props).pipe(adopt()),
      );
      expect(adopted.projectId).toBe(42);
      expect(adopted.name).toBe("existing-backend");
    }),
);

test.provider(
  "defaults the project directory to the stack working directory",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* stack.deploy(Project("DefaultDirectory"));
      expect(project.dir).toBe(".");
      expect(calls).toHaveLength(0);
    }),
);

test.provider(
  "requires explicit adoption for an existing referenced deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Project("Backend", {
          name: "backend-project",
          dir: "test/fixtures/project",
        }),
      );
      existingDeployment = {
        deploymentId: 99,
        projectId: 42,
        name: "quick-fox-456",
        type: "preview",
        reference: "preview/pr-123",
        isDefault: false,
        url: "https://quick-fox-456.convex.cloud",
        expiresAt: null,
      };

      const rejected = yield* Effect.exit(
        stack.deploy(referencedPreviewProgram(false)),
      );
      expect(Exit.isFailure(rejected)).toBe(true);

      const adopted = yield* stack.deploy(referencedPreviewProgram(true));
      expect(adopted.name).toBe("quick-fox-456");
      expect(calls).toHaveLength(1);
      expect(deploymentEnsures[0]).toMatchObject({
        name: "quick-fox-456",
        reference: "preview/pr-123",
      });
    }),
);

test.provider(
  "deploys and memoizes the default production deployment",
  (stack) =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const web = { url: Output.literal("https://web.example.com") };
        const project = yield* Project("Backend", {
          name: "backend-project",
          dir: "test/fixtures/project",
        });
        return yield* Deployment("BackendDeployment", {
          project,
          env: { DIRECT: "value", SITE_URL: web.url },
        });
      });

      const created = yield* stack.deploy(program);
      expect(created.reference).toBe("production");
      expect(created.type).toBe("production");
      expect(created.name).toBe("kind-otter-123");
      expect(created.url).toBe("https://kind-otter-123.convex.cloud");
      expect(projectEnsures[0]).toEqual({ name: "backend-project" });
      expect(deploymentEnsures[0]).toMatchObject({
        projectId: 42,
        type: "prod",
        defaultProductionDeploymentName: "kind-otter-123",
      });
      expect(leases).toEqual(["kind-otter-123"]);
      expect(releases).toBe(1);
      expect(calls[0]?.environment).toEqual({
        DIRECT: "value",
        SITE_URL: "https://web.example.com",
      });

      const unchanged = yield* stack.deploy(program);
      expect(unchanged.sourceHash).toBe(created.sourceHash);
      expect(calls).toHaveLength(1);
    }),
);

test.provider(
  "generates and persists the project name before deploying",
  (stack) =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const project = yield* Project("GeneratedBackend", {
          dir: "test/fixtures/project",
        });
        return yield* Deployment("GeneratedDeployment", { project });
      });

      const created = yield* stack.deploy(program);
      expect(projectEnsures[0]?.name).toMatch(/generatedbackend/);
      expect(created.projectId).toBe(42);
      expect(calls).toHaveLength(1);

      yield* stack.deploy(program);
      expect(projectEnsures).toHaveLength(1);
      expect(calls).toHaveLength(1);
    }),
);

test.provider("infers development and preview kinds from references", (stack) =>
  Effect.gen(function* () {
    const dev = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Project("Backend", {
          name: "backend-project",
          dir: "test/fixtures/project",
        });
        return yield* Deployment("AgentDeployment", {
          project,
          reference: "dev/agent-1",
        });
      }),
    );
    expect(dev.reference).toBe("dev/agent-1");
    expect(dev.type).toBe("development");
    expect(deploymentEnsures[0]).toMatchObject({
      type: "dev",
      reference: "dev/agent-1",
    });

    const expiresAt = "2030-01-01T00:00:00.000Z";
    const preview = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Project("Backend", {
          name: "backend-project",
          dir: "test/fixtures/project",
        });
        return yield* Deployment("AgentDeployment", {
          project,
          reference: "preview/pr-123",
          expiresAt,
        });
      }),
    );
    expect(preview.type).toBe("preview");
    expect(deploymentEnsures[1]?.expiresAt).toBe(new Date(expiresAt).getTime());
  }),
);

test.provider("destroys deployments before their parent project", (stack) =>
  Effect.gen(function* () {
    yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Project("Backend", {
          dir: "test/fixtures/project",
        });
        return yield* Deployment("BackendDeployment", { project });
      }),
    );

    yield* stack.destroy();
    expect(deletions).toEqual(["deployment:kind-otter-123", "project:42"]);
  }),
);

test.provider("supports retaining projects and deployments", (stack) =>
  Effect.gen(function* () {
    yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Project("Backend", {
          dir: "test/fixtures/project",
        }).pipe(retain());
        return yield* Deployment("BackendDeployment", { project }).pipe(
          retain(),
        );
      }),
    );

    yield* stack.destroy();
    expect(deletions).toEqual([]);
  }),
);
