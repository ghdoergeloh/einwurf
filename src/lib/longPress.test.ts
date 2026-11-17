import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LONG_PRESS_MOVE_PX, LONG_PRESS_MS, LongPress } from "./longPress";

describe("LongPress", () => {
  let fired: { x: number; y: number }[];
  let lp: LongPress;
  beforeEach(() => {
    vi.useFakeTimers();
    fired = [];
    lp = new LongPress((p) => fired.push(p));
  });
  afterEach(() => vi.useRealTimers());

  test("stillhalten: löst nach LONG_PRESS_MS genau einmal aus", () => {
    lp.down(1, 100, 100);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual([{ x: 100, y: 100 }]);
    expect(lp.consumeFired()).toBe(true);
    expect(lp.consumeFired()).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(fired).toHaveLength(1);
  });

  test("kurzer Tipp löst nicht aus", () => {
    lp.down(1, 100, 100);
    vi.advanceTimersByTime(200);
    lp.up(1);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fired).toEqual([]);
    expect(lp.consumeFired()).toBe(false);
  });

  test("kleines Zittern ist erlaubt, Schieben bricht ab", () => {
    lp.down(1, 100, 100);
    lp.move(1, 100 + LONG_PRESS_MOVE_PX - 1, 100);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fired).toHaveLength(1);

    lp.down(1, 100, 100);
    lp.move(1, 100, 100 + LONG_PRESS_MOVE_PX + 1);
    lp.move(1, 100, 100); // zurück an den Start zählt nicht mehr
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fired).toHaveLength(1);
  });

  test("zweiter Finger (Pinch) und Abbruch durch den Browser brechen ab", () => {
    lp.down(1, 100, 100);
    lp.cancel();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    lp.down(1, 100, 100);
    lp.up(1);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fired).toEqual([]);
  });

  test("zweiter Finger bricht einen laufenden Druck ab und startet keinen eigenen", () => {
    lp.down(1, 100, 100);
    vi.advanceTimersByTime(200);
    lp.down(2, 200, 200, { primary: false });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fired).toEqual([]);
  });

  test("Doppeltipp-und-halten ist Zoom, kein langes Drücken", () => {
    lp.down(1, 100, 100, { double: true });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fired).toEqual([]);
  });

  test("Bewegung eines anderen Zeigers stört nicht", () => {
    lp.down(1, 100, 100);
    lp.move(2, 300, 300);
    lp.up(2);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fired).toHaveLength(1);
  });

  test("Browser meldet das lange Drücken selbst (contextmenu): sofort, aber nur einmal", () => {
    lp.down(1, 100, 100);
    vi.advanceTimersByTime(300);
    expect(lp.fireNow()).toBe(true);
    expect(fired).toEqual([{ x: 100, y: 100 }]);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(fired).toHaveLength(1);
    expect(lp.fireNow()).toBe(false);
  });

  test("ein neuer Druck setzt den alten Auslöse-Merker zurück", () => {
    lp.down(1, 100, 100);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    lp.down(2, 50, 50);
    expect(lp.consumeFired()).toBe(false);
  });
});
