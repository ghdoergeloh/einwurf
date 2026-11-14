import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** [lng, lat] */
export const position = v.array(v.number());
/** MultiPolygon-Koordinaten im GeoJSON-Format: Polygone → Ringe → Punkte. */
export const multiPolygon = v.array(v.array(v.array(position)));

export default defineSchema({
  campaigns: defineTable({
    /** Geheimer, zufälliger Schlüssel im Link. Wer ihn kennt, darf alles. */
    slug: v.string(),
    name: v.string(),
    placeLabel: v.string(),
    center: v.object({ lat: v.number(), lng: v.number() }),
    /** [west, süd, ost, nord] des gesuchten Ortes, für den Startausschnitt. */
    bbox: v.optional(v.array(v.number())),
    /** Anzahl markierter Häuser, wird bei jeder Änderung mitgeführt. */
    markCount: v.optional(v.number()),
  }).index("by_slug", ["slug"]),

  marks: defineTable({
    campaignId: v.id("campaigns"),
    /** OSM-Objekt, z. B. "way/123456" oder "relation/987". */
    osmId: v.string(),
    geometry: multiPolygon,
  }).index("by_campaign_osm", ["campaignId", "osmId"]),
});
