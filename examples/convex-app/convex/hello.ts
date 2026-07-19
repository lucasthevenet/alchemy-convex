import { queryGeneric } from "convex/server";

export const hello = queryGeneric({
  args: {},
  handler: () => "Hello from alchemy-convex!",
});
