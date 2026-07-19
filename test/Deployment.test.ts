import { expect } from "@effect/vitest";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  ConvexCli,
  Deployment,
  bindEnvironment,
  providersWithRuntime,
  type ConvexDeployRequest,
} from "../src/index.js";

const calls: ConvexDeployRequest[] = [];
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

const { test, beforeEach } = Test.make({
  providers: providersWithRuntime(FakeCli),
});

beforeEach(
  Effect.sync(() => {
    calls.length = 0;
  }),
);

test.provider("deploys and memoizes a Convex project", (stack) =>
  Effect.gen(function* () {
    const program = Effect.gen(function* () {
      const deployment = yield* Deployment("Backend", {
        projectDir: "test/fixtures/project",
        deployKey,
        env: { DIRECT: "value" },
      });
      yield* bindEnvironment(deployment, { BOUND: "output" });
      return deployment;
    });

    const created = yield* stack.deploy(program);
    expect(created.url).toBe("https://kind-otter-123.convex.cloud");
    expect(created.httpActionsUrl).toBe("https://kind-otter-123.convex.site");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.environment).toEqual({
      BOUND: "output",
      DIRECT: "value",
    });

    const unchanged = yield* stack.deploy(program);
    expect(unchanged.sourceHash).toBe(created.sourceHash);
    expect(calls).toHaveLength(1);

    const updated = yield* stack.deploy(
      Deployment("Backend", {
        projectDir: "test/fixtures/project",
        deployKey,
        env: { DIRECT: "next" },
      }),
    );
    expect(updated.environmentKeys).toEqual(["DIRECT"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.previousEnvironmentKeys).toEqual(["BOUND", "DIRECT"]);
    expect(calls[1]?.environment).toEqual({ DIRECT: "next" });
  }),
);
