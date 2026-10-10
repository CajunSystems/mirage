import { defineCatalog, z } from "@mirage/core";
import { basicCatalog } from "@mirage/catalog-basic";
import { MoistureMeter } from "./components/MoistureMeter";

export const catalog = defineCatalog({
  ...basicCatalog.entries,
  MoistureMeter: {
    description: "Soil moisture (0-100) as a bar. Below 30 is dry, above 80 is waterlogged.",
    props: z.object({ label: z.string().default("Soil moisture"), value: z.number().nullable() }),
    component: MoistureMeter,
  },
});
