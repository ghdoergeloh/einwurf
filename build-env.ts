/**
 * Auf Vercel setzt `npx convex deploy --cmd …` die Adresse des Backends (VITE_CONVEX_URL).
 * Fehlt sie, soll der Build abbrechen, statt eine Seite ohne Backend zu veröffentlichen.
 * Gibt die Fehlermeldung zurück oder null, wenn alles passt.
 */
export function missingConvexUrlError(env: { VERCEL?: string; VITE_CONVEX_URL?: string }): string | null {
  if (!env.VERCEL) return null;
  if (env.VITE_CONVEX_URL && env.VITE_CONVEX_URL.trim()) return null;
  return (
    "VITE_CONVEX_URL fehlt. Build muss über `npx convex deploy --cmd 'pnpm build'` laufen (siehe vercel.json) " +
    "und CONVEX_DEPLOY_KEY muss in Vercel gesetzt sein."
  );
}
