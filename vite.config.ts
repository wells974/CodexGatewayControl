import { defineConfig } from "vite";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, root, "");
  const gatewayPort = Number(environment.GATEWAY_PORT ?? environment.CONTROLLER_PORT ?? 4000);
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": path.join(root, "src") } },
    build: { outDir: "dist-web", emptyOutDir: true },
    server: {
      host: "127.0.0.1",
      port: Number(environment.VITE_PORT ?? 5174),
      proxy: {
        "/api": `http://127.0.0.1:${gatewayPort}`,
        "/health": `http://127.0.0.1:${gatewayPort}`,
        "/v1": `http://127.0.0.1:${gatewayPort}`
      }
    }
  };
});
