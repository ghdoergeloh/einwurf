// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { markCellOf } from "./cells";

const modules = import.meta.glob("./**/*.ts");
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
const VIEW = "ViEwKeYvIeWkEyViEwKeY1";
const HOUSE = [7.0001, 50.0001];
const CELL = markCellOf(HOUSE[0], HOUSE[1]);
const base = { name: "Test", placeLabel: "Bornheim", center: { lat: 50.76, lng: 6.99 } };

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.campaigns.create, { ...base, slug: SLUG, viewKey: VIEW });
  await t.mutation(api.marks.set, { slug: SLUG, osmId: "way/1", status: "done", center: HOUSE });
  return t;
}

afterEach(() => vi.unstubAllGlobals());

describe("Ansehen-Schlüssel", () => {
  test("liest die Aktion, ohne den Bearbeiten-Schlüssel zu verraten", async () => {
    const t = await setup();
    const c = await t.query(api.campaigns.get, { slug: VIEW });
    expect(c).toMatchObject({ access: "view", name: "Test", markCount: 1 });
    expect(JSON.stringify(c)).not.toContain(SLUG);
    expect(c).not.toHaveProperty("slug");
    expect(c).not.toHaveProperty("viewKey");
  });

  test("mit dem Bearbeiten-Schlüssel gibt es beide Schlüssel", async () => {
    const t = await setup();
    expect(await t.query(api.campaigns.get, { slug: SLUG })).toMatchObject({ access: "edit", slug: SLUG, viewKey: VIEW });
  });

  test("sieht die Markierungen live", async () => {
    const t = await setup();
    expect(await t.query(api.marks.inCell, { slug: VIEW, cell: CELL })).toEqual([
      { osmId: "way/1", center: HOUSE, status: "done" },
    ]);
  });

  test("kann nichts ändern", async () => {
    const t = await setup();
    await expect(
      t.mutation(api.marks.set, { slug: VIEW, osmId: "way/1", status: "none", center: HOUSE }),
    ).rejects.toThrow(/nicht gefunden/);
    await expect(
      t.mutation(api.marks.set, { slug: VIEW, osmId: "way/2", status: "done", center: HOUSE }),
    ).rejects.toThrow(/nicht gefunden/);
    await expect(t.mutation(api.buildings.prefetch, { slug: VIEW })).rejects.toThrow(/nicht gefunden/);
    await expect(
      t.mutation(api.campaigns.ensureViewKey, { slug: VIEW, viewKey: "ZweiterSchluesselXYZ12" }),
    ).rejects.toThrow(/nicht gefunden/);
    // Nichts hat sich geändert.
    expect(await t.query(api.marks.inCell, { slug: SLUG, cell: CELL })).toHaveLength(1);
    expect(await t.query(api.campaigns.get, { slug: SLUG })).toMatchObject({ markCount: 1, viewKey: VIEW });
    expect(await t.query(api.buildings.prefetchStatus, { slug: SLUG })).toBeNull();
  });

  test("Vorlade-Status gibt es mit dem Ansehen-Schlüssel nicht", async () => {
    const t = await setup();
    await t.mutation(api.buildings.prefetch, { slug: SLUG });
    expect(await t.query(api.buildings.prefetchStatus, { slug: SLUG })).not.toBeNull();
    expect(await t.query(api.buildings.prefetchStatus, { slug: VIEW })).toBeNull();
  });

  test("ältere Aktion bekommt den Schlüssel einmal, danach bleibt er", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.campaigns.create, { ...base, slug: SLUG });
    expect(await t.query(api.campaigns.get, { slug: SLUG })).toMatchObject({ viewKey: null });
    expect(await t.mutation(api.campaigns.ensureViewKey, { slug: SLUG, viewKey: VIEW })).toBe(VIEW);
    // Ein zweites Gerät gleichzeitig: Der erste Schlüssel gilt.
    expect(await t.mutation(api.campaigns.ensureViewKey, { slug: SLUG, viewKey: "ZweiterSchluesselXYZ12" })).toBe(VIEW);
    expect(await t.query(api.campaigns.get, { slug: VIEW })).toMatchObject({ access: "view" });
    expect(await t.query(api.campaigns.get, { slug: "ZweiterSchluesselXYZ12" })).toBeNull();
  });

  test("ungültige oder doppelte Schlüssel werden abgelehnt", async () => {
    const t = await setup();
    const other = "ZyXwVuTsRqPoNmLkJiHgFe";
    // Ansehen-Schlüssel gleich dem eigenen oder einem fremden Schlüssel
    await expect(t.mutation(api.campaigns.create, { ...base, slug: other, viewKey: other })).rejects.toThrow();
    await expect(t.mutation(api.campaigns.create, { ...base, slug: other, viewKey: SLUG })).rejects.toThrow();
    await expect(t.mutation(api.campaigns.create, { ...base, slug: other, viewKey: VIEW })).rejects.toThrow();
    await expect(t.mutation(api.campaigns.create, { ...base, slug: VIEW })).rejects.toThrow();
    await expect(t.mutation(api.campaigns.create, { ...base, slug: other, viewKey: "kurz" })).rejects.toThrow();
    await t.mutation(api.campaigns.create, { ...base, slug: other });
    await expect(t.mutation(api.campaigns.ensureViewKey, { slug: other, viewKey: VIEW })).rejects.toThrow();
    await expect(t.mutation(api.campaigns.ensureViewKey, { slug: other, viewKey: SLUG })).rejects.toThrow();
    await expect(t.mutation(api.campaigns.ensureViewKey, { slug: other, viewKey: other })).rejects.toThrow();
  });

  test("Häuser laden geht mit dem Ansehen-Schlüssel, im Kontingent der Aktion", async () => {
    const t = await setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ elements: [] }))));
    expect(await t.action(api.buildings.load, { slug: VIEW, cells: ["1398:10152"] })).toEqual(["[]"]);
    const rateKeys = await t.run(async (ctx) => (await ctx.db.query("overpassFetches").collect()).map((f) => f.slug));
    expect(rateKeys).toEqual([SLUG]);
  });
});

/**
 * Jede öffentliche Mutation muss hier stehen und den Ansehen-Schlüssel ablehnen.
 * Kommt eine neue dazu, schlägt der Test fehl, bis sie hier geprüft wird.
 */
const MUTATIONS_REJECTING_VIEW_KEY: Record<string, (t: Awaited<ReturnType<typeof setup>>) => Promise<unknown>> = {
  "marks:set": (t) => t.mutation(api.marks.set, { slug: VIEW, osmId: "way/1", status: "none", center: HOUSE }),
  "buildings:prefetch": (t) => t.mutation(api.buildings.prefetch, { slug: VIEW }),
  "campaigns:ensureViewKey": (t) => t.mutation(api.campaigns.ensureViewKey, { slug: VIEW, viewKey: "ZweiterSchluesselXYZ12" }),
};
/** Öffentliche Mutationen, die keine bestehende Aktion ändern. */
const MUTATIONS_WITHOUT_CAMPAIGN = ["campaigns:create"];

describe("Rechte aller öffentlichen Mutationen", () => {
  test("die Liste ist vollständig", async () => {
    const found: string[] = [];
    for (const [path, load] of Object.entries(modules)) {
      if (path.includes("_generated") || path.endsWith(".test.ts")) continue;
      const mod = (await load()) as Record<string, { isMutation?: boolean; isPublic?: boolean }>;
      const name = path.replace(/^\.\//, "").replace(/\.ts$/, "");
      for (const [exp, fn] of Object.entries(mod)) if (fn?.isMutation && fn.isPublic) found.push(`${name}:${exp}`);
    }
    expect(found.sort()).toEqual([...Object.keys(MUTATIONS_REJECTING_VIEW_KEY), ...MUTATIONS_WITHOUT_CAMPAIGN].sort());
  });

  for (const [name, call] of Object.entries(MUTATIONS_REJECTING_VIEW_KEY)) {
    test(`${name} lehnt den Ansehen-Schlüssel ab`, async () => {
      const t = await setup();
      await expect(call(t)).rejects.toThrow();
    });
  }
});
