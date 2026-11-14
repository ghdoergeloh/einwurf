// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { CELL_SIZE, cellKeyOf, decodeBuildings } from "./osm";

const modules = import.meta.glob("./**/*.ts");
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";

/** Ein Haus mitten in der Kachel (x, y). */
function house(id: number, x: number, y: number) {
  const lon = (x + 0.5) * CELL_SIZE;
  const lat = (y + 0.5) * CELL_SIZE;
  const d = 0.0001;
  return {
    type: "way",
    id,
    geometry: [
      { lat: lat - d, lon: lon - d },
      { lat: lat - d, lon: lon + d },
      { lat: lat + d, lon: lon + d },
      { lat: lat + d, lon: lon - d },
      { lat: lat - d, lon: lon - d },
    ],
  };
}
const X = 1398; // ≈ 6,99° Ost
const Y = 10152; // ≈ 50,76° Nord
const CELL_A = `${X}:${Y}`;
const CELL_B = `${X + 1}:${Y}`;
const overpassOk = () =>
  new Response(JSON.stringify({ elements: [house(1, X, Y), house(2, X + 1, Y), house(3, X + 1, Y)] }), { status: 200 });

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.campaigns.create, {
    slug: SLUG, name: "Test", placeLabel: "Bornheim", center: { lat: 50.76, lng: 6.99 },
  });
  return t;
}

const ids = (cells: string[]) => cells.flatMap((d) => decodeBuildings(d).map((f) => f.properties.osmId)).sort();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("buildings.load", () => {
  test("lädt fehlende Kacheln von Overpass, ordnet Häuser nach Mittelpunkt zu und cacht sie", async () => {
    const t = await setup();
    const fetchMock = vi.fn(async () => overpassOk());
    vi.stubGlobal("fetch", fetchMock);

    const first = await t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A, CELL_B] });
    expect(first).toHaveLength(2);
    expect(ids([first[0]])).toEqual(["way/1"]);
    expect(ids([first[1]])).toEqual(["way/2", "way/3"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Zweiter Helfer: alles aus dem Cache, kein weiterer Abruf
    const second = await t.action(api.buildings.load, { slug: SLUG, cells: [CELL_B, CELL_A] });
    expect(ids(second)).toEqual(["way/1", "way/2", "way/3"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("leere Kacheln werden auch gecacht", async () => {
    const t = await setup();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ elements: [] })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A] })).toEqual(["[]"]);
    await t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("ist der erste Server überlastet, wird der nächste gefragt", async () => {
    const t = await setup();
    vi.stubEnv("OVERPASS_URLS", "https://eins.example/api,https://zwei.example/api");
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("https://eins") ? new Response("busy", { status: 429 }) : overpassOk(),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A] });
    expect(ids(res)).toEqual(["way/1"]);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://eins.example/api", "https://zwei.example/api"]);
  });

  test("Laufzeitfehler von Overpass (200 mit remark) zählt als Fehler", async () => {
    const t = await setup();
    vi.stubEnv("OVERPASS_URLS", "https://eins.example/api");
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ elements: [], remark: "runtime error: Query timed out" })),
    ));
    await expect(t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A] })).rejects.toThrow(/nicht erreichbar/);
    // Nichts Leeres in den Cache geschrieben: der nächste Versuch fragt wieder
    vi.stubGlobal("fetch", vi.fn(async () => overpassOk()));
    expect(ids(await t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A] }))).toEqual(["way/1"]);
  });

  test("alle Server weg: verständlicher Fehler", async () => {
    const t = await setup();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    await expect(t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A] })).rejects.toThrow(/nicht erreichbar/);
  });

  test("kein offener Proxy: nur mit gültiger Aktion und wenigen, gültigen Kacheln", async () => {
    const t = await setup();
    const fetchMock = vi.fn(async () => overpassOk());
    vi.stubGlobal("fetch", fetchMock);
    await expect(t.action(api.buildings.load, { slug: "ZZZZZZZZZZZZZZZZZZZZZZ", cells: [CELL_A] })).rejects.toThrow(/nicht gefunden/);
    await expect(t.action(api.buildings.load, { slug: SLUG, cells: ["x"] })).rejects.toThrow();
    const tooMany = Array.from({ length: 25 }, (_, i) => `${X + i}:${Y}`);
    await expect(t.action(api.buildings.load, { slug: SLUG, cells: tooMany })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("Kachel eines Punkts", () => {
    expect(cellKeyOf([(X + 0.5) * CELL_SIZE, (Y + 0.5) * CELL_SIZE])).toBe(CELL_A);
  });
});
