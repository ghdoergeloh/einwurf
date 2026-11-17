import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useConvexConnectionState, useMutation, useQueries, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "../../convex/_generated/api";
import { markCellOf } from "../../convex/cells";
import { countDelta, statusOf, type HouseStatus } from "../../convex/status";
import { decodeBuildings } from "../../convex/osm";
import { BuildingMap, type LoadState, type MapControls, type Mark, type Note, type NoteTarget } from "./BuildingMap";
import { NoteSheet } from "./NoteSheet";
import { ShareSheet } from "./ShareSheet";
import { LogoMark } from "./Logo";
import { campaignPath, navigate } from "../lib/router";

interface Props {
  slug: string;
  isNew: boolean;
}

export function CampaignPage({ slug, isNew }: Props) {
  const campaign = useQuery(api.campaigns.get, { slug });
  // Nur die sichtbaren Zellen abonnieren: Ein Tipp schickt allen nur seine Zelle neu.
  const [cells, setCells] = useState<string[] | null>([]);
  const cellResults = useQueries(
    useMemo(
      () =>
        Object.fromEntries((cells ?? []).map((cell) => [cell, { query: api.marks.inCell, args: { slug, cell } }])),
      [cells, slug],
    ),
  );
  // Notizen ebenso je Zelle, getrennt abonniert: Eine neue Notiz schickt die Markierungen nicht neu.
  const noteResults = useQueries(
    useMemo(
      () =>
        Object.fromEntries((cells ?? []).map((cell) => [cell, { query: api.notes.inCell, args: { slug, cell } }])),
      [cells, slug],
    ),
  );
  const loadedMarkCells = useMemo(
    () => new Set(Object.entries(cellResults).filter(([, r]) => Array.isArray(r)).map(([cell]) => cell)),
    [cellResults],
  );
  const marks = useMemo<Mark[]>(
    () => Object.values(cellResults).flatMap((r) => (Array.isArray(r) ? (r as Mark[]) : [])),
    [cellResults],
  );
  const notes = useMemo<Note[]>(
    () => Object.values(noteResults).flatMap((r) => (Array.isArray(r) ? (r as Note[]) : [])),
    [noteResults],
  );
  const connection = useConvexConnectionState();
  const offline = connection.hasEverConnected && !connection.isWebSocketConnected;

  // Beim Wechsel auf die saubere Adresse ändert sich isNew; die Begrüßung soll bleiben.
  const [welcome] = useState(isNew);
  const [shareOpen, setShareOpen] = useState(isNew);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controls = useRef<MapControls | null>(null);
  const [noteTarget, setNoteTarget] = useState<NoteTarget | null>(null);

  const setMark = useMutation(api.marks.set).withOptimisticUpdate((store, args) => {
    const cell = markCellOf(args.center[0], args.center[1]);
    const list = store.getQuery(api.marks.inCell, { slug: args.slug, cell });
    if (list === undefined) return;
    const target: HouseStatus = args.status ?? (args.marked ? "done" : "none");
    const from = statusOf(list.find((m) => m.osmId === args.osmId));
    const without = list.filter((m) => m.osmId !== args.osmId);
    store.setQuery(
      api.marks.inCell,
      { slug: args.slug, cell },
      target === "none" ? without : [...without, { osmId: args.osmId, center: args.center, status: target }],
    );
    const c = store.getQuery(api.campaigns.get, { slug: args.slug });
    const d = countDelta(from, target);
    if (c)
      store.setQuery(api.campaigns.get, { slug: args.slug }, {
        ...c,
        markCount: Math.max(0, c.markCount + d.done),
        blockedCount: Math.max(0, c.blockedCount + d.blocked),
      });
  });

  const setNoteMutation = useMutation(api.notes.set).withOptimisticUpdate((store, args) => {
    const cell = markCellOf(args.center[0], args.center[1]);
    const list = store.getQuery(api.notes.inCell, { slug: args.slug, cell });
    if (list === undefined) return;
    const note = { osmId: args.osmId, center: args.center, text: args.text.trim(), updatedAt: Date.now() };
    store.setQuery(api.notes.inCell, { slug: args.slug, cell }, [...list.filter((n) => n.osmId !== args.osmId), note]);
  });
  const removeNoteMutation = useMutation(api.notes.remove).withOptimisticUpdate((store, args) => {
    for (const { args: q, value } of store.getAllQueries(api.notes.inCell)) {
      if (q.slug !== args.slug || !value?.some((n) => n.osmId === args.osmId)) continue;
      store.setQuery(api.notes.inCell, q, value.filter((n) => n.osmId !== args.osmId));
    }
  });

  useEffect(() => {
    if (!isNew) return;
    // „?neu“ aus der Adresse entfernen, damit der geteilte Link sauber ist.
    navigate(campaignPath(slug), true);
  }, [isNew, slug]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("map-mode");
    // iOS Safari: Pinch auf Kopfleiste oder Hinweis soll nicht die ganze Seite zoomen.
    const block = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", block);
    return () => {
      root.classList.remove("map-mode");
      document.removeEventListener("gesturestart", block);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    if (campaign) document.title = `${campaign.name} · Einwurf`;
  }, [campaign]);

  const loadAction = useAction(api.buildings.load);
  const loadBuildings = useCallback(
    async (cells: string[]) => (await loadAction({ slug, cells })).flatMap(decodeBuildings),
    [loadAction, slug],
  );

  const showToast = useCallback((text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const onToggle = useCallback(
    (osmId: string, status: HouseStatus, center: number[]) => {
      setMark({ slug, osmId, status, center }).catch((err: unknown) => {
        showToast(
          err instanceof ConvexError && typeof err.data === "string"
            ? err.data
            : "Konnte nicht gespeichert werden. Bitte noch einmal tippen.",
        );
      });
    },
    [setMark, slug, showToast],
  );

  const saveFailed = useCallback(
    (err: unknown) =>
      showToast(
        err instanceof ConvexError && typeof err.data === "string" ? err.data : "Notiz konnte nicht gespeichert werden.",
      ),
    [showToast],
  );
  const closeNote = useCallback(() => setNoteTarget(null), []);
  const openNote = noteTarget && notes.find((n) => n.osmId === noteTarget.osmId);

  const onConflict = useCallback(
    () => showToast("Ein Haus wurde inzwischen von jemand anderem geändert. Dieser Stand gilt."),
    [showToast],
  );

  if (campaign === null) return <NotFound />;

  const url = `${location.origin}${campaignPath(slug)}`;
  const count = campaign?.markCount ?? 0;
  const blocked = campaign?.blockedCount ?? 0;

  return (
    <div className="fixed inset-0 touch-none overflow-hidden overscroll-none bg-[#e9e7e1] select-none">
      {campaign && (
        <BuildingMap
          center={campaign.center}
          bbox={campaign.bbox}
          marks={marks}
          notes={notes}
          onNoteRequest={setNoteTarget}
          onCellsChange={setCells}
          onToggle={onToggle}
          onConflict={onConflict}
          onNotice={showToast}
          onLoadState={setLoadState}
          loadBuildings={loadBuildings}
          loadedMarkCells={loadedMarkCells}
          controlsRef={controls}
        />
      )}

      {/* Kopfleiste */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:p-4">
        <div className="pointer-events-auto mx-auto flex max-w-3xl items-center gap-3 rounded-2xl bg-ink/95 p-2 pr-2 text-white shadow-[0_12px_30px_-10px_rgba(0,0,0,0.5)] backdrop-blur">
          <a href="/" aria-label="Startseite" className="shrink-0">
            <LogoMark className="size-10" />
          </a>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-semibold leading-tight">{campaign?.name ?? " "}</h1>
            <p className="truncate text-xs text-white/55">{campaign?.placeLabel ?? "Lädt …"}</p>
          </div>
          <div
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-sun px-2.5 py-1.5 text-ink"
            title="Häuser mit Flyer"
            aria-live="polite"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
              <path d="M3 11 12 3l9 8v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
            </svg>
            <span className="text-sm font-semibold tabular-nums" data-testid="count">
              {count}
            </span>
            <span className="sr-only">Häuser mit Flyer</span>
          </div>
          {blocked > 0 && (
            <div
              className="-ml-1.5 flex shrink-0 items-center gap-1 rounded-xl bg-blocked px-2 py-1.5 text-ink"
              title="Einwerfen nicht möglich"
              aria-live="polite"
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                <circle cx="12" cy="12" r="8" />
                <path d="m6.5 6.5 11 11" />
              </svg>
              <span className="text-sm font-semibold tabular-nums" data-testid="blocked-count">
                {blocked}
              </span>
              <span className="sr-only">Häuser, bei denen Einwerfen nicht möglich war</span>
            </div>
          )}
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 transition hover:bg-white/20"
            aria-label="Link teilen"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="18" cy="5" r="2.5" />
              <circle cx="6" cy="12" r="2.5" />
              <circle cx="18" cy="19" r="2.5" />
              <path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4" />
            </svg>
          </button>
        </div>
      </div>

      {/* Hinweis unten */}
      {/* Rechts unten bleibt Platz für Zoom- und Standort-Knöpfe. */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-16 z-10 flex justify-start p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:justify-center">
        <StatusPill state={loadState} toast={toast} offline={offline} onRetry={() => controls.current?.retry()} />
      </div>

      {noteTarget && (
        <NoteSheet
          key={noteTarget.osmId}
          houseNumber={noteTarget.houseNumber}
          note={openNote ? { text: openNote.text, updatedAt: openNote.updatedAt } : null}
          onSave={(text, expectedUpdatedAt) => {
            setNoteMutation({ slug, osmId: noteTarget.osmId, center: noteTarget.center, text, expectedUpdatedAt }).catch(
              saveFailed,
            );
            closeNote();
          }}
          onDelete={(expectedUpdatedAt) => {
            removeNoteMutation({ slug, osmId: noteTarget.osmId, expectedUpdatedAt }).catch(saveFailed);
            closeNote();
          }}
          onClose={closeNote}
        />
      )}

      {shareOpen && campaign && (
        <ShareSheet slug={slug} url={url} title={campaign.name} isNew={welcome} onClose={() => setShareOpen(false)} />
      )}
    </div>
  );
}

const SLOW_LOADING_MS = 6_000;

function StatusPill({
  state,
  toast,
  offline,
  onRetry,
}: {
  state: LoadState;
  toast: string | null;
  offline: boolean;
  onRetry: () => void;
}) {
  // Overpass braucht manchmal eine halbe Minute; dann sagen, dass es weitergeht.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (state !== "loading") return;
    const t = setTimeout(() => setSlow(true), SLOW_LOADING_MS);
    return () => clearTimeout(t);
  }, [state]);
  const base =
    "flex max-w-full items-center gap-2.5 rounded-2xl px-4 py-2.5 text-[13px] font-medium leading-snug shadow-[0_10px_30px_-10px_rgba(0,0,0,0.45)] sm:text-sm";
  if (toast)
    return (
      <div role="alert" className={`${base} bg-red-600 text-white`}>
        {toast}
      </div>
    );
  if (offline)
    return (
      <div role="status" className={`${base} bg-orange-100 text-orange-950`}>
        <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-orange-500" />
        Offline. Deine Häuser werden gespeichert, sobald wieder Netz da ist.
      </div>
    );
  if (state === "mapError")
    return (
      <div role="alert" className={`${base} pointer-events-auto bg-white text-ink`}>
        Die Karte konnte nicht geladen werden.
        <button type="button" onClick={() => location.reload()} className="shrink-0 rounded-full bg-ink px-3 py-1 text-xs text-white">
          Neu laden
        </button>
      </div>
    );
  if (state === "error")
    return (
      <div role="alert" className={`${base} pointer-events-auto bg-white text-ink`}>
        Häuser konnten nicht geladen werden.
        <button type="button" onClick={onRetry} className="shrink-0 rounded-full bg-ink px-3 py-1 text-xs text-white">
          Erneut
        </button>
      </div>
    );
  if (state === "zoom")
    return (
      <div className={`${base} bg-white text-ink`}>
        <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5M11 8v6M8 11h6" strokeLinecap="round" />
        </svg>
        Heranzoomen, um Häuser zu sehen
      </div>
    );
  if (state === "loading")
    return (
      <div className={`${base} bg-white text-ink`}>
        <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-ink/20 border-t-ink" />
        <span>
          Häuser werden geladen …
          {slow && (
            <span className="block text-muted">OpenStreetMap ist gerade langsam, das kann eine Weile dauern.</span>
          )}
        </span>
      </div>
    );
  return (
    <div className={`${base} bg-ink/90 text-white backdrop-blur`}>
      <span className="flex shrink-0 flex-col gap-1" aria-hidden="true">
        <span className="size-3 rounded-[3px] bg-sun" />
        <span className="size-3 rounded-[3px] bg-blocked" />
        <span className="size-3 rounded-[3px] bg-note" />
      </span>
      <span>
        Haus antippen, wenn der Flyer drin ist.
        <span className="block text-white/60">
          Kurz danach nochmal: nicht möglich (z. B. „Keine Werbung“). Nochmal: wieder offen.
        </span>
        <span className="block text-white/60">Lange drücken oder Rechtsklick: Notiz (Haus wird blau).</span>
      </span>
    </div>
  );
}

function NotFound() {
  return (
    <div className="grid min-h-full place-items-center bg-paper p-6 text-center">
      <div className="max-w-sm">
        <LogoMark className="mx-auto size-14" />
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Diese Verteilaktion gibt es nicht</h1>
        <p className="mt-2 text-muted">
          Prüfe, ob der Link vollständig kopiert wurde. Er ist lang und geheim, damit ihn niemand errät.
        </p>
        <a
          href="/"
          className="mt-6 inline-flex rounded-2xl bg-ink px-5 py-3 font-medium text-white transition hover:bg-ink-2"
        >
          Neue Aktion starten
        </a>
      </div>
    </div>
  );
}
