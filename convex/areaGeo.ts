/**
 * Gebiete (Ortsteile): Overpass-Abfragen, Wahl der Gemeinden und ihrer Ortsteile, Zusammensetzen
 * der Grenzen, Vereinfachen, Punkt-in-Polygon. Rein und ohne Netz – genutzt von convex/areas.ts
 * und vom Browser.
 *
 * Schnittstelle für andere Teile (z. B. Statistik je Gebiet):
 *   - `Area` = { id, name, geometry, selected }
 *   - `areaAt(punkt, gebiete)` ordnet einen Punkt [lng, lat] (Haus, Markierung) einem Gebiet zu.
 *   - Serverseitig liefert `campaignAreas(ctx, campaignId)` aus convex/areaStore.ts die Gebiete,
 *     im Browser `toAreas(api.areas.list, api.areas.status)`.
 */
import type { Position } from "geojson";
import { CELL_SIZE, cellKey, joinRings, type BBox } from "./osm";

/** MultiPolygon-Koordinaten [lng, lat]: Polygone aus Außenring und Löchern. */
export type AreaGeometry = Position[][][];

export interface Area {
  /** OSM-Relation des Ortsteils, z. B. „relation/2804866“ (stabil, für alle Aktionen gleich). */
  id: string;
  name: string;
  geometry: AreaGeometry;
  /** Soll in dieser Aktion dort verteilt werden? */
  selected: boolean;
}

// ---------------------------------------------------------------------------
// Overpass
// ---------------------------------------------------------------------------

/** Feinste Verwaltungsstufe, die wir als Gebiet betrachten. */
const MAX_LEVEL = 12;

/**
 * Grenz-Kacheln: Das Angebot an Ortsteilen wird je Kachel von 0,05° (in Bornheim etwa
 * 5,5 × 3,5 km) geladen und für alle Aktionen gespeichert.
 */
export const BOUNDARY_TILE = 0.05;
export const BOUNDARY_TILE_PATTERN = /^-?\d{1,4}:-?\d{1,4}$/;

export function boundaryTileOf(lng: number, lat: number): string {
  return `${Math.floor(lng / BOUNDARY_TILE)}:${Math.floor(lat / BOUNDARY_TILE)}`;
}

export function boundaryTilesIn([w, s, e, n]: BBox): string[] {
  const out: string[] = [];
  for (let x = Math.floor(w / BOUNDARY_TILE); x <= Math.floor(e / BOUNDARY_TILE); x++)
    for (let y = Math.floor(s / BOUNDARY_TILE); y <= Math.floor(n / BOUNDARY_TILE); y++) out.push(`${x}:${y}`);
  return out;
}

export function boundaryTileBBox(tile: string): BBox {
  const [x, y] = tile.split(":").map(Number);
  return [x * BOUNDARY_TILE, y * BOUNDARY_TILE, (x + 1) * BOUNDARY_TILE, (y + 1) * BOUNDARY_TILE];
}

/** Gemeinden: Stufe 8; kreisfreie Städte und Kreise (6, 7) nur, wenn keine Gemeinde in ihnen liegt. */
const UNIT_LEVELS = [6, 7, 8];

/** Schritt 1: Gemeinden (und gröbere Kandidaten), die den Ausschnitt schneiden, ohne Geometrie. */
export function unitQuery([w, s, e, n]: BBox): string {
  return `[out:json][timeout:60];rel[boundary=administrative][admin_level~"^(${UNIT_LEVELS.join("|")})$"](${s},${w},${n},${e});out tags bb;`;
}

/**
 * Welche Grenzen sind Gemeinden, deren Ortsteile angeboten werden? Alle auf Stufe 8; eine
 * gröbere (z. B. die kreisfreie Stadt Bonn auf Stufe 6) nur, wenn keine Gemeinde der Liste ganz
 * in ihrer Ausdehnung liegt (ein Kreis enthält seine Gemeinden, eine kreisfreie Stadt keine).
 */
export function chooseUnits(list: ParentCandidate[]): ParentCandidate[] {
  const municipalities = list.filter((c) => c.level === 8);
  const inside = (a: BBox, b: BBox) => a[0] >= b[0] && a[2] <= b[2] && a[1] >= b[1] && a[3] <= b[3];
  const coarse = list.filter((c) => c.level < 8 && UNIT_LEVELS.includes(c.level) && !municipalities.some((m) => inside(m.bbox, c.bbox)));
  // Von mehreren gröberen, ineinander liegenden (Stufe 6 und 7) nur die feinste.
  const finest = coarse.filter((c) => !coarse.some((o) => o.id !== c.id && o.level > c.level && inside(o.bbox, c.bbox)));
  return [...municipalities, ...finest];
}

/**
 * Ortsteile einer Gemeinde: die Unterteilung nach chooseSubdivision, sonst die Gemeinde selbst
 * als ein Gebiet.
 */
export function areasOfUnit(unit: Boundary, boundaries: Boundary[]): Boundary[] {
  return chooseSubdivision(unit, boundaries) ?? [unit];
}

/**
 * Schritt 2: alle feineren Grenzen in der Ausdehnung des Ortes (Verwaltung, ersatzweise
 * boundary=place), nur mit Namen, Stufe und Ausdehnung. Das ist auch für ausgelastete Server
 * leicht; die Geometrie holt Schritt 3 nur für die Kandidaten (siehe preselect).
 */
export function candidateQuery(level: number, [w, s, e, n]: BBox): string {
  const levels = [];
  for (let l = level + 1; l <= MAX_LEVEL; l++) levels.push(l);
  const box = `${s},${w},${n},${e}`;
  const admin = levels.length ? `rel[boundary=administrative][admin_level~"^(${levels.join("|")})$"](${box});` : "";
  return `[out:json][timeout:60];(${admin}rel[boundary=place](${box}););out tags bb;`;
}

/** Schritt 3: Grenzen (Geometrie) genau dieser Relationen. */
export function geometryQuery(ids: number[]): string {
  return `[out:json][timeout:120];rel(id:${ids.join(",")});out geom;`;
}

/** Mehr Kandidaten holt Schritt 3 nicht (Größe der Antwort). */
export const MAX_CANDIDATES = 400;

/**
 * Vorauswahl ohne Geometrie: nur feinere Grenzen, deren Ausdehnung im Ort liegt. Gebiete der
 * Nachbarorte und -kreise ragen über seine Ausdehnung hinaus und fallen so schon vor dem
 * Laden der Geometrie weg; den Rest prüft chooseSubdivision genau.
 */
export function preselect(parent: ParentCandidate, candidates: ParentCandidate[]): ParentCandidate[] {
  const [w, s, e, n] = parent.bbox;
  const tx = (e - w) * 0.01 + 1e-4;
  const ty = (n - s) * 0.01 + 1e-4;
  return candidates
    .filter(
      (c) =>
        c.id !== parent.id &&
        c.level > parent.level &&
        c.bbox[0] >= w - tx && c.bbox[2] <= e + tx && c.bbox[1] >= s - ty && c.bbox[3] <= n + ty,
    )
    .slice(0, MAX_CANDIDATES);
}

interface OverpassPoint {
  lat: number;
  lon: number;
}
export interface OverpassRelation {
  type: string;
  id: number;
  tags?: Record<string, string>;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  members?: { type: string; role: string; geometry?: OverpassPoint[] }[];
}

export interface Boundary {
  id: number;
  name: string;
  /** admin_level; boundary=place zählt als feiner als jede Verwaltungsstufe. */
  level: number;
  geometry: AreaGeometry;
}

/** Stufe für boundary=place (Ersatz, wenn Verwaltungsgrenzen fehlen). */
export const PLACE_LEVEL = 99;

export function levelOf(tags: Record<string, string> | undefined): number | null {
  if (!tags) return null;
  if (tags.boundary === "place") return PLACE_LEVEL;
  const l = Number(tags.admin_level);
  return tags.boundary === "administrative" && Number.isInteger(l) ? l : null;
}

/** Setzt eine Relation mit Geometrie (Overpass „out geom“) zu einem MultiPolygon mit Löchern zusammen. */
export function relationGeometry(rel: OverpassRelation): AreaGeometry {
  const ways = (rel.members ?? []).filter((m) => m.type === "way" && m.geometry && m.geometry.length >= 2);
  const ring = (m: (typeof ways)[number]) => m.geometry!.map((p) => [p.lon, p.lat]);
  const outers = joinRings(ways.filter((m) => m.role !== "inner").map(ring));
  const inners = joinRings(ways.filter((m) => m.role === "inner").map(ring));
  const polys: Position[][][] = outers.map((o) => [o]);
  for (const hole of inners) {
    // Loch dem Außenring zuordnen, in dem es liegt (kleinster zuerst, falls verschachtelt).
    const owner = polys
      .filter((p) => inRing(hole[0], p[0]))
      .sort((a, b) => Math.abs(ringArea(a[0])) - Math.abs(ringArea(b[0])))[0];
    owner?.push(hole);
  }
  return polys;
}

export function parseBoundaries(json: { elements?: OverpassRelation[] }): Boundary[] {
  const out: Boundary[] = [];
  for (const el of json.elements ?? []) {
    if (el.type !== "relation") continue;
    const level = levelOf(el.tags);
    const name = el.tags?.name?.trim();
    if (level === null || !name) continue;
    const geometry = relationGeometry(el);
    if (geometry.length) out.push({ id: el.id, name, level, geometry });
  }
  return out;
}

export interface ParentCandidate {
  id: number;
  name: string;
  level: number;
  bbox: BBox;
}

/** Grenzen mit Stufe und Ausdehnung (Overpass „out tags bb“), auch boundary=place. */
export function parseCandidates(json: { elements?: OverpassRelation[] }): ParentCandidate[] {
  const out: ParentCandidate[] = [];
  for (const el of json.elements ?? []) {
    const level = levelOf(el.tags);
    if (el.type !== "relation" || level === null || !el.bounds) continue;
    const b = el.bounds;
    out.push({ id: el.id, name: el.tags?.name ?? "", level, bbox: [b.minlon, b.minlat, b.maxlon, b.maxlat] });
  }
  return out;
}

/** So viel des Ortes muss eine Stufe abdecken, damit sie als lückenlose Unterteilung gilt. */
export const MIN_COVERAGE = 0.9;

/**
 * Wählt die Unterteilung des Ortes: die feinste Verwaltungsstufe, deren Gebiete (mindestens zwei)
 * den Ort lückenlos und ohne nennenswerte Überlappung abdecken; sonst eine Mischung der Stufen
 * (gröbere zuerst, Lücken mit feineren gefüllt); erst danach boundary=place als Ersatz.
 * Gebiete der Nachbarorte, die nur die Grenze berühren, fallen weg.
 * null = keine Unterteilung, der ganze Ort ist ein Gebiet.
 */
export function chooseSubdivision(parent: Boundary, candidates: Boundary[]): Boundary[] | null {
  const samples = samplePoints(parent.geometry);
  if (samples.length === 0) return null;
  const byLevel = new Map<number, Boundary[]>();
  for (const c of candidates) {
    if (c.id === parent.id || c.level <= parent.level) continue;
    if (!pointInGeometry(interiorPoint(c.geometry), parent.geometry)) continue;
    byLevel.set(c.level, [...(byLevel.get(c.level) ?? []), c]);
  }
  const fits = (list: Boundary[]) => {
    if (list.length < 2) return false;
    const { covered, overlap } = coverage(samples, list);
    return covered >= MIN_COVERAGE && overlap <= MAX_OVERLAP;
  };
  const admin = [...byLevel.keys()].filter((l) => l !== PLACE_LEVEL).sort((a, b) => a - b);
  // 1. Eine Verwaltungsstufe allein, von fein nach grob (z. B. Stadtbezirke einer Großstadt).
  for (const level of [...admin].reverse()) if (fits(byLevel.get(level)!)) return byLevel.get(level)!;
  // 2. Gemischte Stufen: Oft sind Ortsteile teils auf der einen, teils auf der nächsten Stufe
  //    erfasst (in Bornheim etwa Hersel auf 9, Brenig auf 10). Von grob nach fein auffüllen:
  //    Ein Gebiet kommt dazu, wenn sein Inneres noch in keinem gröberen liegt.
  const mixed: Boundary[] = [];
  for (const level of admin)
    for (const c of byLevel.get(level)!) {
      const inner = interiorPoint(c.geometry);
      if (!mixed.some((m) => pointInGeometry(inner, m.geometry))) mixed.push(c);
    }
  if (mixed.some((m) => m.level !== mixed[0].level) && fits(mixed)) return mixed;
  // 3. Ersatz: boundary=place, wenn es den Ort lückenlos teilt.
  const place = byLevel.get(PLACE_LEVEL);
  return place && fits(place) ? place : null;
}

/** Höchstens so viel des Ortes darf in mehr als einem Gebiet einer Stufe liegen (doppelte oder verschachtelte Grenzen). */
export const MAX_OVERLAP = 0.1;
/** Stichproben je Richtung über den Ort. */
const SAMPLE_GRID = 48;

/** Gleichmäßig verteilte Punkte im Gebiet (Raster über die Ausdehnung). */
function samplePoints(g: AreaGeometry): Position[] {
  const [w, s, e, n] = bboxOf(g);
  const out: Position[] = [];
  for (let i = 0; i < SAMPLE_GRID; i++)
    for (let j = 0; j < SAMPLE_GRID; j++) {
      const pt = [w + ((i + 0.5) / SAMPLE_GRID) * (e - w), s + ((j + 0.5) / SAMPLE_GRID) * (n - s)];
      if (pointInGeometry(pt, g)) out.push(pt);
    }
  return out;
}

/** Anteil der Stichproben in mindestens einem Gebiet und in mehr als einem. */
function coverage(samples: Position[], list: Boundary[]): { covered: number; overlap: number } {
  const boxes = list.map((b) => ({ g: b.geometry, b: bboxOf(b.geometry) }));
  let covered = 0;
  let overlap = 0;
  for (const pt of samples) {
    let hits = 0;
    for (const { g, b } of boxes) {
      if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
      if (pointInGeometry(pt, g) && ++hits > 1) break;
    }
    if (hits >= 1) covered++;
    if (hits > 1) overlap++;
  }
  return { covered: covered / samples.length, overlap: overlap / samples.length };
}

// ---------------------------------------------------------------------------
// Geometrie
// ---------------------------------------------------------------------------

/** Fläche eines Rings in Grad² mit Vorzeichen (Gauß), Länge auf den Breitengrad gestaucht. */
export function ringArea(ring: Position[]): number {
  let s = 0;
  const k = Math.cos(((ring[0]?.[1] ?? 0) * Math.PI) / 180);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][0] * k) * ring[i][1] - (ring[i][0] * k) * ring[j][1];
  }
  return s / 2;
}

export function geometryArea(g: AreaGeometry): number {
  let s = 0;
  for (const poly of g) {
    s += Math.abs(ringArea(poly[0]));
    for (const hole of poly.slice(1)) s -= Math.abs(ringArea(hole));
  }
  return Math.max(0, s);
}

/** Punkt im Ring (Strahl-Methode). */
export function inRing([x, y]: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Liegt der Punkt [lng, lat] im Gebiet (in einem Außenring, nicht in dessen Löchern)? */
export function pointInGeometry(pt: Position, g: AreaGeometry): boolean {
  return g.some((poly) => inRing(pt, poly[0]) && !poly.slice(1).some((hole) => inRing(pt, hole)));
}

export function bboxOf(g: AreaGeometry): BBox {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of g)
    for (const [x, y] of poly[0]) {
      w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
    }
  return [w, s, e, n];
}

/**
 * Ein Punkt sicher im Gebiet, für die Beschriftung und zum Aussortieren der Nachbarn:
 * auf einer waagerechten Linie durch die Mitte des größten Polygons die Mitte des breitesten
 * Stücks, das im Gebiet liegt (der Schwerpunkt läge bei einem „C“ außerhalb).
 */
export function interiorPoint(g: AreaGeometry): [number, number] {
  const poly = [...g].sort((a, b) => Math.abs(ringArea(b[0])) - Math.abs(ringArea(a[0])))[0];
  const [w, s, e, n] = bboxOf([poly]);
  let best: { x: number; y: number; len: number } | null = null;
  // Mehrere Linien probieren, falls die mittlere nur einen schmalen Zipfel trifft.
  for (const f of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const y = s + (n - s) * f;
    const xs: number[] = [];
    for (const ring of poly)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const len = xs[i + 1] - xs[i];
      if (!best || len > best.len) best = { x: (xs[i] + xs[i + 1]) / 2, y, len };
    }
  }
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return best ? [r(best.x), r(best.y)] : [r((w + e) / 2), r((s + n) / 2)];
}

/** Abstand eines Punkts von der Strecke a–b (in Grad, Länge gestaucht). */
function segmentDistance(p: Position, a: Position, b: Position, k: number): number {
  const [px, py, ax, ay, bx, by] = [p[0] * k, p[1], a[0] * k, a[1], b[0] * k, b[1]];
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Vereinfacht einen geschlossenen Ring (Douglas-Peucker); Toleranz in Grad Breite (0,00002° ≈ 2 m). */
export function simplifyRing(ring: Position[], tolerance: number): Position[] {
  if (ring.length <= 5) return ring;
  const k = Math.cos((ring[0][1] * Math.PI) / 180);
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  // Geschlossener Ring: am weitesten vom Startpunkt entfernten Punkt als zweiten Anker nehmen.
  let far = 1;
  for (let i = 1; i < ring.length - 1; i++)
    if (Math.hypot((ring[i][0] - ring[0][0]) * k, ring[i][1] - ring[0][1]) > Math.hypot((ring[far][0] - ring[0][0]) * k, ring[far][1] - ring[0][1])) far = i;
  keep[far] = 1;
  const stack: [number, number][] = [[0, far], [far, ring.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    let max = 0;
    let idx = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = segmentDistance(ring[i], ring[i0], ring[i1], k);
      if (d > max) [max, idx] = [d, i];
    }
    if (idx >= 0 && max > tolerance) {
      keep[idx] = 1;
      stack.push([i0, idx], [idx, i1]);
    }
  }
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  const out = ring.filter((_, i) => keep[i]).map(([x, y]) => [r(x), r(y)]);
  return out.length >= 4 ? out : ring;
}

export function simplifyGeometry(g: AreaGeometry, tolerance: number): AreaGeometry {
  return g.map((poly) => poly.map((ring) => simplifyRing(ring, tolerance)));
}

/** Vereinfachen (≈ 2 m), und gröber, bis das Gebiet höchstens maxBytes als Text belegt. */
export function compactGeometry(g: AreaGeometry, maxBytes = 400_000): string {
  let tolerance = 0.00002;
  for (;;) {
    const text = JSON.stringify(simplifyGeometry(g, tolerance));
    if (text.length <= maxBytes || tolerance > 0.01) return text;
    tolerance *= 2;
  }
}

export function decodeGeometry(text: string): AreaGeometry {
  return JSON.parse(text) as AreaGeometry;
}

// ---------------------------------------------------------------------------
// Zuordnung
// ---------------------------------------------------------------------------

/**
 * Gebiet, in dem der Punkt [lng, lat] liegt, oder null. Überlappen sich Gebiete (kommt in OSM
 * vor), gewinnt das erste in der Liste.
 */
export function areaAt<A extends { geometry: AreaGeometry }>(pt: Position, areas: A[]): A | null {
  for (const a of areas) if (pointInGeometry(pt, a.geometry)) return a;
  return null;
}

/** Gebiet mit den Gebäude-Kacheln, die es berührt (für Laden und Vorladen). */
export type AreaWithCells = Area & { cells: string[] };

/** Kacheln wie gespeichert (durch Leerzeichen getrennt; Convex-Arrays fassen höchstens 8192 Einträge). */
export const encodeCells = (cells: string[]) => cells.join(" ");
export const decodeCells = (text: string) => (text ? text.split(" ") : []);

/** Entpackt die Gebiete einer Aktion (api.areas.list) zu `Area` samt Kacheln. */
export function toAreas(
  list: { id: string; name: string; geometry: string; cells: string; selected: boolean }[],
): AreaWithCells[] {
  return list.map((a) => ({
    id: a.id,
    name: a.name,
    geometry: decodeGeometry(a.geometry),
    selected: a.selected,
    cells: decodeCells(a.cells),
  }));
}

/** Gewählte Gebiete als Filter für Kacheln und Häuser. */
export interface Selection {
  /** Umschließender Ausschnitt aller gewählten Gebiete. */
  bbox: BBox;
  /** Berührt die Gebäude-Kachel "x:y" ein gewähltes Gebiet? (siehe touchedCells) */
  touches: (cell: string) => boolean;
  /** Liegt der Punkt [lng, lat] in einem gewählten Gebiet? */
  contains: (pt: Position) => boolean;
}

/**
 * Filter für die gewählten Gebiete; null heißt „keine Einschränkung“: Gebiete noch nicht geladen
 * oder nichts gewählt. Dann gilt wie bisher der ganze Ort.
 */
export function selectionOf(
  areas: { geometry: AreaGeometry; selected: boolean; cells: string[] }[] | null,
): Selection | null {
  const picked = (areas ?? []).filter((a) => a.selected);
  const cells = new Set(picked.flatMap((a) => a.cells));
  const chosen = picked.map((a) => ({ g: a.geometry, b: bboxOf(a.geometry) }));
  if (chosen.length === 0) return null;
  const bbox: BBox = [
    Math.min(...chosen.map((c) => c.b[0])),
    Math.min(...chosen.map((c) => c.b[1])),
    Math.max(...chosen.map((c) => c.b[2])),
    Math.max(...chosen.map((c) => c.b[3])),
  ];
  const inBox = ([x, y]: Position, b: BBox) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
  return {
    bbox,
    touches: (cell) => cells.has(cell),
    contains: (pt) => chosen.some((c) => inBox(pt, c.b) && pointInGeometry(pt, c.g)),
  };
}

/**
 * Alle Gebäude-Kacheln ("x:y", CELL_SIZE), die das Gebiet berühren: Kacheln, deren Mitte darin
 * liegt, und alle Kacheln, durch die eine Grenze läuft (auch schmale Streifen). Wird einmal beim
 * Laden der Gebiete berechnet und gespeichert, damit Auswahl und Vorladen schnell bleiben.
 */
export function touchedCells(g: AreaGeometry): string[] {
  const out = new Set<string>();
  const rings = g.flat();
  const cx = (x: number) => Math.floor(x / CELL_SIZE);
  // Grenzen: jede Kachel, die eine Kante schneidet (Rasterdurchlauf nach Amanatides/Woo).
  for (const ring of rings)
    for (let i = 0; i + 1 < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[i + 1];
      let x = cx(x0);
      let y = cx(y0);
      const xEnd = cx(x1);
      const yEnd = cx(y1);
      out.add(cellKey(x, y));
      const dx = x1 - x0;
      const dy = y1 - y0;
      const stepX = Math.sign(dx);
      const stepY = Math.sign(dy);
      const tDeltaX = dx ? Math.abs(CELL_SIZE / dx) : Infinity;
      const tDeltaY = dy ? Math.abs(CELL_SIZE / dy) : Infinity;
      let tMaxX = dx ? ((stepX > 0 ? (x + 1) * CELL_SIZE - x0 : x0 - x * CELL_SIZE) / Math.abs(dx)) : Infinity;
      let tMaxY = dy ? ((stepY > 0 ? (y + 1) * CELL_SIZE - y0 : y0 - y * CELL_SIZE) / Math.abs(dy)) : Infinity;
      let guard = Math.abs(xEnd - x) + Math.abs(yEnd - y) + 2;
      while ((x !== xEnd || y !== yEnd) && guard-- > 0) {
        if (tMaxX < tMaxY) {
          x += stepX;
          tMaxX += tDeltaX;
        } else {
          y += stepY;
          tMaxY += tDeltaY;
        }
        out.add(cellKey(x, y));
      }
    }
  // Innen: Kacheln, deren Mitte im Gebiet liegt (Scanlinie je Kachelreihe, Löcher gerade/ungerade).
  const [, south, , north] = bboxOf(g);
  for (let y = cx(south); y <= cx(north); y++) {
    const yc = (y + 0.5) * CELL_SIZE;
    const xs: number[] = [];
    for (const ring of rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > yc !== yj > yc) xs.push(((xj - xi) * (yc - yi)) / (yj - yi) + xi);
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let x = Math.ceil(xs[k] / CELL_SIZE - 0.5); (x + 0.5) * CELL_SIZE <= xs[k + 1]; x++) out.add(cellKey(x, y));
  }
  return [...out];
}

/**
 * Nur die Einträge (Markierungen, Notizen), deren Mittelpunkt in einem gewählten Gebiet liegt.
 * Die anderen bleiben gespeichert, die Karte zeigt sie nur nicht. Ohne Auswahl: alle.
 */
export function visibleIn<T extends { center: Position }>(items: Map<string, T>, selection: Selection | null): Map<string, T> {
  if (!selection) return items;
  return new Map([...items].filter(([, item]) => selection.contains(item.center)));
}
