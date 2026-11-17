import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  campaigns: defineTable({
    /** Geheimer, zufälliger Schlüssel im Link. Wer ihn kennt, darf alles. */
    slug: v.string(),
    /**
     * Geheimer Schlüssel des Admin-Links (/admin/…): nur er ändert die Gebietsauswahl.
     * Keine Query gibt ihn heraus. Fehlt bei älteren Aktionen bis zur Migration (convex/migrations.ts).
     */
    adminKey: v.optional(v.string()),
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
    .index("by_slug", ["slug"])
    .index("by_adminKey", ["adminKey"]),

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
    /** Gebiet (areaId) für die Statistik, "" = in keinem Gebiet; gilt nur, wenn areaRun zum Laden der Gebiete passt. */
    area: v.optional(v.string()),
    /** areaSets.run, zu dem `area` bestimmt und mitgezählt wurde (convex/stats.ts). */
    areaRun: v.optional(v.number()),
  })
    .index("by_campaign_osm", ["campaignId", "osmId"])
    .index("by_campaign_cell", ["campaignId", "cell"]),

  /**
   * Gebiete (Ortsteile) einer Aktion aus OSM, mit vereinfachter Grenze (convex/areas.ts).
   * Ändern sich nach dem Laden nicht; die Auswahl steht in areaSets.
   */
  areas: defineTable({
    campaignId: v.id("campaigns"),
    /** „relation/123“ oder „ort“ (ganzer Ort, wenn OSM ihn nicht unterteilt). */
    areaId: v.string(),
    name: v.string(),
    /** MultiPolygon-Koordinaten [lng, lat] als JSON (siehe areaGeo.ts). */
    geometry: v.string(),
    /** [west, süd, ost, nord] */
    bbox: v.array(v.number()),
    /** Punkt im Gebiet für die Beschriftung [lng, lat]. */
    labelAt: v.array(v.number()),
    /** Gebäude-Kacheln, die das Gebiet berühren, durch Leerzeichen getrennt (areaGeo.touchedCells). */
    cells: v.string(),
  }).index("by_campaign", ["campaignId"]),

  /** Ladezustand und Auswahl der Gebiete je Aktion. */
  areaSets: defineTable({
    campaignId: v.id("campaigns"),
    status: v.union(v.literal("loading"), v.literal("done"), v.literal("failed")),
    /** OSM unterteilt den Ort nicht: Er ist ein einziges Gebiet. */
    whole: v.optional(v.boolean()),
    /** Nicht ausgewählte Gebiete (areaId). Neue Aktionen: alle ausgewählt. */
    unselected: v.array(v.string()),
    failures: v.number(),
    updatedAt: v.number(),
    /** Laufnummer; ein älterer Ladevorgang speichert nichts mehr. */
    run: v.number(),
  }).index("by_campaign", ["campaignId"]),

  /**
   * Statistik je Gebiet (convex/stats.ts): eine Zeile je Gebiet, beim Laden der Gebiete neu angelegt.
   * Markierungen werden beim Setzen mitgezählt, Häuser im Hintergrund aus dem Gebäude-Cache gezählt.
   */
  areaStats: defineTable({
    campaignId: v.id("campaigns"),
    areaId: v.string(),
    name: v.string(),
    /** Das Gebiet in `areas` (Grenze für die Zuordnung). */
    areaDoc: v.id("areas"),
    bbox: v.array(v.number()),
    /** areaSets.run, zu dem diese Zeile gehört. */
    run: v.number(),
    done: v.number(),
    blocked: v.number(),
    /** Häuser mit Mittelpunkt im Gebiet, aus dem Gebäude-Cache; fehlt, bis einmal gezählt wurde. */
    houses: v.optional(v.number()),
    /** Kacheln des Gebiets, die beim Zählen im Cache waren, und alle Kacheln des Gebiets. */
    cellsCounted: v.number(),
    cellsTotal: v.number(),
    /** Zwischenstand der laufenden Zählung (statsJobs.seq). */
    countSeq: v.optional(v.number()),
    housesNext: v.optional(v.number()),
    cellsNext: v.optional(v.number()),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_campaign_area", ["campaignId", "areaId"]),

  /** Hintergrund-Zählungen der Statistik je Aktion: Markierungen zuordnen, Häuser zählen. */
  statsJobs: defineTable({
    campaignId: v.id("campaigns"),
    /** areaSets.run, für den gezählt wird. */
    run: v.number(),
    /** Zuordnen älterer Markierungen: Cursor der Seite, null = fertig. */
    marksCursor: v.union(v.string(), v.null()),
    marksDone: v.boolean(),
    /** Häuser zählen: Laufnummer und noch offene Kacheln (durch Leerzeichen getrennt). */
    seq: v.number(),
    cells: v.string(),
    /** Gebiete, deren Häuser gezählt werden (areaId, durch Leerzeichen getrennt). */
    targets: v.string(),
    countedAt: v.number(),
  }).index("by_campaign", ["campaignId"]),

  /** Gemeinsamer Cache der OSM-Gebäude je Kachel (convex/osm.ts), für alle Aktionen. */
  buildingCells: defineTable({
    /** Kachel "x:y" in Schritten von CELL_SIZE. */
    cell: v.string(),
    fetchedAt: v.number(),
    /** Häuser, deren Mittelpunkt in der Kachel liegt; Format siehe encodeBuildings. */
    data: v.string(),
    /** BUILDINGS_FORMAT beim Speichern; fehlt bei Einträgen ohne Hausnummern. */
    format: v.optional(v.number()),
  })
    .index("by_cell", ["cell"])
    .index("by_fetchedAt", ["fetchedAt"]),

  /** Kachel wird gerade von einem Aufruf geladen; andere warten auf den Cache. */
  cellLocks: defineTable({ cell: v.string(), until: v.number() }).index("by_cell", ["cell"]),

  /** Vorladen der Häuser eines Gebiets je Aktion (convex/buildings.ts), mit Fortschritt. */
  prefetchJobs: defineTable({
    slug: v.string(),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
    /** Noch zu ladende Blöcke von Kacheln, der nächste zuerst. */
    batches: v.array(v.array(v.string())),
    total: v.number(),
    done: v.number(),
    failures: v.number(),
    updatedAt: v.number(),
    /** Laufnummer; Schritte einer älteren Kette werden ignoriert. */
    run: v.optional(v.number()),
  }).index("by_slug", ["slug"]),

  /** Protokoll der Overpass-Abrufe für die Begrenzung pro Minute. */
  overpassFetches: defineTable({
    slug: v.string(),
    at: v.number(),
    /** „map“ (Karte, Standard) oder „prefetch“ (Vorladen); getrennte Gesamtkontingente. */
    kind: v.optional(v.union(v.literal("map"), v.literal("prefetch"))),
  })
    .index("by_at", ["at"])
    .index("by_slug_at", ["slug", "at"]),
});
