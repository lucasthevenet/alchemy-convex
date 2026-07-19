import * as Layer from "effect/Layer";
import * as Provider from "alchemy/Provider";
import type { ResourceClassLike } from "alchemy/Resource";
import { CredentialsStoreLive, ProfileLive } from "alchemy/Auth";
import { ConvexAuth } from "./AuthProvider.js";
import { fromAuthProvider } from "./Credentials.js";
import { Deployment, DeploymentProvider } from "./Deployment.js";
import { Project, ProjectProvider } from "./Project.js";
import {
  ConvexManagementApi,
  ConvexManagementApiLive,
  type ConvexManagementApiOptions,
} from "./ManagementApi.js";
import { ConvexCli, ConvexCliLive, type ConvexCliOptions } from "./Runtime.js";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Convex",
) {}

const providerCollection = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Project as unknown as ResourceClassLike<Project>,
      Deployment,
    ]),
  ).pipe(Layer.provide(ProjectProvider()), Layer.provide(DeploymentProvider()));

export interface ConvexProviderOptions
  extends ConvexCliOptions, ConvexManagementApiOptions {}

/** Register Convex resources using the local CLI and Management API. */
export const providers = (options: ConvexProviderOptions = {}) => {
  const credentials = fromAuthProvider();
  const management = ConvexManagementApiLive(options);
  return providerCollection().pipe(
    Layer.provide(management),
    Layer.provide(ConvexCliLive(options)),
    Layer.provideMerge(credentials),
    Layer.provideMerge(ConvexAuth()),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
};

/** Supply custom runtime services, primarily for provider tests. */
export const providersWithRuntime = (
  runtime: Layer.Layer<ConvexCli, never, never>,
  management: Layer.Layer<ConvexManagementApi, never, never>,
) =>
  providerCollection().pipe(Layer.provide(runtime), Layer.provide(management));
