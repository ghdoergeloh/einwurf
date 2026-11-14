# Einwurf – gemeinsame Flyer-Verteilkarte

Eine Karte für Verteilaktionen: Alle Häuser sind dunkelgrau. Wer einen Flyer eingeworfen hat, tippt das Haus an, und es wird gelb. Ein zweiter Tipp nimmt die Markierung zurück. Alle mit dem Link sehen die Änderungen sofort.

- **Ohne Anmeldung.** Jede Aktion hat einen geheimen Link (`/v/<22 Zeichen>`, etwa 131 Bit Zufall). Aktionen werden nirgends aufgelistet.
- **Frontend:** React, Tailwind v4, MapLibre, Vite.
- **Backend:** [Convex](https://convex.dev), live per Subscription.
- **Kartendaten:** © OpenStreetMap-Mitwirkende. Grundkarte von [OpenFreeMap](https://openfreemap.org), Gebäude über die [Overpass API](https://overpass-api.de), Ortssuche über [Nominatim](https://nominatim.org). Alle ohne API-Schlüssel.

## Bedienung der Karte

| Geste | Wirkung |
| --- | --- |
| Tippen auf ein Haus | markieren oder Markierung zurücknehmen (nach 0,3 s, siehe unten) |
| Doppeltipp | hineinzoomen (markiert nichts) |
| Doppeltipp und ziehen | mit einem Finger zoomen |
| Ziehen, Pinch, Mausrad, +/− | schieben und zoomen |
| Standort-Knopf | eigene Position verfolgen |

Ein Tipp wartet kurz, ob ein zweiter folgt. Nur so lassen sich Doppeltipp-Zoom und Markieren unterscheiden. Ein Doppeltipp sind zwei Tipps innerhalb von 300 ms und 30 px, die Regel steht in `src/lib/taps.ts`. Tippt man schnell ein *anderes* Haus an, wird das erste sofort übernommen.

Häuser werden erst ab Zoomstufe 15 geladen, kachelweise und mit etwas Vorrat über den Rand hinaus. Nach einem Fehler wartet die Karte zunehmend länger (5 s bis 60 s), bevor sie Overpass erneut fragt.

Convex speichert je markiertem Haus nur die OSM-ID und den Mittelpunkt, einsortiert in Zellen von 0,01° (`convex/cells.ts`). Jedes Handy abonniert nur die sichtbaren Zellen. Ein Tipp schickt deshalb nur die Zelle mit dem Haus an die Helfer, die sie gerade sehen, nicht die ganze Aktion. Gelb eingefärbt wird der Umriss, den das Handy ohnehin von Overpass hat. Rausgezoomt, oder solange der Umriss fehlt, zeigt die Karte gelbe Punkte. Ohne Netz zeigt die Karte „Offline“, Convex holt das Speichern nach.

## Entwickeln

```bash
pnpm install
npx convex dev          # beim ersten Mal: anmelden oder lokal ohne Konto; schreibt .env.local
pnpm dev                # http://localhost:5173
```

Prüfungen:

```bash
pnpm typecheck
pnpm test               # Convex-Funktionen (convex-test) und Bibliotheken
pnpm build
pnpm e2e                # Browser-Test; braucht laufendes `pnpm dev` + `npx convex dev`
                        # OSM-Dienste werden darin nachgebildet, Convex ist echt
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
2. Einstellungen:
   - Build Command: `npx convex deploy --cmd 'pnpm build'`
   - Output Directory: `dist`
   - Umgebungsvariable `CONVEX_DEPLOY_KEY` = der Production Deploy Key
3. Deploy. Jeder Push auf `main` deployt danach Backend und Frontend zusammen. `convex deploy` setzt `VITE_CONVEX_URL` für den Build selbst.

`vercel.json` leitet alle Pfade auf `index.html` um, damit geteilte Links wie `/v/…` funktionieren.

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

- Overpass, Nominatim und OpenFreeMap sind kostenlose öffentliche Dienste mit fairen Nutzungsregeln. Für eine Gemeinde-Aktion reicht das. Bei vielen gleichzeitigen Nutzern kann Overpass kurz drosseln; dann zeigt die Karte „Erneut“.
- Wer einen Link kennt, kann alles in dieser Aktion ändern (so gewollt). Neue Aktionen kann jeder anlegen. Eine Aktion hat höchstens 20.000 Markierungen. Neue Aktionen sind auf 20 pro Minute begrenzt, über alle Nutzer.
