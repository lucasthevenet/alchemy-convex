import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { hashProject } from "../src/ProjectHash.js";
import { deploymentMetadata } from "../src/Runtime.js";

describe("deploymentMetadata", () => {
  it("derives production deployment metadata from a deploy key", () => {
    expect(
      deploymentMetadata("prod:kind-otter-123|secret", "deployment complete"),
    ).toEqual({
      deploymentName: "kind-otter-123",
      deploymentType: "prod",
      url: "https://kind-otter-123.convex.cloud",
      httpActionsUrl: "https://kind-otter-123.convex.site",
    });
  });

  it("uses the URL emitted for a preview deployment", () => {
    expect(
      deploymentMetadata(
        "preview:team:project|secret",
        "Deployed Convex functions to https://quick-fox-456.convex.cloud",
        { name: "feature-branch" },
      ),
    ).toMatchObject({
      deploymentName: "quick-fox-456",
      deploymentType: "preview",
      url: "https://quick-fox-456.convex.cloud",
    });
  });

  it("preserves regional deployment URLs", () => {
    expect(
      deploymentMetadata(
        "prod:kind-otter-123|secret",
        "Deployed to https://kind-otter-123.eu-west-1.convex.cloud",
      ),
    ).toEqual({
      deploymentName: "kind-otter-123",
      deploymentType: "prod",
      url: "https://kind-otter-123.eu-west-1.convex.cloud",
      httpActionsUrl: "https://kind-otter-123.eu-west-1.convex.site",
    });
  });
});

describe("hashProject", () => {
  it("hashes source changes but ignores generated and secret files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alchemy-convex-hash-"));
    try {
      await mkdir(join(directory, "convex", "_generated"), {
        recursive: true,
      });
      await writeFile(join(directory, "package.json"), "{}");
      await writeFile(
        join(directory, "convex", "notes.ts"),
        "export const a = 1;",
      );
      await writeFile(
        join(directory, "convex", "_generated", "api.js"),
        "first",
      );
      await writeFile(join(directory, ".env.local"), "SECRET=first");

      const first = await Effect.runPromise(hashProject(directory));
      await writeFile(
        join(directory, "convex", "_generated", "api.js"),
        "second",
      );
      await writeFile(join(directory, ".env.local"), "SECRET=second");
      const ignoredChanges = await Effect.runPromise(hashProject(directory));
      expect(ignoredChanges).toBe(first);

      await writeFile(
        join(directory, "convex", "notes.ts"),
        "export const a = 2;",
      );
      const sourceChange = await Effect.runPromise(hashProject(directory));
      expect(sourceChange).not.toBe(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
