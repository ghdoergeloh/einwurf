# Einwurf – gemeinsame Flyer-Verteilkarte

Eine Karte für Verteilaktionen: Alle Häuser sind dunkelgrau. Wer einen Flyer eingeworfen hat, tippt das Haus an, und es wird gelb. Ein zweiter Tipp macht es dunkelgelb: Einwerfen nicht möglich, etwa wegen eines Aufklebers „Keine Werbung“ oder weil der Briefkasten nicht erreichbar ist. Ein dritter Tipp macht es wieder grau. Alle mit dem Link sehen die Änderungen sofort.

- **Ohne Anmeldung.** Jede Aktion hat einen geheimen Link zum Mitmachen (`/v/<22 Zeichen>`, etwa 131 Bit Zufall), einen eigenen geheimen Link zum Ansehen (`/a/<22 Zeichen>`, siehe unten) und einen geheimen **Admin-Link** (`/admin/<22 Zeichen>`) für den Organisator, der die Gebiete festlegt. Aktionen werden nirgends aufgelistet.
- **Frontend:** React, Tailwind v4, MapLibre, Vite.
- **Backend:** [Convex](https://convex.dev), live per Subscription.
- **Kartendaten:** © OpenStreetMap-Mitwirkende. Grundkarte von [OpenFreeMap](https://openfreemap.org), Gebäude über die [Overpass API](https://overpass-api.de), Ortssuche über [Nominatim](https://nominatim.org). Alle ohne API-Schlüssel.
- **Gebäude über Convex:** Der Browser fragt Overpass nicht selbst. Die Convex-Action `buildings.load` holt die Häuser je Kachel (etwa 550 × 350 m), speichert sie 30 Tage für alle Helfer und fragt bei Überlastung zusätzlich andere öffentliche Overpass-Server (versetzt: antwortet einer nach 35 s nicht, kommt der nächste dazu, die erste Antwort gewinnt; jeder darf bis zu 60 s brauchen; Nachbarkacheln kommen nur mit, wenn ohnehin geladen wird). Die öffentlichen Server stecken oft voll und brauchen dann 20–40 s, egal wie klein die Abfrage ist. Deshalb lädt Convex bei so einem Abruf gleich die Nachbarschaft mit (bis zu 30 Kacheln, etwa 2 km²), beim Weiterschieben ist dann alles sofort da. Nur der erste Helfer in einem Gebiet wartet auf Overpass; dauert es länger, sagt die Karte das.
- **Vorladen:** Beim Anlegen einer Aktion lädt Convex im Hintergrund alle Häuser des gesuchten Ortes in den Cache, vom Ortsmittelpunkt nach außen, höchstens 600 Kacheln (etwa 100–120 km², ungefähr ganz Bornheim) und gebremst (höchstens etwa 8 Overpass-Abrufe pro Minute je Aktion, alle Vorladungen zusammen höchstens 15 pro Minute; die Karte hat getrennt davon 30 pro Minute, Vorladen bremst sie also nie aus). Im Teilen-Dialog stehen Fortschritt und der Knopf „Gebiet vorladen“ (für ältere Aktionen oder nach einem Fehler). Gespeichert wird je Kachel ein Eintrag mit allen Häusern als Text, nicht ein Eintrag pro Haus.
- **Hausnummern:** ab Zoomstufe 17 auf den Häusern, hell auf grauen, dunkel auf gelben Häusern. Sie kommen mit den Häusern von Overpass, entweder vom Gebäude selbst oder von einem Adresspunkt darin. Ältere Cache-Einträge ohne Nummern liefert Convex sofort aus und lädt sie im Hintergrund neu (im Kontingent des Vorladen), die Nummern erscheinen dann beim nächsten Öffnen. „Aktualisieren“ im Teilen-Dialog holt sie für das ganze Gebiet.

## Gebiete und Admin-Link

Eine Aktion startet an einer **Adresse** (z. B. eurem Treffpunkt), dem Mittelpunkt der Karte. Der Organisator wählt dann auf der Karte die **Ortsteile**, in denen verteilt wird, auch über Gemeindegrenzen hinweg (etwa Roisdorf und Hersel in Bornheim und Witterschlick in Alfter). Die Helfer sehen und laden nur die Häuser dieser Gebiete.

- **Gebiete bearbeiten** (nur im Admin-Link, Kartensymbol oben): Die Karte zoomt heraus und zeigt alle Ortsteile im Ausschnitt mit Grenze und Namen, gewählte gelb. Ein Tipp auf eine Fläche nimmt den Ortsteil dazu oder heraus; Häuser sind in dem Modus nicht antippbar. „Fertig“ beendet den Modus. Nach dem Anlegen öffnet der Admin-Link direkt so, der Ortsteil an der Adresse ist schon gewählt. Die Auswahl gilt sofort für alle.
- **Mittelpunkt ändern:** im Bearbeiten-Modus unter „Mittelpunkt … Ändern“ eine andere Adresse suchen. Die Gebiete bleiben.
- **Entfernen** eines Ortsteils löscht nichts: Er bleibt mit „nicht gewählt“ in der Aktion stehen, Markierungen und Notizen dort bleiben gespeichert und werden nur nicht gezeigt. Wählt man ihn wieder, ist alles wieder da.
- **Woher die Ortsteile kommen:** aus OpenStreetMap, gespeichert in einem gemeinsamen Cache für alle Aktionen, je Grenz-Kachel von 0,05° (etwa 5 × 3,5 km, 90 Tage). Für eine Kachel werden (1) die Gemeinden geholt, die sie schneiden (`admin_level` 8; eine kreisfreie Stadt auf Stufe 6 oder 7, wenn keine Gemeinde in ihr liegt), (2) die Liste feinerer Grenzen in ihrer Ausdehnung, ohne Geometrie, und (3) die Grenzen nur der Kandidaten, die ganz in einer Gemeinde liegen. Je Gemeinde gilt die **feinste Verwaltungsstufe, die sie zu mindestens 90 % abdeckt, ohne dass sich ihre Gebiete nennenswert überlappen**; passt keine allein, eine Mischung (gröbere Gebiete zuerst, Lücken mit feineren gefüllt, wie in Bornheim mit Ortschaften auf Stufe 9 und 10), danach `boundary=place`. Gemessen wird an Stichproben. Ohne Unterteilung ist die Gemeinde selbst ein Gebiet. Die Regeln stehen in `convex/areaGeo.ts` und `convex/areaLoad.ts`, ohne Sonderfälle für einzelne Orte; geprüft mit echten Grenzen von Bornheim (13 Ortschaften) und Bonn (51 Ortsteile) in `fixtures/osm`.
- **Wer Overpass fragt:** Im Modus „Gebiete bearbeiten“ fragt der **Browser des Admins** Overpass direkt (aus der Convex-Cloud sind die öffentlichen Server oft nicht erreichbar, aus einem normalen Browser schon) und schickt das Ergebnis an Convex (`areas.storeLoaded`). Convex prüft es (Form, Größe, Koordinaten), berechnet Ausdehnung und Kacheln selbst und speichert es **nur für diese Aktion** (höchstens 2.000 Ortsteile je Aktion): Was ein Browser schickt, kann Convex nicht gegen OSM prüfen, und jeder kann eine Aktion anlegen. Gemeinsam für alle Aktionen ist nur, was Convex selbst bei Overpass geladen hat; gelesen wird das Gemeinsame zuerst. Erreicht der Browser Overpass nicht, versucht es Convex selbst; beim Anlegen lädt Convex rund um die Adresse. Häuser fragt weiterhin nur Convex. Eigene Server für den Browser: Vite-Variable `VITE_OVERPASS_URLS` (kommagetrennt).
- **Overpass ausgelastet:** je Server bis 120 s, dann der nächste, im Browser höchstens 3 Minuten je Abfrage (eine Kachel braucht bis zu drei Abfragen); danach versucht es Convex (bis 5 Minuten). Beim ersten Mal in einer Gegend kann das Laden im ungünstigsten Fall über 10 Minuten dauern, danach kommt es aus dem Cache. Scheitert es, zeigt die Leiste die Antwort der Server (nur Hostnamen) und „Erneut versuchen“.
- **Auf der Karte:** Grenzen und Namen der gewählten Gebiete, alles außerhalb dezent abgedunkelt. Dort lädt die Karte keine Häuser (Convex fragt Overpass für solche Kacheln gar nicht und liefert Häuser mit Mittelpunkt außerhalb nicht aus). Die Zähler oben zählen alle Markierungen, die Statistik zählt sie beim jeweiligen Gebiet. Der Ansehen-Link zeigt dieselbe Auswahl.
- **Vorladen** umfasst nur Gebäude-Kacheln, die gewählte Gebiete berühren (je Gebiet einmal berechnet und gespeichert). Ändert sich die Auswahl, plant Convex das Vorladen neu und lädt neue Gebiete nach.
- Ist nichts gewählt (auch nachdem alle Ortsteile abgewählt wurden, oder bei älteren Aktionen), gilt wie bisher der ganze Ort ohne Einschränkung.
- **Für die Statistik je Gebiet:** `campaignAreas(ctx, campaignId)` (`convex/areaStore.ts`) liefert `{ id, name, geometry, selected, cells }` (auch abgewählte), `areaAt(punkt, gebiete)` (`convex/areaGeo.ts`) ordnet ein Haus oder eine Markierung einem Gebiet zu.

## Statistik je Gebiet

Ein Tipp auf den Zähler oben öffnet die **Statistik**, für alle mit einem Link, auch mit dem Ansehen-Link (dort nur lesend). Sie zeigt je Gebiet, wie viel schon erreicht ist, damit der Organisator die Helfer dorthin schicken kann, wo noch viel fehlt.

- **Erreicht** = (Flyer drin + nicht möglich) / alle Häuser des Gebiets: An dunkelgelben Häusern muss niemand mehr hin. Der Anteil gelb steht zusätzlich da, dazu Häuser gesamt, gelb, dunkelgelb und offen und ein Balken. Prozente sind abgerundet; 100 % heißt wirklich alles.
- **Oben die Zielgebiete** (die gewählten Ortsteile) und ihre Summe, darunter eingeklappt die abgewählten, ohne Prozent, weil ihre Häuser nicht geladen werden. „Zeigen“ springt auf der Karte zum Gebiet. Solange keine Ortsteile gewählt sind (dann gilt der ganze Ort), zeigt sie nur die Summen.
- **Häuser zählen:** dieselben Häuser, die die Karte antippbar zeigt, aus dem Gebäude-Cache (auch ältere Einträge, die die Karte ebenfalls zeigt) und über ihren Mittelpunkt einem Gebiet zugeordnet (liegen Gebiete übereinander, gilt das erste gewählte nach Namen, wie auf der Karte). Eine Kachel mit so vielen Häusern, dass sie nicht in den Cache passt (über 900 kB), fehlt in der Zählung; das Gebiet bleibt dann „vorläufig“. Convex zählt sie im Hintergrund in kleinen Schritten, bei geänderter Auswahl und wenn das Vorladen fertig ist; beim Öffnen der Statistik höchstens einmal pro Minute erneut, falls noch etwas fehlt. Fehlen Kacheln eines Gebiets im Cache, steht dort **„vorläufig“**, und die Zahl wird nachgeführt.
- **Markierungen** zählt Convex beim Setzen je Gebiet mit (wie die Zähler oben), live für alle, ohne bei jedem Tipp alle Häuser neu zu zählen. Jede Markierung merkt sich ihr Gebiet (`marks.area`, `marks.areaRun`). Ändert der Admin die Auswahl der Ortsteile, ordnet Convex alle Markierungen der Aktion im Hintergrund neu zu (je 400 pro Schritt; bei überlappenden Ortsteilen zählen Häuser und Markierungen so immer beim selben); solange steht in der Statistik ein Hinweis, die Häuserzahlen bleiben bis zur neuen Zählung stehen. Wurden die Gebiete einer Aktion vor der Statistik angelegt, legt das erste Öffnen der Statistik sie an. Markierungen außerhalb aller Gebiete zählen die Zähler oben mit, die Statistik nennt nur ihre Anzahl. Code: `convex/stats.ts`, Tabellen `areaStats` und `statsJobs`.

**Admin-Link wiederfinden:** Nach dem Anlegen landet der Organisator auf dem Admin-Link; der Teilen-Dialog zeigt ihn mit dem Hinweis „Diesen Link für dich behalten“. Weitergegeben wird nur der Link zum Mitmachen. Ist der Admin-Link verloren: im [Convex-Dashboard](https://dashboard.convex.dev) unter *Data → campaigns* die Aktion suchen (Feld `slug` = Schlüssel aus dem Link zum Mitmachen), dort steht er im Feld `adminKey`. Der Link ist dann `https://<eure-seite>/admin/<adminKey>`. Über den Link zum Mitmachen ist er nicht zu erfahren.

**Ältere Aktionen** (vor dem Admin-Link angelegt) bekommen ihren Admin-Schlüssel durch eine einmalige Migration: im Convex-Dashboard unter *Functions* `migrations:addAdminKeys` ohne Argumente ausführen (mehrfaches Ausführen schadet nicht). Bis dahin gilt für sie der ganze Ort; danach wählt der Organisator im Admin-Link wie oben die Ortsteile.

## Bedienung der Karte

| Geste | Wirkung |
| --- | --- |
| Tippen auf ein Haus | weiterschalten: grau (offen) → gelb (Flyer drin) → dunkelgelb (nicht möglich) → grau (nach 0,3 s, siehe unten) |
| Langes Drücken (0,5 s) oder Rechtsklick auf ein Haus | Notiz anlegen, ändern oder löschen (schaltet nichts weiter); beim Ansehen nur lesen |
| Doppeltipp | hineinzoomen (markiert nichts) |
| Doppeltipp und ziehen | mit einem Finger zoomen |
| Ziehen, Pinch, Mausrad, +/− | schieben und zoomen |
| Standort-Knopf | eigene Position verfolgen |

Ein Tipp wartet kurz, ob ein zweiter folgt. Für „nicht möglich“ also zweimal mit kurzer Pause tippen; zwei schnelle Tipps zoomen. Nur so lassen sich Doppeltipp-Zoom und Markieren unterscheiden. Ein Doppeltipp sind zwei Tipps innerhalb von 300 ms und 30 px. Zieht der Finger nach dem zweiten Tipp, zoomt die Karte stufenlos: 150 px nach unten sind eine Stufe hinein. Die Regel steht in `src/lib/taps.ts`. Tippt man schnell ein *anderes* Haus an, wird das erste sofort übernommen.

Ein Tipp färbt das Haus sofort, dazu sprühen kurz „Pixel-Funken“ (`src/lib/sparks.ts`; mit „Bewegung reduzieren“ im System ohne). Ist der Stand des Hauses noch nicht geladen (langsames Netz, Funkloch), merkt sich das Handy den Tipp und schickt ihn ab, sobald der Stand da ist (`src/lib/pendingTaps.ts`). Hat inzwischen jemand anderes das Haus geändert, gilt dessen Stand, und ein Hinweis erscheint. Der Zähler oben zählt ein gemerktes Haus erst nach dem Abschicken.

**Notizen.** Langes Drücken (Finger oder Maus, 0,5 s) oder ein Rechtsklick auf ein Haus öffnet einen Dialog für eine Notiz, etwa „Briefkasten 3 und 4 haben nichts bekommen“ (höchstens 500 Zeichen, Zeilenumbrüche bleiben). Gibt es schon eine, steht sie darin und lässt sich ändern oder löschen; leer speichern löscht sie ebenfalls. Bewegt sich der Finger dabei mehr als 10 px, kommt ein zweiter Finger dazu oder ist es ein Doppeltipp-und-halten, öffnet sich nichts (`src/lib/longPress.ts`). Das Kontextmenü des Browsers erscheint auf der Karte nie. Ein Haus mit Notiz ist **blau**: ein offenes Haus ganz blau, ein gelbes oder dunkelgelbes behält seine Farbe und bekommt einen blauen Rand und einen blauen Punkt in der Mitte (ab Zoomstufe 17 über der Hausnummer). Rausgezoomt zeigt ein blauer Punkt die Notiz, auf einem gelben Punkt als blauer Kern. Ein normaler Tipp schaltet auch ein Haus mit Notiz weiter, die Notiz bleibt. Notizen sind wie Markierungen live für alle mit dem Link sichtbar und werden je sichtbarer Zelle abonniert (`convex/notes.ts`). Ändert jemand anderes die Notiz, während der Dialog offen ist, übernimmt er sie, solange man noch nichts getippt hat; sonst warnt er, dass Speichern die neue Fassung ersetzt. Auf einem hellgrauen Platzhalter, dessen Haus noch lädt, gibt es statt des Dialogs einen Hinweis: Eine Notiz gehört zu einem bestimmten Haus, und anders als ein Tipp lässt sich Text nicht sinnvoll vormerken und später einem Haus zuordnen.

Solange die Häuser eines neuen Gebiets noch von Overpass kommen, zeigt die Karte die Häuser der Grundkarte hellgrau als Platzhalter. Ein Tipp auf ein hellgraues Haus färbt es sofort vorläufig (gestrichelter Rand) und schaltet weiter wie bei jedem Haus; übernommen wird, sobald das Haus geladen ist (von „offen“ aus: hat jemand anderes es inzwischen markiert, gilt dessen Stand). Gibt es dort kein Haus zum Markieren oder kommt es nach 3 Minuten nicht, erscheint ein Hinweis (`src/lib/placeholderTaps.ts`). Unterhalb von Zoomstufe 15 sind alle Häuser hellgrau (Übersicht, nicht antippbar). Vereinzelt bleibt ein Haus grau (etwa ein Gebäudeteil, den die Grundkarte zeigt, Overpass aber nicht als Gebäude liefert). Häuser werden erst ab Zoomstufe 15 geladen, kachelweise und mit etwas Vorrat über den Rand hinaus. Nach einem Fehler wartet die Karte zunehmend länger (5 s bis 60 s), bevor sie es erneut versucht.

Convex speichert je markiertem Haus nur die OSM-ID und den Mittelpunkt, einsortiert in Zellen von 0,01° (`convex/cells.ts`). Jedes Handy abonniert nur die sichtbaren Zellen. Ein Tipp schickt deshalb nur die Zelle mit dem Haus an die Helfer, die sie gerade sehen, nicht die ganze Aktion. Eingefärbt (gelb oder dunkelgelb) wird der Umriss, den das Handy ohnehin von Overpass hat. Rausgezoomt, oder solange der Umriss fehlt, zeigt die Karte Punkte in derselben Farbe. Ab einem Ausschnitt von mehr als 100 Zellen (etwa ab Zoomstufe 12) zeigt sie keine Markierungen mehr. Ohne Netz zeigt die Karte „Offline“, Convex holt das Speichern nach.

## Links und Rechte

| Link | Rolle | Was geht |
| --- | --- | --- |
| `/v/…` zum Mitmachen | edit | Häuser markieren, teilen, Gebiet vorladen, Statistik |
| `/a/…` nur ansehen | view | Karte, Markierungen, Notizen und Statistik live sehen (Tipp auf ein blaues Haus zeigt die Notiz), sonst nichts |
| `/admin/…` Admin-Link | admin | Gebiete festlegen und alles, was edit kann; wird über die anderen Links nie herausgegeben |

Der Teilen-Dialog zeigt beide Links getrennt („Zum Mitmachen“ und „Nur ansehen“). Ältere Aktionen bekommen ihren Ansehen-Link, sobald jemand mit dem Link zum Mitmachen den Teilen-Dialog öffnet. Die beiden Schlüssel sind unabhängig voneinander zufällig, der eine lässt sich aus dem anderen nicht ableiten.

Durchgesetzt wird das im Backend (`convex/access.ts`): Jede Mutation an einer bestehenden Aktion verlangt mindestens die Rolle edit, mit dem Ansehen-Schlüssel gehen nur lesende Queries und das Laden der Häuser (im selben Kontingent wie die Aktion). Keine Query, die mit dem Ansehen-Schlüssel aufrufbar ist, liefert den Schlüssel zum Mitmachen. Die Gebietsauswahl (`areas.select`, `areas.load`) verlangt die Rolle admin, also den Admin-Schlüssel; keine Query gibt ihn heraus. Ein Test (`convex/access.test.ts`) prüft jede öffentliche Mutation, Action und Query; kommt eine neue dazu, schlägt er fehl, bis ihre Rechte dort geprüft sind.

Mit dem Link zum Mitmachen gibt es oben rechts den Umschalter **Bearbeiten / Ansehen**. Im Modus „Ansehen“ verhält sich die Karte wie beim Ansehen-Link, etwa damit beim Schieben in der Tasche oder beim Zeigen nichts markiert wird. Ein Tipp auf ein Haus zeigt dann nur einen Hinweis; ein Tipp oder langes Drücken auf ein blaues Haus zeigt seine Notiz zum Lesen (wie beim Ansehen-Link), ohne Bearbeiten. Das Handy merkt sich den Modus je Aktion; Standard ist „Bearbeiten“. Schieben, Zoomen, Doppeltipp und Standort funktionieren in beiden Ansichten.

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
                        # OSM-Dienste (auch die Grenzen der Gebiete) werden darin nachgebildet, Convex ist echt.
                        # Einmalig für den Test: npx convex env set OVERPASS_URLS http://127.0.0.1:8787/api/interpreter
                        # (danach wieder entfernen: npx convex env remove OVERPASS_URLS)
node e2e/preview-gebiete.mjs <preview-url>
                        # Gebiete mit echten OSM-Daten gegen ein Preview-Deployment
                        # (Adresse in Bornheim, Ortsteil in Alfter dazuwählen)
node e2e/preview-stats.mjs <preview-url> [adresse]
                        # Statistik gegen ein Vercel-Preview (eigenes Convex-Preview-Backend, echte Overpass-Daten),
                        # der Ortsteil an der Adresse (Standard: Widdig in Bornheim); dauert wegen des gebremsten Vorladens einige Minuten.
```

Gegen eine Vercel-Preview (eigenes Convex-Preview-Backend, echte Häuser von Overpass; nachgebildet ist nur die Ortssuche im Browser):

```bash
pnpm e2e:preview https://<preview>.vercel.app [ordner-für-screenshots]
```

Liegt die Preview hinter Vercel Deployment Protection, braucht der Test den Header `x-vercel-protection-bypass` (Secret aus *Settings → Deployment Protection → Protection Bypass for Automation*), z. B. von einem Proxy gesetzt.

In Previews (`VITE_VERCEL_ENV=preview`) stellt die Seite dafür die Karte als `window.__einwurfMap` bereit, in Produktion nicht.

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
- Wer den Link zum Mitmachen kennt, kann alle Häuser und Notizen dieser Aktion ändern (so gewollt); die Gebiete legt nur der Admin-Link fest. Wer nur den Ansehen-Link kennt, kann nichts ändern. Neue Aktionen kann jeder anlegen. Eine Aktion hat höchstens 20.000 Markierungen und 5.000 Notizen. Neue Aktionen sind auf 20 pro Minute begrenzt, über alle Nutzer.
