import { useEffect, useState } from "react";

/**
 * `view`: Ansehen-Link `/a/…`, sonst Bearbeiten-Link `/v/…` (siehe convex/access.ts).
 * `admin`: Admin-Link `/admin/…`, nur er ändert die Gebietsauswahl.
 */
export type Route =
  | { page: "home" }
  | { page: "campaign"; slug: string; isNew: boolean; view: boolean }
  | { page: "admin"; adminKey: string; isNew: boolean };

export function parseRoute(pathname: string, search = ""): Route {
  const isNew = new URLSearchParams(search).has("neu");
  const a = pathname.match(/^\/admin\/([A-Za-z0-9]+)\/?$/);
  if (a) return { page: "admin", adminKey: a[1], isNew };
  const m = pathname.match(/^\/([va])\/([A-Za-z0-9]+)\/?$/);
  if (!m) return { page: "home" };
  const view = m[1] === "a";
  return { page: "campaign", slug: m[2], isNew: !view && isNew, view };
}

export function campaignPath(slug: string) {
  return `/v/${slug}`;
}

/** Link zum Ansehen (nur lesen) mit dem Ansehen-Schlüssel. */
export function viewPath(viewKey: string) {
  return `/a/${viewKey}`;
}

export function adminPath(adminKey: string) {
  return `/admin/${adminKey}`;
}

export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.pathname, location.search));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.pathname, location.search));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return route;
}
