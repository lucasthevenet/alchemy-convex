import {
  Platform,
  type PlatformProps,
  type Resource,
  havePropsChanged,
  isResolved,
} from "alchemy";
import * as Effect from "effect/Effect";
import * as Provider from "alchemy/Provider";
import type * as Redacted from "effect/Redacted";
import { hashProject, type ProjectHashOptions } from "./ProjectHash.js";
import {
  ConvexCli,
  createConvexRuntimeContext,
  type ConvexDeploymentType,
  type ConvexEnvironment,
  type ConvexRuntimeContext,
} from "./Runtime.js";
import type { Providers } from "./Providers.js";

export const DeploymentTypeId = "Convex.Deployment";
export type DeploymentTypeId = typeof DeploymentTypeId;

export interface DeploymentProps extends PlatformProps {
  /** Directory containing package.json and the Convex project configuration. */
  readonly projectDir?: string;
  /** Production, development, preview, or admin deploy key. */
  readonly deployKey: Redacted.Redacted<string>;
  /** Environment variables reconciled before code is deployed. */
  readonly env?: ConvexEnvironment;
  /** Source hash customization for monorepos or generated sources. */
  readonly source?: ProjectHashOptions;
  /** Deploy even if the source hash and resource properties are unchanged. */
  readonly alwaysDeploy?: boolean;
  readonly typecheck?: "enable" | "try" | "disable";
  readonly codegen?: boolean;
  readonly message?: string;
  readonly preview?: {
    readonly name: string;
    readonly recreate?: boolean;
  };
}

export interface DeploymentAttributes {
  readonly deploymentName: string;
  readonly deploymentType: ConvexDeploymentType;
  readonly url: string;
  readonly httpActionsUrl: string;
  readonly sourceHash: string;
  readonly environmentKeys: string[];
}

export interface DeploymentBinding {
  readonly env?: ConvexEnvironment;
}

export interface Deployment extends Resource<
  DeploymentTypeId,
  DeploymentProps,
  DeploymentAttributes,
  DeploymentBinding,
  Providers
> {}

/**
 * A Convex deployment modeled as an Alchemy custom Platform. The init Effect
 * runs at plan time to capture bindings; Convex's own CLI bundles and executes
 * the project functions in the managed Convex runtime.
 */
export const Deployment: Platform<
  Deployment,
  never,
  void,
  ConvexRuntimeContext
> = Platform(DeploymentTypeId, {
  createRuntimeContext: (id) => createConvexRuntimeContext(DeploymentTypeId, id),
});

/** Attach Alchemy Outputs to a Convex deployment as managed environment vars. */
export const bindEnvironment = (
  deployment: Deployment,
  environment: DeploymentBinding["env"],
): Effect.Effect<void> =>
  Effect.forEach(
    Object.entries(environment ?? {}),
    ([name, value]) =>
      deployment.bind(`env:${name}`, {
        env: { [name]: value },
      }),
    { discard: true },
  );

const activeBindingEnvironment = (
  bindings: readonly { data: DeploymentBinding; action?: string }[],
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

export const DeploymentProvider = () =>
  Provider.effect(
    Deployment,
    Effect.gen(function* () {
      const cli = yield* ConvexCli;

      return {
        version: 1,
        nuke: { skip: true },
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output || !isResolved(news)) return undefined;
          if (news.alwaysDeploy || havePropsChanged(olds, news)) {
            return { action: "update" as const };
          }

          const sourceHash = yield* hashProject(news.projectDir ?? ".", news.source);
          return {
            action: sourceHash === output.sourceHash ? "noop" : "update",
          } as const;
        }),
        reconcile: Effect.fn(function* ({ news, output, bindings, session }) {
          const projectDir = news.projectDir ?? ".";
          const environment = {
            ...activeBindingEnvironment(bindings),
            ...news.env,
          } satisfies ConvexEnvironment;
          const sourceHash = yield* hashProject(projectDir, news.source);
          const result = yield* cli.deploy({
            projectDir,
            deployKey: news.deployKey,
            environment,
            previousEnvironmentKeys: output?.environmentKeys ?? [],
            typecheck: news.typecheck ?? "try",
            codegen: news.codegen ?? true,
            ...(news.message === undefined ? {} : { message: news.message }),
            ...(news.preview === undefined ? {} : { preview: news.preview }),
          });

          for (const line of `${result.stdout}\n${result.stderr}`
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)) {
            yield* session.note(line);
          }

          return {
            deploymentName: result.deploymentName,
            deploymentType: result.deploymentType,
            url: result.url,
            httpActionsUrl: result.httpActionsUrl,
            sourceHash,
            environmentKeys: Object.keys(environment).sort(),
          };
        }),
        delete: ({ session }) =>
          session.note(
            "Convex deployment retained: removing the Alchemy resource does not delete its code, data, or cloud deployment.",
          ),
      };
    }),
  );
