import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { BuildingMap, type LoadState, type MapControls } from "./BuildingMap";
import { ShareSheet } from "./ShareSheet";
import { LogoMark } from "./Logo";
import { campaignPath, navigate } from "../lib/router";

interface Props {
  slug: string;
  isNew: boolean;
}

export function CampaignPage({ slug, isNew }: Props) {
  const campaign = useQuery(api.campaigns.get, { slug });
  const marks = useQuery(api.marks.list, { slug });
  // Beim Wechsel auf die saubere Adresse ändert sich isNew; die Begrüßung soll bleiben.
  const [welcome] = useState(isNew);
  const [shareOpen, setShareOpen] = useState(isNew);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [toast, setToast] = useState<string | null>(null);
  const controls = useRef<MapControls | null>(null);

  const setMark = useMutation(api.marks.set).withOptimisticUpdate((store, args) => {
    const list = store.getQuery(api.marks.list, { slug: args.slug });
    if (list !== undefined) {
      const without = list.filter((m) => m.osmId !== args.osmId);
      const next = args.marked && args.geometry ? [...without, { osmId: args.osmId, geometry: args.geometry }] : without;
      store.setQuery(api.marks.list, { slug: args.slug }, next);
    }
    const c = store.getQuery(api.campaigns.get, { slug: args.slug });
    if (c && list !== undefined) {
      const was = list.some((m) => m.osmId === args.osmId);
      const delta = args.marked === was ? 0 : args.marked ? 1 : -1;
      store.setQuery(api.campaigns.get, { slug: args.slug }, { ...c, markCount: Math.max(0, c.markCount + delta) });
    }
  });

  useEffect(() => {
    if (!isNew) return;
    // „?neu“ aus der Adresse entfernen, damit der geteilte Link sauber ist.
    navigate(campaignPath(slug), true);
  }, [isNew, slug]);

  useEffect(() => {
    if (campaign) document.title = `${campaign.name} · Einwurf`;
  }, [campaign]);

  const onToggle = useCallback(
    (osmId: string, marked: boolean, geometry?: number[][][][]) => {
      setMark({ slug, osmId, marked, geometry }).catch(() => {
        setToast("Konnte nicht gespeichert werden. Bist du online?");
        setTimeout(() => setToast(null), 3500);
      });
    },
    [setMark, slug],
  );

  if (campaign === null) return <NotFound />;

  const url = `${location.origin}${campaignPath(slug)}`;
  const count = campaign?.markCount ?? 0;

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#e9e7e1]">
      {campaign && (
        <BuildingMap
          center={campaign.center}
          bbox={campaign.bbox}
          marks={marks}
          onToggle={onToggle}
          onLoadState={setLoadState}
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
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center p-3 pb-[max(1.75rem,env(safe-area-inset-bottom))]">
        <StatusPill state={loadState} toast={toast} onRetry={() => controls.current?.retry()} />
      </div>

      {shareOpen && campaign && (
        <ShareSheet url={url} title={campaign.name} isNew={welcome} onClose={() => setShareOpen(false)} />
      )}
    </div>
  );
}

function StatusPill({ state, toast, onRetry }: { state: LoadState; toast: string | null; onRetry: () => void }) {
  const base =
    "pointer-events-auto flex max-w-[calc(100%-4.5rem)] items-center gap-2.5 rounded-full px-4 py-2.5 text-sm font-medium shadow-[0_10px_30px_-10px_rgba(0,0,0,0.45)]";
  if (toast) return <div role="alert" className={`${base} bg-red-600 text-white`}>{toast}</div>;
  if (state === "error")
    return (
      <div role="alert" className={`${base} bg-white text-ink`}>
        Häuser konnten nicht geladen werden.
        <button type="button" onClick={onRetry} className="rounded-full bg-ink px-3 py-1 text-xs text-white">
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
        Näher heranzoomen, um Häuser zu sehen
      </div>
    );
  if (state === "loading")
    return (
      <div className={`${base} bg-white text-ink`}>
        <span className="size-3.5 animate-spin rounded-full border-2 border-ink/20 border-t-ink" />
        Häuser werden geladen …
      </div>
    );
  return (
    <div className={`${base} bg-ink/90 text-white backdrop-blur`}>
      <span className="size-3 shrink-0 rounded-[3px] bg-sun" />
      Haus antippen = Flyer drin · nochmal = rückgängig
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
