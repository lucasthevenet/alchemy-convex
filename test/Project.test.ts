import { expect } from "@effect/vitest";
import * as Test from "alchemy/Test/Vitest";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  ConvexCli,
  ConvexManagementApi,
  Project,
  providersWithRuntime,
  type ConvexDeployRequest,
  type EnsureProjectInput,
} from "../src/index.js";

const calls: ConvexDeployRequest[] = [];
const leases: string[] = [];
const ensures: EnsureProjectInput[] = [];
let releases = 0;
const deployKey = Redacted.make("prod:kind-otter-123|secret");

const FakeCli = Layer.succeed(
  ConvexCli,
  ConvexCli.of({
    deploy: (request) =>
      Effect.sync(() => {
        calls.push(request);
        return {
          deploymentName: "kind-otter-123",
          deploymentType: "prod" as const,
          url: "https://kind-otter-123.convex.cloud",
          httpActionsUrl: "https://kind-otter-123.convex.site",
          stdout: "deployed",
          stderr: "",
        };
      }),
  }),
);

const FakeManagement = Layer.succeed(
  ConvexManagementApi,
  ConvexManagementApi.of({
    ensureProject: (input) =>
      Effect.sync(() => {
        ensures.push(input);
        return {
          projectId: input.projectId ?? 42,
          name: input.name,
          slug: input.name,
          teamId: input.teamId ?? 7,
          teamSlug: "alchemy-team",
          deploymentName: "kind-otter-123",
          createdProject: input.projectId === undefined,
          createdDeployment: input.projectId === undefined,
          managedProject: input.projectId === undefined,
        };
      }),
    leaseDeploymentKey: ({ deploymentName }) =>
      Effect.sync(() => {
        leases.push(deploymentName);
        return {
          deployKey,
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

beforeEach(
  Effect.sync(() => {
    calls.length = 0;
    leases.length = 0;
    ensures.length = 0;
    releases = 0;
  }),
);

test.provider("deploys and memoizes a Convex project", (stack) =>
  Effect.gen(function* () {
    const program = Effect.gen(function* () {
      const web = { url: Output.literal("https://web.example.com") };
      return yield* Project("Backend", {
        projectId: 42,
        projectDir: "test/fixtures/project",
        env: { DIRECT: "value", SITE_URL: web.url },
      });
    });

    const created = yield* stack.deploy(program);
    expect(created.url).toBe("https://kind-otter-123.convex.cloud");
    expect(created.httpActionsUrl).toBe("https://kind-otter-123.convex.site");
    expect("deployKey" in created).toBe(false);
    expect(calls).toHaveLength(1);
    expect(ensures).toHaveLength(1);
    expect(leases).toEqual(["kind-otter-123"]);
    expect(releases).toBe(1);
    expect(Redacted.value(calls[0]!.deployKey)).toBe(
      "prod:kind-otter-123|secret",
    );
    expect(calls[0]?.environment).toEqual({
      DIRECT: "value",
      SITE_URL: "https://web.example.com",
    });

    const unchanged = yield* stack.deploy(program);
    expect(unchanged.sourceHash).toBe(created.sourceHash);
    expect(calls).toHaveLength(1);

    const updated = yield* stack.deploy(
      Project("Backend", {
        projectId: 42,
        projectDir: "test/fixtures/project",
        env: { DIRECT: "next" },
      }),
    );
    expect(updated.environmentKeys).toEqual(["DIRECT"]);
    expect(calls).toHaveLength(2);
    expect(releases).toBe(2);
    expect(calls[1]?.previousEnvironmentKeys).toEqual(["DIRECT", "SITE_URL"]);
    expect(calls[1]?.environment).toEqual({ DIRECT: "next" });
  }),
);

test.provider("generates and persists a project name", (stack) =>
  Effect.gen(function* () {
    const program = Project("GeneratedBackend", {
      teamId: 7,
      projectDir: "test/fixtures/project",
    });

    const created = yield* stack.deploy(program);
    expect(created.projectId).toBe(42);
    expect(created.name).toMatch(/generatedbackend/);
    expect(created.managedProject).toBe(true);
    expect(ensures).toHaveLength(1);
    expect(ensures[0]).toMatchObject({
      teamId: 7,
      name: created.name,
    });
    expect(leases).toEqual(["kind-otter-123"]);

    const unchanged = yield* stack.deploy(program);
    expect(unchanged.name).toBe(created.name);
    expect(ensures).toHaveLength(1);
    expect(calls).toHaveLength(1);
  }),
);
