// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { markCellOf } from "./cells";
import { MAX_NOTE_LENGTH, MAX_NOTES_PER_CAMPAIGN } from "./validation";

const modules = import.meta.glob("./**/*.ts");
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
const OTHER = "ZyXwVuTsRqPoNmLkJiHgFe";
const HOUSE = [7.0001, 50.0001];
const CELL = markCellOf(HOUSE[0], HOUSE[1]);

async function setup() {
  const t = convexTest(schema, modules);
  for (const slug of [SLUG, OTHER]) {
    await t.mutation(api.campaigns.create, { slug, name: "Aktion", placeLabel: "Bornheim", center: { lat: 50, lng: 7 } });
  }
  return t;
}

const inCell = (t: Awaited<ReturnType<typeof setup>>, slug = SLUG, cell = CELL) =>
  t.query(api.notes.inCell, { slug, cell });

describe("notes", () => {
  test("anlegen, ändern, löschen", async () => {
    const t = await setup();
    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/1", center: HOUSE, text: "Briefkasten 3 und 4 fehlen" });
    expect(await inCell(t)).toMatchObject([{ osmId: "way/1", center: HOUSE, text: "Briefkasten 3 und 4 fehlen" }]);

    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/1", center: HOUSE, text: "Kiste war leer" });
    const notes = await inCell(t);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ text: "Kiste war leer" });
    expect(typeof notes[0].updatedAt).toBe("number");

    await t.mutation(api.notes.remove, { slug: SLUG, osmId: "way/1" });
    await t.mutation(api.notes.remove, { slug: SLUG, osmId: "way/1" }); // idempotent
    expect(await inCell(t)).toEqual([]);
  });

  test("Text: Zeilen bleiben, Ränder und Steuerzeichen weg; leer oder zu lang wird abgelehnt", async () => {
    const t = await setup();
    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/1", center: HOUSE, text: "  Zeile 1\r\nZeile 2\u0007\n\n\n\nEnde  " });
    expect((await inCell(t))[0].text).toBe("Zeile 1\nZeile 2\n\nEnde");
    await expect(t.mutation(api.notes.set, { slug: SLUG, osmId: "way/2", center: HOUSE, text: " \n " })).rejects.toThrow(/leer/);
    await expect(
      t.mutation(api.notes.set, { slug: SLUG, osmId: "way/2", center: HOUSE, text: "x".repeat(MAX_NOTE_LENGTH + 1) }),
    ).rejects.toThrow(/zu lang/);
    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/2", center: HOUSE, text: "x".repeat(MAX_NOTE_LENGTH) });
  });

  test("ungültige Aktion, ID oder Koordinaten werden abgelehnt", async () => {
    const t = await setup();
    const ok = { slug: SLUG, osmId: "way/1", center: HOUSE, text: "x" };
    await expect(t.mutation(api.notes.set, { ...ok, slug: "ZZZZZZZZZZZZZZZZZZZZZZ" })).rejects.toThrow(/nicht gefunden/);
    await expect(t.mutation(api.notes.set, { ...ok, slug: "kurz" })).rejects.toThrow();
    await expect(t.mutation(api.notes.set, { ...ok, osmId: "node/1" })).rejects.toThrow();
    await expect(t.mutation(api.notes.set, { ...ok, center: [7] })).rejects.toThrow();
    await expect(t.mutation(api.notes.set, { ...ok, center: [7, 500] })).rejects.toThrow();
    await expect(t.mutation(api.notes.remove, { slug: SLUG, osmId: "node/1" })).rejects.toThrow();
    await expect(t.mutation(api.notes.remove, { slug: "ZZZZZZZZZZZZZZZZZZZZZZ", osmId: "way/1" })).rejects.toThrow(/nicht gefunden/);
  });

  test("gehören nur zu ihrer Aktion und Zelle", async () => {
    const t = await setup();
    const far = [7.05, 50.05];
    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/1", center: HOUSE, text: "a" });
    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/2", center: far, text: "b" });
    await t.mutation(api.notes.set, { slug: OTHER, osmId: "way/1", center: HOUSE, text: "c" });
    expect((await inCell(t)).map((n) => n.text)).toEqual(["a"]);
    expect((await inCell(t, SLUG, markCellOf(far[0], far[1]))).map((n) => n.text)).toEqual(["b"]);
    expect((await inCell(t, OTHER)).map((n) => n.text)).toEqual(["c"]);
    await t.mutation(api.notes.remove, { slug: OTHER, osmId: "way/1" });
    expect((await inCell(t)).map((n) => n.text)).toEqual(["a"]);
  });

  test("Obergrenze je Aktion; Ändern und Löschen gehen weiter, Löschen gibt Platz frei", async () => {
    const t = await setup();
    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/1", center: HOUSE, text: "a" });
    await t.run(async (ctx) => {
      const counts = (await ctx.db.query("campaignCounts").first())!;
      await ctx.db.patch(counts._id, { notes: MAX_NOTES_PER_CAMPAIGN });
    });
    await expect(t.mutation(api.notes.set, { slug: SLUG, osmId: "way/2", center: HOUSE, text: "b" })).rejects.toThrow(
      /zu viele Notizen/,
    );
    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/1", center: HOUSE, text: "geändert" });
    await t.mutation(api.notes.remove, { slug: SLUG, osmId: "way/1" });
    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/2", center: HOUSE, text: "b" });
    // Die andere Aktion ist nicht betroffen.
    await t.mutation(api.notes.set, { slug: OTHER, osmId: "way/2", center: HOUSE, text: "b" });
  });

  test("Zähler zählt neue Notizen, nicht Änderungen", async () => {
    const t = await setup();
    const count = () => t.run(async (ctx) => (await ctx.db.query("campaignCounts").first())?.notes ?? 0);
    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/1", center: HOUSE, text: "a" });
    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/1", center: HOUSE, text: "b" });
    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/2", center: HOUSE, text: "c" });
    expect(await count()).toBe(2);
    await t.mutation(api.notes.remove, { slug: SLUG, osmId: "way/1" });
    await t.mutation(api.notes.remove, { slug: SLUG, osmId: "way/1" });
    expect(await count()).toBe(1);
  });

  test("nur unsichtbare Zeichen gilt als leer", async () => {
    const t = await setup();
    await expect(t.mutation(api.notes.set, { slug: SLUG, osmId: "way/1", center: HOUSE, text: "\u200B\u2060\uFEFF" })).rejects.toThrow(
      /leer/,
    );
    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/1", center: HOUSE, text: "a\u200Bb" });
    expect((await inCell(t))[0].text).toBe("a\u200Bb");
    // Zusammengesetzte Emojis (mit Zero-Width-Joiner) bleiben ganz.
    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/2", center: HOUSE, text: "a👨‍👩b" });
    expect((await inCell(t)).find((n) => n.osmId === "way/2")!.text).toBe("a👨‍👩b");
  });

  test("gleichzeitig geändert: Speichern und Löschen mit veraltetem Stand werden abgelehnt", async () => {
    const t = await setup();
    // Erwartet „keine Notiz“, aber jemand war schneller.
    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/1", center: HOUSE, text: "a", expectedUpdatedAt: null });
    await expect(
      t.mutation(api.notes.set, { slug: SLUG, osmId: "way/1", center: HOUSE, text: "b", expectedUpdatedAt: null }),
    ).rejects.toThrow(/inzwischen/);
    const seen = (await inCell(t))[0].updatedAt;
    await expect(
      t.mutation(api.notes.set, { slug: SLUG, osmId: "way/1", center: HOUSE, text: "b", expectedUpdatedAt: seen - 1 }),
    ).rejects.toThrow(/inzwischen/);
    await expect(t.mutation(api.notes.remove, { slug: SLUG, osmId: "way/1", expectedUpdatedAt: seen - 1 })).rejects.toThrow(
      /inzwischen/,
    );
    await t.mutation(api.notes.set, { slug: SLUG, osmId: "way/1", center: HOUSE, text: "b", expectedUpdatedAt: seen });
    expect((await inCell(t))[0].text).toBe("b");
    await t.mutation(api.notes.remove, { slug: SLUG, osmId: "way/1", expectedUpdatedAt: (await inCell(t))[0].updatedAt });
    expect(await inCell(t)).toEqual([]);
    // Schon gelöscht: Löschen mit altem Stand ist dann einfach erledigt.
    await t.mutation(api.notes.remove, { slug: SLUG, osmId: "way/1", expectedUpdatedAt: seen });
  });

  test("ungültige Zelle oder unbekannte Aktion", async () => {
    const t = await setup();
    await expect(t.query(api.notes.inCell, { slug: SLUG, cell: "x" })).rejects.toThrow();
    expect(await t.query(api.notes.inCell, { slug: "nope", cell: CELL })).toEqual([]);
  });
});
