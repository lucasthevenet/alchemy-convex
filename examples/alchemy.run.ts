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
    const project = yield* Convex.Project("Backend", {
      dir: "./examples/convex-app",
    });

    const deployment = yield* Convex.Deployment("BackendDeployment", {
      project,
      env: {
        APP_ENV: "production",
      },
    });

    return {
      convexUrl: deployment.url,
      convexHttpActionsUrl: deployment.httpActionsUrl,
    };
  }),
);
