import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds straight into ../server/public, which the Express server serves.
// In dev, `npm run dev` proxies /api to the backend on :4000.
export default defineConfig({
  plugins: [react()],
  base: "./", // relative asset URLs, so the build works at / or behind /hub/
  build: {
    outDir: "../server/public",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.API_TARGET || "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
