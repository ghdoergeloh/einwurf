import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import {
  MAX_CAMPAIGNS_PER_MINUTE,
  MAX_NAME_LENGTH,
  MAX_PLACE_LENGTH,
  SLUG_PATTERN,
  assertLatLng,
  assertSlug,
  cleanText,
} from "./validation";

/**
 * Legt eine Verteilaktion an. Den geheimen Schlüssel erzeugt der Browser mit
 * crypto.getRandomValues (Zufall in Convex-Mutationen ist deterministisch).
 */
export const create = mutation({
  args: {
    slug: v.string(),
    name: v.string(),
    placeLabel: v.string(),
    center: v.object({ lat: v.number(), lng: v.number() }),
    bbox: v.optional(v.array(v.number())),
  },
  handler: async (ctx, args) => {
    assertSlug(args.slug);
    assertLatLng(args.center.lat, args.center.lng);
    if (args.bbox) {
      const [w, s, e, n] = args.bbox;
      if (args.bbox.length !== 4) throw new ConvexError("Ungültiger Ausschnitt");
      assertLatLng(s, w);
      assertLatLng(n, e);
    }
    const existing = await ctx.db
      .query("campaigns")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (existing) throw new ConvexError("Link existiert bereits");

    // Einfache Bremse gegen Skripte, die massenhaft Aktionen anlegen.
    const recent = await ctx.db.query("campaigns").order("desc").take(MAX_CAMPAIGNS_PER_MINUTE);
    const oldest = recent[MAX_CAMPAIGNS_PER_MINUTE - 1];
    if (oldest && Date.now() - oldest._creationTime < 60_000) {
      throw new ConvexError("Gerade werden sehr viele Aktionen angelegt. Bitte in einer Minute noch einmal versuchen.");
    }

    await ctx.db.insert("campaigns", {
      slug: args.slug,
      name: cleanText(args.name, MAX_NAME_LENGTH, "Name"),
      placeLabel: cleanText(args.placeLabel, MAX_PLACE_LENGTH, "Ort"),
      center: args.center,
      bbox: args.bbox,
      markCount: 0,
      blockedCount: 0,
    });
    return args.slug;
  },
});

/** Liefert die Aktion zum Schlüssel oder null. Es gibt bewusst keine Liste aller Aktionen. */
export const get = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    if (!SLUG_PATTERN.test(slug)) return null;
    const campaign = await ctx.db
      .query("campaigns")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!campaign) return null;
    return {
      slug: campaign.slug,
      name: campaign.name,
      placeLabel: campaign.placeLabel,
      center: campaign.center,
      bbox: campaign.bbox ?? null,
      markCount: campaign.markCount ?? 0,
      blockedCount: campaign.blockedCount ?? 0,
      createdAt: campaign._creationTime,
    };
  },
});
