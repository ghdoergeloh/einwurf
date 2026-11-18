// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { markCellOf, markCellsIn } from "./cells";
import { MAX_CAMPAIGNS_PER_MINUTE, MAX_MARKS_PER_CAMPAIGN } from "./validation";

const modules = import.meta.glob("./**/*.ts");
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
const HOUSE = [7.0001, 50.0001];
const CELL = markCellOf(HOUSE[0], HOUSE[1]);

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.campaigns.create, {
    slug: SLUG,
    name: "  Einladungen   Bornheim ",
    placeLabel: "Bornheim, NRW",
    center: { lat: 50.76, lng: 6.99 },
    bbox: [6.9, 50.7, 7.1, 50.8],
  });
  return t;
}

const slugOf = (i: number) => `S${String(i).padStart(21, "0")}`;

describe("campaigns", () => {
  test("anlegen und per Schlüssel lesen", async () => {
    const t = await setup();
    const c = await t.query(api.campaigns.get, { slug: SLUG });
    expect(c).toMatchObject({ name: "Einladungen Bornheim", placeLabel: "Bornheim, NRW", markCount: 0 });
  });

  test("unbekannter oder ungültiger Schlüssel liefert null", async () => {
    const t = await setup();
    expect(await t.query(api.campaigns.get, { slug: "ZZZZZZZZZZZZZZZZZZZZZZ" })).toBeNull();
    expect(await t.query(api.campaigns.get, { slug: "kurz" })).toBeNull();
  });

  test("Schlüssel muss 22 Zeichen base62 sein und eindeutig", async () => {
    const t = await setup();
    const base = { name: "x", placeLabel: "y", center: { lat: 1, lng: 1 } };
    await expect(t.mutation(api.campaigns.create, { ...base, slug: "abc" })).rejects.toThrow();
    await expect(t.mutation(api.campaigns.create, { ...base, slug: SLUG })).rejects.toThrow();
  });

  test("verdrehter Ausschnitt wird abgelehnt", async () => {
    const t = convexTest(schema, modules);
    const base = { slug: SLUG, name: "x", placeLabel: "y", center: { lat: 50, lng: 7 } };
    await expect(t.mutation(api.campaigns.create, { ...base, bbox: [7.1, 50, 7.0, 50.1] })).rejects.toThrow(/Ausschnitt/);
    await expect(t.mutation(api.campaigns.create, { ...base, bbox: [7.0, 50.1, 7.1, 50] })).rejects.toThrow(/Ausschnitt/);
  });

  test("leerer oder zu langer Name wird abgelehnt", async () => {
    const t = convexTest(schema, modules);
    const base = { slug: SLUG, placeLabel: "y", center: { lat: 1, lng: 1 } };
    await expect(t.mutation(api.campaigns.create, { ...base, name: "   " })).rejects.toThrow();
    await expect(t.mutation(api.campaigns.create, { ...base, name: "x".repeat(81) })).rejects.toThrow();
  });

  test("zu viele neue Aktionen pro Minute werden gebremst, danach geht es wieder", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const base = { name: "x", placeLabel: "y", center: { lat: 1, lng: 1 } };
      for (let i = 0; i < MAX_CAMPAIGNS_PER_MINUTE; i++) {
        await t.mutation(api.campaigns.create, { ...base, slug: slugOf(i) });
      }
      await expect(
        t.mutation(api.campaigns.create, { ...base, slug: slugOf(999) }),
      ).rejects.toThrow(/sehr viele Aktionen/);
      vi.advanceTimersByTime(61_000);
      await expect(t.mutation(api.campaigns.create, { ...base, slug: slugOf(999) })).resolves.toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("marks", () => {
  test("markieren, erneut markieren ist idempotent, demarkieren", async () => {
    const t = await setup();
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: true, center: HOUSE });
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: true, center: HOUSE });
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: CELL })).toEqual([{ osmId: "way/1", center: HOUSE, status: "done" }]);
    expect((await t.query(api.campaigns.get, { slug: SLUG }))?.markCount).toBe(1);

    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: false, center: HOUSE });
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: false, center: HOUSE });
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: CELL })).toEqual([]);
    expect((await t.query(api.campaigns.get, { slug: SLUG }))?.markCount).toBe(0);
  });

  test("Zustände: Flyer drin → nicht möglich → offen, mit Zählern", async () => {
    const t = await setup();
    const get = () => t.query(api.campaigns.get, { slug: SLUG });
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", status: "done", center: HOUSE });
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: CELL })).toEqual([{ osmId: "way/1", center: HOUSE, status: "done" }]);
    expect(await get()).toMatchObject({ markCount: 1, blockedCount: 0 });

    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", status: "blocked", center: HOUSE });
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: CELL })).toEqual([{ osmId: "way/1", center: HOUSE, status: "blocked" }]);
    expect(await get()).toMatchObject({ markCount: 0, blockedCount: 1 });

    // gleicher Zielzustand zweimal (zwei Helfer gleichzeitig): keine Doppelzählung
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", status: "blocked", center: HOUSE });
    expect(await get()).toMatchObject({ markCount: 0, blockedCount: 1 });

    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", status: "none", center: HOUSE });
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: CELL })).toEqual([]);
    expect(await get()).toMatchObject({ markCount: 0, blockedCount: 0 });
  });

  test("ältere Markierungen ohne Zustand sind Flyer drin; ältere Clients mit marked funktionieren weiter", async () => {
    const t = await setup();
    await t.run(async (ctx) => {
      const c = (await ctx.db.query("campaigns").first())!;
      await ctx.db.insert("marks", { campaignId: c._id, osmId: "way/9", center: HOUSE, cell: CELL });
      await ctx.db.patch(c._id, { markCount: 1 });
    });
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: CELL })).toEqual([{ osmId: "way/9", center: HOUSE, status: "done" }]);
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/9", status: "blocked", center: HOUSE });
    expect(await t.query(api.campaigns.get, { slug: SLUG })).toMatchObject({ markCount: 0, blockedCount: 1 });
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/9", marked: false, center: HOUSE });
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/8", marked: true, center: HOUSE });
    expect(await t.query(api.campaigns.get, { slug: SLUG })).toMatchObject({ markCount: 1, blockedCount: 0 });
  });

  test("eine Zelle liefert nur ihre eigenen Häuser", async () => {
    const t = await setup();
    const far = [7.05, 50.05];
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: true, center: HOUSE });
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/2", marked: true, center: far });
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: CELL })).toEqual([{ osmId: "way/1", center: HOUSE, status: "done" }]);
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: markCellOf(far[0], far[1]) })).toEqual([
      { osmId: "way/2", center: far, status: "done" },
    ]);
  });

  test("Markierungen gehören nur zu ihrer Aktion", async () => {
    const t = await setup();
    const other = "ZyXwVuTsRqPoNmLkJiHgFe";
    await t.mutation(api.campaigns.create, {
      slug: other, name: "Andere", placeLabel: "Bonn", center: { lat: 50.7, lng: 7.1 },
    });
    await t.mutation(api.marks.set, { slug: other, osmId: "way/1", marked: true, center: HOUSE });
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: CELL })).toEqual([]);
    expect(await t.query(api.marks.inCell, { slug: other, cell: CELL })).toHaveLength(1);
  });

  test("ohne gültige Aktion, ID oder Koordinaten wird abgelehnt", async () => {
    const t = await setup();
    await expect(
      t.mutation(api.marks.set, { slug: "ZZZZZZZZZZZZZZZZZZZZZZ", osmId: "way/1", marked: true, center: HOUSE }),
    ).rejects.toThrow(/nicht gefunden/);
    await expect(t.mutation(api.marks.set, { slug: SLUG, osmId: "node/1", marked: true, center: HOUSE })).rejects.toThrow();
    await expect(t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: true, center: [7] })).rejects.toThrow();
    await expect(t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: true, center: [7, 500] })).rejects.toThrow();
  });

  test("mehr als die Höchstzahl an Markierungen wird abgelehnt, Zurücknehmen geht weiter", async () => {
    const t = await setup();
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: true, center: HOUSE });
    await t.run(async (ctx) => {
      const counts = await ctx.db.query("campaignCounts").first();
      await ctx.db.patch(counts!._id, { done: MAX_MARKS_PER_CAMPAIGN });
    });
    await expect(
      t.mutation(api.marks.set, { slug: SLUG, osmId: "way/2", marked: true, center: HOUSE }),
    ).rejects.toThrow(/zu viele Markierungen/);
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: false, center: HOUSE });
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: CELL })).toEqual([]);
  });

  test("auch Häuser mit „nicht möglich“ zählen zur Höchstzahl", async () => {
    const t = await setup();
    await t.run(async (ctx) => {
      const c = await ctx.db.query("campaigns").first();
      await ctx.db.patch(c!._id, { markCount: 0, blockedCount: MAX_MARKS_PER_CAMPAIGN });
    });
    await expect(
      t.mutation(api.marks.set, { slug: SLUG, osmId: "way/2", status: "done", center: HOUSE }),
    ).rejects.toThrow(/zu viele Markierungen/);
  });

  test("ein Tipp ändert den Datensatz der Aktion nicht (sonst liefen alle Queries aller Geräte neu)", async () => {
    const t = await setup();
    const before = await t.run(async (ctx) => await ctx.db.query("campaigns").first());
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", status: "done", center: HOUSE });
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/2", status: "blocked", center: HOUSE });
    expect(await t.run(async (ctx) => await ctx.db.query("campaigns").first())).toEqual(before);
    expect(await t.query(api.campaigns.get, { slug: SLUG })).toMatchObject({ markCount: 1, blockedCount: 1 });
  });

  test("Markierungen im alten Raster (0,01°) bleiben sichtbar, ziehen beim Ändern und per Migration um", async () => {
    const t = await setup();
    const far = [7.0081, 50.0081]; // dieselbe alte Zelle, andere neue Zelle
    await t.run(async (ctx) => {
      const c = (await ctx.db.query("campaigns").first())!;
      await ctx.db.insert("marks", { campaignId: c._id, osmId: "way/1", center: HOUSE, cell: "700:5000", status: "done" });
      await ctx.db.insert("marks", { campaignId: c._id, osmId: "way/2", center: far, cell: "700:5000", status: "done" });
      await ctx.db.insert("notes", { campaignId: c._id, osmId: "way/1", center: HOUSE, cell: "700:5000", text: "alt", updatedAt: 1 });
    });
    const ids = async (cell: string) => (await t.query(api.marks.inCell, { slug: SLUG, cell })).map((m) => m.osmId).sort();
    expect(await ids(CELL)).toEqual(["way/1"]);
    expect(await ids(markCellOf(far[0], far[1]))).toEqual(["way/2"]);
    // Neue Markierung in der neuen Zelle; eine ältere Seite fragt noch die alte Zelle ab und sieht alles.
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/3", status: "done", center: HOUSE });
    expect(await ids("700:5000")).toEqual(["way/1", "way/2", "way/3"]);
    // Ändern zieht um.
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", status: "blocked", center: HOUSE });
    const cellOf = (osmId: string) => t.run(async (ctx) => (await ctx.db.query("marks").collect()).find((m) => m.osmId === osmId)!.cell);
    expect(await cellOf("way/1")).toBe(CELL);
    // Die Migration zieht den Rest um, Notizen auch; nichts geht verloren.
    vi.useFakeTimers();
    await t.mutation(internal.migrations.fineCells, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    expect(await cellOf("way/2")).toBe(markCellOf(far[0], far[1]));
    expect(await t.run(async (ctx) => (await ctx.db.query("notes").first())!.cell)).toBe(CELL);
    expect(await ids(CELL)).toEqual(["way/1", "way/3"]);
    expect(await ids(markCellOf(far[0], far[1]))).toEqual(["way/2"]);
    expect((await t.query(api.notes.inCell, { slug: SLUG, cell: CELL })).map((n) => n.text)).toEqual(["alt"]);
  });

  test("ungültige Zelle oder unbekannte Aktion", async () => {
    const t = await setup();
    await expect(t.query(api.marks.inCell, { slug: SLUG, cell: "x" })).rejects.toThrow();
    expect(await t.query(api.marks.inCell, { slug: "nope", cell: CELL })).toEqual([]);
  });
});

describe("cells", () => {
  test("Zellen eines Ausschnitts enthalten die Zelle jedes Punkts darin", () => {
    const cells = markCellsIn([6.985, 50.755, 7.012, 50.771]);
    expect(cells.length).toBeGreaterThanOrEqual(6 * 4);
    expect(cells.length).toBeLessThanOrEqual(7 * 5);
    for (const [lng, lat] of [[6.99, 50.76], [6.9851, 50.7551], [7.0119, 50.7709]]) expect(cells).toContain(markCellOf(lng, lat));
    expect(markCellOf(-0.001, -0.001)).toBe("f-1:-1");
    expect(markCellOf(7.0001, 50.0001)).toBe("f1400:10000");
  });
});
