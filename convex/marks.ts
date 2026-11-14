import { mutation, query, type QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { markCellOf } from "./cells";
import {
  MAX_MARKS_PER_CAMPAIGN,
  SLUG_PATTERN,
  assertCell,
  assertLatLng,
  assertOsmId,
  assertSlug,
} from "./validation";

async function campaignBySlug(ctx: QueryCtx, slug: string) {
  return await ctx.db
    .query("campaigns")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

/**
 * Markierte Häuser einer Rasterzelle, live über die Convex-Subscription.
 * Der Browser abonniert nur die sichtbaren Zellen, damit ein Tipp nicht allen
 * Helfern die ganze Aktion neu schickt.
 */
export const inCell = query({
  args: { slug: v.string(), cell: v.string() },
  handler: async (ctx, { slug, cell }) => {
    if (!SLUG_PATTERN.test(slug)) return [];
    assertCell(cell);
    const campaign = await campaignBySlug(ctx, slug);
    if (!campaign) return [];
    const marks = await ctx.db
      .query("marks")
      .withIndex("by_campaign_cell", (q) => q.eq("campaignId", campaign._id).eq("cell", cell))
      .collect();
    return marks.map((m) => ({ osmId: m.osmId, center: m.center }));
  },
});

/**
 * Setzt oder entfernt die Markierung eines Hauses. Idempotent: Der Client
 * schickt den gewünschten Zustand, nicht „umschalten“, damit zwei Helfer, die
 * gleichzeitig auf dasselbe Haus tippen, sich nicht gegenseitig aufheben.
 * `center` ist der Mittelpunkt des Hauses [lng, lat].
 */
export const set = mutation({
  args: {
    slug: v.string(),
    osmId: v.string(),
    marked: v.boolean(),
    center: v.array(v.number()),
  },
  handler: async (ctx, { slug, osmId, marked, center }) => {
    assertSlug(slug);
    assertOsmId(osmId);
    if (center.length !== 2) throw new ConvexError("Ungültige Koordinaten");
    assertLatLng(center[1], center[0]);
    const campaign = await campaignBySlug(ctx, slug);
    if (!campaign) throw new ConvexError("Verteilaktion nicht gefunden");

    const existing = await ctx.db
      .query("marks")
      .withIndex("by_campaign_osm", (q) => q.eq("campaignId", campaign._id).eq("osmId", osmId))
      .first();

    const count = campaign.markCount ?? 0;
    if (!marked) {
      if (existing) {
        await ctx.db.delete(existing._id);
        await ctx.db.patch(campaign._id, { markCount: Math.max(0, count - 1) });
      }
      return;
    }
    if (existing) return;
    if (count >= MAX_MARKS_PER_CAMPAIGN) throw new ConvexError("Diese Aktion hat schon zu viele Markierungen");

    await ctx.db.insert("marks", {
      campaignId: campaign._id,
      osmId,
      center: [center[0], center[1]],
      cell: markCellOf(center[0], center[1]),
    });
    await ctx.db.patch(campaign._id, { markCount: count + 1 });
  },
});
