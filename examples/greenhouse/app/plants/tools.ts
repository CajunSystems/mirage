import { defineTool, z } from "@cajunsystems/mirage-core";
import { db } from "../../server/db";

export const createPlant = defineTool({
  description: "Add a plant to the greenhouse.",
  mutation: true,
  input: z.object({
    name: z.string().min(1),
    species: z.string().default(""),
    location: z.string().default(""),
    waterEveryDays: z.coerce.number().int().min(1).default(7),
  }),
  output: z.object({ id: z.string() }),
  handler: (input) => ({ id: db.create(input).id }),
});
