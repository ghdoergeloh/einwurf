import { mutation, query, type QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { markCellOf } from "./cells";
import { countDelta, statusOf, type HouseStatus } from "./status";
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
    return marks.map((m) => ({ osmId: m.osmId, center: m.center, status: m.status ?? ("done" as const) }));
  },
});

/**
 * Setzt den Zustand eines Hauses: „none“ (offen), „done“ (Flyer drin) oder „blocked“
 * (Einwerfen nicht möglich, z. B. Aufkleber „Keine Werbung“). Idempotent: Der Client
 * schickt den gewünschten Zustand, nicht „weiterschalten“, damit zwei Helfer, die
 * gleichzeitig auf dasselbe Haus tippen, es nicht doppelt weiterschalten.
 * `center` ist der Mittelpunkt des Hauses [lng, lat].
 * `marked` ist die ältere Form (true = done, false = none) für noch geöffnete alte Seiten.
 */
export const set = mutation({
  args: {
    slug: v.string(),
    osmId: v.string(),
    status: v.optional(v.union(v.literal("none"), v.literal("done"), v.literal("blocked"))),
    marked: v.optional(v.boolean()),
    center: v.array(v.number()),
  },
  handler: async (ctx, { slug, osmId, status, marked, center }) => {
    assertSlug(slug);
    assertOsmId(osmId);
    if (center.length !== 2) throw new ConvexError("Ungültige Koordinaten");
    assertLatLng(center[1], center[0]);
    const target: HouseStatus | undefined = status ?? (marked === undefined ? undefined : marked ? "done" : "none");
    if (!target) throw new ConvexError("Zustand fehlt");
    const campaign = await campaignBySlug(ctx, slug);
    if (!campaign) throw new ConvexError("Verteilaktion nicht gefunden");

    const existing = await ctx.db
      .query("marks")
      .withIndex("by_campaign_osm", (q) => q.eq("campaignId", campaign._id).eq("osmId", osmId))
      .first();
    const from = statusOf(existing);
    if (from === target) return;

    if (target === "none") {
      await ctx.db.delete(existing!._id);
    } else if (existing) {
      await ctx.db.patch(existing._id, { status: target });
    } else {
      const total = (campaign.markCount ?? 0) + (campaign.blockedCount ?? 0);
      if (total >= MAX_MARKS_PER_CAMPAIGN) throw new ConvexError("Diese Aktion hat schon zu viele Markierungen");
      await ctx.db.insert("marks", {
        campaignId: campaign._id,
        osmId,
        center: [center[0], center[1]],
        cell: markCellOf(center[0], center[1]),
        status: target,
      });
    }
    const d = countDelta(from, target);
    await ctx.db.patch(campaign._id, {
      markCount: Math.max(0, (campaign.markCount ?? 0) + d.done),
      blockedCount: Math.max(0, (campaign.blockedCount ?? 0) + d.blocked),
    });
  },
});
