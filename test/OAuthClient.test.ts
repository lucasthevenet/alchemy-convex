import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { authorize } from "../src/OAuthClient.js";

describe("Convex OAuth client", () => {
  it("builds a team authorization URL with state and PKCE", async () => {
    const authorization = await Effect.runPromise(
      authorize({
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://localhost:9977/auth/callback",
      }),
    );
    const url = new URL(authorization.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://dashboard.convex.dev/oauth/authorize/team",
    );
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("state")).toBe(authorization.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toHaveLength(43);
    expect(url.searchParams.has("client_secret")).toBe(false);
  });
});
