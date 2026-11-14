/**
 * Zustand eines Hauses. Antippen schaltet der Reihe nach weiter:
 * offen (schwarz) → Flyer drin (gelb) → nicht möglich (dunkelgelb) → offen.
 * Wird von Backend und Frontend genutzt.
 */
export type HouseStatus = "none" | "done" | "blocked";
/** Gespeicherte Zustände; „none“ heißt: keine Markierung vorhanden. */
export type MarkStatus = Exclude<HouseStatus, "none">;

export function nextStatus(current: HouseStatus): HouseStatus {
  return current === "none" ? "done" : current === "done" ? "blocked" : "none";
}

/** Ältere Markierungen ohne Zustand sind „Flyer drin“. */
export function statusOf(mark: { status?: MarkStatus } | null | undefined): HouseStatus {
  return mark ? (mark.status ?? "done") : "none";
}

/** Wie ändern sich die Zähler, wenn ein Haus von `from` nach `to` wechselt? */
export function countDelta(from: HouseStatus, to: HouseStatus): { done: number; blocked: number } {
  const n = (s: HouseStatus, k: MarkStatus) => (s === k ? 1 : 0);
  return { done: n(to, "done") - n(from, "done"), blocked: n(to, "blocked") - n(from, "blocked") };
}
