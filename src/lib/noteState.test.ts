import { describe, expect, test } from "vitest";
import { expectedUpdatedAt } from "./noteState";

describe("expectedUpdatedAt", () => {
  test("keine Notiz: erwartet „keine“", () => expect(expectedUpdatedAt(null)).toBeNull());
  test("Notiz vom Server: ihr Stand", () => expect(expectedUpdatedAt({ updatedAt: 123 })).toBe(123));
  test("eigene, noch nicht bestätigte Notiz (optimistisch, Uhr des Handys): keine Prüfung", () =>
    expect(expectedUpdatedAt({ updatedAt: 123, pending: true })).toBeUndefined());
});
