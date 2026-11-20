import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API = process.env.API_INTERNAL_URL ?? "http://localhost:4000";
const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? "ws://localhost:4100";

export default defineConfig({
  server: {
    port: Number(process.env.WEB_PORT ?? 3000),
    // Bun keeps workspace packages (fonts included) in the repo root's node_modules.
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
    // Same-origin paths in development, so phones on the Wi-Fi only need one address.
    proxy: {
      // xfwd passes the browser's address on, so rate limits count each guest, not the proxy.
      "/api": { target: API, changeOrigin: true, xfwd: true, rewrite: (p) => p.replace(/^\/api/, "") },
      "/ws": { target: GATEWAY, ws: true },
    },
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
