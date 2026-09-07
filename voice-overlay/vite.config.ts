import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  clearScreen: false,
  server: { port: 1421, strictPort: true },
  build: { outDir: "dist" },
});
