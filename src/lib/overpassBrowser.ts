import { DEFAULT_OVERPASS_ENDPOINTS, type Ask } from "../../convex/areaLoad";

/**
 * Overpass-Abfrage aus dem Browser, nur für die Grenzen der Ortsteile im Modus „Gebiete
 * bearbeiten“: Aus der Convex-Cloud sind die öffentlichen Server oft nicht erreichbar, aus einem
 * normalen Browser schon. Häuser fragt weiter Convex (convex/buildings.ts).
 * Server der Reihe nach; jeder darf so lange brauchen, ausgelastete Server antworten spät.
 */
const TIMEOUT_MS = 120_000;
/** Über alle Server zusammen höchstens so lange je Abfrage, damit die Leiste nicht ewig „lädt“. */
const TOTAL_MS = 180_000;
/** Ein weiterer Server lohnt nur, wenn noch so viel Zeit bleibt. */
const MIN_ATTEMPT_MS = 15_000;
/** Größere Antworten verwerfen (wie in convex/buildings.ts). */
const MAX_RESPONSE_CHARS = 40_000_000;

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "Overpass";
  }
};

export function overpassEndpoints(): string[] {
  const fromEnv = (import.meta.env.VITE_OVERPASS_URLS as string | undefined)?.split(",").map((s) => s.trim()).filter(Boolean);
  return fromEnv?.length ? fromEnv : DEFAULT_OVERPASS_ENDPOINTS;
}

export const browserAsk: Ask = async (step, query, parse) => {
  const problems: string[] = [];
  const deadline = Date.now() + TOTAL_MS;
  for (const url of overpassEndpoints()) {
    const left = deadline - Date.now();
    if (left < MIN_ATTEMPT_MS) {
      problems.push("keine Zeit mehr für weitere Server");
      break;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(TIMEOUT_MS, left));
    try {
      const res = await fetch(url, {
        method: "POST",
        // Overpass erlaubt Abfragen aus dem Browser (CORS); einen eigenen User-Agent setzt der Browser selbst.
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }).toString(),
        // Mit Referer antwortet overpass-api.de mit 406 Not Acceptable (gemessen 2026-11, auch
        // von der Preview aus); ohne Referer, nur mit Origin, kommt die Antwort.
        referrerPolicy: "no-referrer",
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (text.length > MAX_RESPONSE_CHARS) throw new Error(`Antwort zu groß (${Math.round(text.length / 1e6)} MB)`);
      const json = JSON.parse(text) as { remark?: string };
      if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(json.remark);
      return parse(json as never);
    } catch (e) {
      const msg = ctrl.signal.aborted ? "keine Antwort" : e instanceof Error ? e.message : String(e);
      problems.push(`${hostOf(url)}: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Die Ortsteile (OpenStreetMap) sind gerade nicht erreichbar. ${step}: ${problems.join(" · ")}`);
};
