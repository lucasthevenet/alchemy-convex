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
  /** Internal ownership state retained across reconciliations. */
  readonly managedProject?: boolean;
  readonly name: string;
}

export interface FindProjectInput {
  readonly name: string;
}

export interface ProjectMetadata {
  readonly projectId: number;
  readonly name: string;
  readonly slug: string;
  readonly teamId: number;
  readonly teamSlug: string;
  readonly defaultProductionDeploymentName: string | null;
}

export interface EnsuredProject {
  readonly projectId: number;
  readonly name: string;
  readonly slug: string;
  readonly teamId: number;
  readonly teamSlug: string;
  readonly defaultProductionDeploymentName: string;
  readonly createdProject: boolean;
  readonly createdDeployment: boolean;
  readonly managedProject: boolean;
}

export type ManagementDeploymentType = "prod" | "dev" | "preview";

/**
 * Preview creation accepts the identifier without its `preview/` namespace,
 * but deployment reads return the fully-qualified reference. Dev references
 * are accepted by the API exactly as supplied.
 */
const deploymentCreateReference = (
  type: ManagementDeploymentType,
  reference: string,
) =>
  type === "preview" && reference.startsWith("preview/")
    ? reference.slice("preview/".length)
    : reference;

export interface EnsureDeploymentInput {
  readonly projectId: number;
  readonly name?: string;
  readonly type: ManagementDeploymentType;
  readonly reference?: string;
  readonly defaultProductionDeploymentName?: string;
  readonly expiresAt?: number;
}

export interface FindDeploymentInput {
  readonly projectId: number;
  readonly type: ManagementDeploymentType;
  readonly reference?: string;
  readonly defaultProductionDeploymentName?: string;
}

export interface DeploymentMetadata {
  readonly deploymentId: number;
  readonly projectId: number;
  readonly name: string;
  readonly type: ManagementDeploymentType;
  readonly reference: string;
  readonly isDefault: boolean;
  readonly url: string;
  readonly expiresAt: number | null;
}

export interface EnsuredDeployment {
  readonly deploymentId: number;
  readonly projectId: number;
  readonly name: string;
  readonly type: ManagementDeploymentType;
  readonly reference: string;
  readonly isDefault: boolean;
  readonly url: string;
  readonly expiresAt: number | null;
  readonly createdDeployment: boolean;
  readonly managedDeployment: boolean;
}

interface ProjectResponse {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly teamId: number;
  readonly teamSlug: string;
  readonly prodDeploymentName: string | null;
}

interface DeploymentResponse {
  readonly id: number;
  readonly projectId: number;
  readonly name: string;
  readonly deploymentType: ManagementDeploymentType;
  readonly reference: string;
  readonly isDefault: boolean;
  readonly deploymentUrl: string;
  readonly expiresAt: number | null;
}

const toProjectMetadata = (project: ProjectResponse): ProjectMetadata => ({
  projectId: project.id,
  name: project.name,
  slug: project.slug,
  teamId: project.teamId,
  teamSlug: project.teamSlug,
  defaultProductionDeploymentName: project.prodDeploymentName,
});

const toDeploymentMetadata = (
  deployment: DeploymentResponse,
): DeploymentMetadata => ({
  deploymentId: deployment.id,
  projectId: deployment.projectId,
  name: deployment.name,
  type: deployment.deploymentType,
  reference: deployment.reference,
  isDefault: deployment.isDefault,
  url: deployment.deploymentUrl,
  expiresAt: deployment.expiresAt,
});

const ignoreNotFound = <A>(
  effect: Effect.Effect<A, ConvexManagementApiError>,
): Effect.Effect<A | undefined, ConvexManagementApiError> =>
  effect.pipe(
    Effect.catchTag("ConvexManagementApiError", (error) =>
      error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  );

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
    readonly findProject: (
      input: FindProjectInput,
    ) => Effect.Effect<ProjectMetadata | undefined, ConvexManagementApiError>;
    readonly ensureProject: (
      input: EnsureProjectInput,
    ) => Effect.Effect<EnsuredProject, ConvexManagementApiError>;
    readonly ensureDeployment: (
      input: EnsureDeploymentInput,
    ) => Effect.Effect<EnsuredDeployment, ConvexManagementApiError>;
    readonly findDeployment: (
      input: FindDeploymentInput,
    ) => Effect.Effect<
      DeploymentMetadata | undefined,
      ConvexManagementApiError
    >;
    readonly deleteProject: (
      projectId: number,
    ) => Effect.Effect<void, ConvexManagementApiError>;
    readonly deleteDeployment: (
      deploymentName: string,
    ) => Effect.Effect<void, ConvexManagementApiError>;
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

      const getTokenDetails = (accessToken: Redacted.Redacted<string>) =>
        request<
          | { readonly type: "teamToken"; readonly teamId: number }
          | { readonly type: "projectToken"; readonly projectId: number }
        >("get token details", accessToken, "GET", "/token_details");

      return ConvexManagementApi.of({
        findProject: (input) =>
          Effect.gen(function* () {
            const resolved = yield* credentials;
            const tokenDetails = yield* getTokenDetails(resolved.accessToken);
            let projectId: number | undefined;

            if (tokenDetails.type === "projectToken") {
              projectId = tokenDetails.projectId;
            } else {
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
                `/teams/${encodeURIComponent(String(tokenDetails.teamId))}/projects?limit=100&q=${encodeURIComponent(input.name)}`,
              );
              projectId = projects.items.find(
                (project) =>
                  project.name === input.name || project.slug === input.name,
              )?.id;
            }

            if (projectId === undefined) return undefined;
            const project = yield* ignoreNotFound(
              request<ProjectResponse>(
                "get project",
                resolved.accessToken,
                "GET",
                `/projects/${encodeURIComponent(String(projectId))}`,
              ),
            );
            return project === undefined
              ? undefined
              : toProjectMetadata(project);
          }),
        ensureProject: (input) =>
          Effect.gen(function* () {
            const resolved = yield* credentials;
            const tokenDetails = yield* getTokenDetails(resolved.accessToken);

            let projectId = input.projectId;
            let createdProject = false;
            let managedProject = input.managedProject ?? false;
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
              const teamId = inferredTeamId;
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
              defaultProductionDeploymentName: deploymentName,
              createdProject,
              createdDeployment,
              managedProject,
            };
          }),
        findDeployment: (input) =>
          Effect.gen(function* () {
            const resolved = yield* credentials;
            let deployment: DeploymentResponse | undefined;

            if (
              input.type === "prod" &&
              input.defaultProductionDeploymentName !== undefined
            ) {
              deployment = yield* ignoreNotFound(
                request<DeploymentResponse>(
                  "get deployment",
                  resolved.accessToken,
                  "GET",
                  `/deployments/${encodeURIComponent(input.defaultProductionDeploymentName)}`,
                ),
              );
            } else {
              const deployments = yield* request<DeploymentResponse[]>(
                "list deployments",
                resolved.accessToken,
                "GET",
                `/projects/${encodeURIComponent(String(input.projectId))}/list_deployments?deploymentType=${encodeURIComponent(input.type)}`,
              );
              deployment =
                input.type === "prod"
                  ? deployments.find((candidate) => candidate.isDefault)
                  : deployments.find(
                      (candidate) => candidate.reference === input.reference,
                    );
            }

            if (
              deployment === undefined ||
              deployment.projectId !== input.projectId
            ) {
              return undefined;
            }
            return toDeploymentMetadata(deployment);
          }),
        ensureDeployment: (input) =>
          Effect.gen(function* () {
            const resolved = yield* credentials;
            const getDeployment = (name: string) =>
              request<DeploymentResponse>(
                "get deployment",
                resolved.accessToken,
                "GET",
                `/deployments/${encodeURIComponent(name)}`,
              );

            let deployment: DeploymentResponse;
            let createdDeployment = false;
            let managedDeployment = false;

            const cleanupFailedCreate = (candidate: DeploymentResponse) =>
              createdDeployment
                ? ignoreNotFound(
                    request<void>(
                      "clean up invalid deployment",
                      resolved.accessToken,
                      "POST",
                      `/deployments/${encodeURIComponent(candidate.name)}/delete`,
                    ),
                  ).pipe(Effect.asVoid)
                : Effect.void;

            if (input.name !== undefined) {
              deployment = yield* getDeployment(input.name);
            } else if (
              input.type === "prod" &&
              input.defaultProductionDeploymentName !== undefined
            ) {
              deployment = yield* getDeployment(
                input.defaultProductionDeploymentName,
              );
            } else {
              if (input.reference === undefined) {
                return yield* new ConvexManagementApiError({
                  operation: "ensure deployment",
                  message: `A reference is required to create a ${input.type} deployment.`,
                });
              }

              managedDeployment = true;

              const deployments = yield* request<DeploymentResponse[]>(
                "list deployments",
                resolved.accessToken,
                "GET",
                `/projects/${encodeURIComponent(String(input.projectId))}/list_deployments?deploymentType=${encodeURIComponent(input.type)}`,
              );
              const existing = deployments.find(
                (candidate) => candidate.reference === input.reference,
              );
              if (existing !== undefined) {
                return yield* new ConvexManagementApiError({
                  operation: "ensure deployment",
                  message:
                    `Convex deployment ${existing.name} already exists for reference ${input.reference}. ` +
                    "Adopt it explicitly with --adopt or adopt().",
                });
              } else {
                deployment = yield* request<DeploymentResponse>(
                  "create deployment",
                  resolved.accessToken,
                  "POST",
                  `/projects/${encodeURIComponent(String(input.projectId))}/create_deployment`,
                  {
                    type: input.type,
                    reference: deploymentCreateReference(
                      input.type,
                      input.reference,
                    ),
                    ...(input.type === "dev" ? { isDefault: false } : {}),
                    ...(input.expiresAt === undefined
                      ? {}
                      : { expiresAt: input.expiresAt }),
                  },
                );
                createdDeployment = true;
              }
            }

            if (deployment.projectId !== input.projectId) {
              yield* cleanupFailedCreate(deployment);
              return yield* new ConvexManagementApiError({
                operation: "ensure deployment",
                message: `Convex deployment ${deployment.name} belongs to project ${deployment.projectId}, not project ${input.projectId}.`,
              });
            }
            if (deployment.deploymentType !== input.type) {
              yield* cleanupFailedCreate(deployment);
              return yield* new ConvexManagementApiError({
                operation: "ensure deployment",
                message: `Convex deployment ${deployment.name} has type ${deployment.deploymentType}, not ${input.type}.`,
              });
            }
            if (
              input.reference !== undefined &&
              deployment.reference !== input.reference
            ) {
              yield* cleanupFailedCreate(deployment);
              return yield* new ConvexManagementApiError({
                operation: "ensure deployment",
                message: `Convex deployment ${deployment.name} has reference ${deployment.reference}, not ${input.reference}.`,
              });
            }
            if (
              input.expiresAt !== undefined &&
              deployment.expiresAt !== input.expiresAt
            ) {
              deployment = yield* request<DeploymentResponse>(
                "update deployment expiration",
                resolved.accessToken,
                "PATCH",
                `/deployments/${encodeURIComponent(deployment.name)}`,
                { expiresAt: input.expiresAt },
              );
            }

            return {
              deploymentId: deployment.id,
              projectId: deployment.projectId,
              name: deployment.name,
              type: deployment.deploymentType,
              reference: deployment.reference,
              isDefault: deployment.isDefault,
              url: deployment.deploymentUrl,
              expiresAt: deployment.expiresAt,
              createdDeployment,
              managedDeployment,
            };
          }),
        deleteProject: (projectId) =>
          Effect.gen(function* () {
            const resolved = yield* credentials;
            yield* ignoreNotFound(
              request<void>(
                "delete project",
                resolved.accessToken,
                "POST",
                `/projects/${encodeURIComponent(String(projectId))}/delete`,
              ),
            );
          }),
        deleteDeployment: (deploymentName) =>
          Effect.gen(function* () {
            const resolved = yield* credentials;
            yield* ignoreNotFound(
              request<void>(
                "delete deployment",
                resolved.accessToken,
                "POST",
                `/deployments/${encodeURIComponent(deploymentName)}/delete`,
              ),
            );
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
                ...(resolved.type === "accessToken"
                  ? {
                      allowedActions: [
                        "deployment:deploy",
                        "deployment:env:view",
                        "deployment:env:write",
                      ],
                      expiresAt: Date.now() + ttlMs,
                    }
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
