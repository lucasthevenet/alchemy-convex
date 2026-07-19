import * as Layer from "effect/Layer";
import * as Provider from "alchemy/Provider";
import { Deployment, DeploymentProvider } from "./Deployment.js";
import {
  ConvexCli,
  ConvexCliLive,
  type ConvexCliOptions,
} from "./Runtime.js";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Convex",
) {}

const providerCollection = () =>
  Layer.effect(Providers, Provider.collection([Deployment])).pipe(
    Layer.provide(DeploymentProvider()),
  );

/** Register Convex resources using the local Convex CLI runtime. */
export const providers = (options: ConvexCliOptions = {}) =>
  providerCollection().pipe(Layer.provide(ConvexCliLive(options)));

/** Supply a custom CLI implementation, primarily for provider tests. */
export const providersWithRuntime = (
  runtime: Layer.Layer<ConvexCli, never, never>,
) => providerCollection().pipe(Layer.provide(runtime));
