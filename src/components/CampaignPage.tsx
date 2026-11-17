import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useConvexConnectionState, useMutation, useQueries, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "../../convex/_generated/api";
import { markCellOf } from "../../convex/cells";
import { countDelta, statusOf, type HouseStatus } from "../../convex/status";
import { decodeBuildings } from "../../convex/osm";
import { toAreas } from "../../convex/areaGeo";
import { BuildingMap, type LoadState, type MapArea, type MapControls, type Mark, type Note, type NoteTarget } from "./BuildingMap";
import { NoteSheet } from "./NoteSheet";
import { ShareSheet } from "./ShareSheet";
import { AreaEditBar, PlaceDialog, useAreaEditor } from "./AreaEditor";
import { StatsSheet } from "./StatsSheet";
import type { BBox } from "../../convex/osm";
import { LogoMark } from "./Logo";
import { adminPath, campaignPath, navigate, viewPath } from "../lib/router";
import { loadViewMode, saveViewMode, type ViewMode } from "../lib/viewMode";

interface Props {
  /**
   * Schlüssel aus dem Link: Bearbeiten-Schlüssel (`/v/…`) oder Ansehen-Schlüssel (`/a/…`).
   * Im Admin-Link der Bearbeiten-Schlüssel, den die Admin-Seite über campaigns.get erfährt.
   */
  slug: string;
  isNew: boolean;
  /** Geöffnet über den Ansehen-Link `/a/…`. */
  viewLink: boolean;
  /** Nur im Admin-Link: Schlüssel für die Gebietsauswahl. */
  adminKey?: string;
}

type Toast = { text: string; tone: "error" | "info" };

/**
 * Admin-Link (/admin/…): erfährt den Bearbeiten-Schlüssel und zeigt dieselbe Karte, dazu die
 * Gebietsauswahl. Der Admin-Schlüssel selbst steht nur in der Adresse.
 */
export function AdminPage({ adminKey, isNew }: { adminKey: string; isNew: boolean }) {
  const campaign = useQuery(api.campaigns.get, { slug: adminKey });
  if (campaign === null || (campaign && campaign.role !== "admin")) return <NotFound />;
  if (!campaign || !("slug" in campaign)) return <div className="fixed inset-0 bg-[#e9e7e1]" />;
  return <CampaignPage slug={campaign.slug} isNew={isNew} viewLink={false} adminKey={adminKey} />;
}

export function CampaignPage({ slug, isNew, viewLink, adminKey }: Props) {
  const campaign = useQuery(api.campaigns.get, { slug });
  // Nur ansehen: Ansehen-Link, oder ein Ansehen-Schlüssel in einem /v/-Link (das Backend
  // entscheidet über die Rechte, die Oberfläche folgt ihm nur).
  const viewOnly = viewLink || campaign?.role === "view";
  // Umschalter für Helfer mit dem Bearbeiten-Link, je Gerät und Aktion gemerkt.
  const [mode, setModeState] = useState<ViewMode>(() => (viewLink ? "edit" : loadViewMode(slug)));
  const setMode = useCallback(
    (m: ViewMode) => {
      setModeState(m);
      saveViewMode(slug, m);
    },
    [slug],
  );
  const readOnly = viewOnly || mode === "view";
  // Gebiete: in jeder Rolle sichtbar (auch beim Ansehen); ändern nur im Admin-Link.
  const areaList = useQuery(api.areas.list, { slug });
  const areas = useMemo<MapArea[]>(
    () => (areaList ? toAreas(areaList).map((a, i) => ({ ...a, labelAt: areaList[i].labelAt })) : []),
    [areaList],
  );
  // Admin-Link: Modus „Gebiete bearbeiten“ (nach dem Anlegen gleich an).
  const [editAreas, setEditAreas] = useState(isNew && !!adminKey);
  const [mapView, setMapView] = useState<{ bbox: BBox; zoom: number } | null>(null);
  const onViewChange = useCallback((bbox: BBox, zoom: number) => setMapView({ bbox, zoom }), []);
  const editor = useAreaEditor({ adminKey, slug, active: editAreas, view: mapView, campaignAreas: areaList });
  const [placeOpen, setPlaceOpen] = useState(false);
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
  const [statsOpen, setStatsOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controls = useRef<MapControls | null>(null);
  const startEditAreas = useCallback(() => {
    setShareOpen(false);
    setEditAreas(true);
    controls.current?.overview();
  }, []);
  // Neue Aktion: Karte gleich herauszoomen, damit die Ortsteile ringsum zu sehen sind.
  useEffect(() => {
    if (!editAreas) return;
    const t = setTimeout(() => controls.current?.overview(), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
    const note = { osmId: args.osmId, center: args.center, text: args.text.trim(), updatedAt: Date.now(), pending: true };
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
    navigate(adminKey ? adminPath(adminKey) : campaignPath(slug), true);
  }, [isNew, slug, adminKey]);

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

  const showToast = useCallback((text: string, tone: Toast["tone"] = "error") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, tone });
    toastTimer.current = setTimeout(() => setToast(null), tone === "info" ? 2500 : 4000);
  }, []);

  // Ein Tipp im Ansehen-Modus markiert nichts; ein kurzer Hinweis sagt, wie es geht.
  // Beim Ansehen-Link genügt der feste Hinweis „Nur ansehen“.
  const onReadOnlyTap = useCallback(
    (kind: "tap" | "note") => {
      if (viewOnly) return;
      showToast(
        kind === "note"
          ? "Ansehen-Modus – für Notizen auf Bearbeiten wechseln"
          : "Ansehen-Modus – zum Markieren auf Bearbeiten wechseln",
        "info",
      );
    },
    [viewOnly, showToast],
  );

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

  // Admin-Schlüssel unter /v/…: auf den Admin-Link umleiten, damit nie der Admin-Schlüssel
  // als Link zum Mitmachen im Teilen-Dialog landet.
  useEffect(() => {
    if (!adminKey && campaign?.role === "admin") navigate(adminPath(slug), true);
  }, [adminKey, campaign?.role, slug]);
  if (campaign === null) return <NotFound />;
  if (!adminKey && campaign?.role === "admin") return null;

  // Weitergegeben wird immer der Bearbeiten-Link, auch mit dem Admin-Link (#2). Mit dem
  // Ansehen-Schlüssel kennt die Seite den Bearbeiten-Schlüssel gar nicht; der eigene
  // Schlüssel ist dann der Ansehen-Schlüssel.
  const editUrl = !viewOnly && campaign && "slug" in campaign ? `${location.origin}${campaignPath(campaign.slug)}` : null;
  const viewKey = campaign?.role === "view" ? slug : (campaign?.viewKey ?? null);
  const viewUrl = viewKey ? `${location.origin}${viewPath(viewKey)}` : null;
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
          readOnly={readOnly}
          onReadOnlyTap={onReadOnlyTap}
          onLoadState={setLoadState}
          loadBuildings={loadBuildings}
          loadedMarkCells={loadedMarkCells}
          controlsRef={controls}
          areas={editAreas ? editor.areas : areas}
          editAreas={editAreas}
          onAreaTap={editor.toggle}
          onViewChange={onViewChange}
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
            <p className="truncate text-xs text-white/55">
              {viewOnly && <span className="font-semibold text-white/80">Nur ansehen · </span>}
              {campaign?.placeLabel ?? "Lädt …"}
            </p>
          </div>
          {/* Zähler: öffnet die Statistik je Gebiet. */}
          <button
            type="button"
            onClick={() => setStatsOpen(true)}
            className="flex shrink-0 items-center rounded-xl transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            aria-label={`Statistik: ${count} Häuser mit Flyer${blocked > 0 ? `, ${blocked} nicht möglich` : ""}`}
            title="Statistik"
            data-testid="open-stats"
          >
            <span
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-sun px-2.5 py-1.5 text-ink"
              aria-live="polite"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
                <path d="M3 11 12 3l9 8v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
              </svg>
              <span className="text-sm font-semibold tabular-nums" data-testid="count">
                {count}
              </span>
            </span>
            {blocked > 0 && (
              <span
                className="ml-1.5 flex shrink-0 items-center gap-1 rounded-xl bg-blocked px-2 py-1.5 text-ink"
                aria-live="polite"
              >
                <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                  <circle cx="12" cy="12" r="8" />
                  <path d="m6.5 6.5 11 11" />
                </svg>
                <span className="text-sm font-semibold tabular-nums" data-testid="blocked-count">
                  {blocked}
                </span>
              </span>
            )}
          </button>
          {adminKey && (
            <button
              type="button"
              onClick={() => (editAreas ? setEditAreas(false) : startEditAreas())}
              aria-pressed={editAreas}
              className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 transition hover:bg-white/20"
              aria-label="Gebiete bearbeiten"
              title="Gebiete bearbeiten"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4Z" strokeLinejoin="round" />
                <path d="M9 4v13M15 6.5v13" />
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            hidden={viewOnly && !viewUrl}
            className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 transition hover:bg-white/20"
            aria-label={viewOnly ? "Ansicht teilen" : "Link teilen"}
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="18" cy="5" r="2.5" />
              <circle cx="6" cy="12" r="2.5" />
              <circle cx="18" cy="19" r="2.5" />
              <path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4" />
            </svg>
          </button>
        </div>
        {campaign && editAreas && adminKey && (
          <AreaEditBar
            selectedCount={editor.selectedCount}
            placeLabel={campaign.placeLabel}
            loading={editor.loading}
            tooFar={editor.tooFar}
            empty={editor.empty}
            error={editor.error}
            onRetry={editor.retry}
            onChangePlace={() => setPlaceOpen(true)}
            onDone={() => setEditAreas(false)}
          />
        )}
        {campaign && !viewOnly && !editAreas && (
          <div className="mx-auto mt-2 flex max-w-3xl justify-end">
            <ModeSwitch mode={mode} onChange={setMode} />
          </div>
        )}
      </div>

      {/* Hinweis unten */}
      {/* Rechts unten bleibt Platz für Zoom- und Standort-Knöpfe. */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-16 z-10 flex justify-start p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:justify-center">
        <StatusPill
          state={loadState}
          toast={toast}
          offline={offline}
          onRetry={() => controls.current?.retry()}
          readOnly={viewOnly ? "link" : mode === "view" ? "mode" : null}
          onEdit={() => setMode("edit")}
        />
      </div>

      {noteTarget && (
        <NoteSheet
          key={noteTarget.osmId}
          readOnly={viewOnly ? "link" : mode === "view" ? "mode" : false}
          houseNumber={noteTarget.houseNumber}
          note={openNote ? { text: openNote.text, updatedAt: openNote.updatedAt, pending: openNote.pending } : null}
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
        <ShareSheet
          slug={viewOnly ? null : slug}
          editUrl={editUrl}
          viewUrl={viewUrl}
          title={campaign.name}
          isNew={welcome}
          showPrefetch={!readOnly}
          onClose={() => setShareOpen(false)}
          adminUrl={adminKey ? `${location.origin}${adminPath(adminKey)}` : undefined}
          onChooseAreas={adminKey ? startEditAreas : undefined}
        />
      )}
      {statsOpen && (
        <StatsSheet
          slug={slug}
          canRefresh={!viewOnly}
          areas={areas}
          onShow={(bbox) => {
            setStatsOpen(false);
            controls.current?.showBBox(bbox);
          }}
          onClose={() => setStatsOpen(false)}
        />
      )}
      {placeOpen && adminKey && (
        <PlaceDialog
          adminKey={adminKey}
          onClose={() => setPlaceOpen(false)}
          onDone={(p) => {
            setPlaceOpen(false);
            controls.current?.flyTo({ lat: p.lat, lng: p.lng });
          }}
        />
      )}
    </div>
  );
}

const SLOW_LOADING_MS = 6_000;

/** Umschalter „Bearbeiten / Ansehen“ für Helfer mit dem Bearbeiten-Link. */
function ModeSwitch({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  const item = (m: ViewMode, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      aria-pressed={mode === m}
      onClick={() => onChange(m)}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
        mode === m ? "bg-white text-ink shadow-sm" : "text-white/70 hover:text-white"
      }`}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Modus"
      data-testid="mode-switch"
      className="pointer-events-auto flex gap-0.5 rounded-xl bg-ink/90 p-1 shadow-[0_10px_24px_-10px_rgba(0,0,0,0.5)] backdrop-blur"
    >
      {item(
        "edit",
        "Bearbeiten",
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M4 20h4L19 9l-4-4L4 16v4Z" strokeLinejoin="round" />
        </svg>,
      )}
      {item(
        "view",
        "Ansehen",
        <EyeIcon className="size-4" />,
      )}
    </div>
  );
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function StatusPill({
  state,
  toast,
  offline,
  onRetry,
  readOnly,
  onEdit,
}: {
  state: LoadState;
  toast: Toast | null;
  offline: boolean;
  onRetry: () => void;
  /** „link“: Ansehen-Link, „mode“: Ansehen-Modus mit dem Bearbeiten-Link. */
  readOnly: "link" | "mode" | null;
  onEdit: () => void;
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
    return toast.tone === "info" ? (
      <div role="status" className={`${base} bg-white text-ink`}>
        <EyeIcon className="size-4 shrink-0" />
        {toast.text}
      </div>
    ) : (
      <div role="alert" className={`${base} bg-red-600 text-white`}>
        {toast.text}
      </div>
    );
  if (offline)
    return (
      <div role="status" className={`${base} bg-orange-100 text-orange-950`}>
        <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-orange-500" />
        {readOnly
          ? "Offline. Der Stand wird aktualisiert, sobald wieder Netz da ist."
          : "Offline. Deine Häuser werden gespeichert, sobald wieder Netz da ist."}
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
  if (readOnly === "link")
    return (
      <div role="status" data-testid="view-only" className={`${base} bg-ink/90 text-white backdrop-blur`}>
        <EyeIcon className="size-5 shrink-0" />
        <span>
          Nur ansehen
          <span className="block text-white/60">Gelb: Flyer drin. Dunkelgelb: nicht möglich. Blau: Notiz, antippen zum Lesen. Der Stand ist live.</span>
        </span>
      </div>
    );
  if (readOnly === "mode")
    return (
      <div role="status" data-testid="view-only" className={`${base} pointer-events-auto bg-ink/90 text-white backdrop-blur`}>
        <EyeIcon className="size-5 shrink-0" />
        <span>
          Ansehen-Modus
          <span className="block text-white/60">Antippen markiert nichts, blaue Häuser zeigen ihre Notiz.</span>
        </span>
        <button type="button" onClick={onEdit} className="shrink-0 rounded-full bg-sun px-3 py-1 text-xs font-semibold text-ink">
          Bearbeiten
        </button>
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

export function NotFound() {
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
