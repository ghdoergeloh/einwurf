import { describe, expect, test } from "vitest";
import { progressOf, sumProgress } from "./progress";

describe("Fortschritt je Gebiet", () => {
  test("erreicht = (gelb + dunkelgelb) / alle Häuser, abgerundet", () => {
    expect(progressOf({ houses: 200, done: 50, blocked: 9, complete: true })).toEqual({
      houses: 200, done: 50, blocked: 9, open: 141, percent: 29, yellowPercent: 25, provisional: false,
    });
  });
  test("rechnet in ganzen Zahlen: keine Rundungsfehler (29 von 100 sind 29 %)", () => {
    expect(progressOf({ houses: 100, done: 29, blocked: 0, complete: true }).percent).toBe(29);
    for (let of = 1; of <= 1000; of++)
      for (let n = 0; n <= of; n++) {
        const want = Math.floor((n * 100) / of);
        if (progressOf({ houses: of, done: n, blocked: 0, complete: true }).percent !== want) throw new Error(`${n}/${of}`);
      }
  });
  test("100 % erst, wenn wirklich alles erreicht ist", () => {
    expect(progressOf({ houses: 1000, done: 999, blocked: 0, complete: true }).percent).toBe(99);
    expect(progressOf({ houses: 1000, done: 990, blocked: 10, complete: true }).percent).toBe(100);
  });
  test("mehr Markierungen als gezählte Häuser (vorläufig): höchstens 100 %, nichts offen", () => {
    expect(progressOf({ houses: 10, done: 12, blocked: 1, complete: false })).toMatchObject({ percent: 100, open: 0, provisional: true });
  });
  test("noch nicht gezählt oder Gebiet ohne Häuser: kein Prozent", () => {
    expect(progressOf({ houses: null, done: 3, blocked: 0, complete: false })).toMatchObject({ percent: null, open: null, provisional: true });
    expect(progressOf({ houses: 0, done: 0, blocked: 0, complete: true })).toMatchObject({ percent: null, open: 0 });
  });
  test("Summe über Zielgebiete; vorläufig, wenn eins vorläufig ist", () => {
    const s = sumProgress([
      { houses: 100, done: 10, blocked: 10, complete: true },
      { houses: 300, done: 100, blocked: 0, complete: false },
    ]);
    expect(s).toMatchObject({ houses: 400, done: 110, blocked: 10, percent: 30, provisional: true });
    expect(sumProgress([{ houses: null, done: 1, blocked: 0, complete: false }]).houses).toBeNull();
    // Gebiet noch ohne Häuserzahl: seine Markierungen zählen nicht gegen die Häuser der anderen
    const partial = sumProgress([
      { houses: 100, done: 10, blocked: 0, complete: true },
      { houses: null, done: 90, blocked: 0, complete: false },
    ]);
    expect(partial).toMatchObject({ houses: 100, done: 10, percent: 10, provisional: true });
    expect(sumProgress([]).percent).toBeNull();
  });
});
