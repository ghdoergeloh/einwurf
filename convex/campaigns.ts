import { mutation, query } from "./_generated/server";
import { startPrefetch } from "./buildings";
import { startInitialAreas } from "./areas";
import { campaignByKey, requireRole, keyTaken } from "./access";
import { ConvexError, v } from "convex/values";
import {
  MAX_CAMPAIGNS_PER_MINUTE,
  MAX_NAME_LENGTH,
  MAX_PLACE_LENGTH,
  assertLatLng,
  assertSlug,
  cleanText,
} from "./validation";

function assertBBox(bbox: number[]) {
  if (bbox.length !== 4) throw new ConvexError("Ungültiger Ausschnitt");
  const [w, s, e, n] = bbox;
  assertLatLng(s, w);
  assertLatLng(n, e);
  if (!(w < e && s < n)) throw new ConvexError("Ungültiger Ausschnitt");
}

/**
 * Legt eine Verteilaktion an. Die geheimen Schlüssel erzeugt der Browser mit
 * crypto.getRandomValues (Zufall in Convex-Mutationen ist deterministisch).
 * `viewKey` und `adminKey` fehlen nur bei noch geöffneten alten Seiten.
 */
export const create = mutation({
  args: {
    slug: v.string(),
    viewKey: v.optional(v.string()),
    adminKey: v.optional(v.string()),
    name: v.string(),
    placeLabel: v.string(),
    center: v.object({ lat: v.number(), lng: v.number() }),
    bbox: v.optional(v.array(v.number())),
  },
  handler: async (ctx, args) => {
    assertSlug(args.slug);
    assertLatLng(args.center.lat, args.center.lng);
    if (args.bbox) assertBBox(args.bbox);
    if (await keyTaken(ctx, args.slug)) throw new ConvexError("Link existiert bereits");
    if (args.viewKey !== undefined) {
      assertSlug(args.viewKey);
      if (args.viewKey === args.slug || (await keyTaken(ctx, args.viewKey))) {
        throw new ConvexError("Link existiert bereits");
      }
    }
    if (args.adminKey !== undefined) {
      assertSlug(args.adminKey);
      if (args.adminKey === args.slug || args.adminKey === args.viewKey || (await keyTaken(ctx, args.adminKey))) {
        throw new ConvexError("Link existiert bereits");
      }
    }

    // Einfache Bremse gegen Skripte, die massenhaft Aktionen anlegen.
    const recent = await ctx.db.query("campaigns").order("desc").take(MAX_CAMPAIGNS_PER_MINUTE);
    const oldest = recent[MAX_CAMPAIGNS_PER_MINUTE - 1];
    if (oldest && Date.now() - oldest._creationTime < 60_000) {
      throw new ConvexError("Gerade werden sehr viele Aktionen angelegt. Bitte in einer Minute noch einmal versuchen.");
    }

    const campaignId = await ctx.db.insert("campaigns", {
      slug: args.slug,
      viewKey: args.viewKey,
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
    // Ortsteile rund um die Adresse laden und den an der Adresse wählen (Admin wählt weitere dazu).
    if (process.env.AREAS_ON_CREATE !== "off") await startInitialAreas(ctx, campaignId);
    return args.slug;
  },
});

/**
 * Liefert die Aktion zum Schlüssel (jede Rolle) samt `role`, oder null.
 * Mit dem Ansehen-Schlüssel ohne `slug` und `viewKey`: Aus dem Ansehen-Link darf sich der
 * Bearbeiten-Link nicht erfahren lassen. Den Admin-Schlüssel liefert die Query nie (wer ihn
 * hat, kennt ihn). Es gibt bewusst keine Liste aller Aktionen.
 */
export const get = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const found = await campaignByKey(ctx, slug);
    if (!found) return null;
    const { campaign, role } = found;
    const shared = {
      name: campaign.name,
      placeLabel: campaign.placeLabel,
      center: campaign.center,
      bbox: campaign.bbox ?? null,
      markCount: campaign.markCount ?? 0,
      blockedCount: campaign.blockedCount ?? 0,
      createdAt: campaign._creationTime,
    };
    if (role === "view") return { role, ...shared };
    return { role, slug: campaign.slug, viewKey: campaign.viewKey ?? null, ...shared };
  },
});

/**
 * Gibt einer älteren Aktion ihren Ansehen-Schlüssel (Teilen-Dialog, ab Rolle edit).
 * Hat sie schon einen, bleibt er; zurück kommt der gültige Schlüssel.
 */
export const ensureViewKey = mutation({
  args: { slug: v.string(), viewKey: v.string() },
  handler: async (ctx, { slug, viewKey }) => {
    const { campaign } = await requireRole(ctx, slug, "edit");
    if (campaign.viewKey) return campaign.viewKey;
    assertSlug(viewKey);
    if (await keyTaken(ctx, viewKey)) throw new ConvexError("Link existiert bereits");
    await ctx.db.patch(campaign._id, { viewKey });
    return viewKey;
  },
});

/**
 * Mittelpunkt der Aktion (Adresse) ändern, z. B. nach einem Umzug des Treffpunkts. Nur mit dem
 * Admin-Schlüssel. Ändert Startausschnitt und Vorladen ohne gewählte Gebiete, nicht die Gebiete.
 */
export const setPlace = mutation({
  args: {
    adminKey: v.string(),
    placeLabel: v.string(),
    center: v.object({ lat: v.number(), lng: v.number() }),
    bbox: v.optional(v.array(v.number())),
  },
  handler: async (ctx, { adminKey, placeLabel, center, bbox }) => {
    const { campaign } = await requireRole(ctx, adminKey, "admin");
    assertLatLng(center.lat, center.lng);
    if (bbox) assertBBox(bbox);
    await ctx.db.patch(campaign._id, { placeLabel: cleanText(placeLabel, MAX_PLACE_LENGTH, "Ort"), center, bbox });
    // Ohne gewählte Gebiete richtet sich das Vorladen nach dem Mittelpunkt: neu planen.
    const job = await ctx.db.query("prefetchJobs").withIndex("by_slug", (q) => q.eq("slug", campaign.slug)).unique();
    if (job) await startPrefetch(ctx, campaign.slug, { replan: true });
  },
});
