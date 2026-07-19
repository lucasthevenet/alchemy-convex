import {
  AuthError,
  AuthProviderLayer,
  CredentialsStore,
  displayRedacted,
  getEnvRedacted,
  retryOnce,
  type ConfigureContext,
} from "alchemy/Auth";
import * as Clank from "alchemy/Util/Clank";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as OAuthClient from "./OAuthClient.js";

export const CONVEX_AUTH_PROVIDER_NAME = "Convex";
export const CONVEX_ACCESS_TOKEN_ENV_NAME = "CONVEX_ACCESS_TOKEN";

export type ConvexAuthConfig =
  | { readonly method: "env" }
  | { readonly method: "stored" }
  | { readonly method: "oauth" };

export interface ConvexStoredCredentials {
  readonly type: "accessToken";
  readonly accessToken: string;
}

export type ConvexResolvedCredentials =
  | {
      readonly type: "accessToken";
      readonly accessToken: Redacted.Redacted<string>;
      readonly source: {
        readonly type: "env" | "stored";
        readonly details?: string;
      };
    }
  | {
      readonly type: "oauth";
      readonly accessToken: Redacted.Redacted<string>;
      readonly source: { readonly type: "oauth" };
    };

const storedCredentialName = "convex-stored";
const oauthCredentialName = "convex-oauth";

const options: Array<{
  value: ConvexAuthConfig["method"];
  label: string;
  hint: string;
}> = [
  {
    value: "env",
    label: "Environment Variable",
    hint: CONVEX_ACCESS_TOKEN_ENV_NAME,
  },
  {
    value: "oauth",
    label: "OAuth",
    hint: "browser-based Convex team authorization",
  },
  {
    value: "stored",
    label: "Access Token",
    hint: "enter interactively, stored in ~/.alchemy/credentials",
  },
];

/** Registers Convex access-token and OAuth authentication with `alchemy login`. */
export const ConvexAuth = () =>
  AuthProviderLayer<ConvexAuthConfig, ConvexResolvedCredentials>()(
    CONVEX_AUTH_PROVIDER_NAME,
    Effect.gen(function* () {
      const store = yield* CredentialsStore;

      const oauthLogin = (profileName: string) =>
        Effect.gen(function* () {
          const authorization = yield* OAuthClient.authorize();
          yield* Clank.info("Convex: opening browser for OAuth login...");
          yield* Clank.info(authorization.url);
          yield* Clank.openUrl(authorization.url).pipe(
            Effect.catch(() =>
              Clank.warn(
                "Convex: could not open a browser. Open the URL above manually.",
              ),
            ),
          );
          yield* Clank.info(
            "Convex: waiting for authorization (up to 5 minutes)...",
          );
          const credentials = yield* OAuthClient.callback(authorization);
          yield* store.write(profileName, oauthCredentialName, credentials);
          yield* Clank.success("Convex: OAuth credentials saved.");
          return credentials;
        });

      const loginStored = Effect.fn(function* (profileName: string) {
        const accessToken = yield* Clank.password({
          message: "Convex access token",
          validate: (value) => (value.length === 0 ? "Required" : undefined),
        }).pipe(retryOnce);

        yield* store.write<ConvexStoredCredentials>(
          profileName,
          storedCredentialName,
          { type: "accessToken", accessToken },
        );
        yield* Clank.success("Convex: access token saved.");
        return { method: "stored" as const };
      });

      const configureInteractive = (profileName: string) =>
        Clank.select({
          message: "Convex authentication method",
          options,
        }).pipe(
          Effect.flatMap((method) =>
            Match.value(method).pipe(
              Match.when("env", () =>
                Effect.succeed({ method: "env" as const }),
              ),
              Match.when("oauth", () =>
                oauthLogin(profileName).pipe(
                  Effect.as({ method: "oauth" as const }),
                ),
              ),
              Match.when("stored", () => loginStored(profileName)),
              Match.exhaustive,
            ),
          ),
        );

      const configure = (profileName: string, context: ConfigureContext) =>
        Effect.gen(function* () {
          if (context.ci) return { method: "env" as const };
          return yield* configureInteractive(profileName);
        }).pipe(
          Effect.mapError(
            (cause) =>
              new AuthError({
                message: "Failed to configure Convex credentials",
                cause,
              }),
          ),
        );

      const read = (
        profileName: string,
        config: ConvexAuthConfig,
      ): Effect.Effect<ConvexResolvedCredentials, AuthError> =>
        Match.value(config).pipe(
          Match.when(
            { method: "env" },
            Effect.fn(function* () {
              const accessToken = yield* getEnvRedacted(
                CONVEX_ACCESS_TOKEN_ENV_NAME,
              );
              if (!accessToken || Redacted.value(accessToken).length === 0) {
                return yield* new AuthError({
                  message: `Convex environment credentials not found. Set ${CONVEX_ACCESS_TOKEN_ENV_NAME}.`,
                });
              }
              return {
                type: "accessToken" as const,
                accessToken,
                source: {
                  type: "env" as const,
                  details: CONVEX_ACCESS_TOKEN_ENV_NAME,
                },
              };
            }),
          ),
          Match.when({ method: "stored" }, () =>
            store
              .read<ConvexStoredCredentials>(profileName, storedCredentialName)
              .pipe(
                Effect.flatMap((credentials) =>
                  credentials == null || credentials.type !== "accessToken"
                    ? Effect.fail(
                        new AuthError({
                          message:
                            "Convex stored access token not found. Run: alchemy login --configure",
                        }),
                      )
                    : Effect.succeed({
                        type: "accessToken" as const,
                        accessToken: Redacted.make(credentials.accessToken),
                        source: { type: "stored" as const },
                      }),
                ),
              ),
          ),
          Match.when({ method: "oauth" }, () =>
            store
              .read<OAuthClient.OAuthCredentials>(
                profileName,
                oauthCredentialName,
              )
              .pipe(
                Effect.flatMap((credentials) =>
                  credentials == null || credentials.type !== "oauth"
                    ? Effect.fail(
                        new AuthError({
                          message:
                            "Convex OAuth credentials not found. Run: alchemy login",
                        }),
                      )
                    : Effect.succeed({
                        type: "oauth" as const,
                        accessToken: Redacted.make(credentials.access),
                        source: { type: "oauth" as const },
                      }),
                ),
              ),
          ),
          Match.exhaustive,
        );

      const logout = (profileName: string, config: ConvexAuthConfig) =>
        Match.value(config).pipe(
          Match.when({ method: "env" }, () => Effect.void),
          Match.when({ method: "stored" }, () =>
            store
              .delete(profileName, storedCredentialName)
              .pipe(
                Effect.andThen(
                  Clank.success("Convex: stored access token removed."),
                ),
              ),
          ),
          Match.when({ method: "oauth" }, () =>
            store
              .delete(profileName, oauthCredentialName)
              .pipe(
                Effect.andThen(
                  Clank.success("Convex: OAuth credentials removed."),
                ),
              ),
          ),
          Match.exhaustive,
        );

      const login = (profileName: string, config: ConvexAuthConfig) =>
        Match.value(config)
          .pipe(
            Match.when({ method: "env" }, () => Effect.void),
            Match.when({ method: "stored" }, () =>
              store
                .read<ConvexStoredCredentials>(
                  profileName,
                  storedCredentialName,
                )
                .pipe(
                  Effect.flatMap((credentials) =>
                    credentials?.type === "accessToken"
                      ? Effect.void
                      : loginStored(profileName).pipe(Effect.asVoid),
                  ),
                ),
            ),
            Match.when({ method: "oauth" }, () =>
              store
                .read<OAuthClient.OAuthCredentials>(
                  profileName,
                  oauthCredentialName,
                )
                .pipe(
                  Effect.flatMap((credentials) =>
                    credentials?.type === "oauth"
                      ? Effect.void
                      : oauthLogin(profileName).pipe(Effect.asVoid),
                  ),
                ),
            ),
            Match.exhaustive,
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new AuthError({
                  message: "Failed to log in to Convex",
                  cause,
                }),
            ),
          );

      const prettyPrint = (profileName: string, config: ConvexAuthConfig) =>
        read(profileName, config).pipe(
          Effect.flatMap((credentials) =>
            Effect.all([
              Console.log(
                `  accessToken: ${displayRedacted(credentials.accessToken, 12)}`,
              ),
              Console.log(`  source: ${credentials.source.type}`),
            ]),
          ),
          Effect.asVoid,
        );

      return { configure, login, logout, prettyPrint, read };
    }),
  );
