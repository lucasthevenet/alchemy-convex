import {
  Platform,
  havePropsChanged,
  isResolved,
  type PlatformProps,
  type Resource,
} from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { ConvexManagementApi } from "./ManagementApi.js";
import type { Project, ProjectAttributes } from "./Project.js";
import { hashProject } from "./ProjectHash.js";
import type { Providers } from "./Providers.js";
import {
  ConvexCli,
  createConvexRuntimeContext,
  type ConvexEnvironment,
  type ConvexRuntimeContext,
} from "./Runtime.js";

export const DeploymentTypeId = "Convex.Deployment";
export type DeploymentTypeId = typeof DeploymentTypeId;

export type DeploymentReference =
  | "production"
  | `dev/${string}`
  | `preview/${string}`;

export type DeploymentKind = "production" | "development" | "preview";

export interface DeploymentProps extends PlatformProps {
  /** Parent Convex project. */
  readonly project: Project;
  /** Target deployment reference. Defaults to `"production"`. */
  readonly reference?: DeploymentReference;
  /** Environment variables reconciled before code is deployed. */
  readonly env?: ConvexEnvironment;
  /** Deploy even if the source hash and resource properties are unchanged. */
  readonly alwaysDeploy?: boolean;
  readonly typecheck?: "enable" | "try" | "disable";
  readonly codegen?: boolean;
  readonly message?: string;
  /** Absolute preview expiration as an ISO timestamp or Unix milliseconds. */
  readonly expiresAt?: string | number;
}

export interface DeploymentAttributes {
  readonly projectId: number;
  readonly deploymentId: number;
  /** Convex-generated physical deployment name. */
  readonly name: string;
  readonly reference: DeploymentReference;
  readonly type: DeploymentKind;
  readonly isDefault: boolean;
  readonly url: string;
  readonly httpActionsUrl: string;
  readonly expiresAt: number | null;
  readonly sourceHash: string;
  readonly environmentKeys: string[];
}

export interface Deployment extends Resource<
  DeploymentTypeId,
  DeploymentProps,
  DeploymentAttributes,
  never,
  Providers
> {}

/** A production, development, or preview deployment within a Convex project. */
export const Deployment: Platform<
  Deployment,
  never,
  void,
  ConvexRuntimeContext
> = Platform(DeploymentTypeId, {
  createRuntimeContext: (id) =>
    createConvexRuntimeContext(DeploymentTypeId, id),
});

const resolveReference = (
  reference: DeploymentReference | undefined,
): {
  reference: DeploymentReference;
  managementType: "prod" | "dev" | "preview";
  kind: DeploymentKind;
} => {
  const resolved = reference ?? "production";
  if (resolved === "production") {
    return { reference: resolved, managementType: "prod", kind: "production" };
  }
  if (/^dev\/[a-z0-9][a-z0-9/-]*$/.test(resolved) && resolved.length <= 100) {
    return { reference: resolved, managementType: "dev", kind: "development" };
  }
  if (
    /^preview\/[a-z0-9][a-z0-9/-]*$/.test(resolved) &&
    resolved.length <= 100
  ) {
    return { reference: resolved, managementType: "preview", kind: "preview" };
  }
  throw new Error(
    'Convex deployment reference must be "production", "dev/<name>", or "preview/<name>".',
  );
};

const expirationTimestamp = (expiresAt: string | number | undefined) => {
  if (expiresAt === undefined) return undefined;
  const timestamp =
    typeof expiresAt === "number" ? expiresAt : new Date(expiresAt).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error("Convex deployment expiresAt must be a valid date.");
  }
  return timestamp;
};

const projectAttributes = (project: unknown) => project as ProjectAttributes;

export const DeploymentProvider = () =>
  Provider.effect(
    Deployment,
    Effect.gen(function* () {
      const cli = yield* ConvexCli;
      const management = yield* ConvexManagementApi;

      return {
        version: 2,
        nuke: { skip: true },
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ olds, output }) {
          if (!isResolved(olds)) return undefined;
          const project = projectAttributes(olds.project);
          if (project?.projectId === undefined) return undefined;
          const target = resolveReference(olds.reference);
          const deployment = yield* management.findDeployment({
            projectId: project.projectId,
            type: target.managementType,
            ...(target.managementType === "prod"
              ? project.defaultProductionDeploymentName.length === 0
                ? {}
                : {
                    defaultProductionDeploymentName:
                      project.defaultProductionDeploymentName,
                  }
              : { reference: target.reference }),
          });
          if (deployment === undefined) return undefined;

          // The default production deployment is created with its parent
          // project. With no Deployment state yet, route through reconcile so
          // the local Convex code and environment are still pushed.
          if (target.managementType === "prod" && output === undefined) {
            return undefined;
          }

          const attributes: DeploymentAttributes = {
            projectId: deployment.projectId,
            deploymentId: deployment.deploymentId,
            name: deployment.name,
            reference: target.reference,
            type: target.kind,
            isDefault: deployment.isDefault,
            url: deployment.url,
            httpActionsUrl: `https://${deployment.name}.convex.site`,
            expiresAt: deployment.expiresAt,
            sourceHash: output?.sourceHash ?? "",
            environmentKeys: output?.environmentKeys ?? [],
          };

          if (
            target.managementType === "prod" ||
            output?.deploymentId === deployment.deploymentId
          ) {
            return attributes;
          }
          return Unowned(attributes);
        }),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output || !isResolved(news) || !isResolved(olds)) {
            return undefined;
          }
          const oldProject = projectAttributes(olds.project);
          const newProject = projectAttributes(news.project);
          if (
            oldProject.projectId !== newProject.projectId ||
            resolveReference(olds.reference).reference !==
              resolveReference(news.reference).reference
          ) {
            return { action: "replace" as const };
          }
          if (news.alwaysDeploy || havePropsChanged(olds, news)) {
            return { action: "update" as const };
          }
          const sourceHash = yield* hashProject(
            newProject.dir,
            newProject.source,
          );
          return {
            action: sourceHash === output.sourceHash ? "noop" : "update",
          } as const;
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const project = projectAttributes(news.project);
          const target = resolveReference(news.reference);
          if (news.expiresAt !== undefined && target.kind !== "preview") {
            throw new Error(
              "Convex deployment expiresAt is only supported for preview references.",
            );
          }
          const expiresAt = expirationTimestamp(news.expiresAt);
          const environment = news.env ?? ({} satisfies ConvexEnvironment);
          const sourceHash = yield* hashProject(project.dir, project.source);

          const deployment = yield* management.ensureDeployment({
            projectId: project.projectId,
            ...(output?.name === undefined ? {} : { name: output.name }),
            type: target.managementType,
            ...(target.managementType === "prod"
              ? project.defaultProductionDeploymentName.length === 0
                ? {}
                : {
                    defaultProductionDeploymentName:
                      project.defaultProductionDeploymentName,
                  }
              : { reference: target.reference }),
            ...(expiresAt === undefined ? {} : { expiresAt }),
          });
          if (deployment.createdDeployment) {
            yield* session.note(
              `Created Convex ${target.kind} deployment ${deployment.name}.`,
            );
          }

          const lease = yield* management.leaseDeploymentKey({
            deploymentName: deployment.name,
          });
          const result = yield* cli
            .deploy({
              projectDir: project.dir,
              deployKey: lease.deployKey,
              environment,
              previousEnvironmentKeys:
                output?.name === deployment.name
                  ? output.environmentKeys
                  : ([] as const),
              typecheck: news.typecheck ?? "try",
              codegen: news.codegen ?? true,
              ...(news.message === undefined ? {} : { message: news.message }),
            })
            .pipe(
              Effect.ensuring(
                lease.release.pipe(
                  Effect.catch((error: { readonly message: string }) =>
                    session.note(
                      `Warning: failed to revoke temporary Convex deploy key (${error.message}). It will expire automatically.`,
                    ),
                  ),
                ),
              ),
            );

          for (const line of `${result.stdout}\n${result.stderr}`
            .split("\n")
            .map((outputLine) => outputLine.trim())
            .filter(Boolean)) {
            yield* session.note(line);
          }

          return {
            projectId: project.projectId,
            deploymentId: deployment.deploymentId,
            name: deployment.name,
            reference: target.reference,
            type: target.kind,
            isDefault: deployment.isDefault,
            url: result.url,
            httpActionsUrl: result.httpActionsUrl,
            expiresAt: deployment.expiresAt,
            sourceHash,
            environmentKeys: Object.keys(environment).sort(),
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* management.deleteDeployment(output.name);
          yield* session.note(`Deleted Convex deployment ${output.name}.`);
        }),
      };
    }),
  );
