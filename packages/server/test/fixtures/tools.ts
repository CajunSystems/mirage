import { defineTool, z } from "@cajunsystems/mirage-core";

export const ping = defineTool({
  description: "Global tool.",
  input: z.object({}),
  output: z.string(),
  handler: () => "global",
});

export const whoami = defineTool({
  description: "Returns the user from context.",
  input: z.object({}),
  output: z.string(),
  handler: (_input, ctx) => String(ctx.user),
});
