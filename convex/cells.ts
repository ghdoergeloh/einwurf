/**
 * Raster für Markierungen und Notizen. Eine Zelle ist 0,005° groß (in Bornheim etwa
 * 350 m × 550 m). Das Handy abonniert nur die sichtbaren Zellen; ein Tipp schickt nur seine
 * Zelle neu. Jede Neuberechnung liest alle Markierungen der Zelle, deshalb nicht zu groß
 * (Database I/O), aber auch nicht zu klein (zu viele Abos je Bildschirm).
 * Wird von Backend und Frontend genutzt.
 *
 * Schlüssel: „f<x>:<y>“. Ältere Einträge haben noch Zellen von 0,01° ohne „f“ (LEGACY);
 * marks.inCell und notes.inCell lesen beide, bis migrations:fineCells gelaufen ist.
 */
export const MARK_CELL_DEG = 0.005;
export const LEGACY_CELL_DEG = 0.01;
/** Neue Zellen mit „f“, ältere ohne (noch von älteren Seiten abonniert). */
export const MARK_CELL_PATTERN = /^f?-?\d{1,5}:-?\d{1,5}$/;
const RATIO = Math.round(LEGACY_CELL_DEG / MARK_CELL_DEG);

export function markCellOf(lng: number, lat: number): string {
  return `f${Math.floor(lng / MARK_CELL_DEG)}:${Math.floor(lat / MARK_CELL_DEG)}`;
}

/** Ist das eine Zelle im alten Raster (0,01°)? */
export const isLegacyCell = (cell: string) => !cell.startsWith("f");

const parse = (cell: string) => cell.replace(/^f/, "").split(":").map(Number) as [number, number];

/** Alte Zelle (0,01°), in der eine neue liegt. */
export function legacyParentOf(cell: string): string {
  const [x, y] = parse(cell);
  return `${Math.floor(x / RATIO)}:${Math.floor(y / RATIO)}`;
}

/** Neue Zellen, die eine alte überdecken. */
export function fineChildrenOf(legacy: string): string[] {
  const [x, y] = parse(legacy);
  const out: string[] = [];
  for (let i = 0; i < RATIO; i++) for (let j = 0; j < RATIO; j++) out.push(`f${x * RATIO + i}:${y * RATIO + j}`);
  return out;
}

/** Alle Zellen, die einen Ausschnitt [west, süd, ost, nord] überdecken. */
export function markCellsIn([w, s, e, n]: [number, number, number, number]): string[] {
  const out: string[] = [];
  for (let x = Math.floor(w / MARK_CELL_DEG); x <= Math.floor(e / MARK_CELL_DEG); x++)
    for (let y = Math.floor(s / MARK_CELL_DEG); y <= Math.floor(n / MARK_CELL_DEG); y++) out.push(`f${x}:${y}`);
  return out;
}
