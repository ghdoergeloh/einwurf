import { CELL_SIZE, cellKeyOf } from "../../convex/osm";

/**
 * Tipps auf ein Haus der Grundkarte (hellgrauer Platzhalter), dessen antippbare Form noch von
 * Overpass kommt. Sobald sie da ist, wird das Haus an der Stelle wie bei einem normalen Tipp
 * weitergeschaltet. Gehört kein Haus zur Stelle, wird der Tipp verworfen.
 */
export interface PlaceholderTap {
  lngLat: [number, number];
}

/** Kachel des Punkts und ihre acht Nachbarn: Das Haus gehört zur Kachel seines Mittelpunkts. */
export function neighbourCells([lng, lat]: [number, number]): string[] {
  const out: string[] = [];
  for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) out.push(cellKeyOf([lng + dx * CELL_SIZE, lat + dy * CELL_SIZE]));
  return out;
}

export function resolvePlaceholderTaps(
  taps: PlaceholderTap[],
  isLoaded: (cell: string) => boolean,
  houseAt: (lngLat: [number, number]) => string | null,
) {
  const apply: { tap: PlaceholderTap; osmId: string }[] = [];
  const rest: PlaceholderTap[] = [];
  const dropped: PlaceholderTap[] = [];
  for (const tap of taps) {
    if (!isLoaded(cellKeyOf(tap.lngLat))) {
      rest.push(tap);
      continue;
    }
    const osmId = houseAt(tap.lngLat);
    if (osmId) apply.push({ tap, osmId });
    else if (neighbourCells(tap.lngLat).every(isLoaded)) dropped.push(tap);
    else rest.push(tap);
  }
  return { apply, rest, dropped };
}
