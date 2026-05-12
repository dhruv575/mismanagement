import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));
// Single .env at the repo root (DATABASE_URL, OPENROUTER_API_KEY, etc.).
const ENV_DIR = path.resolve(here, "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ENV_DIR, "");
  const apiPort = Number(env.PORT || 5071);
  const apiUrl = env.VITE_API_URL || `http://localhost:${apiPort}`;
  return {
    envDir: ENV_DIR,
    plugins: [react()],
    server: {
      port: 5070,
      strictPort: true,
      proxy: {
        // No rewrite — the Hono app uses basePath('/api'), so the dev server
        // expects /api/* intact (matches Vercel's rewrite in prod).
        "/api": {
          target: apiUrl,
          changeOrigin: true,
        },
      },
    },
  };
});
