import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Convex from "../src/index.js";

export default Alchemy.Stack(
  "ConvexExample",
  {
    providers: Convex.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const backend = yield* Convex.Project("Backend", {
      projectDir: "./examples/convex-app",
      env: {
        APP_ENV: "production",
      },
    });

    return {
      convexUrl: backend.url,
      convexHttpActionsUrl: backend.httpActionsUrl,
    };
  }),
);
