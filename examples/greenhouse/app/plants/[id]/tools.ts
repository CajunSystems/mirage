import { defineTool, z } from "@cajunsystems/mirage-core";
import { daysSince, db, needsWater } from "../../../server/db";

export const getPlant = defineTool({
  description: "One plant with its care details.",
  input: z.object({ id: z.string() }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    species: z.string(),
    location: z.string(),
    waterEveryDays: z.number(),
    lastWatered: z.string().nullable(),
    daysSinceWatered: z.number().nullable(),
    moisture: z.number().nullable(),
    notes: z.string(),
    status: z.enum(["Needs water", "OK"]),
    statusTone: z.enum(["warning", "success"]),
  }),
  handler: ({ id }) => {
    const p = db.get(id);
    if (!p) throw new Error(`No plant "${id}"`);
    const days = daysSince(p.lastWatered);
    const thirsty = needsWater(p);
    return {
      ...p,
      daysSinceWatered: Number.isFinite(days) ? days : null,
      status: thirsty ? ("Needs water" as const) : ("OK" as const),
      statusTone: thirsty ? ("warning" as const) : ("success" as const),
    };
  },
});

export const waterPlant = defineTool({
  description: "Record that a plant was watered today.",
  mutation: true,
  input: z.object({ id: z.string() }),
  output: z.object({ id: z.string(), lastWatered: z.string().nullable() }),
  handler: ({ id }) => {
    const p = db.water(id);
    return { id: p.id, lastWatered: p.lastWatered };
  },
});
