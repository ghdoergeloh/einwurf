import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import {
  buildQuery,
  cellKeyOf,
  cellsBBox,
  centerOf,
  encodeBuildings,
  parseCellKey,
  parseOverpass,
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
const OVERPASS_TIMEOUT_MS = 30_000;
/** Öffentliche Overpass-Server, der Reihe nach. Überschreibbar mit der Convex-Umgebungsvariable OVERPASS_URLS. */
const DEFAULT_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const USER_AGENT = "Einwurf/1.0 (gemeinsame Flyer-Verteilkarte)";

export const campaignExists = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) =>
    !!(await ctx.db.query("campaigns").withIndex("by_slug", (q) => q.eq("slug", slug)).unique()),
});

export const cached = internalQuery({
  args: { cells: v.array(v.string()) },
  handler: async (ctx, { cells }) => {
    const out: { cell: string; data: string; fetchedAt: number }[] = [];
    for (const cell of cells) {
      const row = await ctx.db.query("buildingCells").withIndex("by_cell", (q) => q.eq("cell", cell)).unique();
      if (row) out.push({ cell, data: row.data, fetchedAt: row.fetchedAt });
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
      if (row) await ctx.db.patch(row._id, { data, fetchedAt: now });
      else await ctx.db.insert("buildingCells", { cell, data, fetchedAt: now });
    }
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
    // Kein offener Proxy für Overpass: nur für bestehende Aktionen.
    if (!SLUG_PATTERN.test(slug) || !(await ctx.runQuery(internal.buildings.campaignExists, { slug }))) {
      throw new ConvexError("Verteilaktion nicht gefunden");
    }

    const now = Date.now();
    const have = new Map<string, string>();
    for (const hit of await ctx.runQuery(internal.buildings.cached, { cells })) {
      if (now - hit.fetchedAt < CACHE_TTL_MS) have.set(hit.cell, hit.data);
    }
    const missing = cells.filter((c) => !have.has(c));

    if (missing.length > 0) {
      const features = await fetchOverpass(cellsBBox(missing.map((c) => parseCellKey(c)!)));
      // Jedes Haus gehört genau zu der Kachel seines Mittelpunkts.
      const byCell = new Map<string, BuildingFeature[]>(missing.map((c) => [c, []]));
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
    }

    return cells.map((c) => have.get(c) ?? "[]");
  },
});
