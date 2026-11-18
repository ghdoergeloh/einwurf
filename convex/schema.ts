import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  campaigns: defineTable({
    /** Geheimer, zufälliger Bearbeiten-Schlüssel im Link `/v/…`. Erlaubt alles außer der Gebietsauswahl (admin). */
    slug: v.string(),
    /**
     * Geheimer, zufälliger Ansehen-Schlüssel im Link `/a/…`, unabhängig vom slug (siehe access.ts).
     * Fehlt bei älteren Aktionen, bis jemand mit Bearbeiten-Link den Teilen-Dialog öffnet.
     */
    viewKey: v.optional(v.string()),
    /**
     * Geheimer Admin-Schlüssel (Gebietsauswahl, siehe #2 und access.ts). Wird über den
     * Bearbeiten- und den Ansehen-Link nie herausgegeben. Pflicht für jede Aktion.
     */
    adminKey: v.string(),
    name: v.string(),
    placeLabel: v.string(),
    center: v.object({ lat: v.number(), lng: v.number() }),
    /** [west, süd, ost, nord] des gesuchten Ortes, für den Startausschnitt. */
    bbox: v.optional(v.array(v.number())),
    /** Veraltet: Zähler stehen jetzt in campaignCounts (siehe counters.ts); gilt nur, bis dort eine Zeile ist. */
    markCount: v.optional(v.number()),
    /** Anzahl Häuser, bei denen Einwerfen nicht möglich war („blocked“). */
    blockedCount: v.optional(v.number()),
    /** Anzahl Notizen an Häusern, für die Obergrenze MAX_NOTES_PER_CAMPAIGN. */
    noteCount: v.optional(v.number()),
  })
    .index("by_slug", ["slug"])
    .index("by_viewKey", ["viewKey"])
    .index("by_adminKey", ["adminKey"]),

  /** Zähler einer Aktion, getrennt vom Datensatz der Aktion (siehe counters.ts). */
  campaignCounts: defineTable({
    campaignId: v.id("campaigns"),
    done: v.number(),
    blocked: v.number(),
    notes: v.number(),
  }).index("by_campaign", ["campaignId"]),

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
    /** statsJobs.run, zu dem `area` bestimmt und mitgezählt wurde (convex/stats.ts). */
    areaRun: v.optional(v.number()),
  })
    .index("by_campaign_osm", ["campaignId", "osmId"])
    .index("by_campaign_cell", ["campaignId", "cell"]),

  /**
   * Gebiete (Ortsteile) einer Aktion: Kopie aus dem Cache (osmAreas), sobald der Admin sie wählt.
   * Abgewählte bleiben mit selected = false stehen; Markierungen dort bleiben ohnehin erhalten.
   */
  areas: defineTable({
    campaignId: v.id("campaigns"),
    /** OSM-Relation, z. B. „relation/2804866“. */
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
    /** Fehlt nur bei Vorabständen aus PR #7 und heißt dann „gewählt“ (siehe areaStore.isSelected). */
    selected: v.optional(v.boolean()),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_campaign_area", ["campaignId", "areaId"]),

  /**
   * Cache der Ortsteile aus OSM (convex/areas.ts). Ohne campaignId gemeinsam für alle Aktionen
   * (von Convex selbst bei Overpass geladen); mit campaignId nur für diese Aktion (vom Browser
   * ihres Admins geladen und geschickt, deshalb nicht für andere vertrauenswürdig).
   */
  osmAreas: defineTable({
    campaignId: v.optional(v.id("campaigns")),
    areaId: v.string(),
    /** OSM-Relation der Gemeinde, zu der der Ortsteil gehört. */
    unitId: v.number(),
    name: v.string(),
    geometry: v.string(),
    bbox: v.array(v.number()),
    labelAt: v.array(v.number()),
    cells: v.string(),
    fetchedAt: v.number(),
  })
    .index("by_scope_area", ["campaignId", "areaId"])
    .index("by_scope_unit", ["campaignId", "unitId"])
    .index("by_fetchedAt", ["fetchedAt"]),

  /** Cache: welche Gemeinden eine Grenz-Kachel (areaGeo.BOUNDARY_TILE) schneiden; campaignId wie bei osmAreas. */
  boundaryTiles: defineTable({
    campaignId: v.optional(v.id("campaigns")),
    tile: v.string(),
    unitIds: v.array(v.number()),
    fetchedAt: v.number(),
  })
    .index("by_scope_tile", ["campaignId", "tile"])
    .index("by_fetchedAt", ["fetchedAt"]),

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
    /** statsJobs.run, zu dem diese Zeile gehört. */
    run: v.number(),
    /** Gewählt beim Anlegen der Zeile (Auswahl ändern beginnt einen neuen Lauf); fehlt bei älteren Ständen. */
    selected: v.optional(v.boolean()),
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
    /** Laufnummer: steigt, wenn sich Gebiete oder Auswahl ändern (dann wird neu zugeordnet). */
    run: v.number(),
    /** Gebiete samt Auswahl, für die die Zeilen angelegt sind (stats.keyOf); fehlt bei älteren Ständen. */
    areaKey: v.optional(v.string()),
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

  /** Notiz eines Helfers an einem Haus (convex/notes.ts); das Haus erscheint dann blau. */
  notes: defineTable({
    campaignId: v.id("campaigns"),
    /** OSM-Objekt wie bei marks. */
    osmId: v.string(),
    /** Mittelpunkt des Hauses [lng, lat]. */
    center: v.array(v.number()),
    /** Rasterzelle des Mittelpunkts, siehe cells.ts; abonniert wird je Zelle wie bei marks. */
    cell: v.string(),
    text: v.string(),
    updatedAt: v.number(),
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
