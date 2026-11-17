import { describe, expect, test, vi } from "vitest";
import { MAX_STORE_POINTS, loadAndStore, pointsOf } from "./areaLoading";
import type { Ask } from "../../convex/areaLoad";

type Ring = [number, number][];
const box = (w: number, s: number, e: number, n: number): Ring => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const rel = (id: number, name: string, level: number, ring: Ring) => ({
  type: "relation",
  id,
  tags: { name, boundary: "administrative", admin_level: String(level) },
  bounds: { minlon: ring[0][0], minlat: ring[0][1], maxlon: ring[2][0], maxlat: ring[2][1] },
  members: [{ type: "way", role: "outer", geometry: ring.map(([lon, lat]) => ({ lat, lon })) }],
});
/** Zwei Gemeinden in der Kachel 140:1014, jede mit zwei Ortsteilen. */
const REGION = [
  rel(100, "Bornheim", 8, box(7.0, 50.7, 7.02, 50.72)),
  rel(11, "Roisdorf", 10, box(7.0, 50.7, 7.01, 50.72)),
  rel(12, "Hersel", 10, box(7.01, 50.7, 7.02, 50.72)),
  rel(200, "Alfter", 8, box(7.02, 50.7, 7.04, 50.72)),
  rel(21, "Alfter-Ort", 9, box(7.02, 50.7, 7.03, 50.72)),
  rel(22, "Witterschlick", 9, box(7.03, 50.7, 7.04, 50.72)),
];
const ask: Ask = async (_step, query, parse) => {
  const ids = query.match(/rel\(id:([\d,]+)\)/);
  const levels = new Set((query.match(/admin_level~"\^\(([\d|]+)\)\$"/)?.[1] ?? "").split("|"));
  const elements = ids
    ? REGION.filter((r) => ids[1].split(",").map(Number).includes(r.id))
    : REGION.filter((r) => levels.has(r.tags.admin_level)).map(({ members: _m, ...r }) => r);
  return parse({ elements } as never);
};

describe("loadAndStore", () => {
  test("speichert alle Gemeinden und am Ende die Kacheln", async () => {
    const store = vi.fn(async () => {});
    const fallback = vi.fn(async () => {});
    await loadAndStore(["140:1014"], { ask, knownUnits: async () => [], store, fallback });
    expect(fallback).not.toHaveBeenCalled();
    expect(store).toHaveBeenCalledTimes(1);
    const [units, tiles] = store.mock.calls[0] as unknown as [{ unitId: number }[], { tile: string; unitIds: number[] }[]];
    expect(units.map((u) => u.unitId).sort()).toEqual([100, 200]);
    expect(tiles).toEqual([{ tile: "140:1014", unitIds: expect.arrayContaining([100, 200]) }]);
  });

  test("teilt nach Punkten auf; die Kacheln kommen mit dem letzten Aufruf", async () => {
    const big = Array.from({ length: MAX_STORE_POINTS * 0.6 }, (_, i) => [7 + i * 1e-7, 50.7]);
    const store = vi.fn(async () => {});
    await loadAndStore(["140:1014"], {
      // Jede Gemeinde mit einer Grenze von 60 % des Budgets: zwei Aufrufe nötig
      ask: async (step, q, parse) => {
        const r = await ask(step, q, parse);
        if (step === "Ortsteile (Grenzen)") for (const b of r as { geometry: number[][][][] }[]) b.geometry = [[[...big, big[0]] as number[][]]];
        return r;
      },
      knownUnits: async () => [],
      store,
      fallback: async () => {},
    });
    expect(store.mock.calls.length).toBeGreaterThanOrEqual(2);
    const calls = store.mock.calls as unknown as [unknown[], unknown[]][];
    calls.slice(0, -1).forEach(([, tiles]) => expect(tiles).toEqual([]));
    expect(calls.at(-1)![1]).toHaveLength(1);
    for (const [units] of calls)
      expect((units as { areas: { geometry: string }[] }[]).flatMap((u) => u.areas).reduce((n, a) => n + pointsOf(a.geometry), 0)).toBeLessThanOrEqual(MAX_STORE_POINTS * 1.3);
  });

  test("Browser scheitert: Convex lädt; scheitert auch das, gilt der Fehler des Browsers", async () => {
    const failing: Ask = async () => {
      throw new Error("overpass-api.de: HTTP 406");
    };
    const fallback = vi.fn(async () => {});
    await loadAndStore(["140:1014"], { ask: failing, knownUnits: async () => [], store: async () => {}, fallback });
    expect(fallback).toHaveBeenCalledTimes(1);
    await expect(
      loadAndStore(["140:1014"], { ask: failing, knownUnits: async () => [], store: async () => {}, fallback: async () => Promise.reject(new Error("Convex")) }),
    ).rejects.toThrow("overpass-api.de: HTTP 406");
  });

  test("Punkte zählen", () => {
    expect(pointsOf(JSON.stringify([[box(7, 50, 7.1, 50.1)]]))).toBe(5);
  });
});
