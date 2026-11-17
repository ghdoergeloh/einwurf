// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { CELL_SIZE, decodeBuildings } from "./osm";
import { campaignAreas } from "./areaStore";
import { areaAt } from "./areaGeo";

const modules = import.meta.glob("./**/*.ts");
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
const ADMIN = "AdminSchluessel1234567";

type Ring = [number, number][];
const box = (w: number, s: number, e: number, n: number): Ring => [[w, s], [e, s], [e, n], [w, n], [w, s]];
/** Grenze als Relation mit Geometrie, Außenring in zwei Teilstücken (wie oft in OSM). */
function rel(id: number, name: string, tags: Record<string, string>, ring: Ring, hole?: Ring) {
  const half = Math.ceil(ring.length / 2);
  const way = (pts: Ring, role: string) => ({ type: "way", role, geometry: pts.map(([lon, lat]) => ({ lat, lon })) });
  const members = [way(ring.slice(0, half), "outer"), way(ring.slice(half - 1), "outer")];
  if (hole) members.push(way(hole, "inner"));
  return { type: "relation", id, tags: { name, ...tags }, members };
}
const admin = (level: number) => ({ boundary: "administrative", admin_level: String(level) });
const parent = (id: number, name: string, level: number, [w, s, e, n]: number[]) => ({
  type: "relation", id, tags: { name, ...admin(level) }, bounds: { minlon: w, minlat: s, maxlon: e, maxlat: n },
});

/**
 * Ort A, gegliedert wie Bornheim: Stadt (Stufe 8) mit vier Ortsteilen (Stufe 10), dazu ein
 * Nachbarort, dessen Ortsteil nur die Grenze berührt.
 */
const A = {
  bbox: [7.0, 50.7, 7.04, 50.72],
  center: { lng: 7.005, lat: 50.705 },
  parents: [parent(1, "NRW", 4, [6, 50, 9, 52]), parent(2, "Kreis", 6, [6.8, 50.5, 7.4, 51]), parent(100, "Bornheim", 8, [7.0, 50.7, 7.04, 50.72])],
  boundaries: [
    rel(100, "Bornheim", admin(8), box(7.0, 50.7, 7.04, 50.72)),
    rel(11, "Roisdorf", admin(10), box(7.0, 50.7, 7.02, 50.71)),
    rel(12, "Hersel", admin(10), box(7.02, 50.7, 7.04, 50.71)),
    rel(13, "Brenig", admin(10), box(7.0, 50.71, 7.02, 50.72)),
    rel(14, "Sechtem", admin(10), box(7.02, 50.71, 7.04, 50.72)),
    rel(99, "Nachbardorf", admin(10), box(7.04, 50.7, 7.06, 50.72)),
  ],
};

/**
 * Ort B, eine Großstadt: kreisfreie Stadt (Stufe 6) mit zwei Stadtbezirken (Stufe 9), die sie
 * ganz teilen; Stadtteile (Stufe 10) sind nur für einen Bezirk erfasst. Ein Bezirk hat ein Loch
 * (Enklave), in dem der andere liegt. Erwartet: die Stadtbezirke.
 */
const B = {
  bbox: [8.0, 51.0, 8.1, 51.1],
  center: { lng: 8.05, lat: 51.05 },
  parents: [parent(3, "Land", 4, [7, 50, 10, 53]), parent(200, "Großstadt", 6, [8.0, 51.0, 8.1, 51.1])],
  boundaries: [
    rel(200, "Großstadt", admin(6), box(8.0, 51.0, 8.1, 51.1)),
    rel(21, "Außenbezirk", admin(9), box(8.0, 51.0, 8.1, 51.1), box(8.04, 51.04, 8.06, 51.06)),
    rel(22, "Innenstadt", admin(9), box(8.04, 51.04, 8.06, 51.06)),
    rel(31, "Altstadt-Nord", admin(10), box(8.04, 51.05, 8.06, 51.06)),
    rel(32, "Altstadt-Süd", admin(10), box(8.04, 51.04, 8.06, 51.05)),
  ],
};

/** Ein Dorf, das OSM nicht unterteilt. */
const C = {
  bbox: [9.0, 52.0, 9.01, 52.01],
  center: { lng: 9.005, lat: 52.005 },
  parents: [parent(300, "Kleindorf", 8, [9.0, 52.0, 9.01, 52.01])],
  boundaries: [rel(300, "Kleindorf", admin(8), box(9.0, 52.0, 9.01, 52.01))],
};

type Place = typeof A | typeof C;
function overpassFor(place: Place) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const q = new URLSearchParams(String(init?.body)).get("data") ?? "";
    if (q.includes("is_in")) return Response.json({ elements: place.parents });
    if (q.includes("map_to_area")) return Response.json({ elements: place.boundaries });
    // Gebäude: ein Haus in jeder Kachel-Mitte des Ausschnitts
    const [s, w, n, e] = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/)!.slice(1).map(Number);
    const elements = [];
    let id = 1;
    for (let x = Math.floor(w / CELL_SIZE); x < Math.ceil(e / CELL_SIZE); x++)
      for (let y = Math.floor(s / CELL_SIZE); y < Math.ceil(n / CELL_SIZE); y++) {
        const lon = (x + 0.5) * CELL_SIZE, lat = (y + 0.5) * CELL_SIZE, d = 0.0001;
        elements.push({ type: "way", id: id++, geometry: [[-d, -d], [d, -d], [d, d], [-d, d], [-d, -d]].map(([a, b]) => ({ lon: lon + a, lat: lat + b })) });
      }
    return Response.json({ elements });
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function create(place: Place, { loadAreas = true } = {}) {
  vi.stubEnv("AREAS_ON_CREATE", loadAreas ? "on" : "off");
  const t = convexTest(schema, modules);
  await t.mutation(api.campaigns.create, {
    slug: SLUG, adminKey: ADMIN, name: "Test", placeLabel: "Ort, Kreis", center: place.center, bbox: place.bbox,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return t;
}
const names = async (t: ReturnType<typeof convexTest>) => (await t.query(api.areas.list, { slug: SLUG }))!.map((a) => a.name);

describe("Gebiete ermitteln", () => {
  test("Ort wie Bornheim: die Ortsteile, ohne Nachbarort", async () => {
    vi.stubGlobal("fetch", overpassFor(A));
    const t = await create(A);
    expect(await names(t)).toEqual(["Brenig", "Hersel", "Roisdorf", "Sechtem"]);
    expect(await t.query(api.areas.status, { slug: SLUG })).toMatchObject({ status: "done", whole: false, unselected: [] });
    const list = (await t.query(api.areas.list, { slug: SLUG }))!;
    expect(list.find((a) => a.name === "Hersel")).toMatchObject({ id: "relation/12", bbox: [7.02, 50.7, 7.04, 50.71] });
  });

  test("Großstadt: die Stadtbezirke (lückenlos), nicht die nur teilweise erfassten Stadtteile", async () => {
    vi.stubGlobal("fetch", overpassFor(B));
    const t = await create(B);
    expect(await names(t)).toEqual(["Außenbezirk", "Innenstadt"]);
    // Die Enklave gehört zur Innenstadt, nicht zum Außenbezirk.
    const areas = await t.run(async (ctx) => campaignAreas(ctx, (await ctx.db.query("campaigns").first())!._id));
    expect(areaAt([8.05, 51.05], areas!)?.name).toBe("Innenstadt");
    expect(areaAt([8.01, 51.01], areas!)?.name).toBe("Außenbezirk");
  });

  test("keine Unterteilung: der ganze Ort ist ein Gebiet, mit Hinweis", async () => {
    vi.stubGlobal("fetch", overpassFor(C));
    const t = await create(C);
    expect(await t.query(api.areas.list, { slug: SLUG })).toEqual([expect.objectContaining({ id: "ort", name: "Kleindorf" })]);
    expect(await t.query(api.areas.status, { slug: SLUG })).toMatchObject({ status: "done", whole: true });
  });

  test("Overpass überlastet: Ersatz-Server, dann mehrere Versuche, dann „failed“ und erneut versuchen", async () => {
    vi.stubEnv("OVERPASS_URLS", "https://eins.example/api,https://zwei.example/api");
    const good = overpassFor(A);
    const busy = vi.fn(async (url: string, init?: RequestInit) =>
      url.startsWith("https://eins") ? new Response("busy", { status: 429 }) : good(url, init),
    );
    vi.stubGlobal("fetch", busy);
    const t = await create(A);
    expect(await names(t)).toHaveLength(4);
    expect(busy.mock.calls.some((c) => String(c[0]).startsWith("https://zwei"))).toBe(true);

    const down = vi.fn(async () => new Response("busy", { status: 504 }));
    vi.stubGlobal("fetch", down);
    const t2 = await create(A);
    const failed = (await t2.query(api.areas.status, { slug: SLUG }))!;
    expect(failed).toMatchObject({ status: "failed" });
    // Die Antwort der Server steht für die Diagnose im Panel.
    expect(failed.lastError).toContain("https://eins.example/api: HTTP 504");
    expect(failed.lastError).toContain("https://zwei.example/api: HTTP 504");
    expect(await t2.query(api.areas.list, { slug: SLUG })).toEqual([]);
    vi.stubGlobal("fetch", overpassFor(A));
    await t2.mutation(api.areas.load, { adminKey: ADMIN });
    await t2.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await names(t2)).toHaveLength(4);
    expect((await t2.query(api.areas.status, { slug: SLUG }))!.lastError).toBeNull();
  });
});

describe("Admin-Link", () => {
  test("nur der Admin-Schlüssel ändert die Auswahl; der Bearbeiten-Schlüssel wird abgelehnt", async () => {
    vi.stubGlobal("fetch", overpassFor(A));
    const t = await create(A);
    await expect(t.mutation(api.areas.select, { adminKey: SLUG, ids: ["relation/12"], selected: false })).rejects.toThrow();
    await expect(t.mutation(api.areas.load, { adminKey: SLUG })).rejects.toThrow();
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["relation/12", "gibtsnicht"], selected: false });
    expect((await t.query(api.areas.status, { slug: SLUG }))!.unselected).toEqual(["relation/12"]);
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["relation/11", "relation/12", "relation/13", "relation/14"], selected: true });
    expect((await t.query(api.areas.status, { slug: SLUG }))!.unselected).toEqual([]);
  });

  test("der Admin-Schlüssel ist über den Bearbeiten-Link nicht zu erfahren", async () => {
    vi.stubGlobal("fetch", overpassFor(A));
    const t = await create(A);
    const results = [
      await t.query(api.campaigns.get, { slug: SLUG }),
      await t.query(api.areas.list, { slug: SLUG }),
      await t.query(api.areas.status, { slug: SLUG }),
      await t.query(api.buildings.prefetchStatus, { slug: SLUG }),
    ];
    for (const r of results) expect(JSON.stringify(r)).not.toContain(ADMIN);
    expect(await t.query(api.campaigns.get, { slug: SLUG })).toMatchObject({ role: "edit", slug: SLUG });
    // Mit dem Admin-Schlüssel: Rolle admin und der Bearbeiten-Schlüssel zum Weitergeben
    expect(await t.query(api.campaigns.get, { slug: ADMIN })).toMatchObject({ role: "admin", slug: SLUG });
  });

  test("Schlüssel dürfen nicht doppelt vergeben werden", async () => {
    const t = await create(A, { loadAreas: false });
    const base = { name: "X", placeLabel: "X", center: A.center };
    await expect(t.mutation(api.campaigns.create, { ...base, slug: "NeuerSchluessel12345678".slice(0, 22), adminKey: ADMIN })).rejects.toThrow();
    await expect(t.mutation(api.campaigns.create, { ...base, slug: ADMIN, adminKey: "NeuerSchluessel1234567" })).rejects.toThrow();
    await expect(t.mutation(api.campaigns.create, { ...base, slug: "NeuerSchluessel1234567", adminKey: "NeuerSchluessel1234567" })).rejects.toThrow();
  });

  test("Migration: ältere Aktionen bekommen einen eigenen Admin-Schlüssel", async () => {
    vi.useRealTimers();
    const t = convexTest(schema, modules);
    await t.mutation(api.campaigns.create, { slug: SLUG, name: "Alt", placeLabel: "Ort", center: A.center });
    await t.mutation(api.campaigns.create, { slug: "ZweiteAktion1234567890", name: "Alt 2", placeLabel: "Ort", center: A.center });
    expect(await t.action(internal.migrations.addAdminKeys, {})).toBe(2);
    expect(await t.action(internal.migrations.addAdminKeys, {})).toBe(0);
    const keys = await t.run(async (ctx) => (await ctx.db.query("campaigns").collect()).map((c) => c.adminKey));
    expect(keys.every((k) => /^[A-Za-z0-9]{22}$/.test(k!))).toBe(true);
    expect(new Set(keys).size).toBe(2);
    expect(await t.query(api.campaigns.get, { slug: keys[0]! })).toMatchObject({ role: "admin", slug: SLUG });
  });
});

describe("nur gewählte Gebiete", () => {
  // Kacheln: Roisdorf (7.00–7.02 / 50.70–50.71) und Hersel (7.02–7.04 / 50.70–50.71)
  const cellAt = (lng: number, lat: number) => `${Math.floor(lng / CELL_SIZE)}:${Math.floor(lat / CELL_SIZE)}`;
  const ROISDORF = cellAt(7.0075, 50.7025);
  const HERSEL = cellAt(7.0325, 50.7025);

  test("Häuser außerhalb werden weder von Overpass geladen noch ausgeliefert", async () => {
    vi.useRealTimers();
    const fetchMock = overpassFor(A);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("AREAS_ON_CREATE", "on");
    const t = convexTest(schema, modules);
    await t.mutation(api.campaigns.create, { slug: SLUG, adminKey: ADMIN, name: "T", placeLabel: "Ort", center: A.center, bbox: A.bbox });
    await t.finishAllScheduledFunctions(() => {});
    // Alles gewählt: beide Häuser
    let res = await t.action(api.buildings.load, { slug: SLUG, cells: [ROISDORF, HERSEL] });
    expect(res.map((d) => decodeBuildings(d).length)).toEqual([1, 1]);

    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["relation/12"], selected: false });
    res = await t.action(api.buildings.load, { slug: SLUG, cells: [ROISDORF, HERSEL] });
    expect(res.map((d) => decodeBuildings(d).length)).toEqual([1, 0]);

    // Nichts gewählt: wieder der ganze Ort, alle Häuser
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["relation/11", "relation/12", "relation/13", "relation/14"], selected: false });
    res = await t.action(api.buildings.load, { slug: SLUG, cells: [ROISDORF, HERSEL] });
    expect(res.map((d) => decodeBuildings(d).length)).toEqual([1, 1]);
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["relation/11", "relation/13"], selected: true });

    // Eine Kachel nur in abgewählten Gebieten: Overpass wird gar nicht gefragt.
    const before = fetchMock.mock.calls.length;
    const far = cellAt(7.0375, 50.7075); // Sechtem, noch nicht im Cache
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["relation/14"], selected: false });
    expect(await t.action(api.buildings.load, { slug: SLUG, cells: [far] })).toEqual(["[]"]);
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  test("Vorladen nur für Kacheln der gewählten Gebiete, neu geplant bei geänderter Auswahl", async () => {
    vi.stubEnv("PREFETCH_ON_CREATE", "on");
    const fetchMock = overpassFor(A);
    vi.stubGlobal("fetch", fetchMock);
    const t = await create(A);
    const all = (await t.query(api.buildings.prefetchStatus, { slug: SLUG }))!;
    expect(all.status).toBe("done");

    // Nur Roisdorf: 4 × 2 Kacheln (Ränder genau auf Kachelgrenzen; Nachbarkacheln berühren nur)
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["relation/12", "relation/13", "relation/14"], selected: false });
    const job = await t.run(async (ctx) => (await ctx.db.query("prefetchJobs").first())!);
    const planned = job.batches.flat();
    expect(planned).toContain(ROISDORF);
    expect(planned).not.toContain(HERSEL);
    expect(job.total).toBeLessThan(all.total);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.buildings.prefetchStatus, { slug: SLUG })).toMatchObject({ status: "done" });
  });
});
