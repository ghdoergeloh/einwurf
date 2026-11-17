import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Position } from "geojson";
import { campaignByKey, requireRole } from "./access";
import { areaAt, decodeCells, decodeGeometry, encodeCells, inBox, type AreaGeometry } from "./areaGeo";
import { centerOf, decodeBuildings } from "./osm";
import { isSelected } from "./areaStore";
import { countDelta, statusOf, type HouseStatus } from "./status";

/**
 * Statistik je Gebiet: Wie viele Häuser hat ein Gebiet, wie viele haben einen Flyer (gelb),
 * wo ging es nicht (dunkelgelb)?
 *
 * - Häuser: einmal je Gebiet aus dem Gebäude-Cache gezählt (dieselben Häuser, die die Karte
 *   antippbar zeigt, zugeordnet über den Mittelpunkt), im Hintergrund in kleinen Schritten.
 *   Neu gezählt wird bei geänderter Auswahl, wenn das Vorladen fertig ist, und auf Wunsch
 *   (refresh, gebremst).
 * - Markierungen: beim Setzen mitgezählt (wie markCount/blockedCount an der Aktion). Jede
 *   Markierung merkt sich ihr Gebiet und die Laufnummer der Statistik (`areaRun`), zu der sie
 *   gezählt wurde. Kommt ein Gebiet dazu oder fällt eins weg, beginnt ein neuer Lauf, und ein
 *   Hintergrundlauf ordnet alle Markierungen neu zu. Weil Convex Mutationen nacheinander
 *   ausführt, zählt so jede Markierung genau einmal.
 *
 * Überlappen sich Gebiete, gilt das erste gewählte nach Namen, sonst das erste nach Namen
 * (für Häuser und Markierungen gleich). So zählt jedes Haus, das die Karte antippbar zeigt.
 */

/** Markierungen je Schritt beim Nachziehen; Kacheln je Schritt beim Zählen der Häuser. */
const ASSIGN_BATCH = 400;
const COUNT_BATCH = 20;
/** Neu zählen auf Wunsch höchstens so oft. */
const REFRESH_MIN_MS = 60_000;

/** Gebiete der Aktion (gewählte und abgewählte). */
const areaDocs = (ctx: QueryCtx, campaignId: Id<"campaigns">) =>
  ctx.db.query("areas").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).collect();
/** Fingerabdruck der Gebiete: ändert er sich, passen die Statistik-Zeilen nicht mehr. */
const keyOf = (docs: Doc<"areas">[]) => docs.map((d) => d._id).sort().join(" ");
const jobOf = (ctx: QueryCtx, campaignId: Id<"campaigns">) =>
  ctx.db.query("statsJobs").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).unique();
const byName = <A extends { name: string }>(a: A, b: A) => a.name.localeCompare(b.name, "de");

/** Statistik-Zeilen des aktuellen Ladevorgangs, nach Namen (wie areaRows). */
async function statRows(ctx: QueryCtx, campaignId: Id<"campaigns">, run: number) {
  const rows = await ctx.db.query("areaStats").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).collect();
  return rows.filter((r) => r.run === run).sort(byName);
}

/** Abgewählte Gebiete (areaId). */
async function unselectedOf(ctx: QueryCtx, campaignId: Id<"campaigns">) {
  return new Set((await areaDocs(ctx, campaignId)).filter((d) => !isSelected(d)).map((d) => d.areaId));
}

/** Reihenfolge für die Zuordnung: gewählte Gebiete zuerst, dann die übrigen, je nach Namen. */
function preferSelected(rows: Doc<"areaStats">[], off: Set<string>) {
  return [...rows.filter((r) => !off.has(r.areaId)), ...rows.filter((r) => off.has(r.areaId))];
}

/**
 * Stand der Statistik: der Auftrag, wenn seine Zeilen zu den Gebieten passen, sonst null (keine
 * Gebiete, oder Gebiete vor der Statistik angelegt bzw. ohne Anpassung geändert).
 */
async function current(ctx: QueryCtx, campaignId: Id<"campaigns">) {
  const docs = await areaDocs(ctx, campaignId);
  if (docs.length === 0) return { docs, job: null };
  const job = await jobOf(ctx, campaignId);
  return { docs, job: job && job.areaKey === keyOf(docs) ? job : null };
}

type Located = { id: string; name: string; geometry: AreaGeometry; bbox: number[]; cells?: Set<string> };

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
 * Nach jeder Änderung der Gebiete einer Aktion (areas.select, Ortsteil an der Adresse): Kam ein
 * Gebiet dazu oder fiel eins weg, Zeilen neu anlegen, Markierungen neu zuordnen und Häuser
 * zählen; wurde nur die Auswahl geändert, Häuser der neuen Zielgebiete zählen.
 */
export async function syncAreaStats(ctx: MutationCtx, campaignId: Id<"campaigns">) {
  const { docs, job } = await current(ctx, campaignId);
  if (docs.length === 0) return;
  if (job) return await recountHouses(ctx, campaignId);
  await resetAreaStats(ctx, campaignId);
}

/** Zeilen neu anlegen, alle Markierungen (neu) zuordnen, Häuser zählen. */
async function resetAreaStats(ctx: MutationCtx, campaignId: Id<"campaigns">) {
  const docs = await areaDocs(ctx, campaignId);
  if (docs.length === 0) return;
  const old = await jobOf(ctx, campaignId);
  const run = (old?.run ?? 0) + 1;
  for (const row of await ctx.db.query("areaStats").withIndex("by_campaign", (q) => q.eq("campaignId", campaignId)).collect()) {
    await ctx.db.delete(row._id);
  }
  for (const a of docs) {
    await ctx.db.insert("areaStats", {
      campaignId,
      areaId: a.areaId,
      name: a.name,
      areaDoc: a._id,
      bbox: a.bbox,
      run,
      done: 0,
      blocked: 0,
      cellsCounted: 0,
      cellsTotal: decodeCells(a.cells).length,
    });
  }
  const fields = { run, areaKey: keyOf(docs), marksCursor: null, marksDone: false };
  if (old) await ctx.db.patch(old._id, fields);
  else await ctx.db.insert("statsJobs", { campaignId, ...fields, seq: 0, cells: "", targets: "", countedAt: 0 });
  await ctx.scheduler.runAfter(0, internal.stats.assignStep, { campaignId, run });
  await recountHouses(ctx, campaignId);
}

/**
 * Häuser der Zielgebiete neu zählen: der gewählten, oder aller, wenn keins gewählt ist (dann
 * gilt der ganze Ort). Nicht gewählte Gebiete werden nicht geladen, also auch nicht gezählt.
 */
async function recountHouses(ctx: MutationCtx, campaignId: Id<"campaigns">) {
  const { job } = await current(ctx, campaignId);
  if (!job) return;
  const rows = await statRows(ctx, campaignId, job.run);
  const off = await unselectedOf(ctx, campaignId);
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
  const campaign = (await campaignByKey(ctx, slug))?.campaign;
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
  // Noch keine Statistik für diesen Stand: nichts festlegen, das Nachziehen ordnet später zu.
  const { job } = await current(ctx, campaignId);
  if (!job) return {};
  const run = job.run;
  const counted = !!existing && existing.areaRun === run;
  let area: string;
  let rows: Doc<"areaStats">[] | null = null;
  if (counted) area = existing.area ?? "";
  else {
    rows = preferSelected(await statRows(ctx, campaignId, run), await unselectedOf(ctx, campaignId));
    area = locate(center, await withGeometry(ctx, rows.filter((r) => inBox(center, r.bbox))));
  }
  const d = countDelta(counted ? statusOf(existing) : "none", target);
  if (area && (d.done || d.blocked)) {
    const row = await ctx.db
      .query("areaStats")
      .withIndex("by_campaign_area", (q) => q.eq("campaignId", campaignId).eq("areaId", area))
      .unique();
    if (row && row.run === run) await addCounts(ctx, [row], new Map([[area, d]]));
  }
  return { area, areaRun: run };
}

// ---------------------------------------------------------------------------
// Hintergrund
// ---------------------------------------------------------------------------

/** Ältere Markierungen (ohne Gebiet oder aus einem früheren Laden) zuordnen und mitzählen. */
export const assignStep = internalMutation({
  args: { campaignId: v.id("campaigns"), run: v.number() },
  handler: async (ctx, { campaignId, run }) => {
    const { job } = await current(ctx, campaignId);
    if (!job || job.run !== run || job.marksDone) return;
    const page = await ctx.db
      .query("marks")
      .withIndex("by_campaign_osm", (q) => q.eq("campaignId", campaignId))
      .paginate({ cursor: job.marksCursor, numItems: ASSIGN_BATCH });
    const rows = await statRows(ctx, campaignId, run);
    const areas = await withGeometry(ctx, preferSelected(rows, await unselectedOf(ctx, campaignId)));
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
    const { job } = await current(ctx, campaignId);
    if (!job || job.seq !== seq) return;
    const cells = decodeCells(job.cells);
    const batch = cells.slice(0, COUNT_BATCH);
    const rows = await statRows(ctx, campaignId, job.run);
    const targets = new Set(job.targets ? job.targets.split(" ") : []);
    // Alle Gebiete für die Zuordnung (gewählte zuerst), gezählt nur die Ziele.
    const areas = await withGeometry(ctx, preferSelected(rows, await unselectedOf(ctx, campaignId)), { cells: true });
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
    const campaign = (await campaignByKey(ctx, slug))?.campaign;
    if (!campaign) return null;
    const total = { done: campaign.markCount ?? 0, blocked: campaign.blockedCount ?? 0 };
    const { docs, job } = await current(ctx, campaign._id);
    if (docs.length === 0) return { areas: null, needsSetup: false, total };
    const rows = job ? await statRows(ctx, campaign._id, job.run) : [];
    // Gebiete da, aber keine passende Statistik (vor ihr angelegt): Browser stößt refresh an.
    if (!job || rows.length === 0) return { areas: null, needsSetup: true, total };
    const off = new Set(docs.filter((d) => !isSelected(d)).map((d) => d.areaId));
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
        noneSelected,
        rows: [...list.filter((r) => r.target), ...list.filter((r) => !r.target)],
        assigning: !job.marksDone,
        counting: job.cells !== "",
      },
      needsSetup: false,
      total,
    };
  },
});

/**
 * Beim Öffnen der Statistik: fehlt sie für die geladenen Gebiete (vor ihr geladen), anlegen;
 * ist sie vorläufig, Häuser neu zählen (gebremst). Ab der Rolle „edit“ (siehe access.ts); der Ansehen-Link liest nur.
 */
export const refresh = mutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const { campaign } = await requireRole(ctx, slug, "edit");
    const { docs, job } = await current(ctx, campaign._id);
    if (docs.length === 0) return;
    if (!job) return await resetAreaStats(ctx, campaign._id);
    if (job.cells !== "" || Date.now() - job.countedAt < REFRESH_MIN_MS) return;
    await recountHouses(ctx, campaign._id);
  },
});
