import { defineTool, z } from "@mirage/core";

const plant = z.object({ id: z.string(), name: z.string() });

export const listPlants = defineTool({
  description: "List plants, optionally filtered by name.",
  input: z.object({ query: z.string().optional() }),
  output: z.array(plant),
  handler: ({ query }) => [{ id: "p1", name: "Fern" }].filter((p) => !query || p.name.includes(query)),
});

export const ping = defineTool({
  description: "Route-level tool, shadows the global one.",
  input: z.object({}),
  output: z.string(),
  handler: () => "route",
});

export const broken = defineTool({
  description: "Returns output that does not match its schema.",
  input: z.object({}),
  output: z.number(),
  handler: () => "not a number" as unknown as number,
});
