import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import {
  BOUNDARY_TILE_PATTERN,
  MAX_TILES_PER_LOAD,
  MAX_TILES_PER_VIEW,
  boundaryTileOf,
  decodeGeometry,
  pointInGeometry,
  type AreaGeometry,
} from "./areaGeo";
import { MAX_AREA_BYTES, areaRow, computeTiles, type Ask } from "./areaLoad";
import { askServers, overpassDetails, startPrefetch, takeOverpassQuota } from "./buildings";
import { campaignByKey, requireRole } from "./access";
import { isSelected } from "./areaStore";

/**
 * Gebiete (Ortsteile). Das Angebot kommt aus einem gemeinsamen Cache: je Grenz-Kachel (etwa
 * 5 km) die Gemeinden, die sie schneiden, und je Gemeinde ihre Ortsteile (osmAreas). Geladen
 * wird über Overpass, wenn der Admin im Modus „Gebiete bearbeiten“ dorthin schiebt, und beim
 * Anlegen rund um die Adresse. Wählt der Admin einen Ortsteil, kommt eine Kopie in die Aktion
 * (areas); abgewählt bleibt sie mit selected = false stehen.
 */

/** Grenzen ändern sich selten; nach 90 Tagen wird eine Kachel neu geladen. */
const TILE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Mehr Gebiete wählt niemand für eine Aktion. */
const MAX_AREAS = 500;
const FAILURE = "Die Ortsteile (OpenStreetMap) sind gerade nicht erreichbar.";
/** Je Overpass-Server so lange warten; die Abfragen der Grenzen sind größer als die der Häuser. */
const AREAS_SERVER_TIMEOUT_MS = 120_000;
/** Gesamtfrist eines Ladevorgangs (eine Convex-Action darf höchstens 10 Minuten laufen). */
const AREAS_DEADLINE_MS = 5 * 60_000;
/** Beim Anlegen: so oft versuchen, den Ortsteil an der Adresse zu laden. */
const INITIAL_ATTEMPTS = 3;
const INITIAL_RETRY_MS = 30_000;

// ---------------------------------------------------------------------------
// Geltungsbereich des Caches: gemeinsam (ohne campaignId, von Convex selbst geladen und damit
// vertrauenswürdig) oder nur für eine Aktion (vom Browser ihres Admins geschickt). Gelesen wird
// das Gemeinsame zuerst, dann das Eigene; nie das einer anderen Aktion.
// ---------------------------------------------------------------------------

/** Eigene Aktion beim Lesen; undefined = nur gemeinsam (Convex selbst). */
type Own = Id<"campaigns"> | undefined;

const isFresh = (fetchedAt: number, now: number) => now - fetchedAt < TILE_TTL_MS;

/** Frische Ortsteile einer Gemeinde: gemeinsame, sonst die der eigenen Aktion; sonst []. */
async function unitRows(ctx: QueryCtx, unitId: number, own: Own, now: number): Promise<Doc<"osmAreas">[]> {
  for (const scope of own ? [undefined, own] : [undefined]) {
    const rows = await ctx.db.query("osmAreas").withIndex("by_scope_unit", (q) => q.eq("campaignId", scope).eq("unitId", unitId)).collect();
    if (rows.length && isFresh(rows[0].fetchedAt, now)) return rows;
  }
  return [];
}

const unitFresh = async (ctx: QueryCtx, unitId: number, own: Own, now: number) => (await unitRows(ctx, unitId, own, now)).length > 0;

/**
 * Die vollständige, frische Kachel (gemeinsam, sonst eigene) oder null: Kachel nicht abgelaufen
 * und Ortsteile jeder ihrer Gemeinden frisch vorhanden (Gemeinden haben eigene Zeitstempel und
 * werden von cleanup getrennt gelöscht). Für `nearby`, `tileStatus` und `storeLoaded` gleich.
 */
async function tileFresh(ctx: QueryCtx, tile: string, now: number, own: Own): Promise<Doc<"boundaryTiles"> | null> {
  for (const scope of own ? [undefined, own] : [undefined]) {
    const row = await ctx.db.query("boundaryTiles").withIndex("by_scope_tile", (q) => q.eq("campaignId", scope).eq("tile", tile)).unique();
    if (!row || !isFresh(row.fetchedAt, now)) continue;
    let complete = true;
    for (const unitId of row.unitIds) if (!(await unitFresh(ctx, unitId, own, now))) complete = false;
    if (complete) return row;
  }
  return null;
}

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
      .map((r) => ({ id: r.areaId, name: r.name, geometry: r.geometry, bbox: r.bbox, labelAt: r.labelAt, cells: r.cells, selected: isSelected(r) }))
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
    const { campaign } = await requireRole(ctx, adminKey, "admin");
    assertTiles(tiles, MAX_TILES_PER_VIEW);
    const loaded: string[] = [];
    const units = new Set<number>();
    const now = Date.now();
    for (const tile of tiles) {
      // Unvollständige oder abgelaufene Kacheln gelten als nicht geladen: Die Karte lädt sie dann neu.
      const row = await tileFresh(ctx, tile, now, campaign._id);
      if (!row) continue;
      loaded.push(tile);
      row.unitIds.forEach((u) => units.add(u));
    }
    const areas = [];
    for (const unitId of units)
      for (const a of await unitRows(ctx, unitId, campaign._id, now))
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
    if (isSelected(row) !== selected || row.selected === undefined) await ctx.db.patch(row._id, { selected });
    return;
  }
  if (!selected) return;
  // Gemeinsam (von Convex geladen) zuerst, sonst was der Browser dieser Aktion geladen hat.
  const cached =
    (await ctx.db.query("osmAreas").withIndex("by_scope_area", (q) => q.eq("campaignId", undefined).eq("areaId", areaId)).first()) ??
    (await ctx.db.query("osmAreas").withIndex("by_scope_area", (q) => q.eq("campaignId", campaignId).eq("areaId", areaId)).first());
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
export const adminCampaign = internalQuery({
  args: { adminKey: v.string() },
  handler: async (ctx, { adminKey }) => {
    const { campaign } = await requireRole(ctx, adminKey, "admin");
    return { slug: campaign.slug, campaignId: campaign._id, center: [campaign.center.lng, campaign.center.lat] };
  },
});

/** Fehlende gemeinsame Kacheln (für das Laden durch Convex selbst). */
export const tileStatus = internalQuery({
  args: { tiles: v.array(v.string()) },
  handler: async (ctx, { tiles }) => {
    const now = Date.now();
    const missing: string[] = [];
    for (const tile of tiles) if (!(await tileFresh(ctx, tile, now, undefined))) missing.push(tile);
    return missing;
  },
});

/** Gemeinden mit frischen gemeinsamen Ortsteilen (für das Laden durch Convex selbst). */
export const knownUnits = internalQuery({
  args: { unitIds: v.array(v.number()) },
  handler: async (ctx, { unitIds }) => {
    const now = Date.now();
    const known: number[] = [];
    for (const unitId of unitIds) if (await unitFresh(ctx, unitId, undefined, now)) known.push(unitId);
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

/** Ortsteile einer Gemeinde in den gemeinsamen Cache (von Convex selbst geladen; ersetzt ältere). */
export const storeUnit = internalMutation({
  args: { unitId: v.number(), areas: v.array(osmAreaArg) },
  handler: async (ctx, { unitId, areas }) => {
    for (const old of await ctx.db.query("osmAreas").withIndex("by_scope_unit", (q) => q.eq("campaignId", undefined).eq("unitId", unitId)).collect()) {
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
      const row = await ctx.db.query("boundaryTiles").withIndex("by_scope_tile", (q) => q.eq("campaignId", undefined).eq("tile", tile)).unique();
      if (row) await ctx.db.patch(row._id, { unitIds, fetchedAt });
      else await ctx.db.insert("boundaryTiles", { tile, unitIds, fetchedAt });
    }
  },
});

/**
 * Lädt fehlende Grenz-Kacheln über Convex in den Cache (beim Anlegen und als Ersatz, wenn der
 * Browser Overpass nicht erreicht). Logik in areaLoad.computeTiles.
 */
async function loadBoundaryTiles(ctx: ActionCtx, rateKey: string, tiles: string[]) {
  const missing = await ctx.runQuery(internal.areas.tileStatus, { tiles });
  if (missing.length === 0) return;
  const deadline = Date.now() + AREAS_DEADLINE_MS;
  const ask: Ask = async (step, q, parse) => {
    await ctx.runMutation(internal.areas.quota, { slug: rateKey });
    try {
      return await askServers(q, parse, { lockedUntil: deadline, failure: FAILURE, timeoutMs: AREAS_SERVER_TIMEOUT_MS });
    } catch (e) {
      throw new ConvexError(`${FAILURE} ${step}: ${overpassDetails(e)}`.slice(0, 600));
    }
  };
  const result = await computeTiles(missing, ask, (unitIds) => ctx.runQuery(internal.areas.knownUnits, { unitIds }));
  for (const unit of result.units) await ctx.runMutation(internal.areas.storeUnit, unit);
  await ctx.runMutation(internal.areas.storeTiles, { tiles: result.tiles });
}

// ---------------------------------------------------------------------------
// Laden im Browser des Admins: Aus der Convex-Cloud sind die öffentlichen Overpass-Server oft
// nicht erreichbar, aus einem normalen Browser schon. Der Browser rechnet mit derselben Logik
// (areaLoad.computeTiles) und speichert hier; Convex prüft und berechnet die abgeleiteten Felder.
// ---------------------------------------------------------------------------

/** Welche dieser Gemeinden hat schon (frische) Ortsteile im Cache? Nur mit dem Admin-Schlüssel. */
export const unitsInCache = query({
  args: { adminKey: v.string(), unitIds: v.array(v.number()) },
  handler: async (ctx, { adminKey, unitIds }) => {
    const { campaign } = await requireRole(ctx, adminKey, "admin");
    if (unitIds.length > MAX_UNITS_PER_STORE) throw new ConvexError("Zu viele Gemeinden");
    const now = Date.now();
    const known: number[] = [];
    for (const unitId of unitIds) if (await unitFresh(ctx, unitId, campaign._id, now)) known.push(unitId);
    return known;
  },
});

/** Höchstens so viele Gemeinden, Gebiete und Punkte nimmt `storeLoaded` an (gegen Missbrauch). */
const MAX_UNITS_PER_STORE = 40;
const MAX_AREAS_PER_UNIT = 600;
const MAX_POINTS_PER_AREA = 50_000;
/** So viele vom Browser geladene Ortsteile speichert eine Aktion höchstens. */
const MAX_OWN_AREAS = 2_000;
/** Ein Ortsteil (auch eine kreisfreie Stadt als Ganzes) ist kleiner als 1° × 1°. */
const MAX_AREA_SPAN = 1;
const AREA_ID_PATTERN = /^relation\/\d{1,12}$/;

/** Prüft eine Grenze aus dem Browser und berechnet die abgeleiteten Felder neu. */
function checkedArea(a: { areaId: string; name: string; geometry: string }) {
  if (!AREA_ID_PATTERN.test(a.areaId)) throw new ConvexError("Ungültiges Gebiet");
  const name = a.name.trim().replace(/\s+/g, " ");
  if (!name || name.length > 200) throw new ConvexError("Ungültiger Name");
  if (a.geometry.length > MAX_AREA_BYTES) throw new ConvexError("Gebiet zu groß");
  let g: unknown;
  try {
    g = JSON.parse(a.geometry);
  } catch {
    throw new ConvexError("Ungültige Grenze");
  }
  let points = 0;
  const ok =
    Array.isArray(g) &&
    g.length > 0 &&
    g.every(
      (poly) =>
        Array.isArray(poly) &&
        poly.length > 0 &&
        poly.every(
          (ring) =>
            Array.isArray(ring) &&
            ring.length >= 4 &&
            (points += ring.length) <= MAX_POINTS_PER_AREA &&
            ring.every(
              (pt) =>
                Array.isArray(pt) && pt.length === 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1]) && Math.abs(pt[0]) <= 180 && Math.abs(pt[1]) <= 90,
            ),
        ),
    );
  if (!ok) throw new ConvexError("Ungültige Grenze");
  const geometry = g as AreaGeometry;
  const row = areaRow(a.areaId, name, geometry);
  const [w, s, e, n] = row.bbox;
  if (e - w > MAX_AREA_SPAN || n - s > MAX_AREA_SPAN) throw new ConvexError("Gebiet zu groß");
  return row;
}

/**
 * Speichert im Browser geladene Ortsteile und Kacheln, nur für die eigene Aktion: Was ein Browser
 * schickt, kann Convex nicht gegen OSM prüfen, also gilt es nicht für andere Aktionen. Nur mit
 * dem Admin-Schlüssel. Überschreibt nichts, was frisch da ist. Holt danach das Vorwählen an der
 * Adresse nach.
 */
export const storeLoaded = mutation({
  args: {
    adminKey: v.string(),
    units: v.array(v.object({ unitId: v.number(), areas: v.array(v.object({ areaId: v.string(), name: v.string(), geometry: v.string() })) })),
    tiles: v.array(v.object({ tile: v.string(), unitIds: v.array(v.number()) })),
  },
  handler: async (ctx, { adminKey, units, tiles }) => {
    const { campaign } = await requireRole(ctx, adminKey, "admin");
    if (units.length > MAX_UNITS_PER_STORE) throw new ConvexError("Zu viele Gemeinden");
    assertTiles(tiles.map((t) => t.tile), MAX_TILES_PER_LOAD);
    const own = campaign._id;
    const now = Date.now();
    // Speicher je Aktion begrenzen (jeder kann eine Aktion anlegen): einmal zählen, nur frische.
    let ownCount = (await ctx.db.query("osmAreas").withIndex("by_scope_unit", (q) => q.eq("campaignId", own)).take(MAX_OWN_AREAS * 2)).filter(
      (r) => isFresh(r.fetchedAt, now),
    ).length;
    for (const unit of units) {
      if (!Number.isInteger(unit.unitId) || unit.unitId <= 0) throw new ConvexError("Ungültige Gemeinde");
      if (unit.areas.length === 0 || unit.areas.length > MAX_AREAS_PER_UNIT) throw new ConvexError("Ungültige Gemeinde");
      // Schon frisch da (gemeinsam oder eigen): nichts überschreiben.
      if (await unitFresh(ctx, unit.unitId, own, now)) continue;
      const rows = unit.areas.map(checkedArea);
      if (ownCount + rows.length > MAX_OWN_AREAS) throw new ConvexError("Zu viele Ortsteile für diese Aktion");
      // Abgelaufene eigene Zeilen dieser Gemeinde ersetzen (sie zählen schon nicht mehr mit).
      const old = await ctx.db.query("osmAreas").withIndex("by_scope_unit", (q) => q.eq("campaignId", own).eq("unitId", unit.unitId)).collect();
      for (const o of old) await ctx.db.delete(o._id);
      for (const r of rows) await ctx.db.insert("osmAreas", { campaignId: own, unitId: unit.unitId, fetchedAt: now, ...r });
      ownCount += rows.length;
    }
    for (const { tile, unitIds } of tiles) {
      if (unitIds.length > MAX_UNITS_PER_STORE) throw new ConvexError("Zu viele Gemeinden");
      if (await tileFresh(ctx, tile, now, own)) continue;
      // Nur Gemeinden, deren Ortsteile jetzt (für diese Aktion) im Cache stehen.
      const present: number[] = [];
      for (const id of unitIds) if (await unitFresh(ctx, id, own, now)) present.push(id);
      const row = await ctx.db.query("boundaryTiles").withIndex("by_scope_tile", (q) => q.eq("campaignId", own).eq("tile", tile)).unique();
      if (row) await ctx.db.patch(row._id, { unitIds: present, fetchedAt: now });
      else await ctx.db.insert("boundaryTiles", { campaignId: own, tile, unitIds: present, fetchedAt: now });
    }
    // Vorwählen an der Adresse nachholen (wie nach loadTiles), solange die Aktion keine Gebiete hat.
    const point = [campaign.center.lng, campaign.center.lat];
    if (tiles.some((t) => t.tile === boundaryTileOf(point[0], point[1]))) await selectAtPoint(ctx, campaign._id, point);
  },
});

/**
 * Lädt das Angebot an Ortsteilen für diese Grenz-Kacheln (Modus „Gebiete bearbeiten“). Nur mit
 * dem Admin-Schlüssel. Wirft bei Überlastung von Overpass mit der Antwort der Server.
 */
export const loadTiles = action({
  args: { adminKey: v.string(), tiles: v.array(v.string()) },
  handler: async (ctx, { adminKey, tiles }): Promise<void> => {
    assertTiles(tiles, MAX_TILES_PER_LOAD);
    const { slug, campaignId, center } = await ctx.runQuery(internal.areas.adminCampaign, { adminKey });
    await loadBoundaryTiles(ctx, slug, tiles);
    // Ist der Ortsteil an der Adresse beim Anlegen nicht vorgewählt worden (Overpass gestört),
    // jetzt nachholen, sobald seine Kachel da ist. Wählt nur, solange die Aktion keine Gebiete hat.
    if (tiles.includes(boundaryTileOf(center[0], center[1]))) await ctx.runMutation(internal.areas.selectAt, { campaignId, point: center });
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
async function selectAtPoint(ctx: MutationCtx, campaignId: Id<"campaigns">, point: number[]) {
  if (await ctx.db.query("areas").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).first()) return;
  const now = Date.now();
  const tile = await tileFresh(ctx, boundaryTileOf(point[0], point[1]), now, campaignId);
  for (const unitId of tile?.unitIds ?? [])
    for (const a of await unitRows(ctx, unitId, campaignId, now)) {
      if (pointInGeometry(point, decodeGeometry(a.geometry))) {
        await selectArea(ctx, campaignId, a.areaId, true);
        const campaign = await ctx.db.get(campaignId);
        if (campaign) await replanPrefetch(ctx, campaign.slug);
        return;
      }
    }
}

/** Wählt den Ortsteil, in dem der Punkt liegt, falls die Aktion noch keine Gebiete hat. */
export const selectAt = internalMutation({
  args: { campaignId: v.id("campaigns"), point: v.array(v.number()) },
  handler: async (ctx, { campaignId, point }) => await selectAtPoint(ctx, campaignId, point),
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
    const tiles = await ctx.db.query("boundaryTiles").withIndex("by_fetchedAt", (q) => q.lt("fetchedAt", cutoff)).take(200);
    for (const t of tiles) await ctx.db.delete(t._id);
    const areas = await ctx.db.query("osmAreas").withIndex("by_fetchedAt", (q) => q.lt("fetchedAt", cutoff)).take(200);
    for (const a of areas) await ctx.db.delete(a._id);
    // Rückstand (jede Aktion hat eigene Kopien): gleich weiter.
    if (tiles.length === 200 || areas.length === 200) await ctx.scheduler.runAfter(0, internal.areas.cleanup, {});
  },
});

