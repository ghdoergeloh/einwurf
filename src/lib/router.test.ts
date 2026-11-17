import { describe, expect, test } from "vitest";
import { campaignPath, parseRoute, viewPath } from "./router";

const KEY = "AbCdEfGhIjKlMnOpQrStUv";

describe("parseRoute", () => {
  test("Bearbeiten-Link", () => {
    expect(parseRoute(`/v/${KEY}`)).toEqual({ page: "campaign", slug: KEY, isNew: false, view: false });
    expect(parseRoute(`/v/${KEY}/`, "?neu")).toEqual({ page: "campaign", slug: KEY, isNew: true, view: false });
  });

  test("Ansehen-Link", () => {
    expect(parseRoute(`/a/${KEY}`)).toEqual({ page: "campaign", slug: KEY, isNew: false, view: true });
    // „?neu“ gibt es nur beim Anlegen, nie beim Ansehen-Link.
    expect(parseRoute(`/a/${KEY}`, "?neu")).toEqual({ page: "campaign", slug: KEY, isNew: false, view: true });
  });

  test("alles andere ist die Startseite", () => {
    expect(parseRoute("/")).toEqual({ page: "home" });
    expect(parseRoute(`/x/${KEY}`)).toEqual({ page: "home" });
  });

  test("Pfade", () => {
    expect(campaignPath(KEY)).toBe(`/v/${KEY}`);
    expect(viewPath(KEY)).toBe(`/a/${KEY}`);
  });
});
