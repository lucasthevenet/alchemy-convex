import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { randomUUID } from "node:crypto";
import { Credentials } from "./Credentials.js";

export interface DeploymentKeyLease {
  readonly deployKey: Redacted.Redacted<string>;
  /** Revokes access-token leases. OAuth leases reuse the OAuth grant. */
  readonly release: Effect.Effect<void, ConvexManagementApiError>;
}

export interface LeaseDeploymentKeyInput {
  readonly deploymentName: string;
  readonly keyName?: string;
}

export interface EnsureProjectInput {
  readonly projectId?: number;
  readonly teamId?: number;
  readonly name: string;
}

export interface EnsuredProject {
  readonly projectId: number;
  readonly name: string;
  readonly slug: string;
  readonly teamId: number;
  readonly teamSlug: string;
  readonly deploymentName: string;
  readonly createdProject: boolean;
  readonly createdDeployment: boolean;
  readonly managedProject: boolean;
}

interface ProjectResponse {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly teamId: number;
  readonly teamSlug: string;
  readonly prodDeploymentName: string | null;
}

export interface ConvexManagementApiOptions {
  readonly apiBaseUrl?: string;
  /** Temporary access-token deploy keys expire even if cleanup cannot run. */
  readonly deployKeyTtlMs?: number;
}

export class ConvexManagementApiError extends Data.TaggedError(
  "ConvexManagementApiError",
)<{
  readonly operation: string;
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class ConvexManagementApi extends Context.Service<
  ConvexManagementApi,
  {
    readonly ensureProject: (
      input: EnsureProjectInput,
    ) => Effect.Effect<EnsuredProject, ConvexManagementApiError>;
    readonly leaseDeploymentKey: (
      input: LeaseDeploymentKeyInput,
    ) => Effect.Effect<DeploymentKeyLease, ConvexManagementApiError>;
  }
>()("alchemy-convex/ConvexManagementApi") {}

const responseMessage = async (response: Response): Promise<string> => {
  const text = await response.text();
  if (text.length === 0) return `HTTP ${response.status}`;
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (typeof payload.message === "string") return payload.message;
    if (typeof payload.error === "string") return payload.error;
  } catch {
    // The response is not JSON; return its text below.
  }
  return text;
};

export const ConvexManagementApiLive = (
  options: ConvexManagementApiOptions = {},
) =>
  Layer.effect(
    ConvexManagementApi,
    Effect.gen(function* () {
      const credentials = yield* Credentials;
      const apiBaseUrl = (
        options.apiBaseUrl ?? "https://api.convex.dev/v1"
      ).replace(/\/$/, "");
      const ttlMs = Math.max(
        options.deployKeyTtlMs ?? 60 * 60 * 1000,
        30 * 60 * 1000 + 1_000,
      );

      const request = <A>(
        operation: string,
        accessToken: Redacted.Redacted<string>,
        method: "GET" | "POST" | "PATCH",
        path: string,
        body?: Record<string, unknown>,
      ): Effect.Effect<A, ConvexManagementApiError> =>
        Effect.tryPromise({
          try: async () => {
            const response = await fetch(`${apiBaseUrl}${path}`, {
              method,
              headers: {
                Accept: "application/json",
                Authorization: `Bearer ${Redacted.value(accessToken)}`,
                "Content-Type": "application/json",
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            if (!response.ok) {
              throw new ConvexManagementApiError({
                operation,
                message: await responseMessage(response),
                status: response.status,
              });
            }
            if (response.status === 204) return undefined as A;
            const text = await response.text();
            return (text.length === 0 ? undefined : JSON.parse(text)) as A;
          },
          catch: (cause) =>
            cause instanceof ConvexManagementApiError
              ? cause
              : new ConvexManagementApiError({
                  operation,
                  message: `Convex Management API request failed: ${String(cause)}`,
                  cause,
                }),
        });

      return ConvexManagementApi.of({
        ensureProject: (input) =>
          Effect.gen(function* () {
            const resolved = yield* credentials;
            const tokenDetails = yield* request<
              | { readonly type: "teamToken"; readonly teamId: number }
              | { readonly type: "projectToken"; readonly projectId: number }
            >(
              "get token details",
              resolved.accessToken,
              "GET",
              "/token_details",
            );

            let projectId = input.projectId;
            let createdProject = false;
            let managedProject = false;
            let createdDeploymentName: string | undefined;
            if (
              projectId === undefined &&
              tokenDetails.type === "projectToken"
            ) {
              projectId = tokenDetails.projectId;
            }

            if (projectId === undefined) {
              managedProject = true;
              const inferredTeamId =
                tokenDetails.type === "teamToken"
                  ? tokenDetails.teamId
                  : undefined;
              const teamId = input.teamId ?? inferredTeamId;
              if (teamId === undefined) {
                return yield* new ConvexManagementApiError({
                  operation: "ensure project",
                  message:
                    "A team-scoped access token or explicit teamId is required to create a Convex project.",
                });
              }
              const projects = yield* request<{
                readonly items: Array<{
                  readonly id: number;
                  readonly name: string;
                  readonly slug: string;
                }>;
              }>(
                "list projects",
                resolved.accessToken,
                "GET",
                `/teams/${encodeURIComponent(String(teamId))}/projects?limit=100&q=${encodeURIComponent(input.name)}`,
              );
              const existing = projects.items.find(
                (project) =>
                  project.name === input.name || project.slug === input.name,
              );
              if (existing !== undefined) {
                projectId = existing.id;
              } else {
                const created = yield* request<{
                  readonly id: number;
                  readonly slug: string;
                  readonly deploymentName: string | null;
                }>(
                  "create project",
                  resolved.accessToken,
                  "POST",
                  `/teams/${encodeURIComponent(String(teamId))}/create_project`,
                  { projectName: input.name, deploymentType: "prod" },
                );
                projectId = created.id;
                createdDeploymentName = created.deploymentName ?? undefined;
                createdProject = true;
              }
            }

            let project = yield* request<ProjectResponse>(
              "get project",
              resolved.accessToken,
              "GET",
              `/projects/${encodeURIComponent(String(projectId))}`,
            );
            if (managedProject && project.name !== input.name) {
              project = yield* request<ProjectResponse>(
                "rename project",
                resolved.accessToken,
                "PATCH",
                `/projects/${encodeURIComponent(String(project.id))}`,
                { name: input.name },
              );
            }

            let deploymentName =
              project.prodDeploymentName ?? createdDeploymentName;
            let createdDeployment = createdDeploymentName !== undefined;
            if (deploymentName === undefined) {
              const deployment = yield* request<{
                readonly kind: "cloud";
                readonly name: string;
              }>(
                "create production deployment",
                resolved.accessToken,
                "POST",
                `/projects/${encodeURIComponent(String(project.id))}/create_deployment`,
                { type: "prod", isDefault: true },
              );
              deploymentName = deployment.name;
              createdDeployment = true;
            }

            return {
              projectId: project.id,
              name: project.name,
              slug: project.slug,
              teamId: project.teamId,
              teamSlug: project.teamSlug,
              deploymentName,
              createdProject,
              createdDeployment,
              managedProject,
            };
          }),
        leaseDeploymentKey: (input) =>
          Effect.gen(function* () {
            const resolved = yield* credentials;
            const deploymentName = encodeURIComponent(input.deploymentName);
            const keyName =
              input.keyName ??
              `alchemy-${Date.now()}-${randomUUID().slice(0, 8)}`;
            const response = yield* request<{ deployKey?: unknown }>(
              "create deploy key",
              resolved.accessToken,
              "POST",
              `/deployments/${deploymentName}/create_deploy_key`,
              {
                name: keyName,
                allowedActions: [
                  "deployment:deploy",
                  "deployment:env:view",
                  "deployment:env:write",
                ],
                ...(resolved.type === "accessToken"
                  ? { expiresAt: Date.now() + ttlMs }
                  : {}),
              },
            );
            if (typeof response.deployKey !== "string") {
              return yield* new ConvexManagementApiError({
                operation: "create deploy key",
                message:
                  "Convex Management API response did not include deployKey.",
              });
            }

            const deployKey = Redacted.make(response.deployKey);
            const release =
              resolved.type === "oauth"
                ? Effect.void
                : request<void>(
                    "delete deploy key",
                    resolved.accessToken,
                    "POST",
                    `/deployments/${deploymentName}/delete_deploy_key`,
                    { id: response.deployKey },
                  );
            return { deployKey, release };
          }),
      });
    }),
  );
