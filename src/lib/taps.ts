/**
 * Eine einzige Regel für Tipp und Doppeltipp, damit Markieren und Zoomen sich nie
 * widersprechen. Die Karte zoomt bei Doppeltipp selbst (MapLibres eigener
 * Doppeltipp-Zoom ist aus), Doppeltipp-und-ziehen bleibt bei MapLibre.
 */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 30;

export interface Press {
  x: number;
  y: number;
  t: number;
}

/** Gehört ein neuer Druck zum vorigen Tipp (also ein Doppeltipp)? */
export function isSecondTap(prev: Press | null, next: Press): boolean {
  if (!prev) return false;
  return next.t - prev.t <= DOUBLE_TAP_MS && Math.hypot(next.x - prev.x, next.y - prev.y) <= DOUBLE_TAP_PX;
}

export type TapAction<T> =
  | { kind: "wait" } // Tipp vormerken, nach DOUBLE_TAP_MS ausführen
  | { kind: "flush"; previous: T } // voriger Tipp war einzeln: sofort ausführen
  | { kind: "double" }; // Doppeltipp: vorigen Tipp verwerfen, Karte zoomt

/**
 * Entscheidet beim Herunterdrücken (touchstart/mousedown), was mit einem noch
 * vorgemerkten Tipp passiert.
 */
export function onPress<T>(pending: { press: Press; payload: T } | null, next: Press): TapAction<T> {
  if (!pending) return { kind: "wait" };
  if (isSecondTap(pending.press, next)) return { kind: "double" };
  return { kind: "flush", previous: pending.payload };
}

/** Ab dieser Bewegung (px) wird aus einem Doppeltipp ein Ein-Finger-Zoom. */
export const DRAG_ZOOM_THRESHOLD_PX = 6;
/** Pixel senkrecht ziehen für eine Zoomstufe. */
export const DRAG_ZOOM_PX_PER_LEVEL = 150;

/** Doppeltipp und ziehen wie bei Google Maps: nach unten = hinein, nach oben = hinaus. */
export function dragZoomDelta(dy: number): number {
  if (Math.abs(dy) < DRAG_ZOOM_THRESHOLD_PX) return 0;
  return dy / DRAG_ZOOM_PX_PER_LEVEL;
}
