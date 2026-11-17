import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "../../convex/_generated/api";
import { bboxOf } from "../../convex/areaGeo";
import type { MapArea } from "./BuildingMap";

interface Props {
  adminKey: string;
  status: { status: "none" | "loading" | "done" | "failed"; whole: boolean; unselected: string[]; updatedAt: number; staleAfterMs: number };
  areas: MapArea[];
  /** Gebiet auf der Karte zeigen. */
  onShow: (bbox: number[]) => void;
  onClose: () => void;
}

/**
 * Panel „Gebiete“ im Admin-Link: alle Ortsteile mit Kontrollkästchen, „Alle“ und „Keine“.
 * Die Auswahl gilt sofort für alle mit dem Link.
 */
export function AreaSheet({ adminKey, status, areas, onShow, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const select = useMutation(api.areas.select).withOptimisticUpdate((store, { ids, selected }) => {
    // Status-Query ist mit dem Bearbeiten-Schlüssel abonniert; alle Einträge anpassen.
    for (const { args, value } of store.getAllQueries(api.areas.status)) {
      if (!value || value.status !== "done") continue;
      const off = new Set(value.unselected);
      for (const id of ids) {
        if (selected) off.delete(id);
        else off.add(id);
      }
      store.setQuery(api.areas.status, args, { ...value, unselected: [...off].sort() });
    }
  });
  const load = useMutation(api.areas.load);
  // Ob das Laden hängt, hängt an der Zeit: regelmäßig neu prüfen (wie beim Vorladen).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);

  const change = (ids: string[], selected: boolean) => {
    setError(null);
    select({ adminKey, ids, selected }).catch((e: unknown) =>
      setError(e instanceof ConvexError && typeof e.data === "string" ? e.data : "Konnte nicht gespeichert werden."),
    );
  };

  // Hängt das Laden schon lange, darf man es neu anstoßen (wie beim Vorladen).
  const stale = status.status === "loading" && now - status.updatedAt > status.staleAfterMs + 60_000;
  const failed = status.status === "failed" || stale;
  const chosen = areas.filter((a) => a.selected).length;

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center sm:items-center" role="presentation">
      <button type="button" aria-label="Schließen" onClick={onClose} className="absolute inset-0 bg-ink/50 backdrop-blur-[2px]" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="areas-title"
        tabIndex={-1}
        className="relative flex max-h-[92dvh] w-full max-w-md touch-pan-y flex-col overscroll-contain rounded-t-3xl bg-white p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl outline-none select-text sm:rounded-3xl"
        data-testid="areas-sheet"
      >
        <div className="mx-auto mb-4 h-1.5 w-10 shrink-0 rounded-full bg-black/10 sm:hidden" />
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="areas-title" className="text-xl font-semibold tracking-tight">
              Gebiete
            </h2>
            <p className="mt-1 text-sm text-muted">
              Wo wird in dieser Aktion verteilt? Helfer sehen nur die Häuser der gewählten Ortsteile. Gilt sofort für alle.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="-mr-2 -mt-1 grid size-9 shrink-0 place-items-center rounded-full text-muted hover:bg-black/5"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {(status.status === "loading" || status.status === "none") && !stale && (
          <div className="mt-5 flex items-center gap-3 rounded-2xl bg-paper p-4 text-sm">
            <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-ink/20 border-t-ink" />
            <span>
              Ortsteile werden aus OpenStreetMap geladen …
              <span className="block text-xs text-muted">Das kann eine halbe Minute dauern, wenn OpenStreetMap ausgelastet ist.</span>
            </span>
          </div>
        )}
        {failed && (
          <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl bg-paper p-4 text-sm" role="alert">
            <span className="text-muted">Die Ortsteile konnten nicht geladen werden (OpenStreetMap überlastet).</span>
            <button
              type="button"
              onClick={() => load({ adminKey }).catch(() => setError("Konnte nicht gestartet werden."))}
              className="shrink-0 rounded-xl bg-ink px-3 py-2 text-xs font-medium text-white transition hover:bg-ink-2"
            >
              Erneut versuchen
            </button>
          </div>
        )}

        {status.status === "done" && (
          <>
            {status.whole && (
              <p className="mt-4 rounded-2xl bg-sun/25 p-3 text-sm">
                Für diesen Ort sind in OpenStreetMap keine Ortsteile eingetragen. Der ganze Ort ist ein Gebiet.
              </p>
            )}
            <div className="mt-4 flex items-center justify-between gap-3 text-sm">
              <span className="text-muted" aria-live="polite">
                {chosen === 0 ? "Keins gewählt: der ganze Ort" : `${chosen} von ${areas.length} gewählt`}
              </span>
              <span className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => change(areas.map((a) => a.id), true)}
                  className="rounded-xl px-3 py-1.5 text-xs font-medium ring-1 ring-black/10 hover:bg-black/5"
                >
                  Alle
                </button>
                <button
                  type="button"
                  onClick={() => change(areas.map((a) => a.id), false)}
                  className="rounded-xl px-3 py-1.5 text-xs font-medium ring-1 ring-black/10 hover:bg-black/5"
                >
                  Keine
                </button>
              </span>
            </div>
            <ul className="-mx-2 mt-2 min-h-0 flex-1 overflow-y-auto">
              {areas.map((a) => (
                <li key={a.id} className="flex items-center gap-1">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-black/[0.03]">
                    <input
                      type="checkbox"
                      checked={a.selected}
                      onChange={(e) => change([a.id], e.target.checked)}
                      className="size-5 shrink-0 accent-ink"
                    />
                    <span className="truncate text-[15px]">{a.name}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => onShow(bboxOf(a.geometry))}
                    className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
                    aria-label={`${a.name} auf der Karte zeigen`}
                  >
                    Zeigen
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full shrink-0 rounded-2xl bg-ink px-4 py-3 text-sm font-medium text-white transition hover:bg-ink-2"
        >
          Fertig
        </button>
      </div>
    </div>
  );
}
