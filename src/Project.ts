import {
  Resource,
  createPhysicalName,
  havePropsChanged,
  isResolved,
  type ResourceClassLike,
} from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { ConvexManagementApi } from "./ManagementApi.js";
import type { ProjectHashOptions } from "./ProjectHash.js";
import type { Providers } from "./Providers.js";

export const ProjectTypeId = "Convex.Project";
export type ProjectTypeId = typeof ProjectTypeId;

export interface ProjectProps {
  /** Project name. Generated from the Alchemy resource ID when omitted. */
  readonly name?: string;
  /**
   * Directory containing package.json and the Convex project configuration.
   * Defaults to the stack's working directory (`"."`).
   */
  readonly dir?: string;
  /** Source hash customization consumed by child deployments. */
  readonly source?: ProjectHashOptions;
}

export interface ProjectAttributes {
  readonly projectId: number;
  readonly name: string;
  readonly slug: string;
  readonly teamId: number;
  readonly teamSlug: string;
  readonly defaultProductionDeploymentName: string;
  readonly dir: string;
  readonly source: ProjectHashOptions | undefined;
}

export interface Project extends Resource<
  ProjectTypeId,
  ProjectProps,
  ProjectAttributes,
  never,
  Providers
> {}

/** A Convex project. Deploy code with a child {@link Deployment}. */
export const Project = Resource<Project>(ProjectTypeId);

const projectName = (
  id: string,
  name: string | undefined,
  previousName: string | undefined,
) =>
  Effect.gen(function* () {
    return (
      name ??
      previousName ??
      (yield* createPhysicalName({ id, lowercase: true, maxLength: 100 }))
    );
  });

export const ProjectProvider = () =>
  Provider.effect(
    Project as unknown as ResourceClassLike<Project>,
    Effect.gen(function* () {
      const management = yield* ConvexManagementApi;

      return Project.Provider.of({
        version: 4,
        nuke: { skip: true },
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = yield* projectName(id, olds?.name, output?.name);
          const project = yield* management.findProject({ name });
          if (project === undefined) return undefined;

          const attributes: ProjectAttributes = {
            projectId: project.projectId,
            name: project.name,
            slug: project.slug,
            teamId: project.teamId,
            teamSlug: project.teamSlug,
            defaultProductionDeploymentName:
              project.defaultProductionDeploymentName ?? "",
            dir: olds?.dir ?? output?.dir ?? ".",
            source: olds?.source,
          };
          return output?.projectId === project.projectId
            ? attributes
            : Unowned(attributes);
        }),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output || !isResolved(news)) return undefined;
          return havePropsChanged(olds, news)
            ? ({ action: "update" } as const)
            : ({ action: "noop" } as const);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* projectName(id, news?.name, output?.name);
          const project = yield* management.ensureProject({
            name,
            ...(output?.projectId === undefined
              ? {}
              : { projectId: output.projectId, managedProject: true }),
          });
          if (project.createdProject) {
            yield* session.note(
              `Created Convex project ${project.name} (${project.projectId}).`,
            );
          } else if (project.createdDeployment) {
            yield* session.note(
              `Created default production deployment ${project.defaultProductionDeploymentName}.`,
            );
          }

          return {
            projectId: project.projectId,
            name: project.name,
            slug: project.slug,
            teamId: project.teamId,
            teamSlug: project.teamSlug,
            defaultProductionDeploymentName:
              project.defaultProductionDeploymentName,
            dir: news?.dir ?? ".",
            source: news?.source,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* management.deleteProject(output.projectId);
          yield* session.note(`Deleted Convex project ${output.name}.`);
        }),
      });
    }),
  );
