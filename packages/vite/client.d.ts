// Add `/// <reference types="@cajunsystems/mirage-vite/client" />` to type the virtual modules.
declare module "virtual:mirage/routes" {
  import type { MirageRoute } from "@cajunsystems/mirage-react";
  export const routes: MirageRoute[];
}
