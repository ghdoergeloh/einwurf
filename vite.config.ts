import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ command, mode }) => {
  // Auf Vercel setzt `npx convex deploy --cmd …` die Adresse des Backends. Fehlt sie,
  // lieber den Build abbrechen, als eine Seite ohne Backend zu veröffentlichen.
  if (command === "build" && process.env.VERCEL && !loadEnv(mode, process.cwd(), "VITE_").VITE_CONVEX_URL) {
    throw new Error(
      "VITE_CONVEX_URL fehlt. Build muss über `npx convex deploy --cmd 'pnpm build'` laufen (siehe vercel.json) " +
        "und CONVEX_DEPLOY_KEY muss in Vercel gesetzt sein.",
    );
  }
  return {
    plugins: [react(), tailwindcss()],
    test: {
      server: { deps: { inline: ["convex-test"] } },
    },
  };
});
