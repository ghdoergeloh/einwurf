import { describe, expect, test } from "vitest";
import { addTap, cellsToWatch, settleTaps, type PendingTap } from "./pendingTaps";
import { markCellOf } from "../../convex/cells";
import type { HouseStatus } from "../../convex/status";

const C = [7, 50];
const empty = () => new Map<string, PendingTap>();

describe("addTap: Tipps, solange die Markierungen noch laden", () => {
  test("schaltet vom angezeigten Zustand weiter", () => {
    const p = addTap(empty(), "way/1", "none", C);
    expect(p.get("way/1")).toEqual({ from: "none", to: "done", center: C });
  });
  test("weitere Tipps schalten weiter, der Ausgangszustand bleibt", () => {
    let p = addTap(empty(), "way/1", "none", C);
    p = addTap(p, "way/1", "done", C);
    expect(p.get("way/1")).toEqual({ from: "none", to: "blocked", center: C });
  });
  test("einmal rundherum: nichts mehr zu tun", () => {
    let p = addTap(empty(), "way/1", "none", C);
    p = addTap(p, "way/1", "done", C);
    p = addTap(p, "way/1", "blocked", C);
    expect(p.size).toBe(0);
  });
  test("verändert die alte Map nicht", () => {
    const a = empty();
    addTap(a, "way/1", "none", C);
    expect(a.size).toBe(0);
  });
});

describe("settleTaps: sobald die Zelle geladen ist", () => {
  const server = (s: Record<string, HouseStatus>) => (id: string) => s[id] ?? "none";
  test("Zelle noch nicht geladen: bleibt vorgemerkt", () => {
    const p = addTap(empty(), "way/1", "none", C);
    const r = settleTaps(p, () => false, server({}));
    expect(r.send).toEqual([]);
    expect(r.rest.size).toBe(1);
  });
  test("Server wie gesehen: abschicken", () => {
    const p = addTap(empty(), "way/1", "none", C);
    const r = settleTaps(p, () => true, server({}));
    expect(r.send).toEqual([{ osmId: "way/1", status: "done", center: C }]);
    expect(r.conflicts).toEqual([]);
    expect(r.rest.size).toBe(0);
  });
  test("jemand anderes hat das Haus inzwischen geändert: nicht überschreiben", () => {
    // Gesehen: offen (noch nicht geladen); tatsächlich schon „nicht möglich“.
    const p = addTap(empty(), "way/1", "none", C);
    const r = settleTaps(p, () => true, server({ "way/1": "blocked" }));
    expect(r.send).toEqual([]);
    expect(r.conflicts).toEqual(["way/1"]);
  });
  test("Server hat schon den gewünschten Zustand: still erledigt", () => {
    const p = addTap(empty(), "way/1", "none", C);
    const r = settleTaps(p, () => true, server({ "way/1": "done" }));
    expect(r.send).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.rest.size).toBe(0);
  });
});

describe("cellsToWatch: Zellen gemerkter Tipps bleiben abonniert", () => {
  test("auch wenn der Helfer weitergegangen ist", () => {
    let p = addTap(empty(), "way/1", "none", [7.0005, 50.0005]);
    p = addTap(p, "way/2", "none", [7.0006, 50.0006]);
    p = addTap(p, "way/3", "none", [8.0005, 51.0005]);
    expect(cellsToWatch(p).sort()).toEqual([markCellOf(7.0005, 50.0005), markCellOf(8.0005, 51.0005)].sort());
  });
  test("ohne gemerkte Tipps keine", () => expect(cellsToWatch(empty())).toEqual([]));
});
