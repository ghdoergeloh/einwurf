import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { bboxOf } from "../../convex/areaGeo";
import { progressOf, sumProgress, type Progress } from "../lib/progress";
import type { MapArea } from "./BuildingMap";

interface Props {
  /** Bearbeiten- oder Admin-Schlüssel. */
  slug: string;
  /** Gebiete mit Grenze, für „Zeigen“ auf der Karte. */
  areas: MapArea[];
  onShow: (bbox: number[]) => void;
  onClose: () => void;
}

/**
 * Panel „Statistik“: Fortschritt je Gebiet in Prozent, live. Zielgebiete oben mit Summe,
 * nicht gewählte eingeklappt und ohne Prozent (ihre Häuser werden nicht geladen).
 */
export function StatsSheet({ slug, areas, onShow, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const stats = useQuery(api.stats.byArea, { slug });
  const refresh = useMutation(api.stats.refresh);

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

  // Noch vorläufig (z. B. Häuser inzwischen über die Karte geladen): beim Öffnen neu zählen lassen (gebremst).
  // Fehlt die Statistik noch (Gebiete vor ihr geladen): anlegen lassen.
  const provisional = !!stats?.areas?.rows.some((r) => r.target && !r.complete);
  const needsSetup = !!stats?.needsSetup;
  useEffect(() => {
    if (provisional || needsSetup) refresh({ slug }).catch(() => {});
    // Nur beim Öffnen und wenn es vorläufig wird, nicht bei jedem Tipp.
  }, [provisional, needsSetup, refresh, slug]);

  const targets = stats?.areas?.rows.filter((r) => r.target) ?? [];
  const others = stats?.areas?.rows.filter((r) => !r.target) ?? [];
  const sum = sumProgress(targets);
  // Markierungen außerhalb aller Gebiete zählen oben mit, hier nicht.
  const inAreas = (stats?.areas?.rows ?? []).reduce((n, r) => n + r.done + r.blocked, 0);
  const outside = stats?.areas ? stats.total.done + stats.total.blocked - inAreas : 0;
  const bboxById = new Map(areas.map((a) => [a.id, a.geometry]));

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center sm:items-center" role="presentation">
      <button type="button" aria-label="Schließen" onClick={onClose} className="absolute inset-0 bg-ink/50 backdrop-blur-[2px]" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stats-title"
        tabIndex={-1}
        className="relative flex max-h-[92dvh] w-full max-w-md touch-pan-y flex-col overscroll-contain rounded-t-3xl bg-white p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl outline-none select-text sm:rounded-3xl"
        data-testid="stats-sheet"
      >
        <div className="mx-auto mb-4 h-1.5 w-10 shrink-0 rounded-full bg-black/10 sm:hidden" />
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="stats-title" className="text-xl font-semibold tracking-tight">
              Statistik
            </h2>
            <p className="mt-1 text-sm text-muted">
              <b className="font-medium text-ink">Erreicht</b> heißt: Flyer drin oder nicht möglich. Dort muss niemand mehr hin.
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

        <div className="-mx-6 mt-4 min-h-0 flex-1 overflow-y-auto px-6">
          {stats === undefined && (
            <div className="flex items-center gap-3 rounded-2xl bg-paper p-4 text-sm">
              <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-ink/20 border-t-ink" />
              Lädt …
            </div>
          )}

          {stats?.needsSetup && (
            <div className="flex items-center gap-3 rounded-2xl bg-paper p-4 text-sm" role="status">
              <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-ink/20 border-t-ink" />
              Statistik wird vorbereitet …
            </div>
          )}

          {stats && !stats.areas && !stats.needsSetup && (
            <>
              <Totals done={stats.total.done} blocked={stats.total.blocked} />
              <p className="mt-3 text-sm text-muted">
                Für diese Aktion gibt es noch keine Gebiete. Sobald die Ortsteile geladen sind, steht hier der Fortschritt je Gebiet.
              </p>
            </>
          )}

          {stats?.areas && (
            <>
              <section className="rounded-2xl bg-paper p-4" data-testid="stats-sum" aria-label="Alle Zielgebiete">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-sm font-medium">
                    {stats.areas.noneSelected ? "Alle Gebiete" : targets.length === 1 ? targets[0].name : `Alle ${targets.length} Zielgebiete`}
                  </h3>
                  <Percent p={sum} large />
                </div>
                <Bar p={sum} />
                <Numbers p={sum} />
              </section>

              {stats.areas.noneSelected && (
                <p className="mt-3 text-xs text-muted">Keine Gebiete gewählt: Gezählt werden alle Gebiete.</p>
              )}
              {outside > 0 && !stats.areas.assigning && (
                <p className="mt-3 text-xs text-muted">
                  {outside} {outside === 1 ? "Markierung liegt" : "Markierungen liegen"} außerhalb der Gebiete. Die Zähler oben zählen sie mit, hier nicht.
                </p>
              )}
              {stats.areas.assigning && (
                <p className="mt-3 text-xs text-muted" role="status">
                  Ältere Markierungen werden den Gebieten zugeordnet …
                </p>
              )}

              {targets.length > 1 && (
                <ul className="mt-4 space-y-1" aria-label="Zielgebiete">
                  {targets.map((r) => {
                    const p = progressOf(r);
                    const g = bboxById.get(r.id);
                    return (
                      <li key={r.id} className="rounded-xl px-1 py-2" data-testid="stats-area">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="min-w-0 truncate text-[15px] font-medium">{r.name}</span>
                          <span className="flex shrink-0 items-baseline gap-2">
                            {g && (
                              <button
                                type="button"
                                onClick={() => onShow(bboxOf(g))}
                                className="rounded-lg px-1.5 text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
                                aria-label={`${r.name} auf der Karte zeigen`}
                              >
                                Zeigen
                              </button>
                            )}
                            <Percent p={p} />
                          </span>
                        </div>
                        <Bar p={p} />
                        <Numbers p={p} />
                      </li>
                    );
                  })}
                </ul>
              )}

              {others.length > 0 && (
                <details className="mt-4 rounded-xl text-sm">
                  <summary className="cursor-pointer py-1 text-muted">Nicht gewählt ({others.length})</summary>
                  <ul className="mt-1 space-y-1 pb-1 text-muted" aria-label="Nicht gewählte Gebiete">
                    {others.map((r) => (
                      <li key={r.id} className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate">{r.name}</span>
                        {r.done + r.blocked > 0 && (
                          <span className="shrink-0 text-xs tabular-nums">
                            {r.done} Flyer{r.blocked > 0 ? `, ${r.blocked} nicht möglich` : ""}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>

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

function Percent({ p, large = false }: { p: Progress; large?: boolean }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1.5">
      {p.provisional && (
        <span className="text-[11px] font-medium text-muted" title="Häuser werden noch geladen">
          vorläufig
        </span>
      )}
      <span className={`font-semibold tabular-nums ${large ? "text-2xl" : "text-base"}`} data-testid="stats-percent">
        {p.percent === null ? "–" : `${p.percent} %`}
      </span>
    </span>
  );
}

/** Balken: gelb (Flyer drin), dunkelgelb (nicht möglich), Rest offen. */
function Bar({ p }: { p: Progress }) {
  const w = (n: number) => (p.houses ? `${Math.min(100, (n / p.houses) * 100)}%` : "0%");
  return (
    <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-black/[0.08]" aria-hidden="true">
      <div className="bg-sun" style={{ width: w(p.done) }} />
      <div className="bg-blocked" style={{ width: w(Math.min(p.blocked, Math.max(0, (p.houses ?? 0) - p.done))) }} />
    </div>
  );
}

function Numbers({ p }: { p: Progress }) {
  return (
    <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted tabular-nums">
      <span>{p.houses === null ? "Häuser werden gezählt …" : `${p.houses} Häuser`}</span>
      <span className="flex items-center gap-1">
        <span className="size-2 rounded-[2px] bg-sun" aria-hidden="true" />
        {p.done} Flyer drin{p.yellowPercent !== null && ` (${p.yellowPercent} %)`}
      </span>
      <span className="flex items-center gap-1">
        <span className="size-2 rounded-[2px] bg-blocked" aria-hidden="true" />
        {p.blocked} nicht möglich
      </span>
      {p.open !== null && <span>{p.open} offen</span>}
      {p.provisional && p.houses !== null && <span className="w-full">Häuser werden noch geladen, die Zahl wird nachgeführt.</span>}
    </p>
  );
}

function Totals({ done, blocked }: { done: number; blocked: number }) {
  return (
    <section className="rounded-2xl bg-paper p-4 text-sm">
      <p className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-sun" aria-hidden="true" />
          {done} Flyer drin
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-blocked" aria-hidden="true" />
          {blocked} nicht möglich
        </span>
      </p>
    </section>
  );
}
