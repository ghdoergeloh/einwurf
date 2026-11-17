import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import type { Position } from "geojson";
import { campaignForAdmin, campaignForEdit, campaignForRead } from "./access";
import { areaAt, decodeCells, decodeGeometry, encodeCells, type AreaGeometry } from "./areaGeo";
import { centerOf, decodeBuildings } from "./osm";
import { countDelta, statusOf, type HouseStatus } from "./status";

/**
 * Statistik je Gebiet: Wie viele Häuser hat ein Gebiet, wie viele haben einen Flyer (gelb),
 * wo ging es nicht (dunkelgelb)?
 *
 * - Häuser: einmal je Gebiet aus dem Gebäude-Cache gezählt (dieselben Häuser, die die Karte
 *   antippbar zeigt, zugeordnet über den Mittelpunkt), im Hintergrund in kleinen Schritten.
 *   Neu gezählt wird nach dem Laden der Gebiete, bei geänderter Auswahl, wenn das Vorladen
 *   fertig ist, und auf Wunsch (refresh, gebremst).
 * - Markierungen: beim Setzen mitgezählt (wie markCount/blockedCount an der Aktion). Jede
 *   Markierung merkt sich ihr Gebiet und den Ladevorgang der Gebiete (`areaRun`), zu dem sie
 *   gezählt wurde. Ältere Markierungen ordnet ein Hintergrundlauf einmalig zu. Weil Convex
 *   Mutationen nacheinander ausführt, zählt so jede Markierung genau einmal.
 *
 * Überlappen sich Gebiete, gilt wie bei areaAt das erste nach Namen, für Häuser und Markierungen gleich.
 */

/** Markierungen je Schritt beim Nachziehen; Kacheln je Schritt beim Zählen der Häuser. */
const ASSIGN_BATCH = 400;
const COUNT_BATCH = 20;
/** Neu zählen auf Wunsch höchstens so oft. */
const REFRESH_MIN_MS = 60_000;

const setOf = (ctx: QueryCtx, campaignId: Id<"campaigns">) =>
  ctx.db.query("areaSets").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).unique();
const jobOf = (ctx: QueryCtx, campaignId: Id<"campaigns">) =>
  ctx.db.query("statsJobs").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).unique();
const byName = <A extends { name: string }>(a: A, b: A) => a.name.localeCompare(b.name, "de");

/** Statistik-Zeilen des aktuellen Ladevorgangs, nach Namen (wie areaRows). */
async function statRows(ctx: QueryCtx, campaignId: Id<"campaigns">, run: number) {
  const rows = await ctx.db.query("areaStats").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).collect();
  return rows.filter((r) => r.run === run).sort(byName);
}

type Located = { id: string; name: string; geometry: AreaGeometry; bbox: number[]; cells?: Set<string> };
const inBox = ([x, y]: Position, b: number[]) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

/** Grenzen der Gebiete zu den Zeilen laden, nur für die Zuordnung (nie in einer Query für den Browser). */
async function withGeometry(ctx: QueryCtx, rows: Doc<"areaStats">[], { cells = false } = {}): Promise<Located[]> {
  const out: Located[] = [];
  for (const r of rows) {
    const doc = await ctx.db.get(r.areaDoc);
    if (!doc) continue;
    out.push({
      id: r.areaId,
      name: r.name,
      geometry: decodeGeometry(doc.geometry),
      bbox: r.bbox,
      cells: cells ? new Set(decodeCells(doc.cells)) : undefined,
    });
  }
  return out;
}

/** Gebiet eines Punktes [lng, lat] wie areaAt, mit schneller Vorauswahl über den Ausschnitt. */
function locate(pt: Position, areas: Located[]): string {
  return areaAt(pt, areas.filter((a) => inBox(pt, a.bbox)))?.id ?? "";
}

async function addCounts(ctx: MutationCtx, rows: Doc<"areaStats">[], deltas: Map<string, { done: number; blocked: number }>) {
  for (const r of rows) {
    const d = deltas.get(r.areaId);
    if (!d || (d.done === 0 && d.blocked === 0)) continue;
    await ctx.db.patch(r._id, { done: Math.max(0, r.done + d.done), blocked: Math.max(0, r.blocked + d.blocked) });
  }
}

// ---------------------------------------------------------------------------
// Aufrufe aus anderen Modulen
// ---------------------------------------------------------------------------

/**
 * Nach dem Laden der Gebiete (areas.save): Zeilen neu anlegen, ältere Markierungen zuordnen,
 * Häuser zählen.
 */
export async function resetAreaStats(ctx: MutationCtx, campaignId: Id<"campaigns">) {
  const set = await setOf(ctx, campaignId);
  if (!set || set.status !== "done") return;
  for (const old of await ctx.db.query("areaStats").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).collect()) {
    await ctx.db.delete(old._id);
  }
  for (const a of await ctx.db.query("areas").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).collect()) {
    await ctx.db.insert("areaStats", {
      campaignId,
      areaId: a.areaId,
      name: a.name,
      areaDoc: a._id,
      bbox: a.bbox,
      run: set.run,
      done: 0,
      blocked: 0,
      cellsCounted: 0,
      cellsTotal: decodeCells(a.cells).length,
    });
  }
  const job = await jobOf(ctx, campaignId);
  const fields = { run: set.run, marksCursor: null, marksDone: false };
  if (job) await ctx.db.patch(job._id, fields);
  else await ctx.db.insert("statsJobs", { campaignId, ...fields, seq: 0, cells: "", targets: "", countedAt: 0 });
  await ctx.scheduler.runAfter(0, internal.stats.assignStep, { campaignId, run: set.run });
  await recountHouses(ctx, campaignId);
}

/**
 * Häuser der Zielgebiete neu zählen: der gewählten, oder aller, wenn keins gewählt ist (dann
 * gilt der ganze Ort). Nicht gewählte Gebiete werden nicht geladen, also auch nicht gezählt.
 */
export async function recountHouses(ctx: MutationCtx, campaignId: Id<"campaigns">) {
  const set = await setOf(ctx, campaignId);
  const job = await jobOf(ctx, campaignId);
  if (!set || set.status !== "done" || !job || job.run !== set.run) return;
  const rows = await statRows(ctx, campaignId, set.run);
  const off = new Set(set.unselected);
  const picked = rows.filter((r) => !off.has(r.areaId));
  const targets = picked.length ? picked : rows;
  const cells = new Set<string>();
  for (const r of targets) {
    const doc = await ctx.db.get(r.areaDoc);
    for (const c of doc ? decodeCells(doc.cells) : []) cells.add(c);
  }
  const seq = job.seq + 1;
  const ids = new Set(targets.map((r) => r.areaId));
  for (const r of rows) {
    if (ids.has(r.areaId)) await ctx.db.patch(r._id, { countSeq: seq, housesNext: 0, cellsNext: 0 });
    else if (r.countSeq !== undefined) await ctx.db.patch(r._id, { countSeq: undefined, housesNext: undefined, cellsNext: undefined });
  }
  await ctx.db.patch(job._id, { seq, cells: encodeCells([...cells].sort()), targets: [...ids].join(" ") });
  await ctx.scheduler.runAfter(0, internal.stats.countStep, { campaignId, seq });
}

/** Wie recountHouses, für den Bearbeiten-Schlüssel (Vorladen fertig). */
export async function recountHousesFor(ctx: MutationCtx, slug: string) {
  const campaign = await campaignForEdit(ctx, slug);
  if (campaign) await recountHouses(ctx, campaign._id);
}

/**
 * Beim Setzen einer Markierung (marks.set): Zähler des Gebiets anpassen. Liefert die Felder,
 * die die Markierung bekommt ({} solange die Gebiete nicht geladen sind; dann ordnet das
 * Nachziehen sie später zu).
 */
export async function trackMark(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
  existing: Doc<"marks"> | null,
  target: HouseStatus,
  center: [number, number],
): Promise<{ area?: string; areaRun?: number }> {
  const set = await setOf(ctx, campaignId);
  if (!set || set.status !== "done") return {};
  const counted = !!existing && existing.areaRun === set.run;
  let area: string;
  let rows: Doc<"areaStats">[] | null = null;
  if (counted) area = existing.area ?? "";
  else {
    rows = await statRows(ctx, campaignId, set.run);
    area = locate(center, await withGeometry(ctx, rows.filter((r) => inBox(center, r.bbox))));
  }
  const d = countDelta(counted ? statusOf(existing) : "none", target);
  if (area && (d.done || d.blocked)) {
    const row = await ctx.db
      .query("areaStats")
      .withIndex("by_campaign_area", (q) => q.eq("campaignId", campaignId).eq("areaId", area))
      .unique();
    if (row && row.run === set.run) await addCounts(ctx, [row], new Map([[area, d]]));
  }
  return { area, areaRun: set.run };
}

// ---------------------------------------------------------------------------
// Hintergrund
// ---------------------------------------------------------------------------

/** Ältere Markierungen (ohne Gebiet oder aus einem früheren Laden) zuordnen und mitzählen. */
export const assignStep = internalMutation({
  args: { campaignId: v.id("campaigns"), run: v.number() },
  handler: async (ctx, { campaignId, run }) => {
    const set = await setOf(ctx, campaignId);
    const job = await jobOf(ctx, campaignId);
    if (!set || set.status !== "done" || set.run !== run || !job || job.run !== run || job.marksDone) return;
    const page = await ctx.db
      .query("marks")
      .withIndex("by_campaign_osm", (q) => q.eq("campaignId", campaignId))
      .paginate({ cursor: job.marksCursor, numItems: ASSIGN_BATCH });
    const rows = await statRows(ctx, campaignId, run);
    const areas = await withGeometry(ctx, rows);
    const deltas = new Map<string, { done: number; blocked: number }>();
    for (const m of page.page) {
      if (m.areaRun === run) continue;
      const area = locate(m.center, areas);
      await ctx.db.patch(m._id, { area, areaRun: run });
      if (!area) continue;
      const d = deltas.get(area) ?? { done: 0, blocked: 0 };
      d[statusOf(m) === "blocked" ? "blocked" : "done"]++;
      deltas.set(area, d);
    }
    await addCounts(ctx, rows, deltas);
    await ctx.db.patch(job._id, { marksCursor: page.isDone ? null : page.continueCursor, marksDone: page.isDone });
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.stats.assignStep, { campaignId, run });
  },
});

/** Häuser zählen: einige Kacheln aus dem Cache je Schritt. Fehlende Kacheln machen die Zahl vorläufig. */
export const countStep = internalMutation({
  args: { campaignId: v.id("campaigns"), seq: v.number() },
  handler: async (ctx, { campaignId, seq }) => {
    const set = await setOf(ctx, campaignId);
    const job = await jobOf(ctx, campaignId);
    if (!set || set.status !== "done" || !job || job.seq !== seq || job.run !== set.run) return;
    const cells = decodeCells(job.cells);
    const batch = cells.slice(0, COUNT_BATCH);
    const rows = await statRows(ctx, campaignId, set.run);
    const targets = new Set(job.targets ? job.targets.split(" ") : []);
    // Alle Gebiete für die Zuordnung (erstes nach Namen gewinnt), gezählt nur die Ziele.
    const areas = await withGeometry(ctx, rows, { cells: true });
    const houses = new Map<string, number>();
    const cached = new Map<string, number>();
    for (const cell of batch) {
      const entry = await ctx.db.query("buildingCells").withIndex("by_cell", (q) => q.eq("cell", cell)).first();
      if (!entry) continue;
      for (const a of areas) if (targets.has(a.id) && a.cells!.has(cell)) cached.set(a.id, (cached.get(a.id) ?? 0) + 1);
      for (const f of decodeBuildings(entry.data)) {
        const pt = centerOf(f);
        const id = locate(pt, areas);
        if (id && targets.has(id)) houses.set(id, (houses.get(id) ?? 0) + 1);
      }
    }
    const rest = cells.slice(COUNT_BATCH);
    for (const r of rows) {
      if (r.countSeq !== seq) continue;
      const housesNext = (r.housesNext ?? 0) + (houses.get(r.areaId) ?? 0);
      const cellsNext = (r.cellsNext ?? 0) + (cached.get(r.areaId) ?? 0);
      if (rest.length) await ctx.db.patch(r._id, { housesNext, cellsNext });
      // Fertig: Ergebnis übernehmen. Bis dahin zeigt die Statistik die letzte fertige Zählung.
      else await ctx.db.patch(r._id, { houses: housesNext, cellsCounted: cellsNext, countSeq: undefined, housesNext: undefined, cellsNext: undefined });
    }
    await ctx.db.patch(job._id, rest.length ? { cells: encodeCells(rest) } : { cells: "", countedAt: Date.now() });
    if (rest.length) await ctx.scheduler.runAfter(0, internal.stats.countStep, { campaignId, seq });
  },
});

// ---------------------------------------------------------------------------
// Für den Browser
// ---------------------------------------------------------------------------

/**
 * Statistik einer Aktion, live. `total` sind die Zähler der ganzen Aktion (auch außerhalb der
 * Gebiete). `areas` ist null, solange es keine Gebiete gibt. Je Gebiet: `target` = gezählt
 * (gewählt, oder alle, wenn keins gewählt ist), `houses` nur für Ziele und erst nach der
 * ersten Zählung, `complete` = alle Kacheln des Gebiets waren beim Zählen im Cache.
 * Liest keine Grenzen, damit ein Tipp nur wenige kleine Zeilen neu schickt.
 */
export const byArea = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const campaign = (await campaignForRead(ctx, slug))?.campaign;
    if (!campaign) return null;
    const total = { done: campaign.markCount ?? 0, blocked: campaign.blockedCount ?? 0 };
    const set = await setOf(ctx, campaign._id);
    if (!set || set.status !== "done") return { areas: null, total };
    const job = await jobOf(ctx, campaign._id);
    const rows = await statRows(ctx, campaign._id, set.run);
    if (rows.length === 0) return { areas: null, total };
    const off = new Set(set.unselected);
    const noneSelected = rows.every((r) => off.has(r.areaId));
    const list = rows.map((r) => {
      const selected = !off.has(r.areaId);
      const target = noneSelected || selected;
      return {
        id: r.areaId,
        name: r.name,
        selected,
        target,
        done: r.done,
        blocked: r.blocked,
        houses: target ? (r.houses ?? null) : null,
        complete: target && r.houses !== undefined && r.cellsCounted >= r.cellsTotal,
      };
    });
    return {
      areas: {
        whole: !!set.whole,
        noneSelected,
        rows: [...list.filter((r) => r.target), ...list.filter((r) => !r.target)],
        assigning: !job || job.run !== set.run || !job.marksDone,
        counting: !!job && job.cells !== "",
      },
      total,
    };
  },
});

/** Häuser neu zählen (Panel offen, Zahl noch vorläufig). Mit Bearbeiten- oder Admin-Schlüssel, gebremst. */
export const refresh = mutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const campaign = (await campaignForEdit(ctx, slug)) ?? (await campaignForAdmin(ctx, slug));
    if (!campaign) throw new ConvexError("Verteilaktion nicht gefunden");
    const job = await jobOf(ctx, campaign._id);
    if (!job || job.cells !== "" || Date.now() - job.countedAt < REFRESH_MIN_MS) return;
    await recountHouses(ctx, campaign._id);
  },
});
