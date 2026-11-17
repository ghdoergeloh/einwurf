import { computeTiles, type Ask, type LoadedTiles } from "../../convex/areaLoad";

/** So viel schickt ein Speicher-Aufruf höchstens an Convex: Text der Grenzen … */
export const MAX_STORE_CHARS = 2_000_000;
/** … und Punkte (Convex berechnet je Grenze Ausdehnung und Kacheln in der Mutation, ~1 s Budget). */
export const MAX_STORE_POINTS = 100_000;

export type StoreUnits = { unitId: number; areas: { areaId: string; name: string; geometry: string }[] }[];

/** Punkte einer Grenze als Text (jedes Koordinatenpaar beginnt mit „[“ gefolgt von einer Zahl). */
export const pointsOf = (geometry: string) => (geometry.match(/\[-?\d/g) ?? []).length;

/**
 * Lädt Grenz-Kacheln im Browser (`ask` fragt Overpass) und speichert sie über `store`:
 * Gemeinden in Teilen (höchstens MAX_STORE_CHARS Text und MAX_STORE_POINTS Punkte je Aufruf),
 * die Kacheln mit dem letzten Aufruf. Scheitert das, versucht es `fallback` (Convex lädt selbst);
 * scheitert auch das, gilt der Fehler des Browsers.
 */
export async function loadAndStore(
  tiles: string[],
  deps: {
    ask: Ask;
    knownUnits: (unitIds: number[]) => Promise<number[]>;
    store: (units: StoreUnits, tiles: LoadedTiles["tiles"]) => Promise<unknown>;
    fallback: () => Promise<unknown>;
  },
): Promise<void> {
  try {
    const result = await computeTiles(tiles, deps.ask, deps.knownUnits);
    let chunk: StoreUnits = [];
    let chars = 0;
    let points = 0;
    for (const u of result.units) {
      const areas = u.areas.map((a) => ({ areaId: a.areaId, name: a.name, geometry: a.geometry }));
      const c = areas.reduce((n, a) => n + a.geometry.length, 0);
      const p = areas.reduce((n, a) => n + pointsOf(a.geometry), 0);
      if (chunk.length && (chars + c > MAX_STORE_CHARS || points + p > MAX_STORE_POINTS)) {
        await deps.store(chunk, []);
        chunk = [];
        chars = 0;
        points = 0;
      }
      chunk.push({ unitId: u.unitId, areas });
      chars += c;
      points += p;
    }
    await deps.store(chunk, result.tiles);
  } catch (browserError) {
    try {
      await deps.fallback();
    } catch {
      throw browserError;
    }
  }
}
