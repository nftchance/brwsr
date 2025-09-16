import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "src/renderer",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../../dist", emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
