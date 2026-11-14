import { useEffect, useState } from "react";

export type Route = { page: "home" } | { page: "campaign"; slug: string; isNew: boolean };

export function parseRoute(pathname: string, search = ""): Route {
  const m = pathname.match(/^\/v\/([A-Za-z0-9]+)\/?$/);
  if (m) return { page: "campaign", slug: m[1], isNew: new URLSearchParams(search).has("neu") };
  return { page: "home" };
}

export function campaignPath(slug: string) {
  return `/v/${slug}`;
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
