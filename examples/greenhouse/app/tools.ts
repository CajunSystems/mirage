// Tools visible to every route.
import { defineTool, z } from "@cajunsystems/mirage-core";
import { daysSince, db, needsWater, type Plant } from "../server/db";

const row = (p: Plant) => ({
  id: p.id,
  name: p.name,
  species: p.species,
  location: p.location,
  status: needsWater(p) ? ("Needs water" as const) : ("OK" as const),
  daysSinceWatered: Number.isFinite(daysSince(p.lastWatered)) ? daysSince(p.lastWatered) : null,
});

export const PlantRow = z.object({
  id: z.string(),
  name: z.string(),
  species: z.string(),
  location: z.string(),
  status: z.enum(["Needs water", "OK"]),
  daysSinceWatered: z.number().nullable(),
});

export const listPlants = defineTool({
  description: "List plants. `query` matches name, species or location. `needsWater: true` returns only plants due for watering.",
  input: z.object({ query: z.string().optional(), needsWater: z.boolean().optional() }),
  output: z.array(PlantRow),
  handler: ({ query, needsWater: thirsty }) =>
    db
      .list(query)
      .filter((p) => !thirsty || needsWater(p))
      .map(row),
});

export const greenhouseSummary = defineTool({
  description: "Counts for the whole greenhouse.",
  input: z.object({}),
  output: z.object({ total: z.number(), needsWater: z.number(), locations: z.number() }),
  handler: () => {
    const all = db.list();
    return {
      total: all.length,
      needsWater: all.filter(needsWater).length,
      locations: new Set(all.map((p) => p.location)).size,
    };
  },
});
