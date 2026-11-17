import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { decodeGeometry, type Area } from "./areaGeo";

/**
 * Gebiete einer Aktion mit Auswahl, für serverseitige Auswertungen (Vorladen, Statistik je Gebiet).
 * null, solange sie nicht geladen sind. Zuordnen von Häusern: areaAt aus areaGeo.ts.
 */
export async function campaignAreas(ctx: QueryCtx, campaignId: Id<"campaigns">): Promise<Area[] | null> {
  const set = await ctx.db.query("areaSets").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).unique();
  if (!set || set.status !== "done") return null;
  const off = new Set(set.unselected);
  const rows = await ctx.db.query("areas").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).collect();
  return rows
    .map((r) => ({ id: r.areaId, name: r.name, geometry: decodeGeometry(r.geometry), selected: !off.has(r.areaId) }))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}
