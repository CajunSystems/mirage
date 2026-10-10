// In-memory data for the demo. Swap for a real database.
export type Plant = {
  id: string;
  name: string;
  species: string;
  location: string;
  waterEveryDays: number;
  lastWatered: string | null;
  moisture: number | null;
  notes: string;
};

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

const plants: Plant[] = [
  { id: "monstera", name: "Monstera", species: "Monstera deliciosa", location: "Bench A", waterEveryDays: 7, lastWatered: iso(3), moisture: 55, notes: "New leaf unfurling." },
  { id: "fiddle", name: "Fiddle-leaf fig", species: "Ficus lyrata", location: "Bench A", waterEveryDays: 10, lastWatered: iso(12), moisture: 18, notes: "Drops leaves when moved." },
  { id: "basil", name: "Basil", species: "Ocimum basilicum", location: "Herb shelf", waterEveryDays: 2, lastWatered: iso(1), moisture: 70, notes: "" },
  { id: "aloe", name: "Aloe", species: "Aloe vera", location: "Window", waterEveryDays: 21, lastWatered: iso(9), moisture: 22, notes: "Likes to dry out." },
  { id: "fern", name: "Boston fern", species: "Nephrolepis exaltata", location: "Misting tent", waterEveryDays: 3, lastWatered: iso(4), moisture: 35, notes: "" },
];

export const daysSince = (date: string | null) =>
  date ? Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000) : Infinity;

export const needsWater = (p: Plant) => daysSince(p.lastWatered) >= p.waterEveryDays;

export const db = {
  list: (query?: string) => {
    const q = query?.trim().toLowerCase();
    return plants.filter((p) => !q || `${p.name} ${p.species} ${p.location}`.toLowerCase().includes(q));
  },
  get: (id: string) => plants.find((p) => p.id === id) ?? null,
  create(input: { name: string; species: string; location: string; waterEveryDays: number }) {
    const base = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plant";
    let id = base;
    for (let i = 2; plants.some((p) => p.id === id); i++) id = `${base}-${i}`;
    const plant: Plant = { ...input, id, lastWatered: null, moisture: null, notes: "" };
    plants.push(plant);
    return plant;
  },
  water(id: string) {
    const plant = plants.find((p) => p.id === id);
    if (!plant) throw new Error(`No plant "${id}"`);
    plant.lastWatered = iso(0);
    plant.moisture = 85;
    return plant;
  },
};
