import { AUTH_ERROR_URL, AUTH_SUCCESS_URL } from "alchemy/Auth";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import crypto from "node:crypto";
import http from "node:http";

/**
 * Registered Convex OAuth application credentials.
 *
 * Convex requires the client secret when exchanging an authorization code.
 * A distributed CLI cannot keep that value private, so it ships with the
 * provider in the same way as Alchemy's PlanetScale OAuth client. PKCE still
 * protects intercepted authorization codes. Rotate these credentials by
 * registering a new application secret and publishing a new release.
 */
export const OAUTH_CLIENT_ID = "abee2524fbd24f70";
export const OAUTH_CLIENT_SECRET = "a87d14bda3004142a70d9868e87ca0a1";
export const OAUTH_REDIRECT_URI = "http://localhost:9976/auth/callback";

export interface OAuthCredentials {
  readonly type: "oauth";
  readonly access: string;
}

export interface Authorization {
  readonly url: string;
  readonly state: string;
  readonly codeVerifier: string;
}

export class OAuthError extends Data.TaggedError("OAuthError")<{
  readonly error: string;
  readonly errorDescription: string;
}> {}

const randomValue = (): string => crypto.randomBytes(32).toString("base64url");

const codeChallenge = (verifier: string): string =>
  crypto.createHash("sha256").update(verifier).digest("base64url");

/** Create a team-scoped Convex authorization URL using state and PKCE S256. */
export const authorize = (): Effect.Effect<Authorization, OAuthError> =>
  Effect.sync(() => {
    const state = randomValue();
    const codeVerifier = randomValue();
    const url = new URL("https://dashboard.convex.dev/oauth/authorize/team");
    url.searchParams.set("client_id", OAUTH_CLIENT_ID);
    url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString(), state, codeVerifier };
  });

/** Exchange a single-use authorization code for a Convex application token. */
export const exchange = (
  authorization: Authorization,
  code: string,
): Effect.Effect<OAuthCredentials, OAuthError> =>
  Effect.gen(function* () {
    const body = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      grant_type: "authorization_code",
      redirect_uri: OAUTH_REDIRECT_URI,
      code,
      code_verifier: authorization.codeVerifier,
    });
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch("https://api.convex.dev/oauth/token", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        }),
      catch: (cause) =>
        new OAuthError({
          error: "network_error",
          errorDescription: `Convex token request failed: ${String(cause)}`,
        }),
    });

    const payload = yield* Effect.tryPromise({
      try: () => response.json() as Promise<Record<string, unknown>>,
      catch: () =>
        new OAuthError({
          error: "parse_error",
          errorDescription: `Convex token endpoint returned ${response.status}.`,
        }),
    });

    if (!response.ok || typeof payload.access_token !== "string") {
      return yield* new OAuthError({
        error:
          typeof payload.error === "string" ? payload.error : "token_error",
        errorDescription:
          typeof payload.error_description === "string"
            ? payload.error_description
            : `Convex token endpoint returned ${response.status}.`,
      });
    }

    return { type: "oauth" as const, access: payload.access_token };
  });

/** Wait for the localhost OAuth callback. Times out after five minutes. */
export const callback = (
  authorization: Authorization,
): Effect.Effect<OAuthCredentials, OAuthError> =>
  Effect.tryPromise({
    try: () => callbackPromise(authorization),
    catch: (cause) =>
      cause instanceof OAuthError
        ? cause
        : new OAuthError({
            error: "callback_error",
            errorDescription: `Convex OAuth callback failed: ${String(cause)}`,
          }),
  });

const callbackPromise = (
  authorization: Authorization,
): Promise<OAuthCredentials> => {
  const redirect = new URL(OAUTH_REDIRECT_URI);

  return new Promise((resolvePromise, reject) => {
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.pathname !== redirect.pathname) {
        response.statusCode = 404;
        response.end("Not Found");
        return;
      }

      const finish = (location: string) => {
        response.writeHead(302, { Location: location });
        response.end();
        cleanup();
      };
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        finish(AUTH_ERROR_URL);
        reject(
          new OAuthError({
            error: oauthError,
            errorDescription:
              url.searchParams.get("error_description") ??
              "Convex authorization failed.",
          }),
        );
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || state !== authorization.state) {
        finish(AUTH_ERROR_URL);
        reject(
          new OAuthError({
            error: "invalid_callback",
            errorDescription: !code
              ? "The Convex OAuth callback did not include a code."
              : "The Convex OAuth state did not match.",
          }),
        );
        return;
      }

      try {
        const credentials = await Effect.runPromise(
          exchange(authorization, code),
        );
        finish(AUTH_SUCCESS_URL);
        resolvePromise(credentials);
      } catch (cause) {
        finish(AUTH_ERROR_URL);
        reject(cause);
      }
    });

    const timeout = setTimeout(
      () => {
        cleanup();
        reject(
          new OAuthError({
            error: "timeout",
            errorDescription: "Convex authorization timed out.",
          }),
        );
      },
      5 * 60 * 1000,
    );

    const cleanup = () => {
      clearTimeout(timeout);
      server.close();
    };

    server.on("error", (cause) => {
      cleanup();
      reject(
        new OAuthError({
          error: "server_error",
          errorDescription: `Could not start the OAuth callback server: ${cause.message}`,
        }),
      );
    });
    server.listen(Number(redirect.port || 80), redirect.hostname);
  });
};
