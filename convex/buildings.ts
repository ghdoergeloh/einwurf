import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import {
  BUILDINGS_FORMAT,
  MAX_CELL_SPAN,
  buildQuery,
  cellKeyOf,
  cellsBBox,
  centerOf,
  encodeBuildings,
  parseCellKey,
  parseOverpass,
  planPrefetch,
  prefetchArea,
  type BuildingFeature,
} from "./osm";
import { SLUG_PATTERN } from "./validation";

/**
 * Häuser aus OpenStreetMap, serverseitig über Overpass geladen und je Kachel für alle
 * Helfer gecacht. So fragt nur der erste Helfer in einem Gebiet Overpass, und der Browser
 * hängt nicht an CORS und Überlastung eines öffentlichen Servers.
 */

/** So viele Kacheln darf ein Aufruf anfragen (entspricht MAX_CELLS_PER_REQUEST im Browser). */
export const MAX_CELLS_PER_LOAD = 24;
/** Gebäude ändern sich selten; nach 30 Tagen wird neu geladen. */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Convex-Dokumente dürfen höchstens 1 MiB groß sein. */
const MAX_CACHE_BYTES = 900_000;
const OVERPASS_TIMEOUT_MS = 25_000;
/** Öffentliche Overpass-Server, der Reihe nach. Überschreibbar mit der Convex-Umgebungsvariable OVERPASS_URLS. */
const DEFAULT_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const USER_AGENT = "Einwurf/1.0 (gemeinsame Flyer-Verteilkarte)";
/** Höchstens so viele Overpass-Abrufe pro Minute: je Aktion und insgesamt. */
export const MAX_FETCHES_PER_MINUTE_PER_CAMPAIGN = 12;
/** Insgesamt für die Karte (alle Aktionen) … */
export const MAX_FETCHES_PER_MINUTE_TOTAL = 30;
/** … und getrennt davon fürs Vorladen (alle Aktionen), damit es die Karte nie ausbremst. */
export const MAX_PREFETCH_FETCHES_PER_MINUTE = 15;
/**
 * So lange gilt eine Kachel als „wird geladen“: so lange, wie ein Abruf über alle Server
 * höchstens dauern kann, plus Puffer fürs Speichern. Andere Aufrufe warten so lange auf den Cache.
 */
const lockMs = () => endpoints().length * OVERPASS_TIMEOUT_MS + 15_000;
const WAIT_POLL_MS = 1_000;

export const campaignExists = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) =>
    !!(await ctx.db.query("campaigns").withIndex("by_slug", (q) => q.eq("slug", slug)).unique()),
});

export const cached = internalQuery({
  args: { cells: v.array(v.string()) },
  handler: async (ctx, { cells }) => {
    const out: { cell: string; data: string; fetchedAt: number; format: number }[] = [];
    for (const cell of cells) {
      const row = await ctx.db.query("buildingCells").withIndex("by_cell", (q) => q.eq("cell", cell)).unique();
      if (row) out.push({ cell, data: row.data, fetchedAt: row.fetchedAt, format: row.format ?? 1 });
    }
    return out;
  },
});

export const store = internalMutation({
  args: { entries: v.array(v.object({ cell: v.string(), data: v.string() })) },
  handler: async (ctx, { entries }) => {
    const now = Date.now();
    for (const { cell, data } of entries) {
      const row = await ctx.db.query("buildingCells").withIndex("by_cell", (q) => q.eq("cell", cell)).unique();
      if (row) await ctx.db.patch(row._id, { data, fetchedAt: now, format: BUILDINGS_FORMAT });
      else await ctx.db.insert("buildingCells", { cell, data, fetchedAt: now, format: BUILDINGS_FORMAT });
    }
  },
});

/**
 * Teilt die fehlenden Kacheln auf: Die noch nicht gesperrten lädt dieser Aufruf selbst
 * (und sperrt sie), auf die gesperrten wartet er. Prüft dabei die Begrenzung pro Minute.
 * Läuft als Mutation und damit serialisiert – zwei Aufrufe bekommen nie dieselbe Kachel.
 */
export const reserve = internalMutation({
  args: { slug: v.string(), cells: v.array(v.string()), kind: v.optional(v.union(v.literal("map"), v.literal("prefetch"))) },
  handler: async (ctx, { slug, cells, kind = "map" }) => {
    const now = Date.now();
    const toFetch: string[] = [];
    const waitFor: string[] = [];
    for (const cell of cells) {
      const lock = await ctx.db.query("cellLocks").withIndex("by_cell", (q) => q.eq("cell", cell)).unique();
      if (lock && lock.until > now) waitFor.push(cell);
      else toFetch.push(cell);
    }
    if (toFetch.length === 0) return { toFetch, waitFor, lockIds: [] };

    const minuteAgo = now - 60_000;
    const totalLimit = kind === "prefetch" ? MAX_PREFETCH_FETCHES_PER_MINUTE : MAX_FETCHES_PER_MINUTE_TOTAL;
    const total = (
      await ctx.db.query("overpassFetches").withIndex("by_at", (q) => q.gt("at", minuteAgo)).take(MAX_FETCHES_PER_MINUTE_TOTAL + MAX_PREFETCH_FETCHES_PER_MINUTE + 10)
    ).filter((f) => (f.kind ?? "map") === kind);
    const mine = await ctx.db
      .query("overpassFetches")
      .withIndex("by_slug_at", (q) => q.eq("slug", slug).gt("at", minuteAgo))
      .take(MAX_FETCHES_PER_MINUTE_PER_CAMPAIGN);
    if (total.length >= totalLimit || mine.length >= MAX_FETCHES_PER_MINUTE_PER_CAMPAIGN) {
      throw new ConvexError("Gerade werden sehr viele Häuser geladen. Bitte gleich noch einmal versuchen.");
    }
    await ctx.db.insert("overpassFetches", { slug, kind, at: now });
    // Altes Protokoll nebenbei aufräumen.
    for (const old of await ctx.db.query("overpassFetches").withIndex("by_at", (q) => q.lt("at", now - 3_600_000)).take(50)) {
      await ctx.db.delete(old._id);
    }

    // Jede Sperre ist ein neues Dokument; seine ID ist das Kennzeichen für `release`.
    const lockIds = [];
    for (const cell of toFetch) {
      const old = await ctx.db.query("cellLocks").withIndex("by_cell", (q) => q.eq("cell", cell)).unique();
      if (old) await ctx.db.delete(old._id);
      lockIds.push(await ctx.db.insert("cellLocks", { cell, until: now + lockMs() }));
    }
    return { toFetch, waitFor, lockIds };
  },
});

/**
 * Gibt die eigenen Sperren frei (nach dem Speichern oder nach einem Fehler). Eine inzwischen
 * abgelaufene und neu vergebene Sperre hat eine andere ID und bleibt stehen.
 */
export const release = internalMutation({
  args: { lockIds: v.array(v.id("cellLocks")) },
  handler: async (ctx, { lockIds }) => {
    for (const id of lockIds) {
      if (await ctx.db.get(id)) await ctx.db.delete(id);
    }
  },
});

/** Täglich: abgelaufene Kacheln aus dem Cache löschen (siehe crons.ts). */
export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - CACHE_TTL_MS;
    const old = await ctx.db.query("buildingCells").withIndex("by_fetchedAt", (q) => q.lt("fetchedAt", cutoff)).take(500);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === 500) await ctx.scheduler.runAfter(0, internal.buildings.cleanup, {});
  },
});

function endpoints(): string[] {
  const fromEnv = process.env.OVERPASS_URLS?.split(",").map((s) => s.trim()).filter(Boolean);
  return fromEnv?.length ? fromEnv : DEFAULT_ENDPOINTS;
}

async function fetchOverpass(bbox: [number, number, number, number]): Promise<BuildingFeature[]> {
  const problems: string[] = [];
  for (const url of endpoints()) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OVERPASS_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: buildQuery(bbox) }).toString(),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        problems.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { elements?: unknown[]; remark?: string };
      // Bei Zeitüberschreitung antwortet Overpass mit 200 und einem „remark“.
      if (json.remark && /error|timed out/i.test(json.remark)) {
        problems.push(`${url}: ${json.remark}`);
        continue;
      }
      return parseOverpass(json as Parameters<typeof parseOverpass>[0]);
    } catch (e) {
      problems.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  console.warn("Overpass nicht erreichbar", problems);
  throw new ConvexError("Die Gebäudedaten (OpenStreetMap) sind gerade nicht erreichbar. Bitte gleich noch einmal versuchen.");
}

/**
 * Lädt Kacheln aus dem Cache oder von Overpass (gesperrt, damit jede Kachel nur einmal
 * geladen wird). `rateKey` bestimmt das Kontingent pro Minute (Aktion oder Vorladen).
 * Erwartet geprüfte Kacheln. `fetched` sagt, ob Overpass gefragt wurde.
 */
async function loadCells(
  ctx: ActionCtx,
  rateKey: string,
  cells: string[],
  kind: "map" | "prefetch" = "map",
  { wait = true }: { wait?: boolean } = {},
): Promise<{ data: string[]; fetched: boolean }> {
  const have = new Map<string, string>();
  /** Veraltete Einträge (älter als 30 Tage oder altes Format). */
  const stale = new Map<string, string>();
  const readCache = async (wanted: string[]) => {
    const now = Date.now();
    for (const hit of await ctx.runQuery(internal.buildings.cached, { cells: wanted })) {
      if (now - hit.fetchedAt < CACHE_TTL_MS && hit.format === BUILDINGS_FORMAT) have.set(hit.cell, hit.data);
      else stale.set(hit.cell, hit.data);
    }
  };
  await readCache(cells);
  const missing = cells.filter((c) => !have.has(c));
  if (missing.length === 0) return { data: cells.map((c) => have.get(c)!), fetched: false };
  // Karte: Gibt es für alles einen veralteten Eintrag (älter als 30 Tage oder ohne Hausnummern),
  // sofort den zeigen und im Hintergrund auffrischen. Overpass braucht manchmal 30 s und mehr.
  if (kind === "map" && missing.every((c) => stale.has(c))) {
    await ctx.scheduler.runAfter(0, internal.buildings.refresh, { slug: rateKey, cells: missing });
    return { data: cells.map((c) => have.get(c) ?? stale.get(c)!), fetched: false };
  }

  const { toFetch, waitFor, lockIds } = await ctx.runMutation(internal.buildings.reserve, { slug: rateKey, cells: missing, kind });

  if (toFetch.length > 0) {
    try {
      const features = await fetchOverpass(cellsBBox(toFetch.map((c) => parseCellKey(c)!)));
      // Jedes Haus gehört genau zu der Kachel seines Mittelpunkts.
      const byCell = new Map<string, BuildingFeature[]>(toFetch.map((c) => [c, []]));
      for (const f of features) byCell.get(cellKeyOf(centerOf(f)))?.push(f);
      const entries = [...byCell].map(([cell, fs]) => ({ cell, data: encodeBuildings(fs) }));
      for (const e of entries) have.set(e.cell, e.data);
      // In Häppchen speichern, damit kein Aufruf zu groß wird; übergroße Kacheln nicht cachen.
      let batch: typeof entries = [];
      let size = 0;
      for (const e of entries.filter((e) => e.data.length < MAX_CACHE_BYTES)) {
        if (size + e.data.length > 4_000_000 && batch.length) {
          await ctx.runMutation(internal.buildings.store, { entries: batch });
          batch = [];
          size = 0;
        }
        batch.push(e);
        size += e.data.length;
      }
      if (batch.length) await ctx.runMutation(internal.buildings.store, { entries: batch });
    } finally {
      await ctx.runMutation(internal.buildings.release, { lockIds });
    }
  }

  // Kacheln, die gerade ein anderer Helfer lädt: auf seinen Cache-Eintrag warten.
  const started = Date.now();
  let pendingCells = wait ? waitFor : [];
  while (pendingCells.length > 0 && Date.now() - started < lockMs()) {
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    await readCache(pendingCells);
    pendingCells = pendingCells.filter((c) => !have.has(c));
  }
  if (pendingCells.length > 0) {
    throw new ConvexError("Die Häuser werden gerade geladen. Bitte gleich noch einmal versuchen.");
  }

  return { data: cells.map((c) => have.get(c) ?? "[]"), fetched: toFetch.length > 0 };
}

/**
 * Liefert die Häuser der angefragten Kacheln, in derselben Reihenfolge, je Kachel als
 * kompakter JSON-Text (siehe decodeBuildings).
 */
export const load = action({
  args: { slug: v.string(), cells: v.array(v.string()) },
  handler: async (ctx, { slug, cells }): Promise<string[]> => {
    if (cells.length === 0) return [];
    if (cells.length > MAX_CELLS_PER_LOAD) throw new ConvexError("Zu viele Kacheln auf einmal");
    const parsed = cells.map(parseCellKey);
    if (parsed.some((c) => c === null)) throw new ConvexError("Ungültige Kachel");
    // Nur ein zusammenhängendes Stück Karte, keine Abfrage über halbe Kontinente.
    const xs = parsed.map((c) => c!.x);
    const ys = parsed.map((c) => c!.y);
    if (Math.max(...xs) - Math.min(...xs) >= MAX_CELL_SPAN || Math.max(...ys) - Math.min(...ys) >= MAX_CELL_SPAN) {
      throw new ConvexError("Ausschnitt zu groß");
    }
    // Kein offener Proxy für Overpass: nur für bestehende Aktionen.
    if (!SLUG_PATTERN.test(slug) || !(await ctx.runQuery(internal.buildings.campaignExists, { slug }))) {
      throw new ConvexError("Verteilaktion nicht gefunden");
    }

    return (await loadCells(ctx, slug, cells)).data;
  },
});

/** Frischt veraltete Kacheln im Hintergrund auf (siehe loadCells), im Kontingent des Vorladens. */
export const refresh = internalAction({
  args: { slug: v.string(), cells: v.array(v.string()) },
  handler: async (ctx, { slug, cells }) => {
    try {
      // Kacheln, die gerade jemand lädt, überspringen statt warten.
      await loadCells(ctx, prefetchRateKey(slug), cells, "prefetch", { wait: false });
    } catch (e) {
      // Nicht schlimm: Beim nächsten Ansehen wird es wieder versucht.
      console.warn("Auffrischen fehlgeschlagen", e instanceof Error ? e.message : String(e));
    }
  },
});

// ---------------------------------------------------------------------------
// Vorladen: Beim Anlegen einer Aktion (oder per Knopf) lädt Convex im Hintergrund alle
// Häuser des gesuchten Ortes in den Cache, vom Ortsmittelpunkt nach außen, gebremst.
// ---------------------------------------------------------------------------

/** Pause zwischen zwei Overpass-Abrufen beim Vorladen (≈ 8 pro Minute). */
const PREFETCH_PAUSE_MS = 7_000;
/** Wartezeit nach einem Fehler, wächst mit jedem weiteren Fehler. */
const PREFETCH_RETRY_MS = 30_000;
const PREFETCH_MAX_FAILURES = 6;
/** Läuft ein Auftrag so lange nicht weiter, darf er neu gestartet werden. */
const PREFETCH_STALE_MS = 5 * 60_000;

/** Eigenes Kontingent pro Minute, damit das Vorladen Helfer auf der Karte nicht ausbremst. */
const prefetchRateKey = (slug: string) => `${slug}:vorladen`;

/**
 * Startet das Vorladen für eine Aktion, falls nicht schon eines läuft.
 * Wird von campaigns.create und vom Knopf im Teilen-Dialog aufgerufen.
 */
export async function startPrefetch(ctx: MutationCtx, slug: string) {
  const campaign = await ctx.db.query("campaigns").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
  if (!campaign) throw new ConvexError("Verteilaktion nicht gefunden");
  const now = Date.now();
  const existing = await ctx.db.query("prefetchJobs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
  if (existing && existing.status === "running" && now - existing.updatedAt < PREFETCH_STALE_MS) return existing._id;

  const batches = planPrefetch(prefetchArea(campaign), [campaign.center.lng, campaign.center.lat]);
  const job = {
    slug,
    // Nichts zu laden (z. B. alter, verdrehter Ausschnitt): gleich fertig statt ewig „läuft“.
    status: batches.length ? ("running" as const) : ("done" as const),
    batches,
    total: batches.reduce((n, b) => n + b.length, 0),
    done: 0,
    failures: 0,
    updatedAt: now,
    // Neue Laufnummer: Schritte einer älteren Kette werden ignoriert.
    run: (existing?.run ?? 0) + 1,
  };
  let jobId: Id<"prefetchJobs">;
  if (existing) {
    await ctx.db.replace(existing._id, job);
    jobId = existing._id;
  } else {
    jobId = await ctx.db.insert("prefetchJobs", job);
  }
  if (job.status === "running") await ctx.scheduler.runAfter(0, internal.buildings.prefetchStep, { jobId, run: job.run });
  return jobId;
}

/** Knopf „Gebiet vorladen“ im Teilen-Dialog. */
export const prefetch = mutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    if (!SLUG_PATTERN.test(slug)) throw new ConvexError("Verteilaktion nicht gefunden");
    await startPrefetch(ctx, slug);
  },
});

/** Fortschritt des Vorladens, live für den Teilen-Dialog. */
export const prefetchStatus = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    if (!SLUG_PATTERN.test(slug)) return null;
    const job = await ctx.db.query("prefetchJobs").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    if (!job) return null;
    // Ob ein Auftrag hängt, entscheidet der Browser anhand von updatedAt (eine Query wird
    // nur bei Datenänderung neu berechnet, nicht mit der Zeit).
    return { status: job.status, done: job.done, total: job.total, updatedAt: job.updatedAt, staleAfterMs: PREFETCH_STALE_MS };
  },
});

export const prefetchJob = internalQuery({
  args: { jobId: v.id("prefetchJobs") },
  handler: async (ctx, { jobId }) => await ctx.db.get(jobId),
});

/** Ergebnis eines Schritts festhalten und den nächsten einplanen. */
export const prefetchAdvance = internalMutation({
  args: { jobId: v.id("prefetchJobs"), run: v.number(), ok: v.boolean(), fetched: v.boolean() },
  handler: async (ctx, { jobId, run, ok, fetched }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status !== "running" || (job.run ?? 0) !== run) return;
    const now = Date.now();
    if (ok) {
      const [first, ...rest] = job.batches;
      const done = job.done + (first?.length ?? 0);
      if (rest.length === 0) {
        await ctx.db.patch(jobId, { batches: [], done, status: "done", failures: 0, updatedAt: now });
        return;
      }
      await ctx.db.patch(jobId, { batches: rest, done, failures: 0, updatedAt: now });
      // Kam alles aus dem Cache, gleich weiter; sonst Overpass eine Pause gönnen.
      await ctx.scheduler.runAfter(fetched ? PREFETCH_PAUSE_MS : 0, internal.buildings.prefetchStep, { jobId, run });
    } else {
      const failures = job.failures + 1;
      if (failures >= PREFETCH_MAX_FAILURES) {
        await ctx.db.patch(jobId, { status: "failed", failures, updatedAt: now });
        return;
      }
      await ctx.db.patch(jobId, { failures, updatedAt: now });
      await ctx.scheduler.runAfter(PREFETCH_RETRY_MS * failures, internal.buildings.prefetchStep, { jobId, run });
    }
  },
});

/** Ein Schritt: den nächsten Block laden. */
export const prefetchStep = internalAction({
  args: { jobId: v.id("prefetchJobs"), run: v.number() },
  handler: async (ctx, { jobId, run }) => {
    const job = await ctx.runQuery(internal.buildings.prefetchJob, { jobId });
    if (!job || job.status !== "running" || (job.run ?? 0) !== run || job.batches.length === 0) return;
    try {
      const { fetched } = await loadCells(ctx, prefetchRateKey(job.slug), job.batches[0], "prefetch");
      await ctx.runMutation(internal.buildings.prefetchAdvance, { jobId, run, ok: true, fetched });
    } catch (e) {
      console.warn("Vorladen: Block fehlgeschlagen", e instanceof Error ? e.message : e);
      await ctx.runMutation(internal.buildings.prefetchAdvance, { jobId, run, ok: false, fetched: false });
    }
  },
});
