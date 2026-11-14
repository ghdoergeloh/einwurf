// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { CELL_SIZE, cellKeyOf, decodeBuildings } from "./osm";
import { MAX_FETCHES_PER_MINUTE_PER_CAMPAIGN } from "./buildings";

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

  test("keine Abfrage über halbe Kontinente oder außerhalb der Erde", async () => {
    const t = await setup();
    const fetchMock = vi.fn(async () => overpassOk());
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      t.action(api.buildings.load, { slug: SLUG, cells: ["-36000:-18000", "35999:17999"] }),
    ).rejects.toThrow(/zu groß/);
    await expect(t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A, `${X + 8}:${Y}`] })).rejects.toThrow(/zu groß/);
    await expect(t.action(api.buildings.load, { slug: SLUG, cells: ["999999:999999"] })).rejects.toThrow(/Ungültige Kachel/);
    expect(fetchMock).not.toHaveBeenCalled();
    // Nah beieinander ist erlaubt
    await t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A, `${X + 7}:${Y + 7}`] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("Overpass-Abrufe sind pro Minute begrenzt, Cache-Treffer nicht", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = await setup();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ elements: [] }))));
      for (let i = 0; i < MAX_FETCHES_PER_MINUTE_PER_CAMPAIGN; i++) {
        await t.action(api.buildings.load, { slug: SLUG, cells: [`${X}:${Y + i * 10}`] });
      }
      await expect(t.action(api.buildings.load, { slug: SLUG, cells: [`${X}:${Y - 10}`] })).rejects.toThrow(/sehr viele Häuser/);
      // Bereits gecacht: geht weiter
      await expect(t.action(api.buildings.load, { slug: SLUG, cells: [`${X}:${Y}`] })).resolves.toEqual(["[]"]);
      vi.setSystemTime(Date.now() + 61_000);
      await expect(t.action(api.buildings.load, { slug: SLUG, cells: [`${X}:${Y - 10}`] })).resolves.toEqual(["[]"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("viele Helfer gleichzeitig in derselben neuen Kachel: nur ein Overpass-Abruf", async () => {
    const t = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async () => {
      await gate;
      return overpassOk();
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A] });
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(ids(a)).toEqual(["way/1"]);
    expect(ids(b)).toEqual(["way/1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("nach einem Fehler ist die Kachel wieder frei", async () => {
    const t = await setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 504 })));
    await expect(t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A] })).rejects.toThrow(/nicht erreichbar/);
    vi.stubGlobal("fetch", vi.fn(async () => overpassOk()));
    expect(ids(await t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A] }))).toEqual(["way/1"]);
  });

  test("spätes Freigeben löscht keine neu vergebene Sperre", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = await setup();
      const first = await t.mutation(internal.buildings.reserve, { slug: SLUG, cells: [CELL_A] });
      expect(first.toFetch).toEqual([CELL_A]);
      // Solange die Sperre gilt, wartet ein zweiter Aufruf
      expect((await t.mutation(internal.buildings.reserve, { slug: SLUG, cells: [CELL_A] })).waitFor).toEqual([CELL_A]);
      // Sperre läuft ab (Abruf hing), ein dritter Aufruf übernimmt
      vi.setSystemTime(Date.now() + 10 * 60_000);
      const third = await t.mutation(internal.buildings.reserve, { slug: SLUG, cells: [CELL_A] });
      expect(third.toFetch).toEqual([CELL_A]);
      // Der erste meldet sich spät zurück und gibt frei – die Sperre des dritten bleibt
      await t.mutation(internal.buildings.release, { lockIds: first.lockIds });
      expect((await t.mutation(internal.buildings.reserve, { slug: SLUG, cells: [CELL_A] })).waitFor).toEqual([CELL_A]);
      await t.mutation(internal.buildings.release, { lockIds: third.lockIds });
      expect((await t.mutation(internal.buildings.reserve, { slug: SLUG, cells: [CELL_A] })).toFetch).toEqual([CELL_A]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Aufräumen löscht nur abgelaufene Kacheln", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = await setup();
      await t.mutation(internal.buildings.store, { entries: [{ cell: CELL_A, data: "[]" }] });
      vi.setSystemTime(Date.now() + 31 * 24 * 3600_000);
      await t.mutation(internal.buildings.store, { entries: [{ cell: CELL_B, data: "[]" }] });
      await t.mutation(internal.buildings.cleanup, {});
      const left = await t.run((ctx) => ctx.db.query("buildingCells").collect());
      expect(left.map((r) => r.cell)).toEqual([CELL_B]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Einträge im alten Format (ohne Hausnummern): sofort ausliefern, im Hintergrund auffrischen", async () => {
    vi.useFakeTimers();
    try {
      const t = await setup();
      // So sahen Einträge vor den Hausnummern aus: ohne Formatnummer.
      await t.run((ctx) => ctx.db.insert("buildingCells", { cell: CELL_A, fetchedAt: Date.now(), data: '[["way/77",[]]]' }));
      const fetchMock = vi.fn(async () => overpassOk());
      vi.stubGlobal("fetch", fetchMock);
      // Sofort: die alten Häuser, ohne auf Overpass zu warten
      expect(ids(await t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A] }))).toEqual(["way/77"]);
      expect(fetchMock).toHaveBeenCalledTimes(0);
      // Im Hintergrund aufgefrischt
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(ids(await t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A] }))).toEqual(["way/1"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Auffrischen scheitert: kein Fehler, die alten Häuser bleiben", async () => {
    vi.useFakeTimers();
    try {
      const t = await setup();
      await t.run((ctx) => ctx.db.insert("buildingCells", { cell: CELL_A, fetchedAt: Date.now(), data: '[["way/77",[]]]' }));
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
      expect(ids(await t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A] }))).toEqual(["way/77"]);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(ids(await t.action(api.buildings.load, { slug: SLUG, cells: [CELL_A] }))).toEqual(["way/77"]);
      // Ohne alten Eintrag bleibt es beim Fehler
      await expect(t.action(api.buildings.load, { slug: SLUG, cells: [CELL_B] })).rejects.toThrow(/nicht erreichbar/);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Vorladen ersetzt alte Einträge, statt sie stehen zu lassen", async () => {
    const t = await setup();
    await t.run((ctx) => ctx.db.insert("buildingCells", { cell: CELL_A, fetchedAt: Date.now(), data: '[["way/77",[]]]' }));
    vi.stubGlobal("fetch", vi.fn(async () => overpassOk()));
    await t.action(internal.buildings.refresh, { slug: SLUG, cells: [CELL_A] });
    const row = await t.run((ctx) => ctx.db.query("buildingCells").collect());
    expect(row.map((r) => r.format)).toEqual([2]);
  });

  test("Kachel eines Punkts", () => {
    expect(cellKeyOf([(X + 0.5) * CELL_SIZE, (Y + 0.5) * CELL_SIZE])).toBe(CELL_A);
  });
});
