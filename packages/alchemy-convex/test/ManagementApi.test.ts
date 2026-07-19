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
  it("finds an existing project without creating it", async () => {
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
          return new Response(
            JSON.stringify({
              items: [{ id: 42, name: "backend", slug: "backend" }],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: 42,
            name: "backend",
            slug: "backend",
            teamId: 7,
            teamSlug: "alchemy-team",
            prodDeploymentName: "kind-otter-123",
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
        return yield* api.findProject({ name: "backend" });
      }).pipe(Effect.provide(layer)),
    );

    expect(project).toEqual({
      projectId: 42,
      name: "backend",
      slug: "backend",
      teamId: 7,
      teamSlug: "alchemy-team",
      defaultProductionDeploymentName: "kind-otter-123",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/create_project"),
      ),
    ).toBe(false);
  });

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
      defaultProductionDeploymentName: "generated-fox-456",
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

  it("adopts the default production deployment", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: 99,
            projectId: 42,
            name: "kind-otter-123",
            deploymentType: "prod",
            reference: "production",
            isDefault: true,
            deploymentUrl: "https://kind-otter-123.convex.cloud",
            expiresAt: null,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const layer = ConvexManagementApiLive({
      apiBaseUrl: "https://api.example.test/v1",
    }).pipe(Layer.provide(credentialsLayer("accessToken")));

    const deployment = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ConvexManagementApi;
        return yield* api.ensureDeployment({
          projectId: 42,
          type: "prod",
          defaultProductionDeploymentName: "kind-otter-123",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(deployment).toMatchObject({
      name: "kind-otter-123",
      type: "prod",
      isDefault: true,
      createdDeployment: false,
      managedDeployment: false,
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://api.example.test/v1/deployments/kind-otter-123",
    );
  });

  it("finds a referenced deployment without creating it", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify([
            {
              id: 100,
              projectId: 42,
              name: "quick-fox-456",
              deploymentType: "preview",
              reference: "preview/pr-123",
              isDefault: false,
              deploymentUrl: "https://quick-fox-456.convex.cloud",
              expiresAt: null,
            },
          ]),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const layer = ConvexManagementApiLive({
      apiBaseUrl: "https://api.example.test/v1",
    }).pipe(Layer.provide(credentialsLayer("accessToken")));

    const deployment = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ConvexManagementApi;
        return yield* api.findDeployment({
          projectId: 42,
          type: "preview",
          reference: "preview/pr-123",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(deployment).toMatchObject({
      deploymentId: 100,
      name: "quick-fox-456",
      reference: "preview/pr-123",
    });
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "/projects/42/list_deployments?deploymentType=preview",
    );
  });

  it("creates a referenced preview deployment", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/list_deployments?")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.endsWith("/create_deployment")) {
          return new Response(
            JSON.stringify({
              id: 100,
              projectId: 42,
              name: "quick-fox-456",
              deploymentType: "preview",
              reference: "preview/my-stack-backend",
              isDefault: false,
              deploymentUrl: "https://quick-fox-456.convex.cloud",
              expiresAt: 2_000_000_000_000,
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const layer = ConvexManagementApiLive({
      apiBaseUrl: "https://api.example.test/v1",
    }).pipe(Layer.provide(credentialsLayer("accessToken")));

    const deployment = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ConvexManagementApi;
        return yield* api.ensureDeployment({
          projectId: 42,
          type: "preview",
          reference: "preview/my-stack-backend",
          expiresAt: 2_000_000_000_000,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(deployment).toMatchObject({
      name: "quick-fox-456",
      type: "preview",
      reference: "preview/my-stack-backend",
      createdDeployment: true,
      managedDeployment: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)),
    ).toEqual({
      type: "preview",
      reference: "my-stack-backend",
      expiresAt: 2_000_000_000_000,
    });
  });

  it("cleans up a newly created deployment when Convex returns the wrong reference", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/list_deployments?")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.endsWith("/create_deployment")) {
          return new Response(
            JSON.stringify({
              id: 100,
              projectId: 42,
              name: "accurate-grouse-679",
              deploymentType: "preview",
              reference: "preview/preview-lucas",
              isDefault: false,
              deploymentUrl: "https://accurate-grouse-679.convex.cloud",
              expiresAt: null,
            }),
            { status: 200 },
          );
        }
        return new Response(undefined, { status: 204 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const layer = ConvexManagementApiLive({
      apiBaseUrl: "https://api.example.test/v1",
    }).pipe(Layer.provide(credentialsLayer("accessToken")));

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* ConvexManagementApi;
          return yield* api.ensureDeployment({
            projectId: 42,
            type: "preview",
            reference: "preview/lucas",
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toMatchObject({
      _tag: "ConvexManagementApiError",
      message: expect.stringContaining(
        "has reference preview/preview-lucas, not preview/lucas",
      ),
    });
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      "https://api.example.test/v1/deployments/accurate-grouse-679/delete",
    );
  });

  it("refuses to silently take ownership of an existing reference", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify([
            {
              id: 100,
              projectId: 42,
              name: "quick-fox-456",
              deploymentType: "preview",
              reference: "preview/pr-123",
              isDefault: false,
              deploymentUrl: "https://quick-fox-456.convex.cloud",
              expiresAt: null,
            },
          ]),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const layer = ConvexManagementApiLive({
      apiBaseUrl: "https://api.example.test/v1",
    }).pipe(Layer.provide(credentialsLayer("accessToken")));

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* ConvexManagementApi;
          return yield* api.ensureDeployment({
            projectId: 42,
            type: "preview",
            reference: "preview/pr-123",
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toMatchObject({
      _tag: "ConvexManagementApiError",
      operation: "ensure deployment",
      message: expect.stringContaining("Adopt it explicitly"),
    });
  });

  it("updates preview expiration and deletes deployments", async () => {
    const expiresAt = 2_000_000_000_000;
    const deployment = {
      id: 100,
      projectId: 42,
      name: "quick-fox-456",
      deploymentType: "preview",
      reference: "preview/my-stack-backend",
      isDefault: false,
      deploymentUrl: "https://quick-fox-456.convex.cloud",
      expiresAt: null,
    } as const;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/delete")) {
          return new Response(undefined, { status: 204 });
        }
        return new Response(
          JSON.stringify(
            init?.method === "PATCH"
              ? { ...deployment, expiresAt }
              : deployment,
          ),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const layer = ConvexManagementApiLive({
      apiBaseUrl: "https://api.example.test/v1",
    }).pipe(Layer.provide(credentialsLayer("accessToken")));

    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ConvexManagementApi;
        const ensured = yield* api.ensureDeployment({
          projectId: 42,
          name: "quick-fox-456",
          type: "preview",
          expiresAt,
        });
        expect(ensured.expiresAt).toBe(expiresAt);
        yield* api.deleteDeployment(ensured.name);
      }).pipe(Effect.provide(layer)),
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "PATCH" });
    expect(
      JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)),
    ).toEqual({ expiresAt });
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      "https://api.example.test/v1/deployments/quick-fox-456/delete",
    );
  });

  it("deletes projects and treats missing resources as already deleted", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response("not found", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const layer = ConvexManagementApiLive({
      apiBaseUrl: "https://api.example.test/v1",
    }).pipe(Layer.provide(credentialsLayer("accessToken")));

    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* ConvexManagementApi;
        yield* api.deleteDeployment("missing-deployment");
        yield* api.deleteProject(42);
      }).pipe(Effect.provide(layer)),
    );

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://api.example.test/v1/deployments/missing-deployment/delete",
    );
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      "https://api.example.test/v1/projects/42/delete",
    );
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
