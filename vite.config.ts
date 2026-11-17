import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { missingConvexUrlError } from "./build-env";

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    const error = missingConvexUrlError({
      VERCEL: process.env.VERCEL,
      VITE_CONVEX_URL: loadEnv(mode, process.cwd(), "VITE_").VITE_CONVEX_URL,
    });
    if (error) throw new Error(error);
  }
  return {
    plugins: [react(), tailwindcss()],
    test: {
      server: { deps: { inline: ["convex-test"] } },
      exclude: ["**/node_modules/**", "**/.pnpm-store/**", "e2e/**"],
      // Automatisches Vorladen und Laden der Gebiete beim Anlegen in Unit-Tests aus (würde fetch aufrufen).
      env: { PREFETCH_ON_CREATE: "off", AREAS_ON_CREATE: "off" },
    },
  };
});
