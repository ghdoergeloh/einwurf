import { afterEach, describe, expect, test, vi } from "vitest";
import { loadViewMode, saveViewMode } from "./viewMode";

function fakeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Ansehen-Modus je Gerät und Aktion", () => {
  test("Standard ist Bearbeiten", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    expect(loadViewMode("A".repeat(22))).toBe("edit");
  });

  test("wird je Aktion gemerkt", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    saveViewMode("A".repeat(22), "view");
    expect(loadViewMode("A".repeat(22))).toBe("view");
    expect(loadViewMode("B".repeat(22))).toBe("edit");
    saveViewMode("A".repeat(22), "edit");
    expect(loadViewMode("A".repeat(22))).toBe("edit");
  });

  test("ohne Speicher (privater Modus) geht es trotzdem", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("gesperrt");
      },
      setItem: () => {
        throw new Error("gesperrt");
      },
      removeItem: () => {
        throw new Error("gesperrt");
      },
    });
    expect(() => saveViewMode("A".repeat(22), "view")).not.toThrow();
    expect(loadViewMode("A".repeat(22))).toBe("edit");
  });
});
