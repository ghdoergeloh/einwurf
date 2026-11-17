import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import {
  BOUNDARY_TILE_PATTERN,
  MAX_CANDIDATES,
  areasOfUnit,
  bboxOf,
  boundaryTileBBox,
  boundaryTileOf,
  candidateQuery,
  chooseUnits,
  compactGeometry,
  decodeGeometry,
  encodeCells,
  geometryQuery,
  interiorPoint,
  parseBoundaries,
  parseCandidates,
  pointInGeometry,
  preselect,
  touchedCells,
  unitQuery,
  type ParentCandidate,
} from "./areaGeo";
import { askServers, overpassDetails, startPrefetch, takeOverpassQuota } from "./buildings";
import type { BBox } from "./osm";
import { campaignByKey, requireRole } from "./access";

/**
 * Gebiete (Ortsteile). Das Angebot kommt aus einem gemeinsamen Cache: je Grenz-Kachel (etwa
 * 5 km) die Gemeinden, die sie schneiden, und je Gemeinde ihre Ortsteile (osmAreas). Geladen
 * wird über Overpass, wenn der Admin im Modus „Gebiete bearbeiten“ dorthin schiebt, und beim
 * Anlegen rund um die Adresse. Wählt der Admin einen Ortsteil, kommt eine Kopie in die Aktion
 * (areas); abgewählt bleibt sie mit selected = false stehen.
 */

/** Grenzen ändern sich selten; nach 90 Tagen wird eine Kachel neu geladen. */
const TILE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** So viele Grenz-Kacheln lädt ein Aufruf höchstens (Größe der Antwort, Zeit). */
export const MAX_TILES_PER_LOAD = 4;
/** So viele Kacheln zeigt die Karte im Bearbeiten-Modus höchstens auf einmal an. */
export const MAX_TILES_PER_VIEW = 12;
/** Mehr Gebiete wählt niemand für eine Aktion. */
const MAX_AREAS = 500;
const FAILURE = "Die Ortsteile (OpenStreetMap) sind gerade nicht erreichbar.";
/** Je Overpass-Server so lange warten; die Abfragen der Grenzen sind größer als die der Häuser. */
const AREAS_SERVER_TIMEOUT_MS = 120_000;
/** Gesamtfrist eines Ladevorgangs (eine Convex-Action darf höchstens 10 Minuten laufen). */
const AREAS_DEADLINE_MS = 5 * 60_000;
/** Ein Ortsteil belegt als Text höchstens so viel (gröber vereinfacht, wenn nötig). */
const MAX_AREA_BYTES = 200_000;
/** Beim Anlegen: so oft versuchen, den Ortsteil an der Adresse zu laden. */
const INITIAL_ATTEMPTS = 3;
const INITIAL_RETRY_MS = 30_000;

function assertTiles(tiles: string[], max: number) {
  if (tiles.length > max) throw new ConvexError("Zu viele Kacheln auf einmal");
  for (const t of tiles) if (!BOUNDARY_TILE_PATTERN.test(t)) throw new ConvexError("Ungültige Kachel");
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

/**
 * Die Gebiete einer Aktion samt Auswahl (auch abgewählte), nach Namen sortiert; null ohne
 * Aktion. Jede Rolle. `geometry` ist JSON, `cells` die berührten Gebäude-Kacheln; entpacken mit
 * toAreas aus areaGeo.ts.
 */
export const list = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const campaign = (await campaignByKey(ctx, slug))?.campaign;
    if (!campaign) return null;
    const rows = await ctx.db.query("areas").withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id)).collect();
    return rows
      .map((r) => ({ id: r.areaId, name: r.name, geometry: r.geometry, bbox: r.bbox, labelAt: r.labelAt, cells: r.cells, selected: r.selected }))
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
  },
});

/**
 * Angebot an Ortsteilen in diesen Grenz-Kacheln (aus dem Cache), für den Modus „Gebiete
 * bearbeiten“. Nur mit dem Admin-Schlüssel. `loaded` sind die Kacheln, die schon im Cache sind;
 * die anderen lädt `loadTiles`.
 */
export const nearby = query({
  args: { adminKey: v.string(), tiles: v.array(v.string()) },
  handler: async (ctx, { adminKey, tiles }) => {
    await requireRole(ctx, adminKey, "admin");
    assertTiles(tiles, MAX_TILES_PER_VIEW);
    const loaded: string[] = [];
    const units = new Set<number>();
    for (const tile of tiles) {
      const row = await ctx.db.query("boundaryTiles").withIndex("by_tile", (q) => q.eq("tile", tile)).unique();
      if (!row) continue;
      loaded.push(tile);
      row.unitIds.forEach((u) => units.add(u));
    }
    const areas = [];
    for (const unitId of units)
      for (const a of await ctx.db.query("osmAreas").withIndex("by_unit", (q) => q.eq("unitId", unitId)).collect())
        areas.push({ id: a.areaId, name: a.name, geometry: a.geometry, labelAt: a.labelAt });
    return { loaded, areas };
  },
});

// ---------------------------------------------------------------------------
// Auswählen
// ---------------------------------------------------------------------------

/** Kopiert einen Ortsteil aus dem Cache in die Aktion (oder wählt ihn wieder an). */
async function selectArea(ctx: MutationCtx, campaignId: Id<"campaigns">, areaId: string, selected: boolean) {
  const row = await ctx.db
    .query("areas")
    .withIndex("by_campaign_area", (q) => q.eq("campaignId", campaignId).eq("areaId", areaId))
    .unique();
  if (row) {
    if (row.selected !== selected) await ctx.db.patch(row._id, { selected });
    return;
  }
  if (!selected) return;
  const cached = await ctx.db.query("osmAreas").withIndex("by_area", (q) => q.eq("areaId", areaId)).first();
  if (!cached) throw new ConvexError("Diesen Ortsteil gibt es nicht (mehr). Bitte die Karte neu laden.");
  await ctx.db.insert("areas", {
    campaignId,
    areaId,
    name: cached.name,
    geometry: cached.geometry,
    bbox: cached.bbox,
    labelAt: cached.labelAt,
    cells: cached.cells,
    selected: true,
  });
}

/**
 * Ortsteile an- oder abwählen. Nur mit dem Admin-Schlüssel. Abgewählte bleiben gespeichert
 * (selected = false), Markierungen und Notizen dort ohnehin. Plant das Vorladen neu.
 */
export const select = mutation({
  args: { adminKey: v.string(), ids: v.array(v.string()), selected: v.boolean() },
  handler: async (ctx, { adminKey, ids, selected }) => {
    const { campaign } = await requireRole(ctx, adminKey, "admin");
    if (ids.length > MAX_AREAS) throw new ConvexError("Zu viele Gebiete");
    for (const id of ids) await selectArea(ctx, campaign._id, id, selected);
    const count = (await ctx.db.query("areas").withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id)).collect()).length;
    if (count > MAX_AREAS) throw new ConvexError("Zu viele Gebiete");
    await replanPrefetch(ctx, campaign.slug);
  },
});

/** Läuft oder lief ein Vorladen: neu planen, nur noch Kacheln der gewählten Gebiete (Cache-Treffer kosten nichts). */
async function replanPrefetch(ctx: MutationCtx, slug: string) {
  const job = await ctx.db.query("prefetchJobs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
  if (job) await startPrefetch(ctx, slug, { replan: true });
}

// ---------------------------------------------------------------------------
// Laden (Overpass → Cache)
// ---------------------------------------------------------------------------

/** Bearbeiten-Schlüssel zum Admin-Schlüssel (für das Kontingent), sonst Fehler. */
export const adminSlug = internalQuery({
  args: { adminKey: v.string() },
  handler: async (ctx, { adminKey }) => (await requireRole(ctx, adminKey, "admin")).campaign.slug,
});

export const tileStatus = internalQuery({
  args: { tiles: v.array(v.string()) },
  handler: async (ctx, { tiles }) => {
    const now = Date.now();
    const missing: string[] = [];
    for (const tile of tiles) {
      const row = await ctx.db.query("boundaryTiles").withIndex("by_tile", (q) => q.eq("tile", tile)).unique();
      if (!row || now - row.fetchedAt > TILE_TTL_MS) missing.push(tile);
    }
    return missing;
  },
});

export const knownUnits = internalQuery({
  args: { unitIds: v.array(v.number()) },
  handler: async (ctx, { unitIds }) => {
    const now = Date.now();
    const known: number[] = [];
    for (const unitId of unitIds) {
      const a = await ctx.db.query("osmAreas").withIndex("by_unit", (q) => q.eq("unitId", unitId)).first();
      if (a && now - a.fetchedAt < TILE_TTL_MS) known.push(unitId);
    }
    return known;
  },
});

export const quota = internalMutation({
  args: { slug: v.string() },
  // Eigenes Kontingent je Aktion („…:gebiete“), damit Helfer auf der Karte nicht warten.
  handler: async (ctx, { slug }) => await takeOverpassQuota(ctx, `${slug}:gebiete`, "map"),
});

const osmAreaArg = v.object({
  areaId: v.string(),
  name: v.string(),
  geometry: v.string(),
  bbox: v.array(v.number()),
  labelAt: v.array(v.number()),
  cells: v.string(),
});

/** Ortsteile einer Gemeinde in den Cache (ersetzt ältere). */
export const storeUnit = internalMutation({
  args: { unitId: v.number(), areas: v.array(osmAreaArg) },
  handler: async (ctx, { unitId, areas }) => {
    for (const old of await ctx.db.query("osmAreas").withIndex("by_unit", (q) => q.eq("unitId", unitId)).collect()) {
      await ctx.db.delete(old._id);
    }
    const fetchedAt = Date.now();
    for (const a of areas) await ctx.db.insert("osmAreas", { unitId, fetchedAt, ...a });
  },
});

export const storeTiles = internalMutation({
  args: { tiles: v.array(v.object({ tile: v.string(), unitIds: v.array(v.number()) })) },
  handler: async (ctx, { tiles }) => {
    const fetchedAt = Date.now();
    for (const { tile, unitIds } of tiles) {
      const row = await ctx.db.query("boundaryTiles").withIndex("by_tile", (q) => q.eq("tile", tile)).unique();
      if (row) await ctx.db.patch(row._id, { unitIds, fetchedAt });
      else await ctx.db.insert("boundaryTiles", { tile, unitIds, fetchedAt });
    }
  },
});

const intersects = (a: BBox, b: BBox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const union = (boxes: BBox[]): BBox => [
  Math.min(...boxes.map((b) => b[0])),
  Math.min(...boxes.map((b) => b[1])),
  Math.max(...boxes.map((b) => b[2])),
  Math.max(...boxes.map((b) => b[3])),
];

/**
 * Lädt fehlende Grenz-Kacheln in den Cache: (1) die Gemeinden, die sie schneiden, (2) für neue
 * Gemeinden die Liste feinerer Grenzen in ihrer Ausdehnung, (3) die Grenzen der Gemeinden und
 * ihrer Kandidaten. Je Gemeinde werden die Ortsteile gewählt (areaGeo.areasOfUnit).
 * Höchstens drei Overpass-Abrufe, alle ohne Geometrie bis auf den letzten.
 */
async function loadBoundaryTiles(ctx: ActionCtx, rateKey: string, tiles: string[]) {
  const missing = await ctx.runQuery(internal.areas.tileStatus, { tiles });
  if (missing.length === 0) return;
  const deadline = Date.now() + AREAS_DEADLINE_MS;
  const ask = async <T,>(step: string, q: string, parse: (json: never) => T) => {
    await ctx.runMutation(internal.areas.quota, { slug: rateKey });
    try {
      return await askServers(q, parse, { lockedUntil: deadline, failure: FAILURE, timeoutMs: AREAS_SERVER_TIMEOUT_MS });
    } catch (e) {
      throw new ConvexError(`${FAILURE} ${step}: ${overpassDetails(e)}`.slice(0, 600));
    }
  };

  const tileBoxes = missing.map(boundaryTileBBox);
  const units = chooseUnits(await ask("Gemeinden", unitQuery(union(tileBoxes)), parseCandidates));
  const known = new Set(await ctx.runQuery(internal.areas.knownUnits, { unitIds: units.map((u) => u.id) }));
  const fresh = units.filter((u) => !known.has(u.id));

  if (fresh.length > 0) {
    const candidates = await ask(
      "Ortsteile (Liste)",
      candidateQuery(Math.min(...fresh.map((u) => u.level)), union(fresh.map((u) => u.bbox))),
      parseCandidates,
    );
    const perUnit = new Map<number, ParentCandidate[]>(fresh.map((u) => [u.id, preselect(u, candidates)]));
    const ids = [...new Set([...fresh.map((u) => u.id), ...[...perUnit.values()].flat().map((c) => c.id)])].slice(0, MAX_CANDIDATES);
    const boundaries = await ask("Ortsteile (Grenzen)", geometryQuery(ids), parseBoundaries);
    for (const unit of fresh) {
      const own = boundaries.find((b) => b.id === unit.id);
      if (!own) continue;
      const mine = new Set(perUnit.get(unit.id)!.map((c) => c.id));
      const parts = areasOfUnit(own, boundaries.filter((b) => mine.has(b.id)));
      const rows = parts.map((p) => {
        const geometry = compactGeometry(p.geometry, MAX_AREA_BYTES);
        const g = decodeGeometry(geometry);
        return { areaId: `relation/${p.id}`, name: p.name, geometry, bbox: bboxOf(g), labelAt: interiorPoint(g), cells: encodeCells(touchedCells(g)) };
      });
      await ctx.runMutation(internal.areas.storeUnit, { unitId: unit.id, areas: rows });
    }
  }
  await ctx.runMutation(internal.areas.storeTiles, {
    tiles: missing.map((tile, i) => ({ tile, unitIds: units.filter((u) => intersects(u.bbox, tileBoxes[i])).map((u) => u.id) })),
  });
}

/**
 * Lädt das Angebot an Ortsteilen für diese Grenz-Kacheln (Modus „Gebiete bearbeiten“). Nur mit
 * dem Admin-Schlüssel. Wirft bei Überlastung von Overpass mit der Antwort der Server.
 */
export const loadTiles = action({
  args: { adminKey: v.string(), tiles: v.array(v.string()) },
  handler: async (ctx, { adminKey, tiles }): Promise<void> => {
    assertTiles(tiles, MAX_TILES_PER_LOAD);
    const slug = await ctx.runQuery(internal.areas.adminSlug, { adminKey });
    await loadBoundaryTiles(ctx, slug, tiles);
  },
});

// ---------------------------------------------------------------------------
// Beim Anlegen: Ortsteil an der Adresse wählen
// ---------------------------------------------------------------------------

/** Startet das Laden rund um die Adresse (aus campaigns.create). */
export async function startInitialAreas(ctx: MutationCtx, campaignId: Id<"campaigns">) {
  await ctx.scheduler.runAfter(0, internal.areas.initial, { campaignId, attempt: 1 });
}

export const initialInfo = internalQuery({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, { campaignId }) => {
    const campaign = await ctx.db.get(campaignId);
    if (!campaign) return null;
    const any = await ctx.db.query("areas").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).first();
    return { slug: campaign.slug, center: campaign.center, hasAreas: !!any };
  },
});

/** Wählt den Ortsteil, in dem der Punkt liegt, falls die Aktion noch keine Gebiete hat. */
export const selectAt = internalMutation({
  args: { campaignId: v.id("campaigns"), point: v.array(v.number()) },
  handler: async (ctx, { campaignId, point }) => {
    if (await ctx.db.query("areas").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).first()) return;
    const tile = await ctx.db.query("boundaryTiles").withIndex("by_tile", (q) => q.eq("tile", boundaryTileOf(point[0], point[1]))).unique();
    for (const unitId of tile?.unitIds ?? [])
      for (const a of await ctx.db.query("osmAreas").withIndex("by_unit", (q) => q.eq("unitId", unitId)).collect()) {
        if (pointInGeometry(point, decodeGeometry(a.geometry))) {
          await selectArea(ctx, campaignId, a.areaId, true);
          const campaign = await ctx.db.get(campaignId);
          if (campaign) await replanPrefetch(ctx, campaign.slug);
          return;
        }
      }
  },
});

export const initial = internalAction({
  args: { campaignId: v.id("campaigns"), attempt: v.number() },
  handler: async (ctx, { campaignId, attempt }) => {
    const info = await ctx.runQuery(internal.areas.initialInfo, { campaignId });
    if (!info || info.hasAreas) return;
    const point = [info.center.lng, info.center.lat];
    try {
      await loadBoundaryTiles(ctx, info.slug, [boundaryTileOf(point[0], point[1])]);
      await ctx.runMutation(internal.areas.selectAt, { campaignId, point });
    } catch (e) {
      console.warn("Gebiete: Laden an der Adresse fehlgeschlagen", e instanceof Error ? e.message : String(e));
      // Nicht schlimm: Im Modus „Gebiete bearbeiten“ lädt die Karte selbst nach.
      if (attempt < INITIAL_ATTEMPTS) await ctx.scheduler.runAfter(INITIAL_RETRY_MS * attempt, internal.areas.initial, { campaignId, attempt: attempt + 1 });
    }
  },
});

/** Täglich: alte Grenz-Kacheln und Ortsteile aus dem Cache löschen (siehe crons.ts). */
export const cleanup = internalMutation({
  args: {},
  handler: async (ctx: MutationCtx) => {
    const cutoff = Date.now() - TILE_TTL_MS;
    for (const t of await ctx.db.query("boundaryTiles").withIndex("by_fetchedAt", (q) => q.lt("fetchedAt", cutoff)).take(200)) await ctx.db.delete(t._id);
    for (const a of await ctx.db.query("osmAreas").withIndex("by_fetchedAt", (q) => q.lt("fetchedAt", cutoff)).take(200)) await ctx.db.delete(a._id);
  },
});

