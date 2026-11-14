import { describe, expect, test } from "vitest";
import { CELL_SIZE, MAX_CELL_SPAN, buildQuery, decodeBuildings, encodeBuildings, parseCellKey, parseOverpass, planPrefetch, prefetchArea } from "./osm";

const ROISDORF: [number, number, number, number] = [6.97, 50.745, 7.0, 50.765];
const EFB: [number, number] = [6.985, 50.755];

describe("planPrefetch", () => {
  const batches = planPrefetch(ROISDORF, EFB);
  const all = batches.flat();

  test("deckt das ganze Gebiet ab, jede Kachel genau einmal", () => {
    const xs = [Math.floor(ROISDORF[0] / CELL_SIZE), Math.floor(ROISDORF[2] / CELL_SIZE)];
    const ys = [Math.floor(ROISDORF[1] / CELL_SIZE), Math.floor(ROISDORF[3] / CELL_SIZE)];
    expect(all).toHaveLength((xs[1] - xs[0] + 1) * (ys[1] - ys[0] + 1));
    expect(new Set(all).size).toBe(all.length);
  });

  test("jeder Abruf ist erlaubt: höchstens 24 Kacheln, nah beieinander", () => {
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(24);
      const c = b.map((k) => parseCellKey(k)!);
      expect(Math.max(...c.map((p) => p.x)) - Math.min(...c.map((p) => p.x))).toBeLessThan(MAX_CELL_SPAN);
      expect(Math.max(...c.map((p) => p.y)) - Math.min(...c.map((p) => p.y))).toBeLessThan(MAX_CELL_SPAN);
    }
  });

  test("beginnt am Startpunkt und geht nach außen", () => {
    const start = `${Math.floor(EFB[0] / CELL_SIZE)}:${Math.floor(EFB[1] / CELL_SIZE)}`;
    expect(batches[0]).toContain(start);
    const kx = Math.cos((EFB[1] * Math.PI) / 180);
    const dist = (b: string[]) => {
      const c = b.map((k) => parseCellKey(k)!);
      const mx = ((Math.min(...c.map((p) => p.x)) + Math.max(...c.map((p) => p.x)) + 1) / 2) * CELL_SIZE;
      const my = ((Math.min(...c.map((p) => p.y)) + Math.max(...c.map((p) => p.y)) + 1) / 2) * CELL_SIZE;
      return Math.hypot((mx - EFB[0]) * kx, my - EFB[1]);
    };
    const d = batches.map(dist);
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThanOrEqual(d[i - 1] - 1e-9);
  });

  test("riesiger oder weltweiter Ausschnitt: schnell und begrenzt", () => {
    const t0 = performance.now();
    const world = planPrefetch([-180, -89, 179.99, 89], EFB);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(world.flat().length).toBeLessThanOrEqual(600);
    expect(world[0]).toContain(`${Math.floor(EFB[0] / CELL_SIZE)}:${Math.floor(EFB[1] / CELL_SIZE)}`);
  });

  test("verdrehter Ausschnitt: kein Plan", () => {
    expect(planPrefetch([7, 50.8, 6.9, 50.7], EFB)).toEqual([]);
  });

  test("großes Gebiet: begrenzt, die fernen Blöcke fallen weg", () => {
    const big = planPrefetch([6.8, 50.6, 7.3, 50.9], EFB, 100);
    expect(big.flat().length).toBeLessThanOrEqual(100);
    expect(big[0]).toContain(`${Math.floor(EFB[0] / CELL_SIZE)}:${Math.floor(EFB[1] / CELL_SIZE)}`);
  });
});

describe("prefetchArea", () => {
  test("Gebiet der Ortssuche, sonst um die Mitte", () => {
    expect(prefetchArea({ center: { lat: 50, lng: 7 }, bbox: ROISDORF })).toEqual(ROISDORF);
    const [w, s, e, n] = prefetchArea({ center: { lat: 50, lng: 7 }, bbox: null });
    expect(w < 7 && e > 7 && s < 50 && n > 50).toBe(true);
  });
});

describe("Hausnummern", () => {
  const square = (id: number, lon: number, lat: number, tags?: Record<string, string>) => {
    const d = 0.0001;
    return {
      type: "way",
      id,
      tags,
      geometry: [
        { lat: lat - d, lon: lon - d },
        { lat: lat - d, lon: lon + d },
        { lat: lat + d, lon: lon + d },
        { lat: lat + d, lon: lon - d },
        { lat: lat - d, lon: lon - d },
      ],
    };
  };
  const node = (id: number, lon: number, lat: number, hn: string) => ({ type: "node", id, lat, lon, tags: { "addr:housenumber": hn } });

  test("Abfrage holt auch Adresspunkte", () => {
    expect(buildQuery([7, 50, 7.01, 50.01])).toContain('node["addr:housenumber"]');
  });

  test("Nummer am Gebäude oder am Adresspunkt im Gebäude", () => {
    const fs = parseOverpass({
      elements: [
        square(1, 7, 50, { building: "yes", "addr:housenumber": "12" }),
        square(2, 7.001, 50),
        node(10, 7.001, 50, "14a"),
        square(3, 7.002, 50), // Garage ohne Nummer
        node(11, 7.005, 50, "99"), // Adresse ohne Haus
      ],
    });
    expect(fs.map((f) => [f.properties.osmId, f.properties.hn])).toEqual([
      ["way/1", "12"],
      ["way/2", "14a"],
      ["way/3", undefined],
    ]);
  });

  test("mehrere Adressen in einem Haus: sortiert, höchstens drei", () => {
    const fs = parseOverpass({
      elements: [
        square(1, 7, 50),
        node(10, 7, 50, "5"),
        node(11, 7.00002, 50, "3"),
        node(12, 7.00004, 50, "11"),
        node(13, 7.00006, 50, "7"),
        node(14, 7.00008, 50, "3"),
      ],
    });
    expect(fs[0].properties.hn).toBe("3, 5, 7 …");
  });

  test("Kodieren und Dekodieren behält die Nummer; altes Format ohne Nummer geht weiter", () => {
    const fs = parseOverpass({ elements: [square(1, 7, 50, { "addr:housenumber": "2" }), square(2, 7.001, 50)] });
    const back = decodeBuildings(encodeBuildings(fs));
    expect(back.map((f) => f.properties.hn)).toEqual(["2", undefined]);
    const old = JSON.stringify([["way/9", fs[0].geometry.coordinates]]);
    expect(decodeBuildings(old)[0].properties).toEqual({ osmId: "way/9" });
  });
});

test("riesiges Gebäude: Adresspunkt wird trotzdem gefunden, ohne Speicher zu sprengen", () => {
  const ring = [[6, 50], [8, 50], [8, 51], [6, 51], [6, 50]].map(([lon, lat]) => ({ lon, lat }));
  const fs = parseOverpass({
    elements: [{ type: "way", id: 1, geometry: ring }, { type: "node", id: 2, lon: 7, lat: 50.5, tags: { "addr:housenumber": "1" } }],
  });
  expect(fs[0].properties.hn).toBe("1");
});
