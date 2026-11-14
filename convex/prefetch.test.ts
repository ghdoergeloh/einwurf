// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { MAX_PREFETCH_FETCHES_PER_MINUTE } from "./buildings";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
// Kleines Gebiet: 3 × 2 Kacheln → ein Block
const SMALL = { center: { lat: 50.7575, lng: 6.9875 }, bbox: [6.981, 50.751, 6.994, 50.759] };
// Größeres Gebiet: mehrere Blöcke
const BIGGER = { center: { lat: 50.755, lng: 6.985 }, bbox: [6.96, 50.74, 7.01, 50.77] };

const empty = () => new Response(JSON.stringify({ elements: [] }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("PREFETCH_ON_CREATE", "on");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function create(t: ReturnType<typeof convexTest>, area: typeof SMALL) {
  await t.mutation(api.campaigns.create, { slug: SLUG, name: "Test", placeLabel: "Roisdorf", ...area });
}
const cachedCells = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => (await ctx.db.query("buildingCells").collect()).length);

describe("Vorladen", () => {
  test("startet beim Anlegen und lädt das ganze Gebiet in den Cache", async () => {
    const t = convexTest(schema, modules);
    const fetchMock = vi.fn(async () => empty());
    vi.stubGlobal("fetch", fetchMock);
    await create(t, BIGGER);
    expect(await t.query(api.buildings.prefetchStatus, { slug: SLUG })).toMatchObject({ status: "running", done: 0 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query(api.buildings.prefetchStatus, { slug: SLUG });
    expect(status).toMatchObject({ status: "done" });
    expect(status!.done).toBe(status!.total);
    expect(await cachedCells(t)).toBe(status!.total);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  test("Kacheln im Cache werden nicht nochmal bei Overpass geholt", async () => {
    const t = convexTest(schema, modules);
    const fetchMock = vi.fn(async () => empty());
    vi.stubGlobal("fetch", fetchMock);
    await create(t, SMALL);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const calls = fetchMock.mock.calls.length;
    await t.mutation(api.buildings.prefetch, { slug: SLUG });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(await t.query(api.buildings.prefetchStatus, { slug: SLUG })).toMatchObject({ status: "done" });
  });

  test("läuft schon: ein zweiter Knopfdruck startet nichts Doppeltes", async () => {
    const once = convexTest(schema, modules);
    const fetchOnce = vi.fn(async () => empty());
    vi.stubGlobal("fetch", fetchOnce);
    await create(once, BIGGER);
    await once.finishAllScheduledFunctions(vi.runAllTimers);

    const twice = convexTest(schema, modules);
    const fetchTwice = vi.fn(async () => empty());
    vi.stubGlobal("fetch", fetchTwice);
    await create(twice, BIGGER);
    await twice.mutation(api.buildings.prefetch, { slug: SLUG });
    await twice.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchTwice.mock.calls.length).toBe(fetchOnce.mock.calls.length);
    expect(await twice.query(api.buildings.prefetchStatus, { slug: SLUG })).toMatchObject({ status: "done" });
  });

  test("gebremst: zwischen zwei Overpass-Abrufen liegen mindestens 7 Sekunden", async () => {
    const t = convexTest(schema, modules);
    const times: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      times.push(Date.now());
      return empty();
    }));
    await create(t, BIGGER);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(times.length).toBeGreaterThan(2);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(7_000);
  });

  test("viele Vorladungen gleichzeitig: Helfer auf der Karte laden trotzdem", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal("fetch", vi.fn(async () => empty()));
    await create(t, SMALL);
    // Gesamtkontingent des Vorladens (alle Aktionen) voll
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_PREFETCH_FETCHES_PER_MINUTE; i++)
        await ctx.db.insert("overpassFetches", { slug: `andere${i}:vorladen`, kind: "prefetch", at: Date.now() });
    });
    await expect(t.action(api.buildings.load, { slug: SLUG, cells: ["1500:10200"] })).resolves.toEqual(["[]"]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("ein Ausschnitt ohne Kacheln ist sofort fertig statt ewig „läuft“", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal("fetch", vi.fn(async () => empty()));
    await t.run(async (ctx) => {
      // Alter Datensatz mit verdrehtem Ausschnitt (neue werden beim Anlegen abgelehnt)
      await ctx.db.insert("campaigns", {
        slug: SLUG, name: "x", placeLabel: "y", center: { lat: 50, lng: 7 }, bbox: [7.1, 50.1, 7.0, 50.0],
      });
    });
    await t.mutation(api.buildings.prefetch, { slug: SLUG });
    expect(await t.query(api.buildings.prefetchStatus, { slug: SLUG })).toMatchObject({ status: "done", total: 0 });
  });

  test("Overpass weg: wiederholt mit Pause und gibt nach einigen Versuchen auf", async () => {
    const t = convexTest(schema, modules);
    const fetchMock = vi.fn(async () => new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OVERPASS_URLS", "https://eins.example/api");
    await create(t, SMALL);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.buildings.prefetchStatus, { slug: SLUG })).toMatchObject({ status: "failed", done: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  test("Vorladen bremst Helfer auf der Karte nicht aus (eigenes Kontingent)", async () => {
    const t = convexTest(schema, modules);
    vi.stubGlobal("fetch", vi.fn(async () => empty()));
    await create(t, SMALL);
    // Kontingent des Vorladens ausschöpfen, ohne das der Aktion zu berühren
    await t.run(async (ctx) => {
      for (let i = 0; i < 12; i++) await ctx.db.insert("overpassFetches", { slug: `${SLUG}:vorladen`, at: Date.now() });
    });
    await expect(t.action(api.buildings.load, { slug: SLUG, cells: ["1500:10200"] })).resolves.toEqual(["[]"]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("unbekannte Aktion", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.buildings.prefetch, { slug: "ZZZZZZZZZZZZZZZZZZZZZZ" })).rejects.toThrow(/nicht gefunden/);
    expect(await t.query(api.buildings.prefetchStatus, { slug: SLUG })).toBeNull();
  });
});
