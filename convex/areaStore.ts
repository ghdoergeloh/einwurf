import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { decodeCells, decodeGeometry, type AreaWithCells } from "./areaGeo";

/** Gewählt? Fehlt das Feld (Vorabstand), gilt das Gebiet als gewählt. */
export const isSelected = (row: Doc<"areas">) => row.selected !== false;

/**
 * Gespeicherte Gebiete einer Aktion samt Auswahl, ohne sie zu entpacken, nach Namen sortiert;
 * null, solange die Aktion noch nie ein Gebiet hatte (abgewählte zählen mit). Die eine Stelle,
 * die festlegt, was „gewählt“ heißt.
 */
export async function areaRows(
  ctx: QueryCtx,
  campaignId: Id<"campaigns">,
): Promise<{ row: Doc<"areas">; selected: boolean }[] | null> {
  const rows = await ctx.db.query("areas").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).collect();
  if (rows.length === 0) return null;
  return rows.sort((a, b) => a.name.localeCompare(b.name, "de")).map((row) => ({ row, selected: isSelected(row) }));
}

/**
 * Gebiete einer Aktion mit Auswahl, für serverseitige Auswertungen (Statistik je Gebiet).
 * Enthält auch abgewählte Gebiete (selected = false). null, solange die Aktion noch nie ein
 * Gebiet hatte.
 * Zuordnen von Häusern: areaAt aus areaGeo.ts.
 */
export async function campaignAreas(ctx: QueryCtx, campaignId: Id<"campaigns">): Promise<AreaWithCells[] | null> {
  const rows = await areaRows(ctx, campaignId);
  return (
    rows?.map(({ row, selected }) => ({
      id: row.areaId,
      name: row.name,
      geometry: decodeGeometry(row.geometry),
      selected,
      cells: decodeCells(row.cells),
    })) ?? null
  );
}
