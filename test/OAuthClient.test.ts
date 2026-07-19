import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_REDIRECT_URI,
  authorize,
  exchange,
} from "../src/OAuthClient.js";

describe("Convex OAuth client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds a team authorization URL with state and PKCE", async () => {
    const authorization = await Effect.runPromise(authorize());
    const url = new URL(authorization.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://dashboard.convex.dev/oauth/authorize/team",
    );
    expect(url.searchParams.get("client_id")).toBe(OAUTH_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(OAUTH_REDIRECT_URI);
    expect(url.searchParams.get("state")).toBe(authorization.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toHaveLength(43);
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  it("uses the registered application credentials for code exchange", async () => {
    const authorization = await Effect.runPromise(authorize());
    let requestBody: URLSearchParams | undefined;
    vi.stubGlobal(
      "fetch",
      async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = init?.body as URLSearchParams;
        return new Response(
          JSON.stringify({ access_token: "team:example|token" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    );

    const credentials = await Effect.runPromise(
      exchange(authorization, "authorization-code"),
    );

    expect(credentials.access).toBe("team:example|token");
    expect(requestBody?.get("client_id")).toBe(OAUTH_CLIENT_ID);
    expect(requestBody?.get("client_secret")).toBe(OAUTH_CLIENT_SECRET);
    expect(requestBody?.get("redirect_uri")).toBe(OAUTH_REDIRECT_URI);
    expect(requestBody?.get("code_verifier")).toBe(authorization.codeVerifier);
  });
});
