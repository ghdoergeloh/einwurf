import { describe, expect, test } from "vitest";
import { adminPath, campaignPath, parseRoute } from "./router";

describe("parseRoute", () => {
  test("Bearbeiten- und Admin-Link", () => {
    expect(parseRoute(campaignPath("abc"))).toEqual({ page: "campaign", slug: "abc", isNew: false });
    expect(parseRoute(adminPath("xyz"), "?neu")).toEqual({ page: "admin", adminKey: "xyz", isNew: true });
    expect(parseRoute("/admin/")).toEqual({ page: "home" });
    expect(parseRoute("/")).toEqual({ page: "home" });
  });
});
