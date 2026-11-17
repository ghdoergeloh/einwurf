import { describe, expect, test } from "vitest";
import type { Position } from "geojson";
import {
  areaAt,
  chooseParent,
  chooseSubdivision,
  compactGeometry,
  decodeGeometry,
  geometryArea,
  interiorPoint,
  parseBoundaries,
  parseParents,
  pointInGeometry,
  relationGeometry,
  simplifyRing,
  subareaQuery,
  toAreas,
  touchedCells,
  type Boundary,
} from "./areaGeo";

const box = (w: number, s: number, e: number, n: number): Position[] => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const way = (pts: Position[], role = "outer") => ({ type: "way", role, geometry: pts.map(([lon, lat]) => ({ lat, lon })) });
const boundary = (id: number, name: string, level: number, ring: Position[]): Boundary => ({ id, name, level, geometry: [[ring]] });

describe("relationGeometry", () => {
  test("setzt offene Teilstücke zu einem Ring zusammen und hängt Löcher an", () => {
    const g = relationGeometry({
      type: "relation",
      id: 1,
      members: [
        way([[0, 0], [2, 0], [2, 2]]),
        way([[2, 2], [0, 2], [0, 0]]),
        way(box(0.5, 0.5, 1, 1), "inner"),
      ],
    });
    expect(g).toHaveLength(1);
    expect(g[0]).toHaveLength(2);
    expect(pointInGeometry([0.2, 0.2], g)).toBe(true);
    expect(pointInGeometry([0.7, 0.7], g)).toBe(false); // im Loch
    expect(pointInGeometry([3, 3], g)).toBe(false);
  });
});

describe("parse", () => {
  test("Grenzen ohne Namen oder Stufe fallen weg; boundary=place zählt als feinste Stufe", () => {
    const rel = (id: number, tags: Record<string, string>) => ({ type: "relation", id, tags, members: [way(box(0, 0, 1, 1))] });
    const list = parseBoundaries({
      elements: [
        rel(1, { boundary: "administrative", admin_level: "10", name: "Roisdorf" }),
        rel(2, { boundary: "administrative", admin_level: "10" }),
        rel(3, { boundary: "place", name: "Siedlung" }),
        rel(4, { boundary: "postal_code", name: "53332" }),
      ],
    });
    expect(list.map((b) => [b.id, b.level])).toEqual([[1, 10], [3, 99]]);
  });

  test("Kandidaten für den Ort mit Ausdehnung", () => {
    const parents = parseParents({
      elements: [{ type: "relation", id: 7, tags: { boundary: "administrative", admin_level: "8", name: "Bornheim" }, bounds: { minlat: 50.7, minlon: 6.9, maxlat: 50.8, maxlon: 7.0 } }],
    });
    expect(parents).toEqual([{ id: 7, name: "Bornheim", level: 8, bbox: [6.9, 50.7, 7.0, 50.8] }]);
  });

  test("Abfrage der Teilgebiete nur feiner als der Ort", () => {
    expect(subareaQuery(42, 8)).toContain('admin_level~"^(9|10|11|12)$"');
    expect(subareaQuery(42, 8)).toContain("rel(42)");
  });
});

describe("chooseParent", () => {
  const land = { id: 1, name: "NRW", level: 4, bbox: [5, 50, 10, 52] as [number, number, number, number] };
  const kreis = { id: 2, name: "Rhein-Sieg-Kreis", level: 6, bbox: [6.8, 50.5, 7.6, 51] as [number, number, number, number] };
  const stadt = { id: 3, name: "Bornheim", level: 8, bbox: [6.9, 50.7, 7.0, 50.8] as [number, number, number, number] };
  const teil = { id: 4, name: "Roisdorf", level: 10, bbox: [6.97, 50.74, 6.99, 50.76] as [number, number, number, number] };

  test("nimmt die Grenze, die zum Ausschnitt der Ortssuche passt", () => {
    expect(chooseParent([land, kreis, stadt, teil], [6.9, 50.7, 7.0, 50.8])?.id).toBe(3);
    expect(chooseParent([land, kreis, stadt, teil], [6.97, 50.74, 6.99, 50.76])?.id).toBe(4);
  });
  test("Straße gesucht (kleiner Ausschnitt): die Gemeinde", () => {
    expect(chooseParent([land, kreis, stadt, teil], [6.98, 50.75, 6.981, 50.751])?.id).toBe(3);
    expect(chooseParent([land, kreis, stadt, teil], null)?.id).toBe(3);
  });
  test("nichts Brauchbares", () => {
    expect(chooseParent([land], [6.9, 50.7, 7.0, 50.8])).toBeNull();
  });
});

describe("chooseSubdivision", () => {
  const ort = boundary(100, "Ort", 8, box(0, 0, 4, 2));
  const teile = [
    boundary(1, "West", 10, box(0, 0, 2, 2)),
    boundary(2, "Ost", 10, box(2, 0, 4, 2)),
  ];
  // Nachbar, der nur die Grenze berührt
  const nachbar = boundary(3, "Nachbarort", 10, box(4, 0, 6, 2));
  const bezirk = [boundary(5, "Bezirk Süd", 9, box(0, 0, 4, 1)), boundary(6, "Bezirk Nord", 9, box(0, 1, 4, 2))];

  test("feinste lückenlose Stufe, ohne Nachbarn", () => {
    expect(chooseSubdivision(ort, [...teile, nachbar, ...bezirk])?.map((b) => b.name)).toEqual(["West", "Ost"]);
  });
  test("deckt die feinste Stufe nicht alles ab, gilt die nächstgröbere", () => {
    expect(chooseSubdivision(ort, [teile[0], ...bezirk])?.map((b) => b.name)).toEqual(["Bezirk Süd", "Bezirk Nord"]);
  });
  test("nur ein Teilgebiet oder keins: keine Unterteilung", () => {
    expect(chooseSubdivision(ort, [boundary(7, "Alles", 10, box(0, 0, 4, 2))])).toBeNull();
    expect(chooseSubdivision(ort, [nachbar])).toBeNull();
  });
});

describe("Geometrie", () => {
  test("Fläche mit Loch", () => {
    const k = Math.cos(0);
    expect(geometryArea([[box(0, 0, 2, 2), box(0.5, 0.5, 1.5, 1.5)]])).toBeCloseTo(4 * k - 1 * k);
  });

  test("Beschriftungspunkt liegt auch bei einem „C“ im Gebiet", () => {
    const c: Position[] = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 2], [3, 2], [3, 3], [0, 3], [0, 0]];
    const p = interiorPoint([[c]]);
    expect(pointInGeometry(p, [[c]])).toBe(true);
  });

  test("Vereinfachen entfernt Punkte auf einer Geraden und behält Ecken", () => {
    const ring: Position[] = [[0, 0], [0.5, 0.000001], [1, 0], [1, 1], [0.5, 1], [0, 1], [0, 0]];
    const s = simplifyRing(ring, 0.00002);
    expect(s).toEqual([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
  });

  test("compactGeometry wird gröber, bis es passt", () => {
    const ring: Position[] = [];
    for (let i = 0; i < 2000; i++) {
      const a = (i / 2000) * 2 * Math.PI;
      ring.push([7 + 0.05 * Math.cos(a) + 0.0003 * Math.sin(a * 97), 50.7 + 0.03 * Math.sin(a)]);
    }
    ring.push(ring[0]);
    const text = compactGeometry([[ring]], 4_000);
    expect(text.length).toBeLessThanOrEqual(4_000);
    const g = decodeGeometry(text);
    expect(g[0][0].length).toBeGreaterThanOrEqual(4);
    expect(pointInGeometry([7, 50.7], g)).toBe(true);
  });

});

describe("Zuordnung", () => {
  test("areaAt und toAreas", () => {
    const list = [
      { id: "relation/1", name: "West", geometry: JSON.stringify([[box(0, 0, 2, 2)]]), cells: "0:0 1:0" },
      { id: "relation/2", name: "Ost", geometry: JSON.stringify([[box(2, 0, 4, 2)]]), cells: "" },
    ];
    const areas = toAreas(list, ["relation/2"]);
    expect(areas.map((a) => [a.id, a.selected])).toEqual([["relation/1", true], ["relation/2", false]]);
    expect(areaAt([3, 1], areas)?.name).toBe("Ost");
    expect(areaAt([5, 1], areas)).toBeNull();
    expect(areas[0].cells).toEqual(["0:0", "1:0"]);
    expect(areas[1].cells).toEqual([]);
  });
});

describe("Review-Befunde", () => {
  test("C1: boundary=place nur als Ersatz, überlappende Stufen gelten nicht als lückenlos", () => {
    const ort = boundary(100, "Ort", 8, box(0, 0, 4, 2));
    const teile = [boundary(1, "West", 10, box(0, 0, 2, 2)), boundary(2, "Ost", 10, box(2, 0, 4, 2))];
    const places = [
      boundary(3, "Suburb West", 99, box(0, 0, 2, 2)),
      boundary(4, "Quarter A", 99, box(0, 0, 1, 2)),
      boundary(5, "Quarter B", 99, box(1, 0, 2, 2)),
    ];
    expect(chooseSubdivision(ort, [...teile, ...places])?.map((b) => b.name)).toEqual(["West", "Ost"]);
    // Ohne Verwaltungsgrenzen: überlappende place-Grenzen (200 % der Westhälfte) sind keine Teilung
    expect(chooseSubdivision(ort, places)).toBeNull();
    // Lückenlose place-Grenzen als Ersatz
    const ganz = [boundary(6, "Nord", 99, box(0, 1, 4, 2)), boundary(7, "Süd", 99, box(0, 0, 4, 1))];
    expect(chooseSubdivision(ort, ganz)?.map((b) => b.name)).toEqual(["Nord", "Süd"]);
  });

  test("C4: Kacheln eines schmalen Streifens werden erkannt", () => {
    const streifen = [[box(-0.02, 0.001, 0.02, 0.002)]];
    const cells = touchedCells(streifen);
    expect(cells).toContain("0:0");
    expect(cells).toContain("-4:0");
    expect(cells).not.toContain("0:1");
  });

  test("C2: Kacheln einer großen Fläche schnell", () => {
    const ring: Position[] = [];
    for (let i = 0; i < 4000; i++) {
      const a = (i / 4000) * 2 * Math.PI;
      ring.push([7 + 0.2 * Math.cos(a) + 0.002 * Math.sin(a * 131), 50.9 + 0.15 * Math.sin(a)]);
    }
    ring.push(ring[0]);
    const t0 = performance.now();
    const cells = touchedCells([[ring]]);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(cells.length).toBeGreaterThan(3000);
    expect(cells).toContain(`${Math.floor(7 / 0.005)}:${Math.floor(50.9 / 0.005)}`);
  });
});
