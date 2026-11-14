import { expect, test } from "vitest";
import { missingConvexUrlError } from "./build-env";

test("auf Vercel ohne Adresse: Fehler", () => expect(missingConvexUrlError({ VERCEL: "1" })).toMatch(/VITE_CONVEX_URL fehlt/));
test("auf Vercel mit leerer Adresse: Fehler", () =>
  expect(missingConvexUrlError({ VERCEL: "1", VITE_CONVEX_URL: " " })).toMatch(/fehlt/));
test("auf Vercel mit Adresse: in Ordnung", () =>
  expect(missingConvexUrlError({ VERCEL: "1", VITE_CONVEX_URL: "https://x.convex.cloud" })).toBeNull());
test("lokal ohne Vercel: keine Prüfung", () => expect(missingConvexUrlError({})).toBeNull());
