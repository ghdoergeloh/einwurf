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
import { campaignForRead } from "./access";

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
/**
 * So lange darf ein Overpass-Server brauchen. Die öffentlichen Server sind oft ausgelastet;
 * dann wartet eine Abfrage 20–40 s in der Warteschlange, egal wie klein sie ist.
 */
const OVERPASS_TIMEOUT_MS = 60_000;
/**
 * Antwortet ein Server so lange nicht, wird zusätzlich der nächste gefragt; die erste Antwort
 * gewinnt. Länger als eine übliche Antwort (20–30 s), damit nicht jeder Abruf alle Server belastet.
 */
const OVERPASS_HEDGE_MS = 35_000;
/** Ein weiterer Server lohnt nur, wenn bis zur Gesamtfrist noch so viel Zeit bleibt. */
const MIN_ATTEMPT_MS = 15_000;
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
const lockMs = () => (endpoints().length - 1) * OVERPASS_HEDGE_MS + OVERPASS_TIMEOUT_MS + 15_000;
/**
 * Muss Overpass gefragt werden, kommen bis zu so viele noch nicht geladene Nachbarkacheln mit:
 * Die Wartezeit hängt kaum von der Größe ab, und beim Weiterschieben ist dann alles sofort da.
 */
const MAX_FETCH_CELLS = 30;
const NEIGHBOUR_RING = 2;
const WAIT_POLL_MS = 1_000;

/**
 * Bearbeiten-Schlüssel der Aktion zu einem Bearbeiten- oder Ansehen-Schlüssel, oder null.
 * Nur intern: Er dient als Schlüssel des Kontingents, damit beide Links dasselbe teilen.
 */
export const rateKeyOf = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => (await campaignForRead(ctx, slug))?.campaign.slug ?? null,
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
  args: {
    slug: v.string(),
    cells: v.array(v.string()),
    kind: v.optional(v.union(v.literal("map"), v.literal("prefetch"))),
    /** Nachbarkacheln als Zugabe; nur, wenn ohnehin eine angefragte Kachel geladen wird. */
    extra: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { slug, cells, kind = "map", extra = [] }) => {
    const now = Date.now();
    const toFetch: string[] = [];
    const waitFor: string[] = [];
    const locked = async (cell: string) => {
      const lock = await ctx.db.query("cellLocks").withIndex("by_cell", (q) => q.eq("cell", cell)).unique();
      return !!lock && lock.until > now;
    };
    for (const cell of cells) {
      if (await locked(cell)) waitFor.push(cell);
      else toFetch.push(cell);
    }
    const until = now + lockMs();
    if (toFetch.length === 0) return { toFetch, waitFor, lockIds: [], until };
    for (const cell of extra) if (!cells.includes(cell) && !(await locked(cell))) toFetch.push(cell);

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
      lockIds.push(await ctx.db.insert("cellLocks", { cell, until }));
    }
    return { toFetch, waitFor, lockIds, until };
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

/** Ein Server, eine Abfrage. Wirft bei Fehler, Überlastung oder Laufzeitfehler von Overpass. */
async function askOverpass(url: string, query: string, signal: AbortSignal): Promise<BuildingFeature[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }).toString(),
    signal,
  });
  if (!res.ok) {
    // Antwort lesen, damit der Datenstrom sauber endet.
    await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}`);
  }
  const json = (await res.json()) as { elements?: unknown[]; remark?: string };
  // Bei Zeitüberschreitung antwortet Overpass mit 200 und einem „remark“.
  if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(json.remark);
  return parseOverpass(json as Parameters<typeof parseOverpass>[0]);
}

/**
 * Fragt die Server versetzt: zuerst den ersten; scheitert er oder antwortet er nicht innerhalb
 * von OVERPASS_HEDGE_MS, zusätzlich den nächsten. Die erste gültige Antwort gewinnt, die
 * anderen Abfragen werden abgebrochen. Ohne `hedge` (Vorladen, Auffrischen: keine Eile) kommt
 * der nächste Server nur nach einem Fehler dran.
 */
function fetchOverpass(
  bbox: [number, number, number, number],
  { hedge = true, lockedUntil }: { hedge?: boolean; lockedUntil: number },
): Promise<BuildingFeature[]> {
  const urls = endpoints();
  const query = buildQuery(bbox);
  const problems: string[] = [];
  /** Noch laufende Anfragen. Beendete nie abbrechen: Das bringt die Convex-Laufzeit zum Absturz. */
  const running = new Set<AbortController>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  return new Promise((resolve, reject) => {
    let next = 0;
    let done = false;
    // Gesamtfrist innerhalb der Sperre, auch wenn die Server nacheinander gefragt werden;
    // 15 s bleiben fürs Speichern.
    const deadline = lockedUntil - 15_000;
    const finish = () => {
      done = true;
      timers.forEach(clearTimeout);
      for (const c of running) c.abort();
      running.clear();
    };
    const launch = () => {
      const left = deadline - Date.now();
      if (done || next >= urls.length || left < MIN_ATTEMPT_MS) return false;
      const url = urls[next++];
      const ctrl = new AbortController();
      running.add(ctrl);
      const timeout = setTimeout(() => running.has(ctrl) && ctrl.abort(), Math.min(OVERPASS_TIMEOUT_MS, left));
      timers.push(timeout);
      const settle = () => {
        running.delete(ctrl);
        clearTimeout(timeout);
      };
      const hedgeTimer = hedge ? setTimeout(launch, OVERPASS_HEDGE_MS) : undefined;
      if (hedgeTimer) timers.push(hedgeTimer);
      askOverpass(url, query, ctrl.signal).then(
        (features) => {
          settle();
          if (done) return;
          finish();
          resolve(features);
        },
        (e: unknown) => {
          settle();
          if (done) return;
          problems.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
          if (hedgeTimer) clearTimeout(hedgeTimer);
          if (!launch() && running.size === 0) {
            finish();
            console.warn("Overpass nicht erreichbar", problems);
            reject(new ConvexError("Die Gebäudedaten (OpenStreetMap) sind gerade nicht erreichbar. Bitte gleich noch einmal versuchen."));
          }
        },
      );
      return true;
    };
    if (!launch()) {
      // Frist schon vorbei (z. B. Auffrischen kam spät dran): gar nicht erst fragen.
      finish();
      reject(new ConvexError("Die Gebäudedaten (OpenStreetMap) sind gerade nicht erreichbar. Bitte gleich noch einmal versuchen."));
    }
  });
}

/** Kacheln rund um die angefragten (bis NEIGHBOUR_RING), die nächsten zuerst, ohne die angefragten. */
function neighbours(cells: string[]): string[] {
  const parsed = cells.map((c) => parseCellKey(c)!);
  const xs = parsed.map((c) => c.x);
  const ys = parsed.map((c) => c.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const own = new Set(cells);
  const out: { key: string; d: number }[] = [];
  for (let x = x0 - NEIGHBOUR_RING; x <= x1 + NEIGHBOUR_RING; x++)
    for (let y = y0 - NEIGHBOUR_RING; y <= y1 + NEIGHBOUR_RING; y++) {
      const key = `${x}:${y}`;
      if (!own.has(key) && parseCellKey(key)) out.push({ key, d: Math.hypot(x - cx, y - cy) });
    }
  return out.sort((a, b) => a.d - b.d).map((c) => c.key);
}

/**
 * Lädt Kacheln aus dem Cache oder von Overpass (gesperrt, damit jede Kachel nur einmal
 * geladen wird). `rateKey` bestimmt das Kontingent pro Minute (Aktion oder Vorladen).
 * Erwartet geprüfte Kacheln. `fetched` sagt, ob Overpass gefragt wurde.
 */
/**
 * Holt reservierte Kacheln von Overpass, speichert sie im Cache und gibt die Sperren frei
 * (auch bei einem Fehler). Liefert die Daten je Kachel.
 */
async function fetchAndStore(
  ctx: ActionCtx,
  toFetch: string[],
  lockIds: Id<"cellLocks">[],
  { hedge, lockedUntil }: { hedge: boolean; lockedUntil: number },
): Promise<Map<string, string>> {
  try {
    const features = await fetchOverpass(cellsBBox(toFetch.map((c) => parseCellKey(c)!)), { hedge, lockedUntil });
    // Jedes Haus gehört genau zu der Kachel seines Mittelpunkts.
    const byCell = new Map<string, BuildingFeature[]>(toFetch.map((c) => [c, []]));
    for (const f of features) byCell.get(cellKeyOf(centerOf(f)))?.push(f);
    const entries = [...byCell].map(([cell, fs]) => ({ cell, data: encodeBuildings(fs) }));
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
    return new Map(entries.map((e) => [e.cell, e.data]));
  } finally {
    await ctx.runMutation(internal.buildings.release, { lockIds });
  }
}

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
    // Schon jetzt reservieren: Wer dasselbe Gebiet gleich danach öffnet, sieht die Sperre
    // und plant kein zweites Auffrischen ein. Im Kontingent des Vorladens.
    let r;
    try {
      r = await ctx.runMutation(internal.buildings.reserve, { slug: prefetchRateKey(rateKey), cells: missing, kind: "prefetch" });
    } catch {
      // Kontingent erschöpft: beim nächsten Ansehen wieder.
    }
    if (r?.toFetch.length) {
      try {
        await ctx.scheduler.runAfter(0, internal.buildings.refresh, { slug: rateKey, cells: r.toFetch, lockIds: r.lockIds, lockedUntil: r.until });
      } catch (e) {
        await ctx.runMutation(internal.buildings.release, { lockIds: r.lockIds });
        throw e;
      }
    }
    return { data: cells.map((c) => have.get(c) ?? stale.get(c)!), fetched: false };
  }

  // Karte: Nachbarkacheln ohne gültigen Cache-Eintrag gleich mitladen (siehe MAX_FETCH_CELLS).
  let extra: string[] = [];
  if (kind === "map" && missing.length < MAX_FETCH_CELLS) {
    const candidates = neighbours(missing);
    const fresh = new Set(
      (await ctx.runQuery(internal.buildings.cached, { cells: candidates }))
        .filter((h) => Date.now() - h.fetchedAt < CACHE_TTL_MS && h.format === BUILDINGS_FORMAT)
        .map((h) => h.cell),
    );
    extra = candidates.filter((c) => !fresh.has(c)).slice(0, MAX_FETCH_CELLS - missing.length);
  }
  const { toFetch, waitFor, lockIds, until } = await ctx.runMutation(internal.buildings.reserve, { slug: rateKey, cells: missing, kind, extra });

  if (toFetch.length > 0) {
    for (const [cell, data] of await fetchAndStore(ctx, toFetch, lockIds, { hedge: kind === "map", lockedUntil: until })) have.set(cell, data);
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
 * kompakter JSON-Text (siehe decodeBuildings). Mit Bearbeiten- oder Ansehen-Schlüssel,
 * beide im Kontingent der Aktion.
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
    const rateKey = SLUG_PATTERN.test(slug) ? await ctx.runQuery(internal.buildings.rateKeyOf, { slug }) : null;
    if (!rateKey) throw new ConvexError("Verteilaktion nicht gefunden");

    return (await loadCells(ctx, rateKey, cells)).data;
  },
});

/** Frischt veraltete Kacheln im Hintergrund auf (siehe loadCells), im Kontingent des Vorladens. */
export const refresh = internalAction({
  args: {
    slug: v.string(),
    cells: v.array(v.string()),
    lockIds: v.optional(v.array(v.id("cellLocks"))),
    /** Ablauf der Sperren aus dem Einplanen; die Frist des Abrufs richtet sich danach. */
    lockedUntil: v.optional(v.number()),
  },
  handler: async (ctx, { slug, cells, lockIds, lockedUntil }) => {
    try {
      // Schon reserviert (siehe loadCells): direkt laden. Sonst wie beim Vorladen, ohne zu warten.
      if (lockIds) await fetchAndStore(ctx, cells, lockIds, { hedge: false, lockedUntil: lockedUntil ?? Date.now() + lockMs() });
      else await loadCells(ctx, prefetchRateKey(slug), cells, "prefetch", { wait: false });
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

/** Knopf „Gebiet vorladen“ im Teilen-Dialog. Nur mit dem Bearbeiten-Schlüssel (startPrefetch sucht per slug). */
export const prefetch = mutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    if (!SLUG_PATTERN.test(slug)) throw new ConvexError("Verteilaktion nicht gefunden");
    await startPrefetch(ctx, slug);
  },
});

/** Fortschritt des Vorladens, live für den Teilen-Dialog. Nur mit dem Bearbeiten-Schlüssel. */
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
