import type { Position } from "geojson";
import { nextStatus, type HouseStatus } from "../../convex/status";
import { cellKeyOf } from "../../convex/osm";

/**
 * Tipps auf ein Haus der Grundkarte (hellgrauer Platzhalter), dessen antippbare Form noch von
 * Overpass kommt. Das Haus färbt sich sofort, weitere Tipps schalten weiter wie bei jedem Haus.
 * Sobald die Form da ist, wird der Zustand übernommen (als gemerkter Tipp von „offen“ aus, siehe
 * pendingTaps.ts). Gehört kein Haus zur Stelle oder kommt es zu lange nicht, wird verworfen.
 */
export interface PlaceholderTap {
  lngLat: [number, number];
  /** Umriss aus der Grundkarte, für die vorläufige Farbe. */
  shape: Position[][][];
  to: HouseStatus;
  /** Zeitpunkt des ersten Tipps. */
  at: number;
}

/** So lange wartet ein Tipp auf sein Haus. */
export const PLACEHOLDER_MAX_AGE_MS = 3 * 60_000;

export function cyclePlaceholder(
  taps: Map<string, PlaceholderTap>,
  id: string,
  first: Pick<PlaceholderTap, "lngLat" | "shape">,
  now: number,
) {
  const next = new Map(taps);
  const t = taps.get(id);
  // Ein Platzhalter gilt als offen: markierte Häuser zeigt die Karte als Punkt, der ist antippbar.
  const to = nextStatus(t ? t.to : "none");
  if (to === "none") next.delete(id);
  else next.set(id, t ? { ...t, to } : { ...first, to, at: now });
  return next;
}

/** So weit liegt der Mittelpunkt eines Hauses höchstens von der angetippten Stelle (etwa 50 m). */
export const HOUSE_RADIUS_DEG = 0.0007;

/**
 * Kacheln, in denen der Mittelpunkt des angetippten Hauses liegen kann: Das Haus gehört zur
 * Kachel seines Mittelpunkts. Sehr große Gebäude fängt die Frist PLACEHOLDER_MAX_AGE_MS ab.
 */
export function neighbourCells([lng, lat]: [number, number]): string[] {
  const out = new Set<string>();
  for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) out.add(cellKeyOf([lng + dx * HOUSE_RADIUS_DEG, lat + dy * HOUSE_RADIUS_DEG]));
  return [...out];
}

export function resolvePlaceholderTaps<T extends Pick<PlaceholderTap, "lngLat" | "at">>(
  taps: T[],
  isLoaded: (cell: string) => boolean,
  houseAt: (lngLat: [number, number]) => string | null,
  now: number,
) {
  const apply: { tap: T; osmId: string }[] = [];
  const rest: T[] = [];
  const dropped: T[] = [];
  const expired: T[] = [];
  for (const tap of taps) {
    const osmId = isLoaded(cellKeyOf(tap.lngLat)) ? houseAt(tap.lngLat) : null;
    if (osmId) apply.push({ tap, osmId });
    else if (isLoaded(cellKeyOf(tap.lngLat)) && neighbourCells(tap.lngLat).every(isLoaded)) dropped.push(tap);
    else if (now - tap.at > PLACEHOLDER_MAX_AGE_MS) expired.push(tap);
    else rest.push(tap);
  }
  return { apply, rest, dropped, expired };
}
