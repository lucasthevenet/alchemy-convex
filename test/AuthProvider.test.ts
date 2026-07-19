import { AlchemyProfile, AuthProviders, CredentialsStore } from "alchemy/Auth";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { CONVEX_AUTH_PROVIDER_NAME, ConvexAuth } from "../src/AuthProvider.js";

describe("ConvexAuth", () => {
  it("registers with Alchemy's Auth Provider registry", async () => {
    const registry: AuthProviders["Service"] = {};
    const dependencies = Layer.mergeAll(
      Layer.succeed(AuthProviders, registry),
      Layer.succeed(
        AlchemyProfile,
        AlchemyProfile.of({
          readConfig: Effect.die("unused"),
          writeConfig: () => Effect.die("unused"),
          getProfile: () => Effect.die("unused"),
          setProfile: () => Effect.die("unused"),
          deleteProfile: () => Effect.die("unused"),
          loadOrConfigure: () => Effect.die("unused"),
        }),
      ),
      Layer.succeed(
        CredentialsStore,
        CredentialsStore.of({
          read: () => Effect.die("unused"),
          write: () => Effect.die("unused"),
          delete: () => Effect.die("unused"),
          deleteProfile: () => Effect.die("unused"),
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Layer.build(ConvexAuth().pipe(Layer.provide(dependencies))),
      ),
    );

    expect(registry[CONVEX_AUTH_PROVIDER_NAME]).toMatchObject({
      kind: "AuthProvider",
      name: CONVEX_AUTH_PROVIDER_NAME,
    });
  });
});
