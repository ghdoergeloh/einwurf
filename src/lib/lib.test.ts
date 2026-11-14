import { describe, expect, test } from "vitest";
import { generateSlug } from "./slug";
import { buildQuery, cellsBBox, cellsFor, joinRings, parseOverpass } from "./overpass";
import { parseNominatim } from "./geocode";

describe("generateSlug", () => {
  test("22 Zeichen base62, jedes Mal anders", () => {
    const a = generateSlug();
    expect(a).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(new Set(Array.from({ length: 200 }, () => generateSlug())).size).toBe(200);
  });
});

describe("overpass", () => {
  test("Abfrage nutzt Süd,West,Nord,Ost", () => {
    expect(buildQuery([7, 50, 7.1, 50.1])).toContain('way["building"](50,7,50.1,7.1)');
  });

  test("Weg wird zum Gebäude, offene Wege und Knoten werden ignoriert", () => {
    const sq = [{ lat: 50, lon: 7 }, { lat: 50, lon: 7.001 }, { lat: 50.001, lon: 7.001 }, { lat: 50, lon: 7 }];
    const f = parseOverpass({
      elements: [
        { type: "way", id: 1, geometry: sq },
        { type: "way", id: 2, geometry: sq.slice(0, 3) },
        { type: "node", id: 3 },
      ],
    });
    expect(f).toHaveLength(1);
    expect(f[0].properties.osmId).toBe("way/1");
    expect(f[0].geometry.coordinates[0][0]).toHaveLength(4);
  });

  test("Multipolygon-Relation: Teilstücke der Außenlinie werden verbunden, Innenhöfe ignoriert", () => {
    const f = parseOverpass({
      elements: [
        {
          type: "relation",
          id: 9,
          members: [
            { type: "way", role: "outer", geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }] },
            { type: "way", role: "outer", geometry: [{ lat: 0, lon: 0 }, { lat: 1, lon: 0 }, { lat: 1, lon: 1 }] },
            { type: "way", role: "inner", geometry: [{ lat: 0.2, lon: 0.2 }, { lat: 0.2, lon: 0.3 }, { lat: 0.3, lon: 0.3 }, { lat: 0.2, lon: 0.2 }] },
          ],
        },
      ],
    });
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe("relation/9");
    expect(f[0].geometry.coordinates).toHaveLength(1);
    expect(f[0].geometry.coordinates[0][0]).toHaveLength(5);
  });

  test("joinRings verwirft Stücke, die sich nicht schließen", () => {
    expect(joinRings([[[0, 0], [1, 0]], [[5, 5], [6, 6]]])).toEqual([]);
  });

  test("Kacheln decken den Ausschnitt ab", () => {
    const cells = cellsFor([7.001, 50.001, 7.012, 50.004]);
    const [w, s, e, n] = cellsBBox(cells);
    expect(w).toBeLessThanOrEqual(7.001);
    expect(s).toBeLessThanOrEqual(50.001);
    expect(e).toBeGreaterThanOrEqual(7.012);
    expect(n).toBeGreaterThanOrEqual(50.004);
    expect(cells).toHaveLength(3);
  });
});

describe("parseNominatim", () => {
  test("Boundingbox wird zu West,Süd,Ost,Nord", () => {
    const [p] = parseNominatim([
      { display_name: "Bornheim, Rhein-Sieg-Kreis, NRW", name: "Bornheim", lat: "50.76", lon: "6.99", boundingbox: ["50.7", "50.8", "6.9", "7.1"] },
    ]);
    expect(p).toEqual({ label: "Bornheim, Rhein-Sieg-Kreis, NRW", short: "Bornheim", lat: 50.76, lng: 6.99, bbox: [6.9, 50.7, 7.1, 50.8] });
  });
});
