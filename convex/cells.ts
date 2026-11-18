/**
 * Raster für Markierungen und Notizen. Eine Zelle ist 0,005° groß (in Bornheim etwa
 * 350 m × 550 m). Das Handy abonniert nur die sichtbaren Zellen; ein Tipp schickt nur seine
 * Zelle neu. Jede Neuberechnung liest alle Markierungen der Zelle, deshalb nicht zu groß
 * (Database I/O), aber auch nicht zu klein (zu viele Abos je Bildschirm).
 * Wird von Backend und Frontend genutzt.
 *
 * Schlüssel: „f<x>:<y>“ (das „f“ unterscheidet sie vom früheren Raster von 0,01°).
 */
export const MARK_CELL_DEG = 0.005;
export const MARK_CELL_PATTERN = /^f-?\d{1,5}:-?\d{1,5}$/;

export function markCellOf(lng: number, lat: number): string {
  return `f${Math.floor(lng / MARK_CELL_DEG)}:${Math.floor(lat / MARK_CELL_DEG)}`;
}

/** Alle Zellen, die einen Ausschnitt [west, süd, ost, nord] überdecken. */
export function markCellsIn([w, s, e, n]: [number, number, number, number]): string[] {
  const out: string[] = [];
  for (let x = Math.floor(w / MARK_CELL_DEG); x <= Math.floor(e / MARK_CELL_DEG); x++)
    for (let y = Math.floor(s / MARK_CELL_DEG); y <= Math.floor(n / MARK_CELL_DEG); y++) out.push(`f${x}:${y}`);
  return out;
}
