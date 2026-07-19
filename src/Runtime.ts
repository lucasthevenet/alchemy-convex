import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { BaseRuntimeContext } from "alchemy";
import * as Output from "alchemy/Output";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export type ConvexEnvironmentValue = string | Redacted.Redacted<string>;

export type ConvexEnvironment = Readonly<
  Record<string, ConvexEnvironmentValue>
>;

export type ConvexDeploymentType = "prod" | "dev" | "preview" | "unknown";

export interface ConvexDeployRequest {
  readonly projectDir: string;
  readonly deployKey: Redacted.Redacted<string>;
  readonly environment: ConvexEnvironment;
  readonly previousEnvironmentKeys: readonly string[];
  readonly typecheck: "enable" | "try" | "disable";
  readonly codegen: boolean;
  readonly message?: string;
  readonly preview?: {
    readonly name: string;
    readonly recreate?: boolean;
  };
}

export interface ConvexDeployResult {
  readonly deploymentName: string;
  readonly deploymentType: ConvexDeploymentType;
  readonly url: string;
  readonly httpActionsUrl: string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ConvexCliOptions {
  /**
   * Override the Convex executable. By default the runtime resolves the local
   * `convex` package from the deployed project and invokes its JS entrypoint.
   */
  readonly binary?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export class ConvexCliError extends Data.TaggedError("ConvexCliError")<{
  readonly operation: string;
  readonly message: string;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly cause?: unknown;
}> {}

export class ConvexCli extends Context.Service<
  ConvexCli,
  {
    readonly deploy: (
      request: ConvexDeployRequest,
    ) => Effect.Effect<ConvexDeployResult, ConvexCliError>;
  }
>()("alchemy-convex/ConvexCli") {}

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const plainValue = (value: ConvexEnvironmentValue): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const serializeEnvironment = (environment: ConvexEnvironment): string =>
  Object.entries(environment)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${JSON.stringify(plainValue(value))}`)
    .join("\n");

const deploymentTypeFromKey = (
  deployKey: string,
  preview: ConvexDeployRequest["preview"],
): ConvexDeploymentType => {
  if (preview || deployKey.startsWith("preview:")) return "preview";
  if (deployKey.startsWith("prod:")) return "prod";
  if (deployKey.startsWith("dev:")) return "dev";
  return "unknown";
};

const deploymentNameFromKey = (deployKey: string): string | undefined => {
  const identity = deployKey.slice(0, deployKey.indexOf("|"));
  if (identity.startsWith("prod:") || identity.startsWith("dev:")) {
    return identity.slice(identity.indexOf(":") + 1);
  }
  if (!identity.includes(":")) return identity;
  return undefined;
};

const urlPattern = /https:\/\/[a-z0-9-]+\.convex\.cloud\b/gi;

export const deploymentMetadata = (
  deployKey: string,
  output: string,
  preview?: ConvexDeployRequest["preview"],
): Omit<ConvexDeployResult, "stdout" | "stderr"> => {
  const urls = output.match(urlPattern);
  const nameFromKey = deploymentNameFromKey(deployKey);
  const url = urls?.at(-1) ??
    (nameFromKey ? `https://${nameFromKey}.convex.cloud` : undefined);

  if (!url) {
    throw new ConvexCliError({
      operation: "deploy",
      message:
        "Convex deployed successfully but its deployment URL could not be determined from the CLI output.",
    });
  }

  const deploymentName = new URL(url).hostname.slice(
    0,
    -".convex.cloud".length,
  );

  return {
    deploymentName,
    deploymentType: deploymentTypeFromKey(deployKey, preview),
    url,
    httpActionsUrl: url.replace(/\.convex\.cloud$/, ".convex.site"),
  };
};

const resolveInvocation = (
  cwd: string,
  args: readonly string[],
  binary?: string,
): { command: string; args: readonly string[] } => {
  if (binary) return { command: binary, args };

  try {
    const require = createRequire(join(cwd, "__alchemy_convex__.cjs"));
    const packageJson = require.resolve("convex/package.json");
    return {
      command: process.execPath,
      args: [join(dirname(packageJson), "bin", "main.js"), ...args],
    };
  } catch (cause) {
    throw new ConvexCliError({
      operation: "resolve",
      message: `Could not resolve the local Convex CLI from ${cwd}. Install convex in the project or configure providers({ binary }).`,
      cause,
    });
  }
};

const runProcess = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ProcessResult> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolvePromise({ exitCode: code ?? 1, stdout, stderr }),
    );
  });

export const ConvexCliLive = (options: ConvexCliOptions = {}) =>
  Layer.succeed(
    ConvexCli,
    ConvexCli.of({
      deploy: (request) => {
        const cwd = resolve(request.projectDir);
        const deployKey = Redacted.value(request.deployKey);
        const childEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...options.extraEnv,
          CONVEX_DEPLOY_KEY: deployKey,
        };

        const execute = (
          operation: string,
          args: readonly string[],
        ): Effect.Effect<ProcessResult, ConvexCliError> =>
          Effect.tryPromise({
            try: () => {
              const invocation = resolveInvocation(cwd, args, options.binary);
              return runProcess(invocation.command, invocation.args, {
                cwd,
                env: childEnv,
              });
            },
            catch: (cause) =>
              cause instanceof ConvexCliError
                ? cause
                : new ConvexCliError({
                    operation,
                    message: `Failed to start Convex CLI operation ${operation}`,
                    cause,
                  }),
          }).pipe(
            Effect.flatMap((result) =>
              result.exitCode === 0
                ? Effect.succeed(result)
                : Effect.fail(
                    new ConvexCliError({
                      operation,
                      message: `Convex CLI operation ${operation} exited with code ${result.exitCode}`,
                      exitCode: result.exitCode,
                      stderr: result.stderr,
                    }),
                  ),
            ),
          );

        const desiredKeys = Object.keys(request.environment).sort();
        const invalidKey = desiredKeys.find(
          (key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
        );
        const validationError =
          request.preview && desiredKeys.length > 0
            ? new ConvexCliError({
                operation: "env set",
                message:
                  "Managed environment variables are not supported for preview deploy keys in this MVP. Convex must claim the preview before its environment can be addressed.",
              })
            : invalidKey
              ? new ConvexCliError({
                  operation: "env set",
                  message: `Invalid Convex environment variable name: ${JSON.stringify(invalidKey)}`,
                })
              : undefined;
        const validateEnvironment = validationError
          ? Effect.fail(validationError)
          : Effect.void;
        const removedKeys = request.previousEnvironmentKeys.filter(
          (key) => !desiredKeys.includes(key),
        );

        const removeOldEnvironment = Effect.forEach(
          removedKeys,
          (key) => execute(`env remove ${key}`, ["env", "remove", key]),
          { discard: true },
        );

        const setEnvironment =
          desiredKeys.length === 0
            ? Effect.void
            : Effect.acquireUseRelease(
                Effect.tryPromise({
                  try: async () => {
                    const directory = await mkdtemp(
                      join(tmpdir(), "alchemy-convex-"),
                    );
                    const file = join(directory, "environment.env");
                    await writeFile(
                      file,
                      serializeEnvironment(request.environment),
                      { encoding: "utf8", mode: 0o600 },
                    );
                    return { directory, file };
                  },
                  catch: (cause) =>
                    new ConvexCliError({
                      operation: "env set",
                      message:
                        "Failed to prepare a temporary Convex environment file",
                      cause,
                    }),
                }),
                ({ file }) =>
                  execute("env set", [
                    "env",
                    "set",
                    "--force",
                    "--from-file",
                    file,
                  ]),
                ({ directory }) =>
                  Effect.promise(() =>
                    rm(directory, { recursive: true, force: true }),
                  ),
              ).pipe(Effect.asVoid);

        const deployArgs = [
          "deploy",
          "--yes",
          "--typecheck",
          request.typecheck,
          "--codegen",
          request.codegen ? "enable" : "disable",
        ];
        if (request.message) deployArgs.push("--message", request.message);
        if (request.preview) {
          deployArgs.push(
            request.preview.recreate ? "--preview-create" : "--preview-name",
            request.preview.name,
          );
        }

        return validateEnvironment.pipe(
          Effect.andThen(removeOldEnvironment),
          Effect.andThen(setEnvironment),
          Effect.andThen(execute("deploy", deployArgs)),
          Effect.flatMap((result) =>
            Effect.try({
              try: () => ({
                ...deploymentMetadata(
                  deployKey,
                  `${result.stdout}\n${result.stderr}`,
                  request.preview,
                ),
                stdout: result.stdout,
                stderr: result.stderr,
              }),
              catch: (cause) =>
                cause instanceof ConvexCliError
                  ? cause
                  : new ConvexCliError({
                      operation: "deploy",
                      message: "Failed to read Convex deployment metadata",
                      cause,
                    }),
            }),
          ),
        );
      },
    }),
  );

export interface ConvexRuntimeContext extends BaseRuntimeContext {}

/**
 * Runtime context used by Alchemy's `Platform` constructor. Convex owns the
 * actual function runtime; this context captures Alchemy Outputs as Convex
 * environment variables during the plan phase.
 */
export const createConvexRuntimeContext = (
  type: string,
  id: string,
): ConvexRuntimeContext => {
  const env: Record<string, Output.Output<unknown>> = {};

  return {
    Type: type,
    id,
    env,
    set: (bindingId, output) =>
      Effect.sync(() => {
        const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
        env[key] = output;
        return key;
      }),
    get: <T>(key: string) =>
      Effect.sync(() => process.env[key] as T | undefined),
  };
};
