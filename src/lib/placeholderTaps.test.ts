import { describe, expect, test } from "vitest";
import { neighbourCells, resolvePlaceholderTaps, type PlaceholderTap } from "./placeholderTaps";
import { CELL_SIZE, cellKeyOf } from "../../convex/osm";

const at = (lng: number, lat: number): PlaceholderTap => ({ lngLat: [lng, lat] });
const P = at(7.0012, 50.0012);

describe("Tipp auf ein Haus, das noch lädt", () => {
  test("Kachel und Nachbarn: 3 × 3", () => {
    const cells = neighbourCells([7.0012, 50.0012]);
    expect(cells).toHaveLength(9);
    expect(cells).toContain(cellKeyOf([7.0012, 50.0012]));
    expect(cells).toContain(cellKeyOf([7.0012 + CELL_SIZE, 50.0012 - CELL_SIZE]));
  });

  test("Kachel geladen, Haus gefunden: Tipp ausführen", () => {
    const r = resolvePlaceholderTaps([P], () => true, () => "way/1");
    expect(r.apply).toEqual([{ tap: P, osmId: "way/1" }]);
    expect(r.rest).toEqual([]);
  });

  test("noch nicht geladen: weiter merken", () => {
    const r = resolvePlaceholderTaps([P], () => false, () => "way/1");
    expect(r.apply).toEqual([]);
    expect(r.rest).toEqual([P]);
  });

  test("Haus gehört vielleicht zu einer Nachbarkachel, die noch lädt: weiter merken", () => {
    const own = cellKeyOf(P.lngLat);
    const r = resolvePlaceholderTaps([P], (c) => c === own, () => null);
    expect(r.rest).toEqual([P]);
    expect(r.dropped).toEqual([]);
  });

  test("alles geladen und kein Haus an der Stelle: verwerfen", () => {
    const r = resolvePlaceholderTaps([P], () => true, () => null);
    expect(r.dropped).toEqual([P]);
    expect(r.rest).toEqual([]);
  });
});
