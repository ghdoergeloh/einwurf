import { describe, expect, test } from "vitest";
import { BURST_SECONDS, createBurst, particleAt } from "./sparks";

describe("Pixel-Funken", () => {
  test("Flyer drin sprüht am meisten, „wieder offen“ am wenigsten auffällig", () => {
    const done = createBurst("done", 1);
    const blocked = createBurst("blocked", 1);
    const none = createBurst("none", 1);
    expect(done.parts.length).toBeGreaterThan(blocked.parts.length);
    expect(done.ring).not.toBeNull();
    expect(none.ring).toBeNull();
  });

  test("gleicher Zufallswert, gleicher Effekt", () => {
    expect(createBurst("done", 7)).toEqual(createBurst("done", 7));
  });

  test("Funken des ersten Tipps steigen zuerst und fallen dann", () => {
    const b = createBurst("done", 3);
    const ys = b.parts.map((p) => [particleAt(p, 0.05)?.y ?? 0, particleAt(p, 0.45)?.y ?? 0]);
    const rising = ys.filter(([early]) => early < 0).length;
    expect(rising).toBeGreaterThan(b.parts.length / 2);
  });

  test("nach dem Effekt ist alles verschwunden", () => {
    for (const kind of ["done", "blocked", "none"] as const) {
      const b = createBurst(kind, 5);
      expect(b.parts.every((p) => particleAt(p, BURST_SECONDS) === null)).toBe(true);
    }
  });

  test("Pixel bleiben ganzzahlig groß (kein Verschwimmen)", () => {
    const b = createBurst("done", 9);
    for (const p of b.parts) {
      const at = particleAt(p, 0.1);
      if (at) expect(Number.isInteger(at.size)).toBe(true);
    }
  });
});
