import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConvexManagementApi,
  ConvexManagementApiLive,
  Credentials,
} from "../src/index.js";

const credentialsLayer = (type: "accessToken" | "oauth") =>
  Layer.succeed(
    Credentials,
    Effect.succeed(
      type === "oauth"
        ? {
            type,
            accessToken: Redacted.make("team:oauth|secret"),
            source: { type: "oauth" as const },
          }
        : {
            type,
            accessToken: Redacted.make("team:access|secret"),
            source: { type: "stored" as const },
          },
    ),
  );

afterEach(() => vi.unstubAllGlobals());

describe("ConvexManagementApi", () => {
  it("creates a named project with a production deployment", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/token_details")) {
          return new Response(
            JSON.stringify({ type: "teamToken", teamId: 7 }),
            { status: 200 },
          );
        }
        if (url.includes("/teams/7/projects?")) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (url.endsWith("/teams/7/create_project")) {
          return new Response(
            JSON.stringify({
              id: 42,
              slug: "my-stack-backend-production-abc",
              deploymentName: "generated-fox-456",
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: 42,
            name: "my-stack-backend-production-abc",
            slug: "my-stack-backend-production-abc",
            teamId: 7,
            teamSlug: "alchemy-team",
            prodDeploymentName: "generated-fox-456",
          }),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const layer = ConvexManagementApiLive({
      apiBaseUrl: "https://api.example.test/v1",
    }).pipe(Layer.provide(credentialsLayer("accessToken")));

    const project = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ConvexManagementApi;
        return yield* api.ensureProject({
          name: "my-stack-backend-production-abc",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(project).toEqual({
      projectId: 42,
      name: "my-stack-backend-production-abc",
      slug: "my-stack-backend-production-abc",
      teamId: 7,
      teamSlug: "alchemy-team",
      deploymentName: "generated-fox-456",
      createdProject: true,
      createdDeployment: true,
      managedProject: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      JSON.parse(String((fetchMock.mock.calls[2]![1] as RequestInit).body)),
    ).toEqual({
      projectName: "my-stack-backend-production-abc",
      deploymentType: "prod",
    });
  });

  it("leases and revokes an expiring deploy key for a team access token", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        return url.endsWith("/create_deploy_key")
          ? new Response(
              JSON.stringify({ deployKey: "prod:kind-otter-123|temporary" }),
              { status: 200 },
            )
          : new Response("{}", { status: 200 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const layer = ConvexManagementApiLive({
      apiBaseUrl: "https://api.example.test/v1",
    }).pipe(Layer.provide(credentialsLayer("accessToken")));

    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ConvexManagementApi;
        const lease = yield* api.leaseDeploymentKey({
          deploymentName: "kind-otter-123",
          keyName: "alchemy-test",
        });
        expect(Redacted.value(lease.deployKey)).toBe(
          "prod:kind-otter-123|temporary",
        );
        yield* lease.release;
      }).pipe(Effect.provide(layer)),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const create = fetchMock.mock.calls[0]!;
    expect(String(create[0])).toBe(
      "https://api.example.test/v1/deployments/kind-otter-123/create_deploy_key",
    );
    const createInit = create[1] as RequestInit;
    expect(createInit.headers).toMatchObject({
      Authorization: "Bearer team:access|secret",
    });
    expect(JSON.parse(String(createInit.body))).toMatchObject({
      name: "alchemy-test",
      allowedActions: [
        "deployment:deploy",
        "deployment:env:view",
        "deployment:env:write",
      ],
      expiresAt: expect.any(Number),
    });
    const revokeInit = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(JSON.parse(String(revokeInit.body))).toEqual({
      id: "prod:kind-otter-123|temporary",
    });
  });

  it("does not revoke a deploy-key view backed by an OAuth grant", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ deployKey: "prod:kind-otter-123|oauth-secret" }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const layer = ConvexManagementApiLive({
      apiBaseUrl: "https://api.example.test/v1",
    }).pipe(Layer.provide(credentialsLayer("oauth")));

    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ConvexManagementApi;
        const lease = yield* api.leaseDeploymentKey({
          deploymentName: "kind-otter-123",
        });
        yield* lease.release;
      }).pipe(Effect.provide(layer)),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]![1] as RequestInit).body),
    );
    expect(body).toMatchObject({ name: expect.stringMatching(/^alchemy-/) });
    expect(body).not.toHaveProperty("expiresAt");
    expect(body).not.toHaveProperty("allowedActions");
  });
});
