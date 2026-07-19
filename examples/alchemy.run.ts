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
      projectDir: ".",
      env: {
        APP_ENV: "production",
      },
    });

    // Other Alchemy resource Outputs can be attached after construction.
    yield* Convex.bindEnvironment(backend, {
      API_ORIGIN: "https://api.example.com",
    });

    return {
      convexUrl: backend.url,
      convexHttpActionsUrl: backend.httpActionsUrl,
    };
  }),
);
