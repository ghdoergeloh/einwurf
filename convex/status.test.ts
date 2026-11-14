import { describe, expect, test } from "vitest";
import { countDelta, nextStatus, statusOf } from "./status";

describe("Zustand eines Hauses", () => {
  test("Antippen: offen → Flyer drin → nicht möglich → offen", () => {
    expect(nextStatus("none")).toBe("done");
    expect(nextStatus("done")).toBe("blocked");
    expect(nextStatus("blocked")).toBe("none");
  });
  test("alte Markierungen ohne Zustand gelten als Flyer drin", () => {
    expect(statusOf({})).toBe("done");
    expect(statusOf(null)).toBe("none");
    expect(statusOf({ status: "blocked" })).toBe("blocked");
  });
  test("Zähler", () => {
    expect(countDelta("none", "done")).toEqual({ done: 1, blocked: 0 });
    expect(countDelta("done", "blocked")).toEqual({ done: -1, blocked: 1 });
    expect(countDelta("blocked", "none")).toEqual({ done: 0, blocked: -1 });
    expect(countDelta("done", "done")).toEqual({ done: 0, blocked: 0 });
  });
});
