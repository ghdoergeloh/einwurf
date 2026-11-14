import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { searchPlaces, type Place } from "../lib/geocode";
import { generateSlug } from "../lib/slug";
import { campaignPath, navigate } from "../lib/router";
import { Logo } from "./Logo";

type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; results: Place[] }
  | { status: "error" };

export function HomePage() {
  const create = useMutation(api.campaigns.create);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const [place, setPlace] = useState<Place | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearch({ status: "loading" });
    setPlace(null);
    try {
      const results = await searchPlaces(q);
      setSearch({ status: "done", results });
      if (results.length === 1) setPlace(results[0]);
    } catch {
      setSearch({ status: "error" });
    }
  }

  async function onCreate() {
    if (!place) return;
    setCreating(true);
    setError(null);
    try {
      const slug = await create({
        slug: generateSlug(),
        name: name.trim() || `Verteilaktion ${place.short}`,
        placeLabel: place.label,
        center: { lat: place.lat, lng: place.lng },
        bbox: place.bbox ?? undefined,
      });
      navigate(`${campaignPath(slug)}?neu`);
    } catch {
      setError("Die Aktion konnte nicht angelegt werden. Bitte versuch es noch einmal.");
      setCreating(false);
    }
  }

  return (
    <div className="min-h-full bg-paper">
      <div className="mx-auto flex max-w-5xl flex-col px-5 pb-16 pt-6 sm:px-8">
        <header className="flex items-center justify-between">
          <Logo />
        </header>

        <main className="mt-7 grid grid-cols-[minmax(0,1fr)] items-start gap-8 lg:mt-16 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-14 lg:gap-y-8">
          <section className="lg:col-start-1 lg:row-start-1">
            <p className="inline-flex items-center gap-2 rounded-full bg-ink px-3 py-1 text-xs font-medium text-sun">
              <span className="size-1.5 rounded-full bg-sun" /> Live für alle Helfer
            </p>
            <h1 className="mt-4 text-[2.4rem] font-semibold sm:mt-5 sm:text-5xl leading-[1.05] tracking-tight text-balance">
              Jeder Briefkasten zählt.
              <br />
              <span className="relative inline-block">
                <span className="relative z-10">Keiner doppelt.</span>
                <span className="absolute inset-x-0 bottom-1 z-0 h-3 rounded bg-sun sm:h-4" />
              </span>
            </h1>
            <p className="mt-4 max-w-md text-base text-muted text-pretty sm:mt-5 sm:text-lg">
              Startet eine Verteilaktion, teilt den Link mit eurem Team und tippt auf jedes Haus, das
              einen Flyer bekommen hat. Die Karte zeigt allen sofort, wo ihr schon wart.
            </p>
          </section>

          <section className="rounded-3xl bg-white lg:col-start-2 lg:row-span-2 lg:row-start-1 p-5 shadow-[0_1px_0_rgba(0,0,0,0.04),0_20px_50px_-20px_rgba(21,23,28,0.25)] ring-1 ring-black/5 sm:p-7">
            <h2 className="text-xl font-semibold tracking-tight">Neue Verteilaktion</h2>
            <p className="mt-1 text-sm text-muted">Wo wollt ihr verteilen?</p>

            <form onSubmit={onSearch} className="mt-5 flex gap-2">
              <label className="sr-only" htmlFor="place">
                Ort
              </label>
              <input
                id="place"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="z. B. Bornheim Roisdorf"
                autoComplete="off"
                enterKeyHint="search"
                className="min-w-0 flex-1 rounded-2xl border border-black/10 bg-paper px-4 py-3 text-base outline-none transition focus:border-ink focus:bg-white focus:ring-4 focus:ring-sun/40"
              />
              <button
                type="submit"
                disabled={!query.trim() || search.status === "loading"}
                className="rounded-2xl bg-ink px-4 py-3 font-medium text-white transition hover:bg-ink-2 disabled:opacity-40"
              >
                {search.status === "loading" ? "Suche…" : "Suchen"}
              </button>
            </form>

            {search.status === "error" && (
              <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
                Die Ortssuche ist gerade nicht erreichbar. Bitte gleich noch einmal versuchen.
              </p>
            )}
            {search.status === "done" && search.results.length === 0 && (
              <p className="mt-3 text-sm text-muted">Nichts gefunden. Versuch es mit Ort und Straße.</p>
            )}
            {search.status === "done" && search.results.length > 0 && (
              <fieldset className="mt-4">
                <legend className="sr-only">Suchergebnisse</legend>
                <ul className="grid gap-2">
                  {search.results.map((r) => {
                    const selected = place === r;
                    return (
                      <li key={`${r.lat},${r.lng},${r.label}`}>
                        <label
                          className={`flex cursor-pointer items-start gap-3 rounded-2xl border px-3.5 py-3 text-sm transition ${
                            selected ? "border-ink bg-sun/25" : "border-black/10 hover:border-black/30"
                          }`}
                        >
                          <input
                            type="radio"
                            name="place"
                            checked={selected}
                            onChange={() => setPlace(r)}
                            className="mt-0.5 accent-ink"
                          />
                          <span>
                            <span className="block font-medium">{r.short}</span>
                            <span className="line-clamp-2 text-muted">{r.label}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            )}

            {place && (
              <div className="mt-5">
                <label htmlFor="name" className="text-sm font-medium">
                  Name der Aktion <span className="font-normal text-muted">(optional)</span>
                </label>
                <input
                  id="name"
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={`Verteilaktion ${place.short}`}
                  className="mt-1.5 w-full rounded-2xl border border-black/10 bg-paper px-4 py-3 text-base outline-none transition focus:border-ink focus:bg-white focus:ring-4 focus:ring-sun/40"
                />
              </div>
            )}

            <button
              type="button"
              onClick={onCreate}
              disabled={!place || creating}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-sun px-5 py-4 text-base font-semibold text-ink shadow-[0_8px_20px_-8px_rgba(232,181,0,0.8)] transition hover:bg-sun-deep disabled:bg-black/5 disabled:text-black/30 disabled:shadow-none"
            >
              {creating ? "Wird angelegt…" : "Verteilaktion starten"}
              {!creating && <span aria-hidden="true">→</span>}
            </button>
            {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
            <p className="mt-4 text-xs text-muted">
              Jede Aktion bekommt einen geheimen Link. Aktionen werden nirgends aufgelistet. Kein Konto
              nötig.
            </p>
          </section>
          <ol className="grid max-w-md gap-3 text-sm lg:col-start-1 lg:row-start-2">
            {[
              ["Ort wählen", "Stadt, Ortsteil oder Straße suchen."],
              ["Link teilen", "Per WhatsApp, Signal oder QR-Code. Nur wer ihn hat, sieht die Aktion."],
              ["Häuser antippen", "Gelb heißt: Flyer ist drin. Nochmal tippen: dunkelgelb, Einwerfen nicht möglich (z. B. „Keine Werbung“). Nochmal: zurück."],
            ].map(([t, d], i) => (
              <li key={t} className="flex gap-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-ink text-xs font-semibold text-sun">
                  {i + 1}
                </span>
                <span>
                  <span className="font-medium">{t}.</span> <span className="text-muted">{d}</span>
                </span>
              </li>
            ))}
          </ol>
        </main>
      </div>
    </div>
  );
}
