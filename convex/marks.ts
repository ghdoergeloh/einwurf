import { mutation, query, type QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { multiPolygon } from "./schema";
import {
  MAX_MARKS_PER_CAMPAIGN,
  SLUG_PATTERN,
  assertGeometry,
  assertOsmId,
  assertSlug,
} from "./validation";

async function campaignBySlug(ctx: QueryCtx, slug: string) {
  return await ctx.db
    .query("campaigns")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

/** Alle markierten Häuser einer Aktion, live über die Convex-Subscription. */
export const list = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    if (!SLUG_PATTERN.test(slug)) return [];
    const campaign = await campaignBySlug(ctx, slug);
    if (!campaign) return [];
    const marks = await ctx.db
      .query("marks")
      .withIndex("by_campaign_osm", (q) => q.eq("campaignId", campaign._id))
      .collect();
    return marks.map((m) => ({ osmId: m.osmId, geometry: m.geometry }));
  },
});

/**
 * Setzt oder entfernt die Markierung eines Hauses. Idempotent: Der Client
 * schickt den gewünschten Zustand, nicht „umschalten“, damit zwei Helfer, die
 * gleichzeitig auf dasselbe Haus tippen, sich nicht gegenseitig aufheben.
 */
export const set = mutation({
  args: {
    slug: v.string(),
    osmId: v.string(),
    marked: v.boolean(),
    geometry: v.optional(multiPolygon),
  },
  handler: async (ctx, { slug, osmId, marked, geometry }) => {
    assertSlug(slug);
    assertOsmId(osmId);
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
    if (!geometry) throw new ConvexError("Geometrie fehlt");
    assertGeometry(geometry);

    if (count >= MAX_MARKS_PER_CAMPAIGN) throw new ConvexError("Zu viele Markierungen");

    await ctx.db.insert("marks", { campaignId: campaign._id, osmId, geometry });
    await ctx.db.patch(campaign._id, { markCount: count + 1 });
  },
});
