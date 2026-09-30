// Add `/// <reference types="@mirage/vite/client" />` to type the virtual modules.
declare module "virtual:mirage/routes" {
  import type { MirageRoute } from "@mirage/react";
  export const routes: MirageRoute[];
}
