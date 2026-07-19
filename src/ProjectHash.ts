import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import fg from "fast-glob";

export interface ProjectHashOptions {
  /** Glob patterns to hash, relative to `projectDir`. */
  readonly include?: readonly string[];
  /** Additional glob patterns to exclude from the hash. */
  readonly exclude?: readonly string[];
}

export const defaultProjectHashExcludes = [
  "**/.git/**",
  "**/.alchemy/**",
  "**/.convex/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.env",
  "**/.env.*",
  "**/convex/_generated/**",
] as const;

export class ProjectHashError extends Data.TaggedError("ProjectHashError")<{
  readonly projectDir: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Failed to hash Convex project at ${this.projectDir}`;
  }
}

/**
 * Hash the source tree deterministically. Generated Convex types and common
 * build/secret directories are excluded so a successful deploy does not make
 * the next Alchemy plan dirty.
 */
export const hashProject = (
  projectDir: string,
  options: ProjectHashOptions = {},
): Effect.Effect<string, ProjectHashError> => {
  const cwd = resolve(projectDir);

  return Effect.tryPromise({
    try: async () => {
      const project = await stat(cwd);
      if (!project.isDirectory()) {
        throw new Error(`Convex project path is not a directory: ${cwd}`);
      }
      await readFile(resolve(cwd, "package.json"));

      const files = await fg([...(options.include ?? ["**/*"])], {
        cwd,
        absolute: false,
        dot: true,
        followSymbolicLinks: false,
        ignore: [...defaultProjectHashExcludes, ...(options.exclude ?? [])],
        onlyFiles: true,
      });
      files.sort();

      const hash = createHash("sha256");
      for (const file of files) {
        hash.update(file.replaceAll("\\", "/"));
        hash.update("\0");
        hash.update(await readFile(resolve(cwd, file)));
        hash.update("\0");
      }
      return hash.digest("hex");
    },
    catch: (cause) => new ProjectHashError({ projectDir: cwd, cause }),
  });
};
