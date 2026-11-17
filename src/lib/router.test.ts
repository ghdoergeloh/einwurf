import { describe, expect, test } from "vitest";
import { adminPath, campaignPath, parseRoute, viewPath } from "./router";

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

  test("Admin-Link", () => {
    expect(parseRoute(adminPath(KEY), "?neu")).toEqual({ page: "admin", adminKey: KEY, isNew: true });
    expect(parseRoute(`/admin/${KEY}/`)).toEqual({ page: "admin", adminKey: KEY, isNew: false });
    expect(parseRoute("/admin/")).toEqual({ page: "home" });
  });

  test("alles andere ist die Startseite", () => {
    expect(parseRoute("/")).toEqual({ page: "home" });
    expect(parseRoute(`/x/${KEY}`)).toEqual({ page: "home" });
  });

  test("Pfade", () => {
    expect(campaignPath(KEY)).toBe(`/v/${KEY}`);
    expect(viewPath(KEY)).toBe(`/a/${KEY}`);
    expect(adminPath(KEY)).toBe(`/admin/${KEY}`);
  });
});
