// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { BUILDINGS_FORMAT, cellKeyOf, encodeBuildings, type BuildingFeature } from "./osm";
import { bboxOf, boundaryTileOf, encodeCells, touchedCells, type AreaGeometry } from "./areaGeo";

const modules = import.meta.glob("./**/*.ts");
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
const ADMIN = "AdminSchluessel1234567";
const VIEW_KEY = "AnsehenSchluessel12345";

type T = ReturnType<typeof convexTest>;
const box = (w: number, s: number, e: number, n: number): AreaGeometry => [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]];

// Zwei Gebiete nebeneinander, Grenze bei Länge 7.0125 (mitten durch Kacheln von 0,005°), dazu ein drittes weiter östlich.
const SPLIT = 7.0125;
const WEST = box(7.0, 50.7, SPLIT, 50.71);
const EAST = box(SPLIT, 50.7, 7.02, 50.71);
const FAR = box(7.05, 50.7, 7.06, 50.71);

function house(id: string, [x, y]: [number, number]): BuildingFeature {
  const d = 0.00002;
  return {
    type: "Feature",
    id,
    properties: { osmId: id },
    geometry: { type: "MultiPolygon", coordinates: [[[[x - d, y - d], [x + d, y - d], [x + d, y + d], [x - d, y + d], [x - d, y - d]]]] },
  };
}

/** Häuser im Raster (alle 0,002°) in [w, s, e, n]; Mittelpunkte nie genau auf einer Grenze. */
function grid([w, s, e, n]: number[]): BuildingFeature[] {
  const out: BuildingFeature[] = [];
  for (let x = w + 0.0007; x < e; x += 0.002) for (let y = s + 0.0007; y < n; y += 0.002) out.push(house(`way/${Math.round(x * 1e5)}${Math.round(y * 1e5)}`, [x, y]));
  return out;
}

/** Häuser in den Cache legen; Kacheln der Gebiete `fill` ohne Häuser als leere Einträge (wie nach einem Abruf). */
async function storeHouses(t: T, features: BuildingFeature[], fill: AreaGeometry[] = []) {
  const byCell = new Map<string, BuildingFeature[]>();
  for (const f of features) {
    const c = f.geometry.coordinates[0][0][0];
    const key = cellKeyOf([c[0] + 0.00002, c[1] + 0.00002]);
    byCell.set(key, [...(byCell.get(key) ?? []), f]);
  }
  await t.run(async (ctx) => {
    for (const [cell, fs] of byCell) {
      await ctx.db.insert("buildingCells", { cell, fetchedAt: Date.now(), data: encodeBuildings(fs), format: BUILDINGS_FORMAT });
    }
    for (const cell of new Set(fill.flatMap(touchedCells))) {
      if (!byCell.has(cell)) await ctx.db.insert("buildingCells", { cell, fetchedAt: Date.now(), data: "[]", format: BUILDINGS_FORMAT });
    }
  });
}

/**
 * Gebiete in den gemeinsamen Cache legen (Laden selbst testet areas.test.ts) und wie der Admin
 * wählen; `unselected` danach wieder abwählen (bleiben als „nicht gewählt“ in der Aktion).
 */
async function addAreas(t: T, areas: [string, string, AreaGeometry][], unselected: string[] = []) {
  await t.run(async (ctx) => {
    for (const [areaId, name, g] of areas) {
      await ctx.db.insert("osmAreas", {
        areaId,
        unitId: 1,
        name,
        geometry: JSON.stringify(g),
        bbox: bboxOf(g),
        labelAt: [bboxOf(g)[0], bboxOf(g)[1]],
        cells: encodeCells(touchedCells(g)),
        fetchedAt: Date.now(),
      });
    }
  });
  await t.mutation(api.areas.select, { adminKey: ADMIN, ids: areas.map(([id]) => id), selected: true });
  if (unselected.length) await t.mutation(api.areas.select, { adminKey: ADMIN, ids: unselected, selected: false });
}

/** Aktion mit Gebieten. */
async function setup(t: T, areas: [string, string, AreaGeometry][], unselected: string[] = []) {
  const campaignId = await t.run(async (ctx) => {
    return await ctx.db.insert("campaigns", {
      slug: SLUG,
      adminKey: ADMIN,
      name: "Test",
      placeLabel: "Testort",
      center: { lat: 50.705, lng: 7.005 },
      markCount: 0,
      blockedCount: 0,
    });
  });
  await addAreas(t, areas, unselected);
  return campaignId;
}

const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const stats = (t: T, key = SLUG) => t.query(api.stats.byArea, { slug: key });
const row = async (t: T, id: string) => (await stats(t))!.areas!.rows.find((r) => r.id === id)!;
const tap = (t: T, osmId: string, center: [number, number], status: "none" | "done" | "blocked") =>
  t.mutation(api.marks.set, { slug: SLUG, osmId, center, status });

beforeEach(() => {
  vi.useFakeTimers();
  // Vorladen holt nichts von Overpass: Alle Kacheln der Tests liegen schon im Cache oder fehlen absichtlich.
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ elements: [] })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Statistik je Gebiet", () => {
  test("zählt Häuser je Gebiet über den Mittelpunkt, auch in Kacheln, durch die die Grenze läuft", async () => {
    const t = convexTest(schema, modules);
    const houses = grid([7.0, 50.7, 7.02, 50.71]);
    await storeHouses(t, houses, [WEST, EAST]);
    await setup(t, [["w", "West", WEST], ["e", "Ost", EAST]]);
    await settle(t);
    const west = houses.filter((h) => h.geometry.coordinates[0][0][0][0] < SPLIT).length;
    expect(await row(t, "w")).toMatchObject({ houses: west, done: 0, blocked: 0, complete: true, target: true });
    expect(await row(t, "e")).toMatchObject({ houses: houses.length - west, complete: true });
  });

  test("zählt Zustände beim Setzen mit: offen → gelb → dunkelgelb → offen", async () => {
    const t = convexTest(schema, modules);
    await storeHouses(t, grid([7.0, 50.7, 7.02, 50.71]));
    await setup(t, [["w", "West", WEST], ["e", "Ost", EAST]]);
    await settle(t);
    const pt: [number, number] = [7.0051, 50.7051];
    await tap(t, "way/1", pt, "done");
    expect(await row(t, "w")).toMatchObject({ done: 1, blocked: 0 });
    await tap(t, "way/1", pt, "blocked");
    expect(await row(t, "w")).toMatchObject({ done: 0, blocked: 1 });
    await tap(t, "way/1", pt, "blocked"); // doppelt: keine Änderung
    expect(await row(t, "w")).toMatchObject({ done: 0, blocked: 1 });
    await tap(t, "way/1", pt, "none");
    expect(await row(t, "w")).toMatchObject({ done: 0, blocked: 0 });
    expect(await row(t, "e")).toMatchObject({ done: 0, blocked: 0 });
  });

  test("Grenzfall: Häuser knapp links und rechts der Grenze in derselben Kachel", async () => {
    const t = convexTest(schema, modules);
    await setup(t, [["w", "West", WEST], ["e", "Ost", EAST]]);
    await settle(t);
    // Die Grenze liegt mitten in einer Kachel; Punkte knapp links und rechts davon, dazu einer außerhalb aller Gebiete.
    expect(cellKeyOf([SPLIT - 0.0001, 50.705])).toBe(cellKeyOf([SPLIT + 0.0001, 50.705]));
    await tap(t, "way/11", [SPLIT - 0.0001, 50.705], "done");
    await tap(t, "way/12", [SPLIT + 0.0001, 50.705], "blocked");
    await tap(t, "way/13", [7.03, 50.705], "done"); // in keinem Gebiet
    expect(await row(t, "w")).toMatchObject({ done: 1, blocked: 0 });
    expect(await row(t, "e")).toMatchObject({ done: 0, blocked: 1 });
    const s = await stats(t);
    expect(s!.total).toEqual({ done: 2, blocked: 1 });
  });

  test("Grenze quer durch eine Kachel (schräg)", async () => {
    const t = convexTest(schema, modules);
    // Dreiecke, deren Diagonale durch die Kacheln läuft.
    const lower: AreaGeometry = [[[[7.0, 50.7], [7.02, 50.7], [7.02, 50.72], [7.0, 50.7]]]];
    const upper: AreaGeometry = [[[[7.0, 50.7], [7.02, 50.72], [7.0, 50.72], [7.0, 50.7]]]];
    await setup(t, [["lo", "Unten", lower], ["up", "Oben", upper]]);
    await settle(t);
    await tap(t, "way/1", [7.0026, 50.7024], "done"); // knapp unter der Diagonale
    await tap(t, "way/2", [7.0024, 50.7026], "done"); // knapp darüber
    expect(await row(t, "lo")).toMatchObject({ done: 1 });
    expect(await row(t, "up")).toMatchObject({ done: 1 });
  });

  test("ältere Markierungen ohne Gebiet werden einmalig nachgezogen, ohne doppelt zu zählen", async () => {
    const t = convexTest(schema, modules);
    // Markierungen von vor den Gebieten (ohne areaRun).
    await setup(t, []);
    for (let i = 0; i < 30; i++) await tap(t, `way/${i}`, [7.0001 + i * 0.0006, 50.705], i % 3 === 0 ? "blocked" : "done");
    await addAreas(t, [["w", "West", WEST], ["e", "Ost", EAST]]);
    // Während des Nachziehens wird schon getippt: ein altes Haus wechselt, ein neues kommt dazu.
    await tap(t, "way/1", [7.0001 + 0.0006, 50.705], "none");
    await tap(t, "way/999", [7.0151, 50.705], "done");
    await settle(t);
    const xs = Array.from({ length: 30 }, (_, i) => i).filter((i) => i !== 1);
    const westX = xs.filter((i) => 7.0001 + i * 0.0006 < SPLIT);
    const eastX = xs.filter((i) => 7.0001 + i * 0.0006 >= SPLIT);
    const count = (ids: number[], k: "done" | "blocked") => ids.filter((i) => (i % 3 === 0 ? "blocked" : "done") === k).length;
    expect(await row(t, "w")).toMatchObject({ done: count(westX, "done"), blocked: count(westX, "blocked") });
    expect(await row(t, "e")).toMatchObject({ done: count(eastX, "done") + 1, blocked: count(eastX, "blocked") });
    expect((await stats(t))!.areas!.assigning).toBe(false);
    // Ein weiterer Ortsteil kommt dazu: alles wird neu zugeordnet und bleibt richtig.
    await addAreas(t, [["f", "Fern", FAR]]);
    await settle(t);
    expect(await row(t, "w")).toMatchObject({ done: count(westX, "done"), blocked: count(westX, "blocked") });
    expect(await row(t, "e")).toMatchObject({ done: count(eastX, "done") + 1, blocked: count(eastX, "blocked") });
    expect(await row(t, "f")).toMatchObject({ done: 0, blocked: 0 });
  });

  test("ein später gewählter Ortsteil zählt Markierungen mit, die vorher außerhalb lagen", async () => {
    const t = convexTest(schema, modules);
    await storeHouses(t, grid([7.0, 50.7, 7.06, 50.71]), [WEST, FAR]);
    await setup(t, [["w", "West", WEST]]);
    await settle(t);
    await tap(t, "way/1", [7.005, 50.705], "done");
    await tap(t, "way/2", [7.055, 50.705], "blocked"); // außerhalb aller Gebiete
    expect((await stats(t))!.areas!.rows).toHaveLength(1);
    await addAreas(t, [["f", "Fern", FAR]]);
    await settle(t);
    expect(await row(t, "w")).toMatchObject({ done: 1, blocked: 0 });
    expect(await row(t, "f")).toMatchObject({ done: 0, blocked: 1, target: true });
    expect((await row(t, "f")).houses).toBeGreaterThan(0);
    // Wieder abgewählt: bleibt mit seinen Markierungen unter „nicht gewählt“, ohne Häuserzahl.
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["f"], selected: false });
    await settle(t);
    expect(await row(t, "f")).toMatchObject({ blocked: 1, target: false, houses: null });
    await tap(t, "way/3", [7.0551, 50.7051], "done");
    expect(await row(t, "f")).toMatchObject({ done: 1, blocked: 1 });
  });

  test("„vorläufig“, solange Kacheln eines Gebiets fehlen; nachgeführt, wenn das Vorladen fertig ist", async () => {
    const t = convexTest(schema, modules);
    // Nur die westliche Hälfte von „West“ ist im Cache.
    const all = grid([7.0, 50.7, SPLIT, 50.71]);
    await storeHouses(t, all.filter((h) => h.geometry.coordinates[0][0][0][0] < 7.005));
    await setup(t, [["w", "West", WEST]]);
    await settle(t);
    // Das Vorladen bekommt von Overpass nichts (fetch liefert leer) – deshalb hier die übrigen Kacheln nachtragen.
    const r1 = await row(t, "w");
    expect(r1.complete).toBe(false);
    expect(r1.houses).toBeGreaterThan(0);
    expect(r1.houses).toBeLessThan(all.length);

    await t.run(async (ctx) => {
      for (const c of await ctx.db.query("buildingCells").collect()) await ctx.db.delete(c._id);
    });
    await storeHouses(t, all, [WEST]);
    await t.mutation(api.buildings.prefetch, { slug: SLUG });
    await settle(t);
    expect(await row(t, "w")).toMatchObject({ houses: all.length, complete: true });
  });

  test("zeigt gewählte Gebiete als Ziel; nicht gewählte ohne Häuserzahl", async () => {
    const t = convexTest(schema, modules);
    await storeHouses(t, grid([7.0, 50.7, 7.02, 50.71]), [WEST, EAST, FAR]);
    await setup(t, [["w", "West", WEST], ["e", "Ost", EAST], ["f", "Fern", FAR]], ["f"]);
    await settle(t);
    const s = (await stats(t))!;
    expect(s.areas!.rows.map((r) => [r.id, r.target])).toEqual([["e", true], ["w", true], ["f", false]]);
    expect((await row(t, "f")).houses).toBeNull();

    // Auswahl ändern: Ost ab, Fern an.
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["e"], selected: false });
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["f"], selected: true });
    await settle(t);
    expect((await row(t, "e")).target).toBe(false);
    expect((await row(t, "f")).target).toBe(true);
    expect((await row(t, "f")).houses).toBe(0);
  });

  test("alle abgewählt: es gilt der ganze Ort, kein Ortsteil ist Ziel (eingeklappt, ohne Häuserzahl)", async () => {
    const t = convexTest(schema, modules);
    await storeHouses(t, grid([7.0, 50.7, 7.02, 50.71]), [WEST, EAST]);
    await setup(t, [["w", "West", WEST], ["e", "Ost", EAST]]);
    await settle(t);
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["w", "e"], selected: false });
    await settle(t);
    await tap(t, "way/1", [7.005, 50.705], "done");
    const s = (await stats(t))!;
    expect(s.areas!.noneSelected).toBe(true);
    expect(s.areas!.rows.map((r) => [r.id, r.target, r.houses])).toEqual([["e", false, null], ["w", false, null]]);
    expect(await row(t, "w")).toMatchObject({ done: 1 });
    expect(s.total).toEqual({ done: 1, blocked: 0 });
  });

  test("Ortsteil an der Adresse beim Anlegen vorgewählt: Statistik steht sofort, ohne refresh", async () => {
    const t = convexTest(schema, modules);
    await storeHouses(t, grid([7.0, 50.7, SPLIT, 50.71]), [WEST]);
    const campaignId = await setup(t, []);
    await t.run(async (ctx) => {
      await ctx.db.insert("osmAreas", {
        areaId: "w", unitId: 1, name: "West", geometry: JSON.stringify(WEST), bbox: bboxOf(WEST),
        labelAt: [7.0, 50.7], cells: encodeCells(touchedCells(WEST)), fetchedAt: Date.now(),
      });
      await ctx.db.insert("boundaryTiles", { tile: boundaryTileOf(7.005, 50.705), unitIds: [1], fetchedAt: Date.now() });
    });
    await t.mutation(internal.areas.selectAt, { campaignId, point: [7.005, 50.705] });
    await settle(t);
    const s = (await stats(t))!;
    expect(s.needsSetup).toBe(false);
    expect(await row(t, "w")).toMatchObject({ target: true, houses: grid([7.0, 50.7, SPLIT, 50.71]).length, complete: true });
  });

  test("lesbar mit Admin-, Bearbeiten- und Ansehen-Schlüssel, nicht mit unbekanntem", async () => {
    const t = convexTest(schema, modules);
    await setup(t, [["w", "West", WEST]]);
    await settle(t);
    await tap(t, "way/1", [7.005, 50.705], "done");
    expect((await stats(t, ADMIN))!.areas!.rows).toHaveLength(1);
    await t.run(async (ctx) => {
      const c = (await ctx.db.query("campaigns").collect())[0];
      await ctx.db.patch(c._id, { viewKey: VIEW_KEY });
    });
    expect((await stats(t, VIEW_KEY))!.areas!.rows[0]).toMatchObject({ id: "w", done: 1 });
    // Neu zählen ist eine Änderung: nicht mit dem Ansehen-Schlüssel.
    await expect(t.mutation(api.stats.refresh, { slug: VIEW_KEY })).rejects.toThrow(/nichts ändern/);
    expect(await stats(t, "Unbekannt1234567890123")).toBeNull();
  });

  test("ohne Gebiete: nur die Summen", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("campaigns", { slug: SLUG, name: "Alt", placeLabel: "Ort", center: { lat: 50.7, lng: 7 }, markCount: 3, blockedCount: 1 });
    });
    expect(await stats(t)).toEqual({ areas: null, needsSetup: false, total: { done: 3, blocked: 1 } });
  });

  test("Gebiete schon vor der Statistik geladen: refresh legt sie an, Markierungen werden nicht vorschnell zugeordnet", async () => {
    const t = convexTest(schema, modules);
    const campaignId = await setup(t, [["w", "West", WEST]]);
    // Zustand wie vor diesem Stand: Gebiete fertig, aber keine Statistik.
    await t.run(async (ctx) => {
      for (const r of await ctx.db.query("areaStats").collect()) await ctx.db.delete(r._id);
      for (const j of await ctx.db.query("statsJobs").collect()) await ctx.db.delete(j._id);
    });
    await tap(t, "way/1", [7.005, 50.705], "done");
    const mark = await t.run(async (ctx) => (await ctx.db.query("marks").collect())[0]);
    expect(mark.areaRun).toBeUndefined();
    expect(await stats(t)).toMatchObject({ areas: null, needsSetup: true });
    // Der Ansehen-Link darf die Statistik nicht anlegen (das wäre eine Änderung).
    await t.run(async (ctx) => {
      const c = (await ctx.db.query("campaigns").collect())[0];
      await ctx.db.patch(c._id, { viewKey: VIEW_KEY });
    });
    await expect(t.mutation(api.stats.refresh, { slug: VIEW_KEY })).rejects.toThrow(/nichts ändern/);
    expect(await t.run(async (ctx) => (await ctx.db.query("statsJobs").collect()).length)).toBe(0);
    await t.mutation(api.stats.refresh, { slug: SLUG });
    await settle(t);
    expect(await row(t, "w")).toMatchObject({ done: 1 });
    expect((await stats(t))!.needsSetup).toBe(false);
    void campaignId;
  });

  test("Überlappung: Haus und Markierung zählen beim gewählten Gebiet, auch wenn ein nicht gewähltes früher im Alphabet steht", async () => {
    const t = convexTest(schema, modules);
    const houses = grid([7.0, 50.7, SPLIT, 50.71]);
    await storeHouses(t, houses, [WEST]);
    // „Alt“ (nicht gewählt) deckt dieselbe Fläche wie „West“ (gewählt).
    await setup(t, [["a", "Alt", WEST], ["w", "West", WEST]], ["a"]);
    await settle(t);
    await tap(t, "way/1", [7.005, 50.705], "done");
    expect(await row(t, "w")).toMatchObject({ houses: houses.length, done: 1 });
    expect(await row(t, "a")).toMatchObject({ done: 0 });
  });

  test("Überlappung: Auswahl geändert, Häuser und Markierungen wechseln gemeinsam zum gewählten Gebiet", async () => {
    const t = convexTest(schema, modules);
    const houses = grid([7.0, 50.7, SPLIT, 50.71]);
    await storeHouses(t, houses, [WEST]);
    await setup(t, [["a", "Alt", WEST], ["w", "West", WEST]]);
    await settle(t);
    await tap(t, "way/1", [7.005, 50.705], "done");
    expect(await row(t, "a")).toMatchObject({ houses: houses.length, done: 1 });
    await t.mutation(api.areas.select, { adminKey: ADMIN, ids: ["a"], selected: false });
    await settle(t);
    expect(await row(t, "w")).toMatchObject({ houses: houses.length, done: 1, target: true });
    expect(await row(t, "a")).toMatchObject({ done: 0, target: false });
  });

  test("ein Ortsteil kommt dazu: die übrigen behalten ihre Häuserzahl, bis neu gezählt ist", async () => {
    const t = convexTest(schema, modules);
    const houses = grid([7.0, 50.7, SPLIT, 50.71]);
    await storeHouses(t, houses, [WEST, FAR]);
    await setup(t, [["w", "West", WEST]]);
    await settle(t);
    await addAreas(t, [["f", "Fern", FAR]]);
    expect(await row(t, "w")).toMatchObject({ houses: houses.length, complete: false }); // vor dem Neuzählen: „vorläufig“
    await settle(t);
    expect(await row(t, "w")).toMatchObject({ houses: houses.length, complete: true });
  });

  test("refresh bringt eine Statistik aus einem älteren Stand (Fingerabdruck ohne Auswahl) auf den aktuellen", async () => {
    const t = convexTest(schema, modules);
    await setup(t, [["w", "West", WEST], ["e", "Ost", EAST]], ["e"]);
    await settle(t);
    await t.run(async (ctx) => {
      const job = (await ctx.db.query("statsJobs").collect())[0];
      const ids = (await ctx.db.query("areas").collect()).map((a) => a._id).sort().join(" ");
      await ctx.db.patch(job._id, { areaKey: ids });
      for (const r of await ctx.db.query("areaStats").collect()) await ctx.db.patch(r._id, { selected: undefined });
    });
    expect((await row(t, "e")).target).toBe(true); // alter Stand: falsch als Ziel
    await t.mutation(api.stats.refresh, { slug: SLUG });
    await settle(t);
    expect((await row(t, "e")).target).toBe(false);
    expect((await row(t, "w")).target).toBe(true);
  });

  test("Neu zählen per refresh ab Rolle edit und gebremst", async () => {
    const t = convexTest(schema, modules);
    await setup(t, [["w", "West", WEST]]);
    await settle(t);
    await storeHouses(t, grid([7.0, 50.7, SPLIT, 50.71]), [WEST]);
    await t.mutation(api.stats.refresh, { slug: SLUG }); // gebremst: gerade erst gezählt
    await settle(t);
    expect((await row(t, "w")).houses).toBe(0);
    vi.advanceTimersByTime(15 * 60_000 + 1000);
    await t.mutation(api.stats.refresh, { slug: SLUG });
    await settle(t);
    expect((await row(t, "w")).houses).toBe(grid([7.0, 50.7, SPLIT, 50.71]).length);
    // Vollständig gezählt: Öffnen zählt nicht mehr neu (spart Database I/O).
    expect((await row(t, "w")).complete).toBe(true);
    const countedAt = async () => (await t.run(async (ctx) => await ctx.db.query("statsJobs").first()))!.countedAt;
    const before = await countedAt();
    vi.advanceTimersByTime(60 * 60_000);
    await t.mutation(api.stats.refresh, { slug: SLUG });
    await settle(t);
    expect(await countedAt()).toBe(before);
    await expect(t.mutation(api.stats.refresh, { slug: "Unbekannt1234567890123" })).rejects.toThrow();
    // Der Admin-Schlüssel umfasst die Rechte des Bearbeiten-Schlüssels (access.ts).
    await t.mutation(api.stats.refresh, { slug: ADMIN });
  });
});
