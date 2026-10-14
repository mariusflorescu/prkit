import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const webPort = Number(process.env.PRKIT_WEB_PORT ?? 5733);
const serverPort = process.env.PRKIT_SERVER_PORT;
const serverTarget = serverPort ? `http://127.0.0.1:${serverPort}` : undefined;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The favicons are served straight from the brand kit, so there is one copy of each.
  publicDir: "../../assets/brand/favicon",
  worker: { format: "es" },
  resolve: {
    tsconfigPaths: true,
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    // Dev stays single-origin: the UI talks to its own origin and Vite forwards these.
    // changeOrigin stays off so the server sees the browser's Origin for its /ws check.
    ...(serverTarget
      ? {
          proxy: {
            "/ws": { target: serverTarget, ws: true },
            "/health": { target: serverTarget },
            "/appearance.js": { target: serverTarget },
          },
        }
      : {}),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
