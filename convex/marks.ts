import { mutation, query } from "./_generated/server";
import { campaignByKey, requireRole } from "./access";
import { trackMark } from "./stats";
import { addCounts, countsOf } from "./counters";
import { ConvexError, v } from "convex/values";
import { markCellOf } from "./cells";
import { marksInCell } from "./cellRows";
import { countDelta, statusOf, type HouseStatus } from "./status";
import {
  MAX_MARKS_PER_CAMPAIGN,
  SLUG_PATTERN,
  assertCell,
  assertCenter,
  assertOsmId,
  assertSlug,
} from "./validation";

/**
 * Markierte Häuser einer Rasterzelle, live über die Convex-Subscription.
 * Der Browser abonniert nur die sichtbaren Zellen, damit ein Tipp nicht allen
 * Helfern die ganze Aktion neu schickt. Mit jedem Schlüssel (auch Ansehen).
 */
export const inCell = query({
  args: { slug: v.string(), cell: v.string() },
  handler: async (ctx, { slug, cell }) => {
    if (!SLUG_PATTERN.test(slug)) return [];
    assertCell(cell);
    const campaign = (await campaignByKey(ctx, slug))?.campaign;
    if (!campaign) return [];
    const marks = await marksInCell(ctx, campaign._id, cell);
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
 * Ab Rolle edit (Bearbeiten- oder Admin-Schlüssel).
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
    assertCenter(center);
    const target: HouseStatus | undefined = status ?? (marked === undefined ? undefined : marked ? "done" : "none");
    if (!target) throw new ConvexError("Zustand fehlt");
    const { campaign } = await requireRole(ctx, slug, "edit");

    const existing = await ctx.db
      .query("marks")
      .withIndex("by_campaign_osm", (q) => q.eq("campaignId", campaign._id).eq("osmId", osmId))
      .first();
    const from = statusOf(existing);
    if (from === target) return;

    // Statistik je Gebiet mitzählen (convex/stats.ts).
    const area = await trackMark(ctx, campaign._id, existing, target, [center[0], center[1]]);
    if (target === "none") {
      await ctx.db.delete(existing!._id);
    } else if (existing) {
      // Ältere Markierung im alten Raster: dabei in die neue Zelle umziehen.
      await ctx.db.patch(existing._id, { status: target, cell: markCellOf(existing.center[0], existing.center[1]), ...area });
    } else {
      const counts = await countsOf(ctx, campaign);
      const total = counts.done + counts.blocked;
      if (total >= MAX_MARKS_PER_CAMPAIGN) throw new ConvexError("Diese Aktion hat schon zu viele Markierungen");
      await ctx.db.insert("marks", {
        campaignId: campaign._id,
        osmId,
        center: [center[0], center[1]],
        cell: markCellOf(center[0], center[1]),
        status: target,
        ...area,
      });
    }
    const d = countDelta(from, target);
    await addCounts(ctx, campaign, d);
  },
});
