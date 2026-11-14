import { describe, expect, test } from "vitest";
import { DOUBLE_TAP_MS, DOUBLE_TAP_PX, DRAG_ZOOM_PX_PER_LEVEL, dragZoomDelta, isSecondTap, onPress } from "./taps";

const p = (x: number, y: number, t: number) => ({ x, y, t });

describe("isSecondTap", () => {
  test("ohne vorigen Tipp nie", () => expect(isSecondTap(null, p(0, 0, 0))).toBe(false));
  test("schnell und nah: Doppeltipp", () => expect(isSecondTap(p(0, 0, 0), p(10, 10, 150))).toBe(true));
  test("genau an den Grenzen noch Doppeltipp", () =>
    expect(isSecondTap(p(0, 0, 0), p(DOUBLE_TAP_PX, 0, DOUBLE_TAP_MS))).toBe(true));
  test("zu langsam: zwei einzelne Tipps (350 ms)", () => expect(isSecondTap(p(0, 0, 0), p(0, 0, 350))).toBe(false));
  test("zu weit weg: zwei einzelne Tipps (35 px)", () => expect(isSecondTap(p(0, 0, 0), p(35, 0, 100))).toBe(false));
});

describe("onPress", () => {
  const pending = { press: p(100, 100, 1000), payload: "way/1" };
  test("nichts vorgemerkt: warten", () => expect(onPress(null, p(0, 0, 0))).toEqual({ kind: "wait" }));
  test("zweiter Tipp am selben Haus: Doppeltipp, erster wird verworfen", () =>
    expect(onPress(pending, p(105, 98, 1200))).toEqual({ kind: "double" }));
  test("schnell ein anderes Haus: erster sofort ausführen", () =>
    expect(onPress(pending, p(200, 100, 1100))).toEqual({ kind: "flush", previous: "way/1" }));
});

describe("dragZoomDelta", () => {
  test("kleines Zittern zoomt nicht", () => expect(dragZoomDelta(3)).toBe(0));
  test("nach unten hinein, nach oben hinaus", () => {
    expect(dragZoomDelta(DRAG_ZOOM_PX_PER_LEVEL)).toBe(1);
    expect(dragZoomDelta(-DRAG_ZOOM_PX_PER_LEVEL / 2)).toBe(-0.5);
  });
});
