// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { BUILDINGS_FORMAT, cellKeyOf, encodeBuildings, type BuildingFeature } from "./osm";
import { bboxOf, encodeCells, touchedCells, type AreaGeometry } from "./areaGeo";

const modules = import.meta.glob("./**/*.ts");
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
const ADMIN = "AdminSchluessel1234567";

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

/** Aktion mit fertig geladenen Gebieten, direkt in der Datenbank (Laden selbst testet areas.test.ts). */
async function setup(t: T, areas: [string, string, AreaGeometry][], unselected: string[] = []) {
  return await t.run(async (ctx) => {
    const campaignId = await ctx.db.insert("campaigns", {
      slug: SLUG,
      adminKey: ADMIN,
      name: "Test",
      placeLabel: "Testort",
      center: { lat: 50.705, lng: 7.005 },
      markCount: 0,
      blockedCount: 0,
    });
    await ctx.db.insert("areaSets", { campaignId, status: "loading", unselected, failures: 0, updatedAt: Date.now(), run: 1 });
    return campaignId;
  }).then(async (campaignId) => {
    await t.mutation(internal.areas.save, {
      campaignId,
      run: 1,
      whole: false,
      areas: areas.map(([areaId, name, g]) => ({
        areaId,
        name,
        geometry: JSON.stringify(g),
        bbox: bboxOf(g),
        labelAt: [bboxOf(g)[0], bboxOf(g)[1]],
        cells: encodeCells(touchedCells(g)),
      })),
    });
    return campaignId;
  });
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
    // Markierungen von vor den Gebieten (ohne areaRun), direkt in der Datenbank.
    const campaignId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("campaigns", {
        slug: SLUG, adminKey: ADMIN, name: "Alt", placeLabel: "Testort", center: { lat: 50.705, lng: 7.005 }, markCount: 0, blockedCount: 0,
      });
      return id;
    });
    for (let i = 0; i < 30; i++) await tap(t, `way/${i}`, [7.0001 + i * 0.0006, 50.705], i % 3 === 0 ? "blocked" : "done");
    await t.run(async (ctx) => {
      await ctx.db.insert("areaSets", { campaignId, status: "loading", unselected: [], failures: 0, updatedAt: Date.now(), run: 1 });
    });
    await t.mutation(internal.areas.save, {
      campaignId,
      run: 1,
      whole: false,
      areas: [["w", "West", WEST] as const, ["e", "Ost", EAST] as const].map(([areaId, name, g]) => ({
        areaId, name, geometry: JSON.stringify(g), bbox: bboxOf(g), labelAt: [0, 0], cells: encodeCells(touchedCells(g)),
      })),
    });
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
    // Noch einmal laden (z. B. „Erneut versuchen“): Zählung beginnt neu und bleibt richtig.
    await t.run(async (ctx) => {
      const set = (await ctx.db.query("areaSets").collect())[0];
      await ctx.db.patch(set._id, { status: "loading", run: 2 });
    });
    await t.mutation(internal.areas.save, {
      campaignId,
      run: 2,
      whole: false,
      areas: [["w", "West", WEST] as const, ["e", "Ost", EAST] as const].map(([areaId, name, g]) => ({
        areaId, name, geometry: JSON.stringify(g), bbox: bboxOf(g), labelAt: [0, 0], cells: encodeCells(touchedCells(g)),
      })),
    });
    await settle(t);
    expect(await row(t, "w")).toMatchObject({ done: count(westX, "done"), blocked: count(westX, "blocked") });
    expect(await row(t, "e")).toMatchObject({ done: count(eastX, "done") + 1, blocked: count(eastX, "blocked") });
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

  test("lesbar mit Admin- und Bearbeiten-Schlüssel, nicht mit unbekanntem", async () => {
    const t = convexTest(schema, modules);
    await setup(t, [["w", "West", WEST]]);
    await settle(t);
    expect((await stats(t, ADMIN))!.areas!.rows).toHaveLength(1);
    expect(await stats(t, "Unbekannt1234567890123")).toBeNull();
  });

  test("ohne Gebiete: nur die Summen", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("campaigns", { slug: SLUG, name: "Alt", placeLabel: "Ort", center: { lat: 50.7, lng: 7 }, markCount: 3, blockedCount: 1 });
    });
    expect(await stats(t)).toEqual({ areas: null, total: { done: 3, blocked: 1 } });
  });

  test("Neu zählen per refresh nur mit Bearbeiten- oder Admin-Schlüssel und gebremst", async () => {
    const t = convexTest(schema, modules);
    await setup(t, [["w", "West", WEST]]);
    await settle(t);
    await storeHouses(t, grid([7.0, 50.7, SPLIT, 50.71]));
    await t.mutation(api.stats.refresh, { slug: SLUG }); // gebremst: gerade erst gezählt
    await settle(t);
    expect((await row(t, "w")).houses).toBe(0);
    vi.advanceTimersByTime(61_000);
    await t.mutation(api.stats.refresh, { slug: SLUG });
    await settle(t);
    expect((await row(t, "w")).houses).toBe(grid([7.0, 50.7, SPLIT, 50.71]).length);
    await expect(t.mutation(api.stats.refresh, { slug: "Unbekannt1234567890123" })).rejects.toThrow();
  });
});
