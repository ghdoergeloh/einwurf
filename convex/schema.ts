import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  campaigns: defineTable({
    /** Geheimer, zufälliger Schlüssel im Link. Wer ihn kennt, darf alles. */
    slug: v.string(),
    name: v.string(),
    placeLabel: v.string(),
    center: v.object({ lat: v.number(), lng: v.number() }),
    /** [west, süd, ost, nord] des gesuchten Ortes, für den Startausschnitt. */
    bbox: v.optional(v.array(v.number())),
    /** Anzahl Häuser mit Flyer („done“), wird bei jeder Änderung mitgeführt. */
    markCount: v.optional(v.number()),
    /** Anzahl Häuser, bei denen Einwerfen nicht möglich war („blocked“). */
    blockedCount: v.optional(v.number()),
  })
    .index("by_slug", ["slug"]),

  marks: defineTable({
    campaignId: v.id("campaigns"),
    /** OSM-Objekt, z. B. "way/123456" oder "relation/987". */
    osmId: v.string(),
    /** Mittelpunkt des Hauses [lng, lat]; der Umriss kommt im Browser von Overpass. */
    center: v.array(v.number()),
    /** Rasterzelle des Mittelpunkts, siehe cells.ts. */
    cell: v.string(),
    /** Zustand, siehe status.ts. Fehlt bei älteren Markierungen und heißt dann „done“. */
    status: v.optional(v.union(v.literal("done"), v.literal("blocked"))),
  })
    .index("by_campaign_osm", ["campaignId", "osmId"])
    .index("by_campaign_cell", ["campaignId", "cell"]),

  /** Gemeinsamer Cache der OSM-Gebäude je Kachel (convex/osm.ts), für alle Aktionen. */
  buildingCells: defineTable({
    /** Kachel "x:y" in Schritten von CELL_SIZE. */
    cell: v.string(),
    fetchedAt: v.number(),
    /** Häuser, deren Mittelpunkt in der Kachel liegt; Format siehe encodeBuildings. */
    data: v.string(),
  })
    .index("by_cell", ["cell"])
    .index("by_fetchedAt", ["fetchedAt"]),

  /** Kachel wird gerade von einem Aufruf geladen; andere warten auf den Cache. */
  cellLocks: defineTable({ cell: v.string(), until: v.number() }).index("by_cell", ["cell"]),

  /** Protokoll der Overpass-Abrufe für die Begrenzung pro Minute. */
  overpassFetches: defineTable({ slug: v.string(), at: v.number() })
    .index("by_at", ["at"])
    .index("by_slug_at", ["slug", "at"]),
});
