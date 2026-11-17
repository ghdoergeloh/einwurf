/**
 * Langes Drücken auf die Karte (Finger oder Maus) öffnet die Notiz eines Hauses. Die Regel steht
 * hier, damit sie sich ohne Browser prüfen lässt. Schieben, ein zweiter Finger oder Loslassen vor
 * Ablauf der Zeit brechen ab; Tipp und Doppeltipp (lib/taps.ts) bleiben davon unberührt.
 */
export const LONG_PRESS_MS = 500;
/** Weiter darf sich der Finger während des Drückens nicht bewegen (px). */
export const LONG_PRESS_MOVE_PX = 10;

export class LongPress {
  private start: { id: number; x: number; y: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fired = false;

  constructor(private readonly onFire: (at: { x: number; y: number }) => void) {}

  /** Neuer Druck (pointerdown des ersten Fingers bzw. der linken Maustaste). */
  down(id: number, x: number, y: number) {
    this.cancel();
    this.fired = false;
    this.start = { id, x, y };
    this.timer = setTimeout(() => this.fireNow(), LONG_PRESS_MS);
  }

  move(id: number, x: number, y: number) {
    if (!this.start || this.start.id !== id) return;
    if (Math.hypot(x - this.start.x, y - this.start.y) > LONG_PRESS_MOVE_PX) this.cancel();
  }

  up(id: number) {
    if (this.start?.id === id) this.cancel();
  }

  /** Zweiter Finger, pointercancel, Doppeltipp-Zoom: kein langes Drücken. */
  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.start = null;
  }

  /**
   * Sofort auslösen, wenn ein Druck läuft (etwa wenn der Browser selbst ein langes Drücken
   * meldet, Android: contextmenu). Liefert, ob ausgelöst wurde.
   */
  fireNow(): boolean {
    const at = this.start;
    if (!at) return false;
    this.cancel();
    this.fired = true;
    this.onFire({ x: at.x, y: at.y });
    return true;
  }

  /** Wurde der letzte Druck als langes Drücken ausgelöst? Nur einmal true, dann zählt sein Klick nicht. */
  consumeFired(): boolean {
    const f = this.fired;
    this.fired = false;
    return f;
  }
}
