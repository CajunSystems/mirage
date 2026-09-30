import react from "@vitejs/plugin-react";
import { mirage } from "@mirage/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [react(), mirage()] });
