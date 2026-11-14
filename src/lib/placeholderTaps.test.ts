import { describe, expect, test } from "vitest";
import { PLACEHOLDER_MAX_AGE_MS, cyclePlaceholder, neighbourCells, resolvePlaceholderTaps, type PlaceholderTap } from "./placeholderTaps";
import { CELL_SIZE, cellKeyOf } from "../../convex/osm";
import { settleTaps } from "./pendingTaps";

const tap = (to: PlaceholderTap["to"] = "done", at = 0): PlaceholderTap => ({ lngLat: [7.0012, 50.0012], shape: [], to, at });
const P = tap();

describe("Tipp auf ein Haus, das noch lädt", () => {
  test("mitten in der Kachel: nur diese; nah am Rand: auch die Nachbarkachel", () => {
    const mid = (CELL_SIZE * 1400.5);
    expect(neighbourCells([mid, mid])).toEqual([cellKeyOf([mid, mid])]);
    const edge = CELL_SIZE * 1400 + 0.0001;
    expect(neighbourCells([edge, mid]).sort()).toEqual([cellKeyOf([edge, mid]), cellKeyOf([edge - CELL_SIZE, mid])].sort());
  });

  test("Haus war offen, auf dem Server aber inzwischen „nicht möglich“: Konflikt, nichts senden", () => {
    // Aufgelöste Platzhalter-Tipps gehen als gemerkter Tipp „von offen aus“ in settleTaps.
    const pending = new Map([["way/1", { from: "none" as const, to: "done" as const, center: [7, 50] }]]);
    const r = settleTaps(pending, () => true, () => "blocked");
    expect(r.send).toEqual([]);
    expect(r.conflicts).toEqual(["way/1"]);
  });

  test("weitere Tipps schalten weiter wie bei jedem Haus; einmal rundherum: weg", () => {
    let m = new Map<string, PlaceholderTap>();
    m = cyclePlaceholder(m, "a", { lngLat: [7, 50], shape: [] }, 0);
    expect(m.get("a")?.to).toBe("done");
    m = cyclePlaceholder(m, "a", { lngLat: [7, 50], shape: [] }, 0);
    expect(m.get("a")?.to).toBe("blocked");
    m = cyclePlaceholder(m, "a", { lngLat: [7, 50], shape: [] }, 0);
    expect(m.has("a")).toBe(false);
  });

  test("Kachel geladen, Haus gefunden: übernehmen", () => {
    const r = resolvePlaceholderTaps([P], () => true, () => "way/1", 0);
    expect(r.apply).toEqual([{ tap: P, osmId: "way/1" }]);
    expect(r.rest).toEqual([]);
  });

  test("noch nicht geladen: weiter merken", () => {
    const r = resolvePlaceholderTaps([P], () => false, () => "way/1", 0);
    expect(r.rest).toEqual([P]);
  });

  test("Haus gehört vielleicht zu einer Nachbarkachel, die noch lädt: weiter merken", () => {
    const nearEdge: PlaceholderTap = { ...P, lngLat: [7.0002, 50.0012] };
    const own = cellKeyOf(nearEdge.lngLat);
    const r = resolvePlaceholderTaps([nearEdge], (c) => c === own, () => null, 0);
    expect(r.rest).toEqual([nearEdge]);
    expect(r.dropped).toEqual([]);
  });

  test("alles geladen und kein Haus an der Stelle: verwerfen", () => {
    const r = resolvePlaceholderTaps([P], () => true, () => null, 0);
    expect(r.dropped).toEqual([P]);
  });

  test("kommt das Haus zu lange nicht (weggeschoben, Overpass weg): verwerfen", () => {
    const r = resolvePlaceholderTaps([P], () => false, () => null, PLACEHOLDER_MAX_AGE_MS + 1);
    expect(r.expired).toEqual([P]);
    expect(r.rest).toEqual([]);
  });
});
