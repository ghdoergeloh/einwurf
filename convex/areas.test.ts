// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { CELL_SIZE, decodeBuildings } from "./osm";
import { campaignAreas } from "./areaStore";
import { areaAt, boundaryTileOf, touchedCells } from "./areaGeo";
import { markCellOf } from "./cells";

const modules = import.meta.glob("./**/*.ts");
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
const ADMIN = "AdminSchluessel1234567";
const VIEW = "AnsehenSchluessel12345";

type Ring = [number, number][];
const box = (w: number, s: number, e: number, n: number): Ring => [[w, s], [e, s], [e, n], [w, n], [w, s]];
/** Grenze als Relation mit Geometrie, Außenring in zwei Teilstücken (wie oft in OSM). */
function rel(id: number, name: string, level: number, ring: Ring, hole?: Ring) {
  const half = Math.ceil(ring.length / 2);
  const way = (pts: Ring, role: string) => ({ type: "way", role, geometry: pts.map(([lon, lat]) => ({ lat, lon })) });
  const members = [way(ring.slice(0, half), "outer"), way(ring.slice(half - 1), "outer")];
  if (hole) members.push(way(hole, "inner"));
  return { type: "relation", id, tags: { name, boundary: "administrative", admin_level: String(level) }, members };
}

/**
 * Drei Gemeinden nebeneinander (Grenz-Kacheln sind 0,05° breit, 7,00–7,05 und 7,05–7,10):
 *  - Bornheim (Stufe 8) mit vier Ortsteilen (Stufe 10),
 *  - Alfter (Stufe 8) mit zwei Ortsteilen (Stufe 9),
 *  - Bonn, kreisfreie Stadt (Stufe 6), mit zwei Bezirken (Stufe 9).
 * Dazu der Kreis (Stufe 6), der Bornheim und Alfter enthält und selbst kein Angebot ist.
 */
const REGION = [
  rel(1, "Rhein-Sieg-Kreis", 6, box(6.99, 50.69, 7.081, 50.73)),
  rel(100, "Bornheim", 8, box(7.0, 50.7, 7.04, 50.72)),
  rel(11, "Roisdorf", 10, box(7.0, 50.7, 7.02, 50.71)),
  rel(12, "Hersel", 10, box(7.02, 50.7, 7.04, 50.71)),
  rel(13, "Brenig", 10, box(7.0, 50.71, 7.02, 50.72)),
  rel(14, "Sechtem", 10, box(7.02, 50.71, 7.04, 50.72)),
  rel(200, "Alfter", 8, box(7.04, 50.7, 7.08, 50.72)),
  rel(21, "Alfter-Ort", 9, box(7.04, 50.7, 7.06, 50.72)),
  rel(22, "Witterschlick", 9, box(7.06, 50.7, 7.08, 50.72)),
  rel(300, "Bonn", 6, box(7.08, 50.7, 7.12, 50.72)),
  rel(31, "Beuel", 9, box(7.08, 50.7, 7.1, 50.72)),
  rel(32, "Bad Godesberg", 9, box(7.1, 50.7, 7.12, 50.72)),
];
const ROISDORF_POINT = { lng: 7.005, lat: 50.705 };
const TILE_WEST = boundaryTileOf(7.01, 50.71); // 7,00–7,05: Bornheim und Teil von Alfter
const TILE_EAST = boundaryTileOf(7.07, 50.71); // 7,05–7,10: Alfter und Teil von Bonn

function bounds(r: ReturnType<typeof rel>) {
  const pts = r.members.flatMap((m) => m.geometry);
  const lons = pts.map((p) => p.lon);
  const lats = pts.map((p) => p.lat);
  return { minlon: Math.min(...lons), minlat: Math.min(...lats), maxlon: Math.max(...lons), maxlat: Math.max(...lats) };
}

/** Overpass wie echt: „out tags bb“ nach Stufen und Ausschnitt, „rel(id:…)“ mit Geometrie, sonst Häuser. */
function fakeOverpass(relations = REGION) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const q = new URLSearchParams(String(init?.body)).get("data") ?? "";
    const ids = q.match(/rel\(id:([\d,]+)\)/);
    if (ids) {
      const wanted = new Set(ids[1].split(",").map(Number));
      return Response.json({ elements: relations.filter((r) => wanted.has(r.id)) });
    }
    if (q.includes("out tags bb")) {
      const levels = new Set((q.match(/admin_level~"\^\(([\d|]+)\)\$"/)?.[1] ?? "").split("|"));
      const [s, w, n, e] = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/)!.slice(1).map(Number);
      const elements = relations
        .map((r) => ({ r, b: bounds(r) }))
        .filter(({ r, b }) => levels.has(r.tags.admin_level) && b.minlon <= e && b.maxlon >= w && b.minlat <= n && b.maxlat >= s)
        .map(({ r, b }) => ({ type: "relation", id: r.id, tags: r.tags, bounds: b }));
      return Response.json({ elements });
    }
    // Häuser: eins in jeder Kachel-Mitte des Ausschnitts
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

async function create({ initial = false } = {}) {
  vi.stubEnv("AREAS_ON_CREATE", initial ? "on" : "off");
  const t = convexTest(schema, modules);
  await t.mutation(api.campaigns.create, {
    slug: SLUG, adminKey: ADMIN, viewKey: VIEW, name: "Test", placeLabel: "EFB, Bornheim", center: ROISDORF_POINT,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return t;
}
const nearbyNames = async (t: ReturnType<typeof convexTest>, tiles: string[]) =>
  (await t.query(api.areas.nearby, { adminKey: ADMIN, tiles })).areas.map((a) => a.name).sort();
const selected = async (t: ReturnType<typeof convexTest>) =>
  (await t.query(api.areas.list, { slug: SLUG }))!.filter((a) => a.selected).map((a) => a.name).sort();

describe("Angebot an Ortsteilen je Grenz-Kachel", () => {
  test("über Gemeindegrenzen hinweg, je Gemeinde ihre Ortsteile; der Kreis ist kein Angebot", async () => {
    vi.stubGlobal("fetch", fakeOverpass());
    const t = await create();
    expect(await t.query(api.areas.nearby, { adminKey: ADMIN, tiles: [TILE_WEST] })).toEqual({ loaded: [], areas: [] });
    await t.action(api.areas.loadTiles, { adminKey: ADMIN, tiles: [TILE_WEST] });
    // Westkachel: Bornheim ganz, Alfter ragt hinein
    expect(await nearbyNames(t, [TILE_WEST])).toEqual(["Alfter-Ort", "Brenig", "Hersel", "Roisdorf", "Sechtem", "Witterschlick"]);
    // Ostkachel: Alfter und die kreisfreie Stadt Bonn mit ihren Bezirken
    await t.action(api.areas.loadTiles, { adminKey: ADMIN, tiles: [TILE_EAST] });
    expect(await nearbyNames(t, [TILE_EAST])).toEqual(["Alfter-Ort", "Bad Godesberg", "Beuel", "Witterschlick"]);
  });

  test("Cache für alle Aktionen: eine geladene Kachel und bekannte Gemeinden werden nicht neu abgefragt", async () => {
    const fetchMock = fakeOverpass();
    vi.stubGlobal("fetch", fetchMock);
    const t = await create();
    await t.action(api.areas.loadTiles, { adminKey: ADMIN, tiles: [TILE_WEST] });
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBe(3); // Gemeinden, Ortsteil-Liste, Grenzen
    await t.action(api.areas.loadTiles, { adminKey: ADMIN, tiles: [TILE_WEST] });
    expect(fetchMock.mock.calls.length).toBe(calls);
    // Ostkachel: Alfter ist bekannt, nur Bonn wird mit Grenzen geladen
    await t.action(api.areas.loadTiles, { adminKey: ADMIN, tiles: [TILE_EAST] });
    const geometryQuery = fetchMock.mock.calls
      .map((c) => new URLSearchParams(String((c[1] as RequestInit).body)).get("data")!)
      .filter((q) => q.includes("rel(id:"))
      .pop()!;
    expect(geometryQuery).toContain("300");
    expect(geometryQuery).not.toMatch(/\b200\b/);
  });

  test("Overpass überlastet: Fehler mit der Antwort der Server, nur Hostnamen", async () => {
    vi.stubEnv("OVERPASS_URLS", "https://eins.example/api?key=GEHEIM,https://zwei.example/api");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 504 })));
    const t = await create();
    const err = await t.action(api.areas.loadTiles, { adminKey: ADMIN, tiles: [TILE_WEST] }).catch((e: Error) => e);
    expect(String(err)).toContain("Gemeinden");
    expect(String(err)).toContain("eins.example: HTTP 504");
    expect(String(err)).toContain("zwei.example: HTTP 504");
    expect(String(err)).not.toContain("GEHEIM");
    expect(await t.query(api.areas.nearby, { adminKey: ADMIN, tiles: [TILE_WEST] })).toEqual({ loaded: [], areas: [] });
  });

  test("zu große Antwort wird vor dem Parsen verworfen", async () => {
    vi.stubEnv("OVERPASS_URLS", "https://gross.example/api");
    const huge = "x".repeat(40_000_001);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(huge)));
    const t = await create();
    const err = await t.action(api.areas.loadTiles, { adminKey: ADMIN, tiles: [TILE_WEST] }).catch((e: Error) => e);
    expect(String(err)).toContain("gross.example: Antwort zu groß (40 MB)");
  });
});

describe("Auswahl", () => {
  test("beim Anlegen: der Ortsteil an der Adresse ist gewählt", async () => {
    vi.stubGlobal("fetch", fakeOverpass());
    const t = await create({ initial: true });
    expect(await selected(t)).toEqual(["Roisdorf"]);
  });

  test("Ortsteile verschiedener Gemeinden wählen; abwählen behält die Daten", async () => {
    vi.stubGlobal("fetch", fakeOverpass());
    const t = await create({ initial: true });
    await t.action(api.areas.loadTiles, { adminKey: ADMIN, tiles: [TILE_WEST, TILE_EAST] });
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["relation/22", "relation/31"], selected: true });
    expect(await selected(t)).toEqual(["Beuel", "Roisdorf", "Witterschlick"]);

    // Eine Markierung in Roisdorf, dann Roisdorf abwählen: Gebiet und Markierung bleiben gespeichert
    const house = [7.005, 50.705];
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", status: "done", center: house });
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["relation/11"], selected: false });
    expect(await selected(t)).toEqual(["Beuel", "Witterschlick"]);
    const list = (await t.query(api.areas.list, { slug: SLUG }))!;
    expect(list.find((a) => a.name === "Roisdorf")).toMatchObject({ selected: false });
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: markCellOf(house[0], house[1]) })).toHaveLength(1);
    // Wieder anwählen geht ohne Overpass
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["relation/11"], selected: true });
    expect(await selected(t)).toContain("Roisdorf");

    // Schnittstelle für die Statistik (#4): alle Gebiete mit Auswahl, Zuordnung per Punkt
    const areas = await t.run(async (ctx) => campaignAreas(ctx, (await ctx.db.query("campaigns").first())!._id));
    expect(areaAt([7.07, 50.71], areas!)?.name).toBe("Witterschlick");
    expect(areas!.map((a) => [a.name, a.selected])).toEqual([["Beuel", true], ["Roisdorf", true], ["Witterschlick", true]]);
  });

  test("scheitert das Vorwählen beim Anlegen, holt es das erste Laden im Bearbeiten-Modus nach (S4)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 504 })));
    const t = await create({ initial: true });
    expect(await selected(t)).toEqual([]);
    vi.stubGlobal("fetch", fakeOverpass());
    await t.action(api.areas.loadTiles, { adminKey: ADMIN, tiles: [TILE_WEST] });
    expect(await selected(t)).toEqual(["Roisdorf"]);
    // Hat die Aktion schon Gebiete (auch abgewählte), wählt Laden nichts mehr von selbst.
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["relation/11"], selected: false });
    await t.action(api.areas.loadTiles, { adminKey: ADMIN, tiles: [TILE_WEST] });
    expect(await selected(t)).toEqual([]);
  });

  test("unbekannter Ortsteil wird abgelehnt", async () => {
    vi.stubGlobal("fetch", fakeOverpass());
    const t = await create();
    await expect(t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["relation/999"], selected: true })).rejects.toThrow(/gibt es nicht/);
  });
});

describe("Admin-Link", () => {
  test("nur der Admin-Schlüssel lädt, sieht das Angebot und wählt; andere Schlüssel werden abgelehnt", async () => {
    vi.stubGlobal("fetch", fakeOverpass());
    const t = await create();
    await t.action(api.areas.loadTiles, { adminKey: ADMIN, tiles: [TILE_WEST] });
    for (const key of [SLUG, VIEW]) {
      await expect(t.action(api.areas.loadTiles, { adminKey: key, tiles: [TILE_WEST] })).rejects.toThrow(/Admin-Link/);
      await expect(t.query(api.areas.nearby, { adminKey: key, tiles: [TILE_WEST] })).rejects.toThrow(/Admin-Link/);
      await expect(t.mutation(api.areas.select, { adminKey: key, ids: ["relation/11"], selected: true })).rejects.toThrow(/Admin-Link/);
      await expect(
        t.mutation(api.campaigns.setPlace, { adminKey: key, placeLabel: "X", center: { lat: 50, lng: 7 } }),
      ).rejects.toThrow(/Admin-Link/);
    }
    // Nur das Laden mit dem Admin-Schlüssel hat den Ortsteil an der Adresse gewählt, sonst nichts.
    expect(await selected(t)).toEqual(["Roisdorf"]);
  });

  test("Mittelpunkt nachträglich ändern", async () => {
    const t = await create();
    await t.mutation(api.campaigns.setPlace, {
      adminKey: ADMIN, placeLabel: "Neuer Treffpunkt, Alfter", center: { lat: 50.71, lng: 7.05 }, bbox: [7.049, 50.709, 7.051, 50.711],
    });
    expect(await t.query(api.campaigns.get, { slug: SLUG })).toMatchObject({
      placeLabel: "Neuer Treffpunkt, Alfter", center: { lat: 50.71, lng: 7.05 }, bbox: [7.049, 50.709, 7.051, 50.711],
    });
    await expect(t.mutation(api.campaigns.setPlace, { adminKey: ADMIN, placeLabel: "X", center: { lat: 99, lng: 7 } })).rejects.toThrow();
  });

  test("der Admin-Schlüssel ist über den Bearbeiten-Link nicht zu erfahren", async () => {
    vi.stubGlobal("fetch", fakeOverpass());
    const t = await create({ initial: true });
    const results = [
      await t.query(api.campaigns.get, { slug: SLUG }),
      await t.query(api.areas.list, { slug: SLUG }),
      await t.query(api.buildings.prefetchStatus, { slug: SLUG }),
    ];
    for (const r of results) expect(JSON.stringify(r)).not.toContain(ADMIN);
    expect(await t.query(api.campaigns.get, { slug: SLUG })).toMatchObject({ role: "edit", slug: SLUG });
    expect(await t.query(api.campaigns.get, { slug: ADMIN })).toMatchObject({ role: "admin", slug: SLUG });
  });

  test("Schlüssel dürfen nicht doppelt vergeben werden", async () => {
    const t = await create();
    const base = { name: "X", placeLabel: "X", center: ROISDORF_POINT };
    await expect(t.mutation(api.campaigns.create, { ...base, slug: "NeuerSchluessel1234567", adminKey: ADMIN })).rejects.toThrow();
    await expect(t.mutation(api.campaigns.create, { ...base, slug: ADMIN, adminKey: "NeuerSchluessel1234567" })).rejects.toThrow();
    await expect(t.mutation(api.campaigns.create, { ...base, slug: "NeuerSchluessel1234567", adminKey: "NeuerSchluessel1234567" })).rejects.toThrow();
  });

  test("Migration: ältere Aktionen bekommen einen eigenen Admin-Schlüssel", async () => {
    vi.useRealTimers();
    const t = convexTest(schema, modules);
    await t.mutation(api.campaigns.create, { slug: SLUG, name: "Alt", placeLabel: "Ort", center: ROISDORF_POINT });
    await t.mutation(api.campaigns.create, { slug: "ZweiteAktion1234567890", name: "Alt 2", placeLabel: "Ort", center: ROISDORF_POINT });
    expect(await t.action(internal.migrations.addAdminKeys, {})).toBe(2);
    expect(await t.action(internal.migrations.addAdminKeys, {})).toBe(0);
    const keys = await t.run(async (ctx) => (await ctx.db.query("campaigns").collect()).map((c) => c.adminKey));
    expect(keys.every((k) => /^[A-Za-z0-9]{22}$/.test(k!))).toBe(true);
    expect(new Set(keys).size).toBe(2);
    expect(await t.query(api.campaigns.get, { slug: keys[0]! })).toMatchObject({ role: "admin", slug: SLUG });
  });
});

describe("nur gewählte Gebiete", () => {
  const cellAt = (lng: number, lat: number) => `${Math.floor(lng / CELL_SIZE)}:${Math.floor(lat / CELL_SIZE)}`;
  const ROISDORF = cellAt(7.0075, 50.7025);
  const HERSEL = cellAt(7.0325, 50.7025);
  const WITTERSCHLICK = cellAt(7.0675, 50.7025);

  test("Häuser außerhalb werden weder von Overpass geladen noch ausgeliefert, über Gemeindegrenzen hinweg", async () => {
    vi.useRealTimers();
    const fetchMock = fakeOverpass();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("AREAS_ON_CREATE", "off");
    const t = convexTest(schema, modules);
    await t.mutation(api.campaigns.create, { slug: SLUG, adminKey: ADMIN, name: "T", placeLabel: "Ort", center: ROISDORF_POINT });
    // Noch nichts gewählt: der ganze Ort wie bisher
    let res = await t.action(api.buildings.load, { slug: SLUG, cells: [ROISDORF, HERSEL] });
    expect(res.map((d) => decodeBuildings(d).length)).toEqual([1, 1]);

    await t.action(api.areas.loadTiles, { adminKey: ADMIN, tiles: [TILE_WEST, TILE_EAST] });
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["relation/11", "relation/22"], selected: true });
    res = await t.action(api.buildings.load, { slug: SLUG, cells: [ROISDORF, HERSEL] });
    expect(res.map((d) => decodeBuildings(d).length)).toEqual([1, 0]);
    res = await t.action(api.buildings.load, { slug: SLUG, cells: [WITTERSCHLICK] });
    expect(res.map((d) => decodeBuildings(d).length)).toEqual([1]);

    // Eine Kachel nur in nicht gewählten Gebieten: Overpass wird gar nicht gefragt.
    const before = fetchMock.mock.calls.length;
    expect(await t.action(api.buildings.load, { slug: SLUG, cells: [cellAt(7.0375, 50.7175)] })).toEqual(["[]"]);
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  test("Vorladen nur für Kacheln der gewählten Gebiete, neu geplant bei geänderter Auswahl", async () => {
    vi.stubEnv("PREFETCH_ON_CREATE", "on");
    vi.stubGlobal("fetch", fakeOverpass());
    const t = await create({ initial: true });
    expect(await t.query(api.buildings.prefetchStatus, { slug: SLUG })).toMatchObject({ status: "done" });
    const planned = async () => (await t.run(async (ctx) => (await ctx.db.query("prefetchJobs").first())!)).total;
    // Roisdorf: 4 × 2 Kacheln, dazu die, deren Kante seine Grenze berührt
    const cellsOf = (w: number, s: number, e: number, n: number) => touchedCells([[box(w, s, e, n)]]).length;
    expect(await planned()).toBe(cellsOf(7.0, 50.7, 7.02, 50.71));
    await t.action(api.areas.loadTiles, { adminKey: ADMIN, tiles: [TILE_EAST] });
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["relation/22"], selected: true });
    const job = await t.run(async (ctx) => (await ctx.db.query("prefetchJobs").first())!);
    expect(job.total).toBe(new Set([...touchedCells([[box(7.0, 50.7, 7.02, 50.71)]]), ...touchedCells([[box(7.06, 50.7, 7.08, 50.72)]])]).size);
    expect(job.batches.flat()).toContain(WITTERSCHLICK);
    expect(job.batches.flat()).not.toContain(HERSEL);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.buildings.prefetchStatus, { slug: SLUG })).toMatchObject({ status: "done" });
  });
});
