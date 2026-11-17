import { useEffect, useState } from "react";

export type Route =
  | { page: "home" }
  | { page: "campaign"; slug: string; isNew: boolean }
  /** Admin-Link: eigener geheimer Schlüssel, nur er ändert die Gebietsauswahl. */
  | { page: "admin"; adminKey: string; isNew: boolean };

export function parseRoute(pathname: string, search = ""): Route {
  const isNew = new URLSearchParams(search).has("neu");
  const m = pathname.match(/^\/v\/([A-Za-z0-9]+)\/?$/);
  if (m) return { page: "campaign", slug: m[1], isNew };
  const a = pathname.match(/^\/admin\/([A-Za-z0-9]+)\/?$/);
  if (a) return { page: "admin", adminKey: a[1], isNew };
  return { page: "home" };
}

export function campaignPath(slug: string) {
  return `/v/${slug}`;
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
