/**
 * Laden der Ortsteile für Grenz-Kacheln: welche Abfragen, in welcher Reihenfolge, was gespeichert
 * wird. Rein und ohne Netz; die Abfrage selbst (`ask`) stellt der Aufrufer: der Browser des
 * Admins (src/components/AreaEditor.tsx) oder Convex (convex/areas.ts, beim Anlegen).
 */
import {
  MAX_CANDIDATES,
  areasOfUnit,
  bboxOf,
  boundaryTileBBox,
  candidateQuery,
  chooseUnits,
  compactGeometry,
  decodeGeometry,
  encodeCells,
  geometryQuery,
  interiorPoint,
  parseBoundaries,
  parseCandidates,
  preselect,
  touchedCells,
  unitQuery,
  type AreaGeometry,
  type ParentCandidate,
} from "./areaGeo";
import type { BBox } from "./osm";

/** Ein Ortsteil belegt als Text höchstens so viel (gröber vereinfacht, wenn nötig). */
export const MAX_AREA_BYTES = 200_000;

/** Eine Overpass-Abfrage; `step` benennt den Schritt für die Fehlermeldung. */
export type Ask = <T>(step: string, query: string, parse: (json: never) => T) => Promise<T>;

export interface OsmAreaRow {
  areaId: string;
  name: string;
  geometry: string;
  bbox: number[];
  labelAt: number[];
  cells: string;
}

export interface LoadedTiles {
  /** Ortsteile je neu geladener Gemeinde. */
  units: { unitId: number; areas: OsmAreaRow[] }[];
  /** Gemeinden je Kachel (nur solche mit Ortsteilen im Cache). */
  tiles: { tile: string; unitIds: number[] }[];
}

/** Gespeicherte Form eines Gebiets; die abgeleiteten Felder werden aus der Grenze berechnet. */
export function areaRow(areaId: string, name: string, geometry: AreaGeometry): OsmAreaRow {
  const text = compactGeometry(geometry, MAX_AREA_BYTES);
  const g = decodeGeometry(text);
  return { areaId, name, geometry: text, bbox: bboxOf(g), labelAt: interiorPoint(g), cells: encodeCells(touchedCells(g)) };
}

const intersects = (a: BBox, b: BBox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const union = (boxes: BBox[]): BBox => [
  Math.min(...boxes.map((b) => b[0])),
  Math.min(...boxes.map((b) => b[1])),
  Math.max(...boxes.map((b) => b[2])),
  Math.max(...boxes.map((b) => b[3])),
];

/**
 * Ortsteile für diese (fehlenden) Grenz-Kacheln: (1) die Gemeinden, die sie schneiden, (2) für
 * Gemeinden, die nicht schon im Cache sind (`knownUnits`), die Liste feinerer Grenzen in ihrer
 * Ausdehnung, (3) die Grenzen der Gemeinden und ihrer Kandidaten, in Abrufen von höchstens
 * MAX_CANDIDATES Grenzen, nie eine Gemeinde nur zum Teil. Je Gemeinde werden die Ortsteile
 * gewählt (areaGeo.areasOfUnit). Gemeinden ohne eigene Grenze in der Antwort fallen weg.
 */
export async function computeTiles(
  tiles: string[],
  ask: Ask,
  knownUnits: (unitIds: number[]) => Promise<number[]>,
): Promise<LoadedTiles> {
  if (tiles.length === 0) return { units: [], tiles: [] };
  const tileBoxes = tiles.map(boundaryTileBBox);
  const units = chooseUnits(await ask("Gemeinden", unitQuery(union(tileBoxes)), parseCandidates));
  const known = new Set(await knownUnits(units.map((u) => u.id)));
  const fresh = units.filter((u) => !known.has(u.id));
  const stored = new Set<number>(known);
  const loaded: LoadedTiles["units"] = [];

  if (fresh.length > 0) {
    const candidates = await ask(
      "Ortsteile (Liste)",
      candidateQuery(Math.min(...fresh.map((u) => u.level)), union(fresh.map((u) => u.bbox))),
      parseCandidates,
    );
    // Je Gemeinde höchstens MAX_CANDIDATES Grenzen (auch eine sehr große Gemeinde).
    const perUnit = new Map<number, ParentCandidate[]>(fresh.map((u) => [u.id, preselect(u, candidates).slice(0, MAX_CANDIDATES - 1)]));
    let todo = [...fresh];
    while (todo.length > 0) {
      const ids = new Set<number>();
      const batch: ParentCandidate[] = [];
      for (const unit of todo) {
        const own = [unit.id, ...perUnit.get(unit.id)!.map((c) => c.id)].filter((id) => !ids.has(id));
        if (batch.length > 0 && ids.size + own.length > MAX_CANDIDATES) continue;
        own.forEach((id) => ids.add(id));
        batch.push(unit);
      }
      todo = todo.filter((u) => !batch.includes(u));
      const boundaries = await ask("Ortsteile (Grenzen)", geometryQuery([...ids]), parseBoundaries);
      for (const unit of batch) {
        const own = boundaries.find((b) => b.id === unit.id);
        if (!own) continue;
        const mine = new Set(perUnit.get(unit.id)!.map((c) => c.id));
        const parts = areasOfUnit(own, boundaries.filter((b) => mine.has(b.id)));
        loaded.push({ unitId: unit.id, areas: parts.map((p) => areaRow(`relation/${p.id}`, p.name, p.geometry)) });
        stored.add(unit.id);
      }
    }
  }
  return {
    units: loaded,
    tiles: tiles.map((tile, i) => ({
      tile,
      unitIds: units.filter((u) => stored.has(u.id) && intersects(u.bbox, tileBoxes[i])).map((u) => u.id),
    })),
  };
}

/** Öffentliche Overpass-Server, der Reihe nach (auch für Convex, siehe buildings.ts). */
export const DEFAULT_OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  // Aus der Convex-Cloud ist overpass-api.de zeitweise gar nicht erreichbar („error sending request“);
  // dann kommt dieser sofort dran.
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
