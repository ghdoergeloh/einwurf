import { mutation, query, type QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { markCellOf } from "./cells";
import { MAX_NOTES_PER_CAMPAIGN, SLUG_PATTERN, assertCell, assertLatLng, assertOsmId, assertSlug, cleanNote } from "./validation";

/**
 * Notizen an Häusern, z. B. „Briefkasten 3 und 4 haben nichts bekommen“. Ein Haus mit Notiz
 * zeigt die Karte blau. Abonniert wird wie bei den Markierungen nur je sichtbarer Zelle.
 */

async function campaignBySlug(ctx: QueryCtx, slug: string) {
  return await ctx.db
    .query("campaigns")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

async function noteOf(ctx: QueryCtx, campaignId: Id<"campaigns">, osmId: string) {
  return await ctx.db
    .query("notes")
    .withIndex("by_campaign_osm", (q) => q.eq("campaignId", campaignId).eq("osmId", osmId))
    .first();
}

/** Notizen einer Rasterzelle, live über die Convex-Subscription. */
export const inCell = query({
  args: { slug: v.string(), cell: v.string() },
  handler: async (ctx, { slug, cell }) => {
    if (!SLUG_PATTERN.test(slug)) return [];
    assertCell(cell);
    const campaign = await campaignBySlug(ctx, slug);
    if (!campaign) return [];
    const notes = await ctx.db
      .query("notes")
      .withIndex("by_campaign_cell", (q) => q.eq("campaignId", campaign._id).eq("cell", cell))
      .collect();
    return notes.map((n) => ({ osmId: n.osmId, center: n.center, text: n.text, updatedAt: n.updatedAt }));
  },
});

/** Legt die Notiz eines Hauses an oder ersetzt sie. `center` ist der Mittelpunkt [lng, lat]. */
export const set = mutation({
  args: { slug: v.string(), osmId: v.string(), center: v.array(v.number()), text: v.string() },
  handler: async (ctx, { slug, osmId, center, text }) => {
    assertSlug(slug);
    assertOsmId(osmId);
    if (center.length !== 2) throw new ConvexError("Ungültige Koordinaten");
    assertLatLng(center[1], center[0]);
    const clean = cleanNote(text);
    const campaign = await campaignBySlug(ctx, slug);
    if (!campaign) throw new ConvexError("Verteilaktion nicht gefunden");

    const existing = await noteOf(ctx, campaign._id, osmId);
    if (existing) {
      await ctx.db.patch(existing._id, { text: clean, updatedAt: Date.now() });
      return;
    }
    const count = campaign.noteCount ?? 0;
    if (count >= MAX_NOTES_PER_CAMPAIGN) throw new ConvexError("Diese Aktion hat schon zu viele Notizen");
    await ctx.db.insert("notes", {
      campaignId: campaign._id,
      osmId,
      center: [center[0], center[1]],
      cell: markCellOf(center[0], center[1]),
      text: clean,
      updatedAt: Date.now(),
    });
    await ctx.db.patch(campaign._id, { noteCount: count + 1 });
  },
});

/** Löscht die Notiz eines Hauses; ohne Notiz passiert nichts. */
export const remove = mutation({
  args: { slug: v.string(), osmId: v.string() },
  handler: async (ctx, { slug, osmId }) => {
    assertSlug(slug);
    assertOsmId(osmId);
    const campaign = await campaignBySlug(ctx, slug);
    if (!campaign) throw new ConvexError("Verteilaktion nicht gefunden");
    const existing = await noteOf(ctx, campaign._id, osmId);
    if (!existing) return;
    await ctx.db.delete(existing._id);
    await ctx.db.patch(campaign._id, { noteCount: Math.max(0, (campaign.noteCount ?? 0) - 1) });
  },
});
