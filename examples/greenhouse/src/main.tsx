/// <reference types="@mirage/vite/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MirageApp } from "@mirage/react";
import { routes } from "virtual:mirage/routes";
import "@mirage/catalog-basic/styles.css";
import "../components/MoistureMeter.css";
import { catalog } from "../catalog";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MirageApp routes={routes} catalog={catalog} />
  </StrictMode>,
);
