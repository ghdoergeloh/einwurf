export interface Place {
  label: string;
  short: string;
  lat: number;
  lng: number;
  /** [west, süd, ost, nord] */
  bbox: [number, number, number, number] | null;
}

interface NominatimResult {
  display_name: string;
  name?: string;
  lat: string;
  lon: string;
  boundingbox?: [string, string, string, string]; // [süd, nord, west, ost]
}

export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

export function parseNominatim(results: NominatimResult[]): Place[] {
  return results.map((r) => {
    const b = r.boundingbox?.map(Number);
    return {
      label: r.display_name,
      short: r.name || r.display_name.split(",")[0],
      lat: Number(r.lat),
      lng: Number(r.lon),
      // Orte über die Datumsgrenze (West > Ost) bekommen keinen Ausschnitt, nur die Mitte.
      bbox: b && b.every(Number.isFinite) && b[2] < b[3] && b[0] < b[1] ? [b[2], b[0], b[3], b[1]] : null,
    };
  });
}

/** Ortssuche über Nominatim. Nur auf Absenden aufrufen (Nutzungsregeln: keine Autovervollständigung). */
export async function searchPlaces(q: string, signal?: AbortSignal): Promise<Place[]> {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "6");
  url.searchParams.set("accept-language", "de");
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  return parseNominatim(await res.json());
}
