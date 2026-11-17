import { mutation, query } from "./_generated/server";
import { startPrefetch } from "./buildings";
import { startAreas } from "./areas";
import { campaignForRead, keyTaken } from "./access";
import { ConvexError, v } from "convex/values";
import {
  MAX_CAMPAIGNS_PER_MINUTE,
  MAX_NAME_LENGTH,
  MAX_PLACE_LENGTH,
  assertLatLng,
  assertSlug,
  cleanText,
} from "./validation";

/**
 * Legt eine Verteilaktion an. Die geheimen Schlüssel erzeugt der Browser mit
 * crypto.getRandomValues (Zufall in Convex-Mutationen ist deterministisch).
 * `adminKey` fehlt nur bei noch geöffneten alten Seiten.
 */
export const create = mutation({
  args: {
    slug: v.string(),
    adminKey: v.optional(v.string()),
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
      if (!(w < e && s < n)) throw new ConvexError("Ungültiger Ausschnitt");
    }
    if (await keyTaken(ctx, args.slug)) throw new ConvexError("Link existiert bereits");
    if (args.adminKey !== undefined) {
      assertSlug(args.adminKey);
      if (args.adminKey === args.slug || (await keyTaken(ctx, args.adminKey))) throw new ConvexError("Link existiert bereits");
    }

    // Einfache Bremse gegen Skripte, die massenhaft Aktionen anlegen.
    const recent = await ctx.db.query("campaigns").order("desc").take(MAX_CAMPAIGNS_PER_MINUTE);
    const oldest = recent[MAX_CAMPAIGNS_PER_MINUTE - 1];
    if (oldest && Date.now() - oldest._creationTime < 60_000) {
      throw new ConvexError("Gerade werden sehr viele Aktionen angelegt. Bitte in einer Minute noch einmal versuchen.");
    }

    const campaignId = await ctx.db.insert("campaigns", {
      slug: args.slug,
      adminKey: args.adminKey,
      name: cleanText(args.name, MAX_NAME_LENGTH, "Name"),
      placeLabel: cleanText(args.placeLabel, MAX_PLACE_LENGTH, "Ort"),
      center: args.center,
      bbox: args.bbox,
      markCount: 0,
      blockedCount: 0,
    });
    // Häuser des Ortes im Hintergrund vorladen, damit die Helfer nicht warten.
    // (In Unit-Tests aus, siehe vite.config.ts; dort wird es gezielt geprüft.)
    if (process.env.PREFETCH_ON_CREATE !== "off") await startPrefetch(ctx, args.slug);
    // Ortsteile im Hintergrund laden, damit der Anleger sie gleich auswählen kann.
    if (process.env.AREAS_ON_CREATE !== "off") await startAreas(ctx, campaignId);
    return args.slug;
  },
});

/**
 * Liefert die Aktion zum Bearbeiten- oder Admin-Schlüssel, oder null. `slug` ist der
 * Bearbeiten-Schlüssel (für die Admin-Seite: zum Markieren und Weitergeben). Den
 * Admin-Schlüssel gibt diese Query nie heraus. Es gibt bewusst keine Liste aller Aktionen.
 */
export const get = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const found = await campaignForRead(ctx, slug);
    if (!found) return null;
    const { campaign, access } = found;
    return {
      access,
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
