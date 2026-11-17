# Einwurf – gemeinsame Flyer-Verteilkarte

Eine Karte für Verteilaktionen: Alle Häuser sind dunkelgrau. Wer einen Flyer eingeworfen hat, tippt das Haus an, und es wird gelb. Ein zweiter Tipp macht es dunkelgelb: Einwerfen nicht möglich, etwa wegen eines Aufklebers „Keine Werbung“ oder weil der Briefkasten nicht erreichbar ist. Ein dritter Tipp macht es wieder grau. Alle mit dem Link sehen die Änderungen sofort.

- **Ohne Anmeldung.** Jede Aktion hat einen geheimen Link zum Mitmachen (`/v/<22 Zeichen>`, etwa 131 Bit Zufall) und einen eigenen geheimen Link zum Ansehen (`/a/<22 Zeichen>`, siehe unten). Aktionen werden nirgends aufgelistet.
- **Frontend:** React, Tailwind v4, MapLibre, Vite.
- **Backend:** [Convex](https://convex.dev), live per Subscription.
- **Kartendaten:** © OpenStreetMap-Mitwirkende. Grundkarte von [OpenFreeMap](https://openfreemap.org), Gebäude über die [Overpass API](https://overpass-api.de), Ortssuche über [Nominatim](https://nominatim.org). Alle ohne API-Schlüssel.
- **Gebäude über Convex:** Der Browser fragt Overpass nicht selbst. Die Convex-Action `buildings.load` holt die Häuser je Kachel (etwa 550 × 350 m), speichert sie 30 Tage für alle Helfer und fragt bei Überlastung zusätzlich andere öffentliche Overpass-Server (versetzt: antwortet einer nach 35 s nicht, kommt der nächste dazu, die erste Antwort gewinnt; jeder darf bis zu 60 s brauchen; Nachbarkacheln kommen nur mit, wenn ohnehin geladen wird). Die öffentlichen Server stecken oft voll und brauchen dann 20–40 s, egal wie klein die Abfrage ist. Deshalb lädt Convex bei so einem Abruf gleich die Nachbarschaft mit (bis zu 30 Kacheln, etwa 2 km²), beim Weiterschieben ist dann alles sofort da. Nur der erste Helfer in einem Gebiet wartet auf Overpass; dauert es länger, sagt die Karte das.
- **Vorladen:** Beim Anlegen einer Aktion lädt Convex im Hintergrund alle Häuser des gesuchten Ortes in den Cache, vom Ortsmittelpunkt nach außen, höchstens 600 Kacheln (etwa 100–120 km², ungefähr ganz Bornheim) und gebremst (höchstens etwa 8 Overpass-Abrufe pro Minute je Aktion, alle Vorladungen zusammen höchstens 15 pro Minute; die Karte hat getrennt davon 30 pro Minute, Vorladen bremst sie also nie aus). Im Teilen-Dialog stehen Fortschritt und der Knopf „Gebiet vorladen“ (für ältere Aktionen oder nach einem Fehler). Gespeichert wird je Kachel ein Eintrag mit allen Häusern als Text, nicht ein Eintrag pro Haus.
- **Hausnummern:** ab Zoomstufe 17 auf den Häusern, hell auf grauen, dunkel auf gelben Häusern. Sie kommen mit den Häusern von Overpass, entweder vom Gebäude selbst oder von einem Adresspunkt darin. Ältere Cache-Einträge ohne Nummern liefert Convex sofort aus und lädt sie im Hintergrund neu (im Kontingent des Vorladen), die Nummern erscheinen dann beim nächsten Öffnen. „Aktualisieren“ im Teilen-Dialog holt sie für das ganze Gebiet.

## Bedienung der Karte

| Geste | Wirkung |
| --- | --- |
| Tippen auf ein Haus | weiterschalten: grau (offen) → gelb (Flyer drin) → dunkelgelb (nicht möglich) → grau (nach 0,3 s, siehe unten) |
| Doppeltipp | hineinzoomen (markiert nichts) |
| Doppeltipp und ziehen | mit einem Finger zoomen |
| Ziehen, Pinch, Mausrad, +/− | schieben und zoomen |
| Standort-Knopf | eigene Position verfolgen |

Ein Tipp wartet kurz, ob ein zweiter folgt. Für „nicht möglich“ also zweimal mit kurzer Pause tippen; zwei schnelle Tipps zoomen. Nur so lassen sich Doppeltipp-Zoom und Markieren unterscheiden. Ein Doppeltipp sind zwei Tipps innerhalb von 300 ms und 30 px. Zieht der Finger nach dem zweiten Tipp, zoomt die Karte stufenlos: 150 px nach unten sind eine Stufe hinein. Die Regel steht in `src/lib/taps.ts`. Tippt man schnell ein *anderes* Haus an, wird das erste sofort übernommen.

Ein Tipp färbt das Haus sofort, dazu sprühen kurz „Pixel-Funken“ (`src/lib/sparks.ts`; mit „Bewegung reduzieren“ im System ohne). Ist der Stand des Hauses noch nicht geladen (langsames Netz, Funkloch), merkt sich das Handy den Tipp und schickt ihn ab, sobald der Stand da ist (`src/lib/pendingTaps.ts`). Hat inzwischen jemand anderes das Haus geändert, gilt dessen Stand, und ein Hinweis erscheint. Der Zähler oben zählt ein gemerktes Haus erst nach dem Abschicken.

Solange die Häuser eines neuen Gebiets noch von Overpass kommen, zeigt die Karte die Häuser der Grundkarte hellgrau als Platzhalter. Ein Tipp auf ein hellgraues Haus färbt es sofort vorläufig (gestrichelter Rand) und schaltet weiter wie bei jedem Haus; übernommen wird, sobald das Haus geladen ist (von „offen“ aus: hat jemand anderes es inzwischen markiert, gilt dessen Stand). Gibt es dort kein Haus zum Markieren oder kommt es nach 3 Minuten nicht, erscheint ein Hinweis (`src/lib/placeholderTaps.ts`). Unterhalb von Zoomstufe 15 sind alle Häuser hellgrau (Übersicht, nicht antippbar). Vereinzelt bleibt ein Haus grau (etwa ein Gebäudeteil, den die Grundkarte zeigt, Overpass aber nicht als Gebäude liefert). Häuser werden erst ab Zoomstufe 15 geladen, kachelweise und mit etwas Vorrat über den Rand hinaus. Nach einem Fehler wartet die Karte zunehmend länger (5 s bis 60 s), bevor sie es erneut versucht.

Convex speichert je markiertem Haus nur die OSM-ID und den Mittelpunkt, einsortiert in Zellen von 0,01° (`convex/cells.ts`). Jedes Handy abonniert nur die sichtbaren Zellen. Ein Tipp schickt deshalb nur die Zelle mit dem Haus an die Helfer, die sie gerade sehen, nicht die ganze Aktion. Eingefärbt (gelb oder dunkelgelb) wird der Umriss, den das Handy ohnehin von Overpass hat. Rausgezoomt, oder solange der Umriss fehlt, zeigt die Karte Punkte in derselben Farbe. Ab einem Ausschnitt von mehr als 100 Zellen (etwa ab Zoomstufe 12) zeigt sie keine Markierungen mehr. Ohne Netz zeigt die Karte „Offline“, Convex holt das Speichern nach.

## Links und Rechte

| Link | Rolle | Was geht |
| --- | --- | --- |
| `/v/…` zum Mitmachen | edit | Häuser markieren, teilen, Gebiet vorladen |
| `/a/…` nur ansehen | view | Karte und Markierungen live sehen, sonst nichts |

Der Teilen-Dialog zeigt beide Links getrennt („Zum Mitmachen“ und „Nur ansehen“). Ältere Aktionen bekommen ihren Ansehen-Link, sobald jemand mit dem Link zum Mitmachen den Teilen-Dialog öffnet. Die beiden Schlüssel sind unabhängig voneinander zufällig, der eine lässt sich aus dem anderen nicht ableiten.

Durchgesetzt wird das im Backend (`convex/access.ts`): Jede Mutation verlangt mindestens die Rolle edit, mit dem Ansehen-Schlüssel gehen nur lesende Queries und das Laden der Häuser (im selben Kontingent wie die Aktion). Keine Query, die mit dem Ansehen-Schlüssel aufrufbar ist, liefert den Schlüssel zum Mitmachen. Ein Test (`convex/access.test.ts`) prüft jede öffentliche Mutation; kommt eine neue dazu, schlägt er fehl, bis ihre Rechte dort geprüft sind. Für eine dritte Rolle admin (Admin-Link, Gebietsauswahl) ist die Prüfung schon vorbereitet.

Mit dem Link zum Mitmachen gibt es oben rechts den Umschalter **Bearbeiten / Ansehen**. Im Modus „Ansehen“ verhält sich die Karte wie beim Ansehen-Link, etwa damit beim Schieben in der Tasche oder beim Zeigen nichts markiert wird. Ein Tipp auf ein Haus zeigt dann nur einen Hinweis. Das Handy merkt sich den Modus je Aktion; Standard ist „Bearbeiten“. Schieben, Zoomen, Doppeltipp und Standort funktionieren in beiden Ansichten.

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
3. Deployen. Build-Befehl, Ausgabeordner und die Umleitung für geteilte Links (`/v/…`, `/a/…`) stehen in `vercel.json`, in der Vercel-Oberfläche muss dafür nichts eingestellt werden. `convex deploy` deployt dabei das Backend und setzt `VITE_CONVEX_URL` für den Build.

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
- Overpass-Abrufe über Convex sind begrenzt: 12 pro Minute je Aktion, 30 pro Minute insgesamt für die Karte (Vorladen getrennt, 15 pro Minute). Cache-Treffer zählen nicht. Ohne Anmeldung kann jemand mit mehreren Aktionen das gemeinsame Limit kurzzeitig ausschöpfen; neue Gebiete laden dann erst nach einer Minute. Der Cache wird täglich von Kacheln älter als 30 Tage befreit.
- Wer den Link zum Mitmachen kennt, kann alle Häuser dieser Aktion ändern (so gewollt). Wer nur den Ansehen-Link kennt, kann nichts ändern. Neue Aktionen kann jeder anlegen. Eine Aktion hat höchstens 20.000 Markierungen. Neue Aktionen sind auf 20 pro Minute begrenzt, über alle Nutzer.
