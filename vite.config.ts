import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist-web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: { "/api": "http://127.0.0.1:4000", "/health": "http://127.0.0.1:4000", "/v1": "http://127.0.0.1:4000" }
  }
});
