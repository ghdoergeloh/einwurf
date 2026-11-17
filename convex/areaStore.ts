import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { decodeCells, decodeGeometry, type AreaWithCells } from "./areaGeo";

/**
 * Gespeicherte Gebiete einer Aktion samt Auswahl, ohne sie zu entpacken; null, solange sie
 * nicht geladen sind. Die eine Stelle, die festlegt, was „gewählt“ heißt.
 */
export async function areaRows(
  ctx: QueryCtx,
  campaignId: Id<"campaigns">,
): Promise<{ row: Doc<"areas">; selected: boolean }[] | null> {
  const set = await ctx.db.query("areaSets").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).unique();
  if (!set || set.status !== "done") return null;
  const off = new Set(set.unselected);
  const rows = await ctx.db.query("areas").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).collect();
  return rows
    .sort((a, b) => a.name.localeCompare(b.name, "de"))
    .map((row) => ({ row, selected: !off.has(row.areaId) }));
}

/**
 * Gebiete einer Aktion mit Auswahl, für serverseitige Auswertungen (Statistik je Gebiet).
 * null, solange sie nicht geladen sind. Zuordnen von Häusern: areaAt aus areaGeo.ts.
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
