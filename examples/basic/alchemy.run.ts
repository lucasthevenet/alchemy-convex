import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Convex from "alchemy-convex";
import * as Layer from "effect/Layer";
import * as Cloudflare from "alchemy/Cloudflare";
import { adopt } from "alchemy/AdoptPolicy";

export default Alchemy.Stack(
  "ConvexExample",
  {
    providers: Layer.mergeAll(Convex.providers(), Cloudflare.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const project = yield* Convex.Project("Backend");

    const deployment = yield* Convex.Deployment("BackendDeployment", {
      project,
      reference: "preview/lucas",
    }).pipe(adopt());

    return {
      convexUrl: deployment.url,
      convexHttpActionsUrl: deployment.httpActionsUrl,
    };
  }),
);
