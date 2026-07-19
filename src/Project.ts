import {
  Platform,
  createPhysicalName,
  havePropsChanged,
  isResolved,
  type PlatformProps,
  type Resource,
} from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { ConvexManagementApi } from "./ManagementApi.js";
import { hashProject, type ProjectHashOptions } from "./ProjectHash.js";
import type { Providers } from "./Providers.js";
import {
  ConvexCli,
  createConvexRuntimeContext,
  type ConvexDeploymentType,
  type ConvexEnvironment,
  type ConvexRuntimeContext,
} from "./Runtime.js";

export const ProjectTypeId = "Convex.Project";
export type ProjectTypeId = typeof ProjectTypeId;

export interface ProjectProps extends PlatformProps {
  /** Project name. Generated from the Alchemy resource ID when omitted. */
  readonly name?: string;
  /** Adopt an existing Convex project instead of resolving or creating by name. */
  readonly projectId?: number;
  /** Team used when creating or resolving a project; inferred from team tokens. */
  readonly teamId?: number;
  /** Directory containing package.json and the Convex project configuration. */
  readonly projectDir?: string;
  /** Environment variables reconciled before code is deployed. */
  readonly env?: ConvexEnvironment;
  /** Source hash customization for monorepos or generated sources. */
  readonly source?: ProjectHashOptions;
  /** Deploy even if the source hash and resource properties are unchanged. */
  readonly alwaysDeploy?: boolean;
  readonly typecheck?: "enable" | "try" | "disable";
  readonly codegen?: boolean;
  readonly message?: string;
}

export interface ProjectAttributes {
  readonly projectId: number;
  readonly name: string;
  readonly slug: string;
  readonly teamId: number;
  readonly teamSlug: string;
  readonly deploymentName: string;
  readonly deploymentType: ConvexDeploymentType;
  readonly url: string;
  readonly httpActionsUrl: string;
  readonly sourceHash: string;
  readonly environmentKeys: string[];
  readonly managedProject: boolean;
}

export interface ProjectBinding {
  readonly env?: ConvexEnvironment;
}

export interface Project extends Resource<
  ProjectTypeId,
  ProjectProps,
  ProjectAttributes,
  ProjectBinding,
  Providers
> {}

/**
 * A Convex project modeled as an Alchemy custom Platform. The provider creates
 * or adopts the project, ensures its default production deployment exists, and
 * uses Convex's CLI to deploy the source tree.
 */
export const Project: Platform<Project, never, void, ConvexRuntimeContext> =
  Platform(ProjectTypeId, {
    createRuntimeContext: (id) => createConvexRuntimeContext(ProjectTypeId, id),
  });

/** Attach Alchemy Outputs to a Convex project's managed environment vars. */
export const bindEnvironment = (
  project: Project,
  environment: ProjectBinding["env"],
): Effect.Effect<void> =>
  Effect.forEach(
    Object.entries(environment ?? {}),
    ([name, value]) =>
      project.bind(`env:${name}`, {
        env: { [name]: value },
      }),
    { discard: true },
  );

const activeBindingEnvironment = (
  bindings: readonly { data: ProjectBinding; action?: string }[],
): ConvexEnvironment =>
  bindings
    .filter((binding) => binding.action !== "delete")
    .reduce<ConvexEnvironment>(
      (environment, binding) => ({
        ...environment,
        ...binding.data.env,
      }),
      {},
    );

export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      const cli = yield* ConvexCli;
      const management = yield* ConvexManagementApi;

      return {
        version: 1,
        nuke: { skip: true },
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output || !isResolved(news)) return undefined;
          if (news.alwaysDeploy || havePropsChanged(olds, news)) {
            return { action: "update" as const };
          }

          const sourceHash = yield* hashProject(
            news.projectDir ?? ".",
            news.source,
          );
          return {
            action: sourceHash === output.sourceHash ? "noop" : "update",
          } as const;
        }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          bindings,
          session,
        }) {
          const projectDir = news.projectDir ?? ".";
          const environment = {
            ...activeBindingEnvironment(bindings),
            ...news.env,
          } satisfies ConvexEnvironment;
          const sourceHash = yield* hashProject(projectDir, news.source);
          const name =
            news.name ??
            (yield* createPhysicalName({
              id,
              lowercase: true,
              maxLength: 100,
            }));
          const ensured = yield* management.ensureProject({
            name,
            ...(news.projectId === undefined
              ? output?.managedProject === true
                ? { projectId: output.projectId }
                : {}
              : { projectId: news.projectId }),
            ...(news.teamId === undefined ? {} : { teamId: news.teamId }),
          });
          if (ensured.createdProject) {
            yield* session.note(
              `Created Convex project ${ensured.name} (${ensured.projectId}).`,
            );
          } else if (ensured.createdDeployment) {
            yield* session.note(
              `Created default production deployment ${ensured.deploymentName}.`,
            );
          }

          const lease = yield* management.leaseDeploymentKey({
            deploymentName: ensured.deploymentName,
          });
          const result = yield* cli
            .deploy({
              projectDir,
              deployKey: lease.deployKey,
              environment,
              previousEnvironmentKeys: output?.environmentKeys ?? [],
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
            .map((line) => line.trim())
            .filter(Boolean)) {
            yield* session.note(line);
          }

          return {
            projectId: ensured.projectId,
            name: ensured.name,
            slug: ensured.slug,
            teamId: ensured.teamId,
            teamSlug: ensured.teamSlug,
            deploymentName: result.deploymentName,
            deploymentType: result.deploymentType,
            url: result.url,
            httpActionsUrl: result.httpActionsUrl,
            sourceHash,
            environmentKeys: Object.keys(environment).sort(),
            managedProject: ensured.managedProject,
          };
        }),
        delete: ({ session }) =>
          session.note(
            "Convex project retained: removing the Alchemy resource does not delete its code, data, project, or deployments.",
          ),
      };
    }),
  );
