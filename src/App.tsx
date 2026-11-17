import { lazy, Suspense } from "react";
import { HomePage } from "./components/HomePage";
import { useRoute } from "./lib/router";

// Die Karte (MapLibre) ist groß; die Startseite soll ohne sie schnell laden.
const CampaignPage = lazy(() => import("./components/CampaignPage").then((m) => ({ default: m.CampaignPage })));
const AdminPage = lazy(() => import("./components/CampaignPage").then((m) => ({ default: m.AdminPage })));

export function App() {
  const route = useRoute();
  if (route.page === "campaign")
    return (
      <Suspense fallback={<div className="fixed inset-0 bg-[#e9e7e1]" />}>
        <CampaignPage key={route.slug} slug={route.slug} isNew={route.isNew} />
      </Suspense>
    );
  if (route.page === "admin")
    return (
      <Suspense fallback={<div className="fixed inset-0 bg-[#e9e7e1]" />}>
        <AdminPage key={route.adminKey} adminKey={route.adminKey} isNew={route.isNew} />
      </Suspense>
    );
  return <HomePage />;
}
