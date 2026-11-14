# Einwurf – gemeinsame Flyer-Verteilkarte

Eine Karte für Verteilaktionen: Alle Häuser sind dunkelgrau. Wer einen Flyer eingeworfen hat, tippt das Haus an, und es wird gelb. Ein zweiter Tipp macht es dunkelgelb: Einwerfen nicht möglich, etwa wegen eines Aufklebers „Keine Werbung“ oder weil der Briefkasten nicht erreichbar ist. Ein dritter Tipp macht es wieder grau. Alle mit dem Link sehen die Änderungen sofort.

- **Ohne Anmeldung.** Jede Aktion hat einen geheimen Link (`/v/<22 Zeichen>`, etwa 131 Bit Zufall). Aktionen werden nirgends aufgelistet.
- **Frontend:** React, Tailwind v4, MapLibre, Vite.
- **Backend:** [Convex](https://convex.dev), live per Subscription.
- **Kartendaten:** © OpenStreetMap-Mitwirkende. Grundkarte von [OpenFreeMap](https://openfreemap.org), Gebäude über die [Overpass API](https://overpass-api.de), Ortssuche über [Nominatim](https://nominatim.org). Alle ohne API-Schlüssel.
- **Gebäude über Convex:** Der Browser fragt Overpass nicht selbst. Die Convex-Action `buildings.load` holt die Häuser je Kachel (etwa 550 × 350 m), speichert sie 30 Tage für alle Helfer und weicht bei Überlastung auf andere öffentliche Overpass-Server aus. Nur der erste Helfer in einem Gebiet wartet auf Overpass.

## Bedienung der Karte

| Geste | Wirkung |
| --- | --- |
| Tippen auf ein Haus | weiterschalten: grau (offen) → gelb (Flyer drin) → dunkelgelb (nicht möglich) → grau (nach 0,3 s, siehe unten) |
| Doppeltipp | hineinzoomen (markiert nichts) |
| Doppeltipp und ziehen | mit einem Finger zoomen |
| Ziehen, Pinch, Mausrad, +/− | schieben und zoomen |
| Standort-Knopf | eigene Position verfolgen |

Ein Tipp wartet kurz, ob ein zweiter folgt. Für „nicht möglich“ also zweimal mit kurzer Pause tippen; zwei schnelle Tipps zoomen. Nur so lassen sich Doppeltipp-Zoom und Markieren unterscheiden. Ein Doppeltipp sind zwei Tipps innerhalb von 300 ms und 30 px. Zieht der Finger nach dem zweiten Tipp, zoomt die Karte stufenlos: 150 px nach unten sind eine Stufe hinein. Die Regel steht in `src/lib/taps.ts`. Tippt man schnell ein *anderes* Haus an, wird das erste sofort übernommen.

Häuser werden erst ab Zoomstufe 15 geladen, kachelweise und mit etwas Vorrat über den Rand hinaus. Nach einem Fehler wartet die Karte zunehmend länger (5 s bis 60 s), bevor sie es erneut versucht.

Convex speichert je markiertem Haus nur die OSM-ID und den Mittelpunkt, einsortiert in Zellen von 0,01° (`convex/cells.ts`). Jedes Handy abonniert nur die sichtbaren Zellen. Ein Tipp schickt deshalb nur die Zelle mit dem Haus an die Helfer, die sie gerade sehen, nicht die ganze Aktion. Eingefärbt (gelb oder dunkelgelb) wird der Umriss, den das Handy ohnehin von Overpass hat. Rausgezoomt, oder solange der Umriss fehlt, zeigt die Karte Punkte in derselben Farbe. Ab einem Ausschnitt von mehr als 100 Zellen (etwa ab Zoomstufe 12) zeigt sie keine Markierungen mehr. Ohne Netz zeigt die Karte „Offline“, Convex holt das Speichern nach.

## Entwickeln

```bash
pnpm install
npx convex dev          # beim ersten Mal: anmelden oder lokal ohne Konto; schreibt .env.local
pnpm dev                # http://localhost:5173
```

Lehnt `npx convex dev` das Schema wegen alter Testdaten ab, die Tabelle leeren: `npx convex import --table marks --replace -y leer.jsonl` (leere Datei).

Prüfungen:

```bash
pnpm typecheck
pnpm test               # Convex-Funktionen (convex-test) und Bibliotheken
pnpm build
pnpm e2e                # Browser-Test; braucht laufendes `pnpm dev` + `npx convex dev`
                        # OSM-Dienste werden darin nachgebildet, Convex ist echt.
                        # Einmalig für den Test: npx convex env set OVERPASS_URLS http://127.0.0.1:8787/api/interpreter
                        # (danach wieder entfernen: npx convex env remove OVERPASS_URLS)
```

## Deployen

Es braucht zwei Teile: das Convex-Backend und die statischen Dateien des Frontends.

### 1. Convex-Projekt anlegen (einmalig)

```bash
npx convex login
npx convex dev --once --configure new   # Projekt anlegen, z. B. "einwurf"
```

Im [Convex-Dashboard](https://dashboard.convex.dev) unter *Settings → Deploy Keys* einen **Production Deploy Key** erzeugen.

### 2a. Frontend auf Vercel (empfohlen, am einfachsten)

1. Repository auf GitHub pushen und in Vercel importieren.
2. In Vercel unter *Settings → Environment Variables* `CONVEX_DEPLOY_KEY` = der Production Deploy Key anlegen, Environment **Production**. Das ist eine Variable in Vercel, kein GitHub-Secret.
3. Deployen. Build-Befehl, Ausgabeordner und die Umleitung für geteilte Links (`/v/…`) stehen in `vercel.json`, in der Vercel-Oberfläche muss dafür nichts eingestellt werden. `convex deploy` deployt dabei das Backend und setzt `VITE_CONVEX_URL` für den Build.

Fehlt `VITE_CONVEX_URL` beim Build auf Vercel (Key fehlt oder Build lief nicht über `convex deploy`), bricht der Build mit einer Meldung ab, statt eine Seite ohne Backend zu veröffentlichen.

**Preview-Deployments** (Pushes auf andere Branches als `main`) brauchen ebenfalls einen Key, sonst schlagen sie rot fehl. Dafür gibt es zwei Wege:
- einen **Preview Deploy Key** im Convex-Dashboard erzeugen und unter demselben Namen mit Environment **Preview** anlegen (Convex legt dann je Branch ein eigenes Test-Backend an), oder
- Previews in Vercel abschalten: *Settings → Git → Ignored Build Step* auf „Only build production“ stellen.

### 2b. Netlify

Wie Vercel: Build Command `npx convex deploy --cmd 'pnpm build'`, Publish Directory `dist`, Variable `CONVEX_DEPLOY_KEY`. Die Umleitung steht in `public/_redirects`.

### 2c. Selbst hosten (eigener Server)

```bash
CONVEX_DEPLOY_KEY=<key> npx convex deploy --cmd 'pnpm build'
# dist/ auf den Server kopieren
```

nginx braucht die Umleitung für die geteilten Links:

```nginx
location / {
  try_files $uri /index.html;
}
```

Auch Convex lässt sich selbst betreiben (Docker-Image `ghcr.io/get-convex/convex-backend`, siehe [Self-Hosting](https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md)). Dann `CONVEX_SELF_HOSTED_URL` und `CONVEX_SELF_HOSTED_ADMIN_KEY` statt des Deploy Keys setzen.

**Wichtig:** Die Seite muss über **HTTPS** laufen, sonst funktionieren Standort, Teilen und Kopieren auf dem Handy nicht.

## Grenzen

- Overpass, Nominatim und OpenFreeMap sind kostenlose öffentliche Dienste mit fairen Nutzungsregeln. Dank Cache fragt die App Overpass je Gebiet nur einmal. Sind alle Overpass-Server überlastet, zeigt die Karte „Erneut“.
- Optional: Convex-Umgebungsvariable `OVERPASS_URLS` (kommagetrennt) legt eigene Overpass-Server fest.
- Overpass-Abrufe über Convex sind begrenzt: 12 pro Minute je Aktion, 40 pro Minute insgesamt. Cache-Treffer zählen nicht. Ohne Anmeldung kann jemand mit mehreren Aktionen das gemeinsame Limit kurzzeitig ausschöpfen; neue Gebiete laden dann erst nach einer Minute. Der Cache wird täglich von Kacheln älter als 30 Tage befreit.
- Wer einen Link kennt, kann alles in dieser Aktion ändern (so gewollt). Neue Aktionen kann jeder anlegen. Eine Aktion hat höchstens 20.000 Markierungen. Neue Aktionen sind auf 20 pro Minute begrenzt, über alle Nutzer.
