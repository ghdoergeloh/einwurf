import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "../../convex/_generated/api";
import { MAX_TILES_PER_LOAD, MAX_TILES_PER_VIEW, boundaryTilesIn, decodeGeometry } from "../../convex/areaGeo";
import type { BBox } from "../../convex/osm";
import { searchPlaces, type Place } from "../lib/geocode";
import { computeTiles } from "../../convex/areaLoad";
import { browserAsk } from "../lib/overpassBrowser";

/** So viel Grenz-Text schickt ein Speicher-Aufruf höchstens an Convex. */
const MAX_STORE_CHARS = 2_000_000;
import type { MapArea } from "./BuildingMap";


type Campaign = { id: string; name: string; geometry: string; labelAt: number[]; cells: string; selected: boolean; bbox: number[] };

/**
 * Modus „Gebiete bearbeiten“ (Admin-Link): Angebot an Ortsteilen im sichtbaren Ausschnitt aus
 * dem gemeinsamen Cache, fehlende Kacheln werden über Convex von Overpass nachgeladen.
 * Liefert die Gebiete für die Karte (Angebot und Auswahl der Aktion zusammen) und `toggle`.
 */
export function useAreaEditor({
  adminKey,
  slug,
  active,
  view,
  campaignAreas,
}: {
  adminKey: string | undefined;
  slug: string;
  active: boolean;
  view: { bbox: BBox; zoom: number } | null;
  campaignAreas: Campaign[] | undefined | null;
}) {
  const allTiles = useMemo(() => (active && view ? boundaryTilesIn(view.bbox) : []), [active, view]);
  const tooFar = allTiles.length > MAX_TILES_PER_VIEW;
  const tiles = tooFar ? [] : allTiles;
  const nearby = useQuery(api.areas.nearby, active && adminKey && tiles.length ? { adminKey, tiles } : "skip");
  const loadTiles = useAction(api.areas.loadTiles);
  const storeLoaded = useMutation(api.areas.storeLoaded);
  const convex = useConvex();

  /**
   * Lädt Kacheln im Browser (Overpass direkt) und speichert sie über Convex; erreicht der
   * Browser Overpass nicht, versucht es Convex selbst.
   */
  const load = useCallback(
    async (key: string, batch: string[]) => {
      try {
        const result = await computeTiles(batch, browserAsk, (unitIds) => convex.query(api.areas.unitsInCache, { adminKey: key, unitIds }));
        let chunk: { unitId: number; areas: { areaId: string; name: string; geometry: string }[] }[] = [];
        let size = 0;
        for (const u of result.units) {
          const areas = u.areas.map((a) => ({ areaId: a.areaId, name: a.name, geometry: a.geometry }));
          const chars = areas.reduce((n, a) => n + a.geometry.length, 0);
          if (chunk.length && size + chars > MAX_STORE_CHARS) {
            await storeLoaded({ adminKey: key, units: chunk, tiles: [] });
            chunk = [];
            size = 0;
          }
          chunk.push({ unitId: u.unitId, areas });
          size += chars;
        }
        await storeLoaded({ adminKey: key, units: chunk, tiles: result.tiles });
      } catch (browserError) {
        // Ersatz: Convex fragt Overpass selbst.
        try {
          await loadTiles({ adminKey: key, tiles: batch });
        } catch {
          throw browserError;
        }
      }
    },
    [convex, loadTiles, storeLoaded],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Kacheln, deren Laden gescheitert ist: nicht in einer Schleife neu versuchen, erst auf Knopfdruck. */
  const failed = useRef(new Set<string>());
  const busy = useRef(false);

  const missing = useMemo(
    () => (nearby ? tiles.filter((t) => !nearby.loaded.includes(t) && !failed.current.has(t)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nearby, tiles.join(","), error],
  );

  useEffect(() => {
    if (!active || !adminKey || busy.current || missing.length === 0) return;
    busy.current = true;
    setLoading(true);
    const batch = missing.slice(0, MAX_TILES_PER_LOAD);
    load(adminKey, batch)
      .then(() => setError(null))
      .catch((e: unknown) => {
        batch.forEach((t) => failed.current.add(t));
        setError(
          e instanceof ConvexError && typeof e.data === "string"
            ? e.data
            : e instanceof Error
              ? e.message
              : "Die Ortsteile konnten nicht geladen werden.",
        );
      })
      .finally(() => {
        busy.current = false;
        setLoading(false);
      });
  }, [active, adminKey, missing, load]);

  const retry = useCallback(() => {
    failed.current.clear();
    setError(null);
  }, []);

  // Angebot und Auswahl der Aktion zusammen; Geometrie nur einmal je Gebiet entpacken.
  const decoded = useRef(new Map<string, MapArea["geometry"]>());
  const geometryOf = (id: string, text: string) => {
    let g = decoded.current.get(id);
    if (!g) decoded.current.set(id, (g = decodeGeometry(text)));
    return g;
  };
  const areas = useMemo<MapArea[]>(() => {
    const own = new Map((campaignAreas ?? []).map((a) => [a.id, a]));
    const out: MapArea[] = [];
    const seen = new Set<string>();
    for (const a of nearby?.areas ?? []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      const mine = own.get(a.id);
      out.push({ id: a.id, name: a.name, geometry: geometryOf(a.id, a.geometry), labelAt: a.labelAt, selected: !!mine?.selected, cells: mine ? mine.cells.split(" ").filter(Boolean) : [] });
    }
    for (const a of own.values()) {
      if (seen.has(a.id)) continue;
      out.push({ id: a.id, name: a.name, geometry: geometryOf(a.id, a.geometry), labelAt: a.labelAt, selected: a.selected, cells: a.cells.split(" ").filter(Boolean) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nearby, campaignAreas]);

  // Antippen: sofort umfärben (optimistisch), dann speichern.
  const offered = useRef(nearby?.areas ?? []);
  offered.current = nearby?.areas ?? offered.current;
  const select = useMutation(api.areas.select).withOptimisticUpdate((store, { ids, selected }) => {
    const list = store.getQuery(api.areas.list, { slug });
    if (!list) return;
    const next = [...list];
    for (const id of ids) {
      const i = next.findIndex((a) => a.id === id);
      if (i >= 0) next[i] = { ...next[i], selected };
      else if (selected) {
        const o = offered.current.find((a) => a.id === id);
        if (o) next.push({ id, name: o.name, geometry: o.geometry, labelAt: o.labelAt, bbox: [], cells: "", selected: true });
      }
    }
    store.setQuery(api.areas.list, { slug }, next);
  });
  const [saveError, setSaveError] = useState<string | null>(null);
  const toggle = useCallback(
    (id: string) => {
      if (!adminKey) return;
      const current = areas.find((a) => a.id === id);
      setSaveError(null);
      select({ adminKey, ids: [id], selected: !current?.selected }).catch((e: unknown) =>
        setSaveError(e instanceof ConvexError && typeof e.data === "string" ? e.data : "Konnte nicht gespeichert werden."),
      );
    },
    [adminKey, areas, select],
  );

  // Alle Kacheln geladen, aber kein Angebot: OSM kennt hier keine Gemeinden mit Grenzen.
  const empty = !!nearby && tiles.length > 0 && nearby.loaded.length === tiles.length && nearby.areas.length === 0;

  return {
    areas,
    toggle,
    tooFar,
    empty,
    loading: loading || (tiles.length > 0 && nearby === undefined),
    error: saveError ?? error,
    retry,
    selectedCount: (campaignAreas ?? []).filter((a) => a.selected).length,
  };
}

/** Leiste oben im Modus „Gebiete bearbeiten“. */
export function AreaEditBar({
  selectedCount,
  placeLabel,
  loading,
  tooFar,
  empty,
  error,
  onRetry,
  onChangePlace,
  onDone,
}: {
  selectedCount: number;
  placeLabel: string;
  loading: boolean;
  tooFar: boolean;
  empty: boolean;
  error: string | null;
  onRetry: () => void;
  onChangePlace: () => void;
  onDone: () => void;
}) {
  return (
    <div className="pointer-events-auto mx-auto mt-2 max-w-3xl rounded-2xl bg-white p-3 text-sm text-ink shadow-[0_12px_30px_-10px_rgba(0,0,0,0.4)]" data-testid="area-edit-bar">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Gebiete bearbeiten</p>
          <p className="text-xs text-muted" aria-live="polite">
            Ortsteile antippen, um sie hinzuzufügen oder zu entfernen ·{" "}
            {selectedCount === 0 ? "keins gewählt (ganzer Ort)" : selectedCount === 1 ? "1 gewählt" : `${selectedCount} gewählt`}
          </p>
        </div>
        <button type="button" onClick={onDone} className="shrink-0 rounded-xl bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink-2">
          Fertig
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 border-t border-black/5 pt-2 text-xs">
        <span className="min-w-0 truncate text-muted">
          Mittelpunkt: <span className="text-ink">{placeLabel.split(",").slice(0, 2).join(",")}</span>
        </span>
        <button type="button" onClick={onChangePlace} className="shrink-0 text-ink underline underline-offset-2">
          Ändern
        </button>
      </div>
      {(tooFar || loading || error || empty) && (
        <div className="mt-2 flex items-center gap-2 rounded-xl bg-paper px-3 py-2 text-xs" role={error ? "alert" : "status"}>
          {error ? (
            <>
              <span className="min-w-0 flex-1 break-words" data-testid="areas-error">
                {error}
              </span>
              <button type="button" onClick={onRetry} className="shrink-0 rounded-lg bg-ink px-2.5 py-1 font-medium text-white">
                Erneut versuchen
              </button>
            </>
          ) : tooFar ? (
            "Heranzoomen, um Ortsteile zu sehen"
          ) : empty ? (
            "Hier kennt OpenStreetMap keine Gemeinden mit Grenzen. Ohne gewählte Gebiete gilt der ganze Ort."
          ) : (
            <>
              <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-ink/20 border-t-ink" />
              Ortsteile werden aus OpenStreetMap geladen … Beim ersten Mal in einer Gegend kann das bis zu 10 Minuten dauern, wenn die Server ausgelastet sind.
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Dialog „Mittelpunkt ändern“: Adresse suchen, übernehmen. */
export function PlaceDialog({ adminKey, onDone, onClose }: { adminKey: string; onDone: (p: Place) => void; onClose: () => void }) {
  const setPlace = useMutation(api.campaigns.setPlace);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [state, setState] = useState<"idle" | "searching" | "saving" | "error">("idle");

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setState("searching");
    try {
      setResults(await searchPlaces(query.trim()));
      setState("idle");
    } catch {
      setState("error");
    }
  }

  async function choose(p: Place) {
    setState("saving");
    try {
      await setPlace({ adminKey, placeLabel: p.label, center: { lat: p.lat, lng: p.lng }, bbox: p.bbox ?? undefined });
      onDone(p);
    } catch {
      setState("error");
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center sm:items-center" role="presentation">
      <button type="button" aria-label="Schließen" onClick={onClose} className="absolute inset-0 bg-ink/50 backdrop-blur-[2px]" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="place-title"
        className="relative max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl select-text sm:rounded-3xl"
      >
        <h2 id="place-title" className="text-xl font-semibold tracking-tight">
          Mittelpunkt ändern
        </h2>
        <p className="mt-1 text-sm text-muted">Adresse, an der die Karte startet, z. B. euer Treffpunkt. Die Gebiete bleiben, wie sie sind.</p>
        <form onSubmit={onSearch} className="mt-4 flex gap-2">
          <label className="sr-only" htmlFor="place-query">
            Adresse
          </label>
          <input
            id="place-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="z. B. Königstraße 25, Bornheim"
            autoComplete="off"
            enterKeyHint="search"
            className="min-w-0 flex-1 rounded-2xl border border-black/10 bg-paper px-4 py-3 text-base outline-none focus:border-ink focus:bg-white"
          />
          <button type="submit" disabled={!query.trim() || state === "searching"} className="rounded-2xl bg-ink px-4 py-3 font-medium text-white disabled:opacity-40">
            {state === "searching" ? "Suche…" : "Suchen"}
          </button>
        </form>
        {state === "error" && <p className="mt-3 text-sm text-red-700">Das hat nicht geklappt. Bitte gleich noch einmal versuchen.</p>}
        {results && results.length === 0 && <p className="mt-3 text-sm text-muted">Nichts gefunden.</p>}
        {results && results.length > 0 && (
          <ul className="mt-3 grid gap-2">
            {results.map((r) => (
              <li key={`${r.lat},${r.lng},${r.label}`}>
                <button
                  type="button"
                  disabled={state === "saving"}
                  onClick={() => choose(r)}
                  className="w-full rounded-2xl border border-black/10 px-3.5 py-3 text-left text-sm hover:border-black/30 disabled:opacity-50"
                >
                  <span className="block font-medium">{r.short}</span>
                  <span className="line-clamp-2 text-muted">{r.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" onClick={onClose} className="mt-4 w-full rounded-2xl px-4 py-3 text-sm font-medium text-ink-3 hover:bg-black/5">
          Abbrechen
        </button>
      </div>
    </div>
  );
}
