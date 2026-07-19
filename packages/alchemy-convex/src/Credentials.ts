import {
  ALCHEMY_PROFILE,
  AlchemyProfile,
  CredentialsStore,
  getAuthProvider,
} from "alchemy/Auth";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CONVEX_AUTH_PROVIDER_NAME,
  readCredentials,
  type ConvexAuthConfig,
  type ConvexResolvedCredentials,
} from "./AuthProvider.js";

/** Lazy credentials resolved from the active Alchemy profile. */
export class Credentials extends Context.Service<
  Credentials,
  Effect.Effect<ConvexResolvedCredentials>
>()("Convex::Credentials") {}

export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const profiles = yield* AlchemyProfile;
      const store = yield* CredentialsStore;
      const auth = yield* getAuthProvider<
        ConvexAuthConfig,
        ConvexResolvedCredentials
      >(CONVEX_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      return yield* Effect.gen(function* () {
        const config = yield* profiles.loadOrConfigure(auth, profileName, {
          ci,
        });
        return yield* readCredentials(
          store,
          profileName,
          config as ConvexAuthConfig,
        );
      }).pipe(Effect.orDie, Effect.cached);
    }),
  );
