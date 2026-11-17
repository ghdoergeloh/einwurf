/**
 * Fortschritt eines Gebiets für die Statistik. „Erreicht“ sind Häuser mit Flyer (gelb) und
 * solche, bei denen es nicht ging (dunkelgelb): Dort muss niemand mehr hin.
 * Prozente abgerundet, damit 100 % erst erscheint, wenn wirklich alles erreicht ist.
 */
export interface Progress {
  /** Häuser im Gebiet; null, solange nicht gezählt. */
  houses: number | null;
  done: number;
  blocked: number;
  open: number | null;
  /** Anteil erreicht; null ohne Häuserzahl. */
  percent: number | null;
  /** Anteil gelb (Flyer drin). */
  yellowPercent: number | null;
  /** Häuser noch nicht vollständig geladen: Zahl wird nachgeführt. */
  provisional: boolean;
}

interface Counts {
  houses: number | null;
  done: number;
  blocked: number;
  complete: boolean;
}

const pct = (n: number, of: number) => Math.min(100, Math.floor((n / of) * 100));

export function progressOf({ houses, done, blocked, complete }: Counts): Progress {
  const has = houses !== null && houses > 0;
  return {
    houses,
    done,
    blocked,
    open: houses === null ? null : Math.max(0, houses - done - blocked),
    percent: has ? pct(done + blocked, houses) : null,
    yellowPercent: has ? pct(done, houses) : null,
    provisional: !complete,
  };
}

/** Summe über mehrere Gebiete (Zielgebiete). */
export function sumProgress(rows: Counts[]): Progress {
  const counted = rows.filter((r) => r.houses !== null);
  return progressOf({
    houses: counted.length ? counted.reduce((s, r) => s + r.houses!, 0) : null,
    done: rows.reduce((s, r) => s + r.done, 0),
    blocked: rows.reduce((s, r) => s + r.blocked, 0),
    complete: rows.length > 0 && rows.every((r) => r.complete),
  });
}
