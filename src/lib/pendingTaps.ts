import { nextStatus, type HouseStatus } from "../../convex/status";

/**
 * Tipps auf Häuser, deren Markierungen noch laden. Das Haus färbt sich sofort um; abgeschickt
 * wird erst, wenn der echte Zustand bekannt ist. Hat inzwischen jemand anderes das Haus
 * geändert, gewinnt dessen Stand, damit kein „nicht möglich“ verloren geht.
 */
export interface PendingTap {
  /** Zustand, den der Helfer beim ersten Tipp gesehen hat. */
  from: HouseStatus;
  /** Zustand nach allen Tipps. */
  to: HouseStatus;
  center: number[];
}

export function addTap(pending: Map<string, PendingTap>, osmId: string, shown: HouseStatus, center: number[]) {
  const next = new Map(pending);
  const p = pending.get(osmId);
  if (!p) {
    next.set(osmId, { from: shown, to: nextStatus(shown), center });
    return next;
  }
  const to = nextStatus(p.to);
  if (to === p.from) next.delete(osmId);
  else next.set(osmId, { ...p, to });
  return next;
}

export function settleTaps(
  pending: Map<string, PendingTap>,
  isLoaded: (center: number[]) => boolean,
  serverStatus: (osmId: string) => HouseStatus,
) {
  const send: { osmId: string; status: HouseStatus; center: number[] }[] = [];
  const conflicts: string[] = [];
  const rest = new Map<string, PendingTap>();
  for (const [osmId, p] of pending) {
    if (!isLoaded(p.center)) {
      rest.set(osmId, p);
      continue;
    }
    const now = serverStatus(osmId);
    if (now === p.to) continue;
    if (now === p.from) send.push({ osmId, status: p.to, center: p.center });
    else conflicts.push(osmId);
  }
  return { send, conflicts, rest };
}
