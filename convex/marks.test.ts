// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
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
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: CELL })).toEqual([{ osmId: "way/1", center: HOUSE }]);
    expect((await t.query(api.campaigns.get, { slug: SLUG }))?.markCount).toBe(1);

    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: false, center: HOUSE });
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: false, center: HOUSE });
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: CELL })).toEqual([]);
    expect((await t.query(api.campaigns.get, { slug: SLUG }))?.markCount).toBe(0);
  });

  test("eine Zelle liefert nur ihre eigenen Häuser", async () => {
    const t = await setup();
    const far = [7.05, 50.05];
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: true, center: HOUSE });
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/2", marked: true, center: far });
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: CELL })).toEqual([{ osmId: "way/1", center: HOUSE }]);
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: markCellOf(far[0], far[1]) })).toEqual([
      { osmId: "way/2", center: far },
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
      const c = await ctx.db.query("campaigns").first();
      await ctx.db.patch(c!._id, { markCount: MAX_MARKS_PER_CAMPAIGN });
    });
    await expect(
      t.mutation(api.marks.set, { slug: SLUG, osmId: "way/2", marked: true, center: HOUSE }),
    ).rejects.toThrow(/zu viele Markierungen/);
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: false, center: HOUSE });
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: CELL })).toEqual([]);
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
    expect(cells).toHaveLength(4 * 3);
    expect(cells).toContain(markCellOf(6.99, 50.76));
    expect(markCellOf(-0.001, -0.001)).toBe("-1:-1");
  });
});
