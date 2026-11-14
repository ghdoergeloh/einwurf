// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
const square = [[[[7, 50], [7.0001, 50], [7.0001, 50.0001], [7, 50.0001], [7, 50]]]];

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
});

describe("marks", () => {
  test("markieren, erneut markieren ist idempotent, demarkieren", async () => {
    const t = await setup();
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: true, geometry: square });
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: true, geometry: square });
    let marks = await t.query(api.marks.list, { slug: SLUG });
    expect(marks).toEqual([{ osmId: "way/1", geometry: square }]);
    expect((await t.query(api.campaigns.get, { slug: SLUG }))?.markCount).toBe(1);

    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: false });
    await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: false });
    marks = await t.query(api.marks.list, { slug: SLUG });
    expect(marks).toEqual([]);
    expect((await t.query(api.campaigns.get, { slug: SLUG }))?.markCount).toBe(0);
  });

  test("Markierungen gehören nur zu ihrer Aktion", async () => {
    const t = await setup();
    const other = "ZyXwVuTsRqPoNmLkJiHgFe";
    await t.mutation(api.campaigns.create, {
      slug: other, name: "Andere", placeLabel: "Bonn", center: { lat: 50.7, lng: 7.1 },
    });
    await t.mutation(api.marks.set, { slug: other, osmId: "way/1", marked: true, geometry: square });
    expect(await t.query(api.marks.list, { slug: SLUG })).toEqual([]);
    expect(await t.query(api.marks.list, { slug: other })).toHaveLength(1);
  });

  test("ohne gültige Aktion, ID oder Geometrie wird abgelehnt", async () => {
    const t = await setup();
    await expect(
      t.mutation(api.marks.set, { slug: "ZZZZZZZZZZZZZZZZZZZZZZ", osmId: "way/1", marked: true, geometry: square }),
    ).rejects.toThrow(/nicht gefunden/);
    await expect(
      t.mutation(api.marks.set, { slug: SLUG, osmId: "node/1", marked: true, geometry: square }),
    ).rejects.toThrow();
    await expect(t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: true })).rejects.toThrow();
    await expect(
      t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", marked: true, geometry: [[[[7, 50], [7, 51]]]] }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.marks.set, {
        slug: SLUG, osmId: "way/1", marked: true, geometry: [[[[7, 500], [7, 50], [8, 50], [7, 500]]]],
      }),
    ).rejects.toThrow();
  });

  test("Liste für unbekannte Aktion ist leer", async () => {
    const t = await setup();
    expect(await t.query(api.marks.list, { slug: "nope" })).toEqual([]);
  });
});
