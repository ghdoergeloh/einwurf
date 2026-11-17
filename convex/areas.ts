import { internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import {
  WHOLE_PLACE_ID,
  bboxGeometry,
  bboxOf,
  chooseParent,
  chooseSubdivision,
  compactGeometry,
  decodeGeometry,
  encodeCells,
  interiorPoint,
  parentQuery,
  parseBoundaries,
  parseParents,
  subareaQuery,
  touchedCells,
  type AreaGeometry,
} from "./areaGeo";
import { askServers, overpassDeadline, overpassDetails, startPrefetch, takeOverpassQuota } from "./buildings";
import { prefetchArea } from "./osm";
import { campaignByKey, requireRole } from "./access";
import { recountHouses, resetAreaStats } from "./stats";

/**
 * Gebiete (Ortsteile) einer Aktion: Convex lädt die Grenzen einmal je Aktion von Overpass
 * (beim Anlegen oder beim ersten Öffnen älterer Aktionen) und speichert sie vereinfacht.
 * Die Auswahl gilt für alle mit dem Link und ist live.
 */

/** Läuft ein Ladevorgang so lange nicht weiter, darf er neu gestartet werden. */
const AREAS_STALE_MS = 5 * 60_000;
/** Nach einem Fehler erneut versuchen, mit wachsender Pause; danach „failed“ und Knopf. */
const AREAS_RETRY_MS = 30_000;
const AREAS_MAX_FAILURES = 3;
/** Alle Gebiete zusammen höchstens so groß (Text), damit das Speichern in einen Aufruf passt. */
const AREAS_MAX_TOTAL_BYTES = 3_000_000;
/** Mehr Gebiete nimmt niemand in eine Liste zum Ankreuzen. */
const MAX_AREAS = 500;
const FAILURE = "Die Gebiete (OpenStreetMap) sind gerade nicht erreichbar.";
/** So viel der Fehlermeldung wird gespeichert und angezeigt. */
const MAX_ERROR_LENGTH = 300;

const setOf = (ctx: QueryCtx, campaignId: Id<"campaigns">) =>
  ctx.db.query("areaSets").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).unique();

/** Startet (oder wiederholt) das Laden der Gebiete. Die Auswahl bleibt erhalten. */
export async function startAreas(ctx: MutationCtx, campaignId: Id<"campaigns">) {
  const existing = await setOf(ctx, campaignId);
  const run = (existing?.run ?? 0) + 1;
  const fields = { status: "loading" as const, failures: 0, updatedAt: Date.now(), run, lastError: undefined };
  if (existing) await ctx.db.patch(existing._id, fields);
  else await ctx.db.insert("areaSets", { campaignId, unselected: [], ...fields });
  await ctx.scheduler.runAfter(0, internal.areas.download, { campaignId, run });
}

/**
 * Gebiete laden, falls noch nicht geschehen oder gescheitert (ältere Aktionen beim ersten
 * Öffnen des Admin-Links, Knopf „Erneut versuchen“). Sonst nichts. Nur mit dem Admin-Schlüssel.
 */
export const load = mutation({
  args: { adminKey: v.string() },
  handler: async (ctx, { adminKey }) => {
    const { campaign } = await requireRole(ctx, adminKey, "admin");
    const set = await setOf(ctx, campaign._id);
    const stale = set?.status === "loading" && Date.now() - set.updatedAt > AREAS_STALE_MS;
    if (!set || set.status === "failed" || stale) await startAreas(ctx, campaign._id);
  },
});

/**
 * Die Gebiete einer Aktion, nach Namen sortiert; null ohne Aktion. Ändert sich nur nach dem
 * Laden, deshalb ohne Auswahl (die steht in `status`, damit ein Häkchen nicht alle Grenzen neu schickt).
 * `geometry` ist JSON, `cells` die berührten Gebäude-Kacheln; entpacken mit toAreas aus areaGeo.ts.
 */
export const list = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const campaign = (await campaignByKey(ctx, slug))?.campaign;
    if (!campaign) return null;
    const rows = await ctx.db.query("areas").withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id)).collect();
    return rows
      .map((r) => ({ id: r.areaId, name: r.name, geometry: r.geometry, bbox: r.bbox, labelAt: r.labelAt, cells: r.cells }))
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
  },
});

/** Ladezustand und Auswahl, live. */
export const status = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const campaign = (await campaignByKey(ctx, slug))?.campaign;
    if (!campaign) return null;
    const set = await setOf(ctx, campaign._id);
    if (!set) return { status: "none" as const, whole: false, unselected: [], updatedAt: 0, staleAfterMs: AREAS_STALE_MS, lastError: null };
    return {
      status: set.status,
      whole: !!set.whole,
      unselected: set.unselected,
      updatedAt: set.updatedAt,
      staleAfterMs: AREAS_STALE_MS,
      /** Antwort der Overpass-Server beim letzten Fehlschlag (z. B. „HTTP 429“), für den Hinweis im Panel. */
      lastError: set.lastError ?? null,
    };
  },
});

/** Gebiete an- oder abwählen (eins, mehrere, alle). Nur mit dem Admin-Schlüssel. Plant das Vorladen neu. */
export const select = mutation({
  args: { adminKey: v.string(), ids: v.array(v.string()), selected: v.boolean() },
  handler: async (ctx, { adminKey, ids, selected }) => {
    const { campaign } = await requireRole(ctx, adminKey, "admin");
    if (ids.length > MAX_AREAS) throw new ConvexError("Zu viele Gebiete");
    const set = await setOf(ctx, campaign._id);
    if (!set || set.status !== "done") throw new ConvexError("Die Gebiete sind noch nicht geladen");
    const known = new Set(
      (await ctx.db.query("areas").withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id)).collect()).map((a) => a.areaId),
    );
    const off = new Set(set.unselected);
    for (const id of ids) {
      if (!known.has(id)) continue;
      if (selected) off.delete(id);
      else off.add(id);
    }
    const unselected = [...off].sort();
    if (unselected.join("\n") === [...set.unselected].sort().join("\n")) return;
    await ctx.db.patch(set._id, { unselected });
    // Statistik: Häuser der neuen Zielgebiete zählen (was schon im Cache ist; der Rest folgt nach dem Vorladen).
    await recountHouses(ctx, campaign._id);
    // Läuft oder lief ein Vorladen, die ausgewählten Gebiete zuerst (Kacheln im Cache kosten nichts).
    await replanPrefetch(ctx, campaign.slug);
  },
});

/** Läuft oder lief ein Vorladen: neu planen, nur noch Kacheln der gewählten Gebiete (Cache-Treffer kosten nichts). */
async function replanPrefetch(ctx: MutationCtx, slug: string) {
  const job = await ctx.db.query("prefetchJobs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
  if (job) await startPrefetch(ctx, slug, { replan: true });
}

// ---------------------------------------------------------------------------
// Laden (im Hintergrund)
// ---------------------------------------------------------------------------

export const forFetch = internalQuery({
  args: { campaignId: v.id("campaigns") },
  handler: async (ctx, { campaignId }) => {
    const campaign = await ctx.db.get(campaignId);
    const set = await setOf(ctx, campaignId);
    return campaign && set ? { campaign, run: set.run, status: set.status } : null;
  },
});

export const quota = internalMutation({
  args: { slug: v.string() },
  // Im Kontingent des Vorladens: Gebiete haben keine Eile, die Karte geht vor.
  handler: async (ctx, { slug }) => await takeOverpassQuota(ctx, `${slug}:gebiete`, "prefetch"),
});

const areaArg = v.object({
  areaId: v.string(),
  name: v.string(),
  geometry: v.string(),
  bbox: v.array(v.number()),
  labelAt: v.array(v.number()),
  cells: v.string(),
});

export const save = internalMutation({
  args: { campaignId: v.id("campaigns"), run: v.number(), whole: v.boolean(), areas: v.array(areaArg) },
  handler: async (ctx, { campaignId, run, whole, areas }) => {
    const set = await setOf(ctx, campaignId);
    if (!set || set.run !== run) return;
    for (const old of await ctx.db.query("areas").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).collect()) {
      await ctx.db.delete(old._id);
    }
    for (const a of areas) await ctx.db.insert("areas", { campaignId, ...a });
    const ids = new Set(areas.map((a) => a.areaId));
    await ctx.db.patch(set._id, {
      status: "done",
      whole,
      failures: 0,
      lastError: undefined,
      updatedAt: Date.now(),
      // Auswahl aus einem früheren Laden übernehmen, soweit es die Gebiete noch gibt.
      unselected: set.unselected.filter((id) => ids.has(id)),
    });
    await resetAreaStats(ctx, campaignId);
    const campaign = await ctx.db.get(campaignId);
    if (campaign) await replanPrefetch(ctx, campaign.slug);
  },
});

export const failed = internalMutation({
  args: { campaignId: v.id("campaigns"), run: v.number(), error: v.optional(v.string()) },
  handler: async (ctx, { campaignId, run, error }) => {
    const set = await setOf(ctx, campaignId);
    if (!set || set.run !== run || set.status !== "loading") return;
    const failures = set.failures + 1;
    if (failures >= AREAS_MAX_FAILURES) {
      await ctx.db.patch(set._id, { status: "failed", failures, updatedAt: Date.now(), lastError: error });
      return;
    }
    await ctx.db.patch(set._id, { failures, updatedAt: Date.now(), lastError: error });
    await ctx.scheduler.runAfter(AREAS_RETRY_MS * failures, internal.areas.download, { campaignId, run });
  },
});

type NewArea = { areaId: string; name: string; geometry: AreaGeometry };

/** Ersatz: der ganze Ort als ein Gebiet. */
function wholePlace(campaign: Doc<"campaigns">, name: string | null, geometry: AreaGeometry | null): NewArea {
  return {
    areaId: WHOLE_PLACE_ID,
    name: name || campaign.placeLabel.split(",")[0].trim() || campaign.name,
    geometry: geometry ?? bboxGeometry(prefetchArea(campaign)),
  };
}

/**
 * Holt die Gebiete von Overpass: erst die Grenzen am Mittelpunkt der Aktion (welche ist der
 * gesuchte Ort?), dann die Teilgebiete des Ortes. Wählt die feinste lückenlose Unterteilung.
 */
async function fetchAreas(ctx: ActionCtx, campaign: Doc<"campaigns">) {
  const ask = <T,>(q: string, parse: (json: never) => T) => askServers(q, parse, { hedge: false, lockedUntil: overpassDeadline(), failure: FAILURE });
  await ctx.runMutation(internal.areas.quota, { slug: campaign.slug });
  const parents = await ask(parentQuery(campaign.center.lat, campaign.center.lng), parseParents);
  const b = campaign.bbox;
  const parent = chooseParent(parents, b && b.length === 4 ? [b[0], b[1], b[2], b[3]] : null);
  if (!parent) return { whole: true, areas: [wholePlace(campaign, null, null)] };

  await ctx.runMutation(internal.areas.quota, { slug: campaign.slug });
  const boundaries = await ask(subareaQuery(parent.id, parent.level), parseBoundaries);
  const place = boundaries.find((x) => x.id === parent.id);
  if (!place) return { whole: true, areas: [wholePlace(campaign, parent.name, null)] };
  const parts = chooseSubdivision(place, boundaries);
  if (!parts) return { whole: true, areas: [wholePlace(campaign, place.name, place.geometry)] };
  return { whole: false, areas: parts.slice(0, MAX_AREAS).map((p) => ({ areaId: `relation/${p.id}`, name: p.name, geometry: p.geometry })) };
}

export const download = internalAction({
  args: { campaignId: v.id("campaigns"), run: v.number() },
  handler: async (ctx, { campaignId, run }) => {
    const info = await ctx.runQuery(internal.areas.forFetch, { campaignId });
    if (!info || info.run !== run || info.status !== "loading") return;
    try {
      const { whole, areas } = await fetchAreas(ctx, info.campaign);
      const maxBytes = Math.min(400_000, Math.floor(AREAS_MAX_TOTAL_BYTES / areas.length));
      const rows = areas.map((a) => {
        const geometry = compactGeometry(a.geometry, maxBytes);
        const g = decodeGeometry(geometry);
        return { areaId: a.areaId, name: a.name, geometry, bbox: bboxOf(g), labelAt: interiorPoint(g), cells: encodeCells(touchedCells(g)) };
      });
      await ctx.runMutation(internal.areas.save, { campaignId, run, whole, areas: rows });
    } catch (e) {
      const error = overpassDetails(e).slice(0, MAX_ERROR_LENGTH);
      console.warn("Gebiete: Laden fehlgeschlagen", error);
      await ctx.runMutation(internal.areas.failed, { campaignId, run, error });
    }
  },
});
