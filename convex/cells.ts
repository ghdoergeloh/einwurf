/**
 * Raster für Markierungen. Eine Zelle ist 0,01° groß (in Bornheim etwa 700 m × 1,1 km).
 * Das Handy abonniert nur die sichtbaren Zellen; ein Tipp schickt nur seine Zelle neu.
 * Wird von Backend und Frontend genutzt.
 */
export const MARK_CELL_DEG = 0.01;
export const MARK_CELL_PATTERN = /^-?\d{1,5}:-?\d{1,5}$/;

export function markCellOf(lng: number, lat: number): string {
  return `${Math.floor(lng / MARK_CELL_DEG)}:${Math.floor(lat / MARK_CELL_DEG)}`;
}

/** Alle Zellen, die einen Ausschnitt [west, süd, ost, nord] überdecken. */
export function markCellsIn([w, s, e, n]: [number, number, number, number]): string[] {
  const out: string[] = [];
  for (let x = Math.floor(w / MARK_CELL_DEG); x <= Math.floor(e / MARK_CELL_DEG); x++)
    for (let y = Math.floor(s / MARK_CELL_DEG); y <= Math.floor(n / MARK_CELL_DEG); y++) out.push(`${x}:${y}`);
  return out;
}
