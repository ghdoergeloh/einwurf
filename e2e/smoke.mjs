// Browser-Test der ganzen App gegen ein laufendes `pnpm dev` + `npx convex dev` (lokal).
// OSM-Dienste werden nachgebildet, Convex ist echt:
//  - Ortssuche und Grundkarte im Browser (Playwright-Routen),
//  - Overpass als kleiner HTTP-Server auf Port 8787, den die Convex-Action fragt.
//    Einmalig: npx convex env set OVERPASS_URLS http://127.0.0.1:8787/api/interpreter
// Aufruf: node e2e/smoke.mjs [basis-url] [ordner-für-screenshots]
import { chromium } from "playwright";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";

// Schrift für die Hausnummern (Noto Sans Bold, Zeichen 0–255, SIL Open Font License), damit der Test ohne Netz läuft.
const GLYPHS = readFileSync(new URL("./fixtures/noto-sans-bold-0-255.pbf", import.meta.url));

const BASE = process.argv[2] ?? "http://localhost:5173";
const SHOTS = process.argv[3];
// Jeder Lauf in einem eigenen Gebiet, damit der gemeinsame Gebäude-Cache den Overpass-Weg nicht überdeckt.
// Länge weit gestreut (0,001°-Raster über 14°): Ein Lauf trifft praktisch nie den Cache früherer
// Läufe samt Nachbarschaft. Die Breite bleibt fest, die Bildschirm-Abstände unten passen zu ihr.
const CENTER = { lat: 50.76, lng: Math.round((2 + Math.random() * 14) * 1000) / 1000 };

// Häuser im Raster um CENTER: 0,0004° × 0,0003° Abstand.
const GX = 0.0004, GY = 0.0003;
function houseRing(i, j) {
  const x = CENTER.lng + i * GX;
  const y = CENTER.lat + j * GY;
  const dx = 0.00013, dy = 0.0001;
  return [[x - dx, y - dy], [x + dx, y - dy], [x + dx, y + dy], [x - dx, y + dy], [x - dx, y - dy]];
}
// Ein zweites Gebiet weiter östlich, ohne Cache: dort testen wir Tipps auf Platzhalter.
const FAR_I = 150;
const FAR = { lat: CENTER.lat, lng: CENTER.lng + FAR_I * GX };

function fakeBuildings(body) {
  const q = new URLSearchParams(body).get("data");
  const [s, w, n, e] = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/).slice(1).map(Number);
  const elements = [];
  for (let i = Math.ceil((w - CENTER.lng) / GX); i <= Math.floor((e - CENTER.lng) / GX); i++)
    for (let j = Math.ceil((s - CENTER.lat) / GY); j <= Math.floor((n - CENTER.lat) / GY); j++) {
      const x = CENTER.lng + i * GX;
      const y = CENTER.lat + j * GY;
      // Dieses Haus gibt es nur in der Grundkarte, nicht bei Overpass (z. B. ein Gebäudeteil).
      if (i === FAR_I + 3 && j === 3) continue;
      const ring = houseRing(i, j);
      // Jedes zweite Haus hat eine Hausnummer am Gebäude, jedes vierte einen Adresspunkt darin.
      const tags = (i + j) % 2 === 0 ? { building: "yes", "addr:housenumber": String(80 + i) } : { building: "yes" };
      const id = (i + 5000) * 10000 + (j + 5000);
      elements.push({ type: "way", id, tags, geometry: ring.map(([lon, lat]) => ({ lat, lon })) });
      if ((i + j) % 4 === 0) elements.push({ type: "node", id, lat: y, lon: x, tags: { "addr:housenumber": `${80 + i}a` } });
    }
  return { elements };
}

// Grenzen: Stadt (Stufe 8) mit zwei Ortsteilen (Stufe 10). Das zweite Gebiet (FAR) liegt außerhalb.
const AREA_SPLIT = CENTER.lng + 0.0025;
const relBox = (id, name, level, [w, s, e, n]) => ({
  type: "relation",
  id,
  tags: { boundary: "administrative", admin_level: String(level), name },
  members: [{ type: "way", role: "outer", geometry: [[w, s], [e, s], [e, n], [w, n], [w, s]].map(([lon, lat]) => ({ lat, lon })) }],
});
const TOWN = [CENTER.lng - 0.01, CENTER.lat - 0.01, CENTER.lng + 0.01, CENTER.lat + 0.01];
function fakeAreas(query) {
  if (query.includes("is_in")) {
    const [w, s, e, n] = TOWN;
    return { elements: [{ type: "relation", id: 900, tags: { boundary: "administrative", admin_level: "8", name: "Bornheim" }, bounds: { minlon: w, minlat: s, maxlon: e, maxlat: n } }] };
  }
  return {
    elements: [
      relBox(900, "Bornheim", 8, TOWN),
      relBox(901, "Roisdorf", 10, [TOWN[0], TOWN[1], AREA_SPLIT, TOWN[3]]),
      relBox(902, "Hersel", 10, [AREA_SPLIT, TOWN[1], TOWN[2], TOWN[3]]),
    ],
  };
}

let overpassCalls = 0;
/** Verzögerung des nachgebildeten Overpass (langsamer Server). */
let overpassDelayMs = 0;
const overpass = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const q = new URLSearchParams(body).get("data") ?? "";
    res.setHeader("Content-Type", "application/json");
    if (q.includes("is_in") || q.includes("map_to_area")) return res.end(JSON.stringify(fakeAreas(q)));
    overpassCalls++;
    setTimeout(() => res.end(JSON.stringify(fakeBuildings(body))), overpassDelayMs);
  });
});
await new Promise((r) => overpass.listen(8787, "127.0.0.1", r));

let browserCalledOverpass = false;
async function mockOsm(ctx, { styleFails = false } = {}) {
  await ctx.route("https://nominatim.openstreetmap.org/**", (r) =>
    r.fulfill({
      json: [
        { display_name: "Roisdorf, Bornheim, Rhein-Sieg-Kreis, Nordrhein-Westfalen, Deutschland", name: "Roisdorf", lat: String(CENTER.lat), lon: String(CENTER.lng), boundingbox: [String(CENTER.lat - 0.002), String(CENTER.lat + 0.002), String(CENTER.lng - 0.003), String(CENTER.lng + 0.003)] },
        { display_name: "Bornheim, Rhein-Sieg-Kreis, Nordrhein-Westfalen, Deutschland", name: "Bornheim", lat: "50.75", lon: "6.98", boundingbox: ["50.7", "50.8", "6.9", "7.1"] },
      ],
    }),
  );
  await ctx.route("https://tiles.openfreemap.org/**", (r) =>
    styleFails
      ? r.fulfill({ status: 500, body: "kaputt" })
      : r.request().url().includes("/fonts/")
        ? r.fulfill({ body: GLYPHS, contentType: "application/x-protobuf" })
        : r.fulfill({
            json: {
              version: 8,
              glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
              sources: {
                leer: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
                // Häuser der Grundkarte (Platzhalter) im zweiten Gebiet
                platzhalter: {
                  type: "geojson",
                  data: {
                    type: "FeatureCollection",
                    features: [
                      ...Array.from({ length: 21 * 21 }, (_, k) => ({
                        type: "Feature",
                        properties: {},
                        geometry: { type: "Polygon", coordinates: [houseRing(FAR_I - 10 + (k % 21), -10 + Math.floor(k / 21))] },
                      })),
                    ],
                  },
                },
              },
              layers: [
                { id: "bg", type: "background", paint: { "background-color": "#ebe8e1" } },
                { id: "ortsnamen", type: "symbol", source: "leer", layout: { "text-field": "x", "text-font": ["Noto Sans Regular"] } },
                { id: "building", type: "fill", source: "platzhalter", paint: { "fill-color": "#eee" } },
              ],
            },
          }),
  );
  // Der Browser darf Overpass nie direkt fragen (CORS, Last) – das macht Convex.
  const isOverpass = (url) => /(^|\.)(overpass-api\.de|overpass\.kumi\.systems|overpass\.private\.coffee|maps\.mail\.ru)$/.test(url.hostname);
  await ctx.route(isOverpass, (r) => {
    browserCalledOverpass = true;
    return r.abort();
  });
}

const shot = (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const errors = [];
const track = (p) => {
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
};

try {
  // Startseite → Aktion anlegen
  const a = await browser.newContext(phone);
  await mockOsm(a);
  const p = await a.newPage();
  track(p);
  await p.goto(BASE);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth), 390, "Startseite ohne waagerechtes Scrollen");
  await shot(p, "1-home");
  await p.fill("#place", "Roisdorf");
  await p.getByRole("button", { name: "Suchen" }).click();
  await p.getByText("Roisdorf, Bornheim").click();
  await p.getByRole("button", { name: /Verteilaktion starten/ }).click();
  await p.getByRole("dialog").waitFor();
  await p.waitForTimeout(500);
  // Beim Anlegen lädt Convex die Häuser des Ortes vor; der Dialog zeigt den Fortschritt
  await p.getByText("Häuser des Gebiets sind vorgeladen ✓").waitFor({ timeout: 30_000 });
  const callsAfterPrefetch = overpassCalls;
  assert.ok(callsAfterPrefetch > 0, "Vorladen hat Overpass gefragt");
  await shot(p, "2-share");
  // Der Anleger landet auf dem Admin-Link; weitergegeben wird der Bearbeiten-Link.
  const adminUrl = p.url();
  assert.match(adminUrl, /\/admin\/[A-Za-z0-9]{22}$/, "Admin-Link ohne ?neu");
  const url = await p.getByLabel("Link zum Mitmachen").inputValue();
  assert.match(url, /\/v\/[A-Za-z0-9]{22}$/, "Bearbeiten-Link zum Weitergeben");
  assert.equal(await p.getByLabel("Admin-Link").inputValue(), adminUrl);
  await p.getByText("Diesen Link für dich behalten").waitFor();
  assert.ok(!adminUrl.includes(url.split("/v/")[1]), "Admin- und Bearbeiten-Schlüssel verschieden");

  // Ortsteile festlegen
  await p.getByRole("button", { name: /Ortsteile festlegen/ }).click();
  const sheet = p.getByTestId("areas-sheet");
  await sheet.getByLabel("Hersel").waitFor({ timeout: 30_000 });
  assert.deepEqual(await sheet.getByRole("checkbox").evaluateAll((els) => els.map((e) => e.checked)), [true, true], "neue Aktion: alle gewählt");
  await shot(p, "2a-gebiete");
  await sheet.getByRole("button", { name: "Fertig" }).click();
  await p.waitForTimeout(2500);

  // Kartenseite scrollt nicht
  const scroll = await p.evaluate(() => [document.documentElement.scrollHeight, innerHeight, document.documentElement.scrollWidth]);
  assert.deepEqual(scroll, [844, 844, 390], "Kartenseite ohne Scrollen");

  // Zweiter Helfer öffnet denselben Link
  const b = await browser.newContext(phone);
  await mockOsm(b);
  const p2 = await b.newPage();
  track(p2);
  await p2.goto(url);
  await p2.waitForTimeout(2500);
  // Bearbeiten-Link: keine Gebietsauswahl
  assert.equal(await p2.getByRole("button", { name: "Gebiete" }).count(), 0, "Gebiete nur im Admin-Link");

  const box = await p.getByTestId("map").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const count = (page) => page.getByTestId("count").textContent();
  const blocked = async (page) => ((await page.getByTestId("blocked-count").count()) ? page.getByTestId("blocked-count").textContent() : "0");
  const zoom = (page) => page.evaluate(() => window.__einwurfMap.getZoom());
  /** Zustand des Hauses an diesem Bildschirmpunkt laut Einfärbung (feature-state): none, done, blocked. */
  const statusAt = (page, x, y) =>
    page.evaluate(([x, y]) => {
      const map = window.__einwurfMap;
      const r = map.getCanvasContainer().getBoundingClientRect();
      const [f] = map.queryRenderedFeatures([x - r.left, y - r.top], { layers: ["buildings-fill"] });
      return f ? (map.getFeatureState({ source: "buildings", id: f.properties.osmId }).status ?? "none") : null;
    }, [x, y]);
  const next = { none: "done", done: "blocked", blocked: "none" };
  /** Wartet bis zu 15 s, bis das Haus den erwarteten Zustand hat (Häuser laden asynchron). */
  const expectStatus = async (page, x, y, want, msg) => {
    const until = Date.now() + 15_000;
    let got = await statusAt(page, x, y);
    while (got !== want && Date.now() < until) {
      await page.waitForTimeout(250);
      got = await statusAt(page, x, y);
    }
    assert.equal(got, want, msg);
  };

  // Zwei schnelle Tipps auf verschiedene Häuser: beide markiert
  await p.mouse.click(cx, cy);
  await p.mouse.click(cx + 60, cy + 40);
  await p.waitForTimeout(1200);
  assert.equal(await count(p), "2");
  assert.equal(await count(p2), "2", "live beim zweiten Helfer");
  assert.equal(await statusAt(p2, cx, cy), "done", "beim zweiten Helfer gelb");
  await shot(p2, "3-live");

  // Gebiete: Grenzen und Namen sichtbar; Hersel abwählen → beim Helfer live nur noch Roisdorf
  // Ein Haus in Hersel, gleich östlich der Grenze (Raster siehe fakeBuildings)
  const herselAt = (page) =>
    page.evaluate(([lng, lat]) => {
      const m = window.__einwurfMap;
      const r = m.getCanvasContainer().getBoundingClientRect();
      const q = m.project([lng, lat]);
      return [q.x + r.left, q.y + r.top];
    }, [CENTER.lng + 8 * GX, CENTER.lat]);
  const labels = (page) => page.evaluate(() => window.__einwurfMap.queryRenderedFeatures({ layers: ["area-labels"] }).map((f) => f.properties.name).sort());
  const [hx, hy] = await herselAt(p2);
  await expectStatus(p2, hx, hy, "none", "Haus in Hersel geladen");
  // Markierung und Notiz in Hersel: nach dem Abwählen nicht mehr zu sehen, danach wieder
  const noteAt = (page, x, y) =>
    page.evaluate(([x, y]) => {
      const map = window.__einwurfMap;
      const r = map.getCanvasContainer().getBoundingClientRect();
      const [f] = map.queryRenderedFeatures([x - r.left, y - r.top], { layers: ["buildings-fill"] });
      return f ? Boolean(map.getFeatureState({ source: "buildings", id: f.properties.osmId }).note) : null;
    }, [x, y]);
  /** Rausgezoomt gezeigte Punkte (Markierungen, Notizen) östlich der Grenze, also in Hersel. */
  const pointsInHersel = (page) =>
    page.evaluate(
      (split) =>
        window.__einwurfMap
          .queryRenderedFeatures({ layers: ["mark-points", "note-points"] })
          .filter((f) => f.geometry.coordinates[0] > split).length,
      AREA_SPLIT,
    );
  await p2.mouse.click(hx, hy);
  await expectStatus(p2, hx, hy, "done", "Haus in Hersel markiert");
  await p2.mouse.click(hx, hy, { button: "right" });
  const hd = p2.getByRole("dialog");
  await hd.waitFor();
  await hd.getByLabel("Text der Notiz").fill("Hersel: Hund im Garten");
  await hd.getByRole("button", { name: "Speichern" }).click();
  await hd.waitFor({ state: "hidden" });
  assert.equal(await noteAt(p2, hx, hy), true, "Notiz in Hersel blau");
  await p.getByRole("button", { name: "Gebiete" }).click();
  await sheet.getByLabel("Hersel").uncheck();
  await p2.waitForTimeout(1500);
  assert.equal(await statusAt(p2, hx, hy), null, "Haus in abgewähltem Gebiet nicht mehr da");
  assert.equal(await statusAt(p2, cx, cy), "done", "Haus in gewähltem Gebiet bleibt");
  assert.equal(await p2.evaluate(() => window.__einwurfMap.querySourceFeatures("area-mask").length > 0), true, "Rest abgedunkelt");
  await p2.evaluate(() => window.__einwurfMap.jumpTo({ zoom: 14 }));
  await p2.waitForTimeout(800);
  assert.deepEqual(await labels(p2), ["Roisdorf"], "Helfer sieht nur gewählte Gebiete");
  assert.equal(await pointsInHersel(p2), 0, "Markierung und Notiz im abgewählten Gebiet nicht zu sehen");
  await p.evaluate(() => window.__einwurfMap.jumpTo({ zoom: 14 }));
  await p.waitForTimeout(800);
  assert.deepEqual(await labels(p), ["Hersel", "Roisdorf"], "Admin sieht alle Gebiete");
  await shot(p2, "3-gebiete-helfer");
  await sheet.getByRole("button", { name: "Keine" }).click();
  await sheet.getByRole("button", { name: "Fertig" }).click();
  await p.evaluate(() => window.__einwurfMap.jumpTo({ zoom: 16 }));
  await p2.evaluate(() => window.__einwurfMap.jumpTo({ zoom: 16 }));
  await p2.waitForTimeout(1500);
  // Nichts gewählt: wieder der ganze Ort
  await expectStatus(p2, hx, hy, "done", "Haus in Hersel wieder da, mit seiner Markierung");
  assert.equal(await noteAt(p2, hx, hy), true, "Notiz wieder zu sehen");
  assert.equal(await p2.evaluate(() => window.__einwurfMap.querySourceFeatures("area-mask").length), 0);
  // Aufräumen, damit die Zähler der folgenden Schritte stimmen: wieder offen, Notiz weg
  for (const want of ["blocked", "none"]) {
    await p2.mouse.click(hx, hy);
    await expectStatus(p2, hx, hy, want, `Haus in Hersel: ${want}`);
    await p2.waitForTimeout(400);
  }
  await p2.mouse.click(hx, hy, { button: "right" });
  await hd.waitFor();
  await hd.getByRole("button", { name: "Notiz löschen" }).click();
  await hd.waitFor({ state: "hidden" });
  await p2.waitForTimeout(800);
  assert.equal(await noteAt(p2, hx, hy), false);

  // Häuser der Grundkarte bleiben als hellgraue Platzhalter sichtbar
  assert.deepEqual(
    await p2.evaluate(() => [window.__einwurfMap.getPaintProperty("building", "fill-color"), window.__einwurfMap.getLayoutProperty("building", "visibility") ?? "visible"]),
    ["#cfcdc6", "visible"],
  );

  // Hausnummern ab Zoomstufe 17 auf den Häusern
  const zStart = await zoom(p2);
  await p2.evaluate(() => window.__einwurfMap.jumpTo({ zoom: 17.5 }));
  await p2.waitForTimeout(2500);
  const numbers = await p2.evaluate(() => window.__einwurfMap.queryRenderedFeatures({ layers: ["buildings-number"] }).map((f) => f.properties.hn));
  assert.ok(numbers.length > 3, "Hausnummern sichtbar");
  assert.ok(numbers.some((n) => n.includes(",")), "Adresspunkt und Gebäudenummer zusammen");
  await shot(p2, "3a-hausnummern");
  await p2.evaluate((z) => window.__einwurfMap.jumpTo({ zoom: z }), zStart);
  await p2.waitForTimeout(1500);

  // Wer später dazukommt, sieht die Häuser gelb (Markierung vor oder nach den Umrissen geladen)
  const c3 = await browser.newContext(phone);
  await mockOsm(c3);
  const p3 = await c3.newPage();
  track(p3);
  await p3.goto(url);
  await p3.waitForTimeout(2500);
  await expectStatus(p3, cx, cy, "done", "nach Neuladen gelb");
  await expectStatus(p3, cx - 120, cy - 120, "none", "Nachbarhaus bleibt grau");
  // Rausgezoomt: Markierungen als gelbe Punkte, Hinweis zum Heranzoomen
  await p3.evaluate(() => window.__einwurfMap.jumpTo({ zoom: 13.5 }));
  await p3.waitForTimeout(1500);
  const dots = await p3.evaluate(() => window.__einwurfMap.queryRenderedFeatures({ layers: ["mark-points"] }).length);
  assert.ok(dots >= 1, "Punkte rausgezoomt");
  await p3.getByText("Heranzoomen, um Häuser zu sehen").waitFor();
  // Rausgezoomt gibt es keine Notiz, nur einen Hinweis
  await p3.mouse.click(cx, cy, { button: "right" });
  await p3.getByText("Für eine Notiz näher heranzoomen.").waitFor({ timeout: 5000 });
  assert.equal(await p3.getByRole("dialog").count(), 0);
  await shot(p3, "3b-zoomed-out");

  // Der zweite Helfer tippt ein gelbes Haus nochmal an: „nicht möglich“ (dunkelgelb), bei allen
  assert.equal(await blocked(p), "0", "ohne „nicht möglich“ keine zweite Zahl");
  await p2.mouse.click(cx, cy);
  await p2.waitForTimeout(1200);
  assert.equal(await count(p), "1");
  assert.equal(await blocked(p), "1");
  assert.equal(await statusAt(p, cx, cy), "blocked", "dunkelgelb beim ersten Helfer");
  await shot(p, "3c-blocked");
  // …und ein drittes Mal: wieder offen
  await p2.mouse.click(cx, cy);
  await p2.waitForTimeout(1200);
  assert.equal(await statusAt(p, cx, cy), "none");
  assert.equal(await blocked(p), "0");
  await p2.mouse.click(cx, cy); // wieder gelb für die weiteren Schritte
  await p2.waitForTimeout(1200);
  assert.equal(await count(p), "2");

  // Notiz: Rechtsklick auf ein Haus öffnet den Dialog, kein Kontextmenü, der Zustand bleibt
  const nx = cx + 120, ny = cy - 120;
  const notePainted = (page, x, y) =>
    page.evaluate(([x, y]) => {
      const map = window.__einwurfMap;
      const r = map.getCanvasContainer().getBoundingClientRect();
      const [f] = map.queryRenderedFeatures([x - r.left, y - r.top], { layers: ["buildings-fill"] });
      return f ? Boolean(map.getFeatureState({ source: "buildings", id: f.properties.osmId }).note) : null;
    }, [x, y]);
  const noteStatus = await statusAt(p, nx, ny);
  await p.evaluate(() => {
    window.__menuShown = 0;
    window.addEventListener("contextmenu", (e) => !e.defaultPrevented && window.__menuShown++);
  });
  await p.mouse.click(nx, ny, { button: "right" });
  const dialog = p.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(await p.evaluate(() => window.__menuShown), 0, "kein Kontextmenü des Browsers");
  await dialog.getByLabel("Text der Notiz").fill("Briefkasten 3 und 4 haben nichts bekommen");
  await shot(p, "4a-notiz");
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await notePainted(p, nx, ny), true, "Haus mit Notiz blau");
  await p.waitForTimeout(1200);
  assert.equal(await statusAt(p, nx, ny), noteStatus, "Rechtsklick schaltet nicht weiter");
  assert.equal(await notePainted(p2, nx, ny), true, "zweites Gerät sieht die Notiz ohne Neuladen");
  await shot(p2, "4b-notiz-live");

  // Langes Drücken beim zweiten Helfer: Notiz steht drin, ändern; der Zustand bleibt
  await p2.mouse.move(nx, ny);
  await p2.mouse.down();
  await p2.waitForTimeout(800);
  const d2 = p2.getByRole("dialog");
  await d2.waitFor();
  await p2.mouse.up();
  await p2.waitForTimeout(400);
  assert.ok(await d2.isVisible(), "Loslassen schließt den Dialog nicht");
  assert.equal(await d2.getByLabel("Text der Notiz").inputValue(), "Briefkasten 3 und 4 haben nichts bekommen");
  await d2.getByLabel("Text der Notiz").fill("Kiste war leer");
  await d2.getByRole("button", { name: "Speichern" }).click();
  await p2.waitForTimeout(1200);
  assert.equal(await statusAt(p2, nx, ny), noteStatus, "langes Drücken schaltet nicht weiter");
  // Ein normaler Tipp schaltet auch ein Haus mit Notiz weiter
  await p.mouse.click(nx, ny);
  await p.waitForTimeout(1200);
  assert.equal(await statusAt(p2, nx, ny), next[noteStatus], "Tipp auf Haus mit Notiz schaltet weiter");
  assert.equal(await notePainted(p2, nx, ny), true, "Notiz bleibt beim Weiterschalten");
  const dot = await p2.evaluate(() => window.__einwurfMap.queryRenderedFeatures({ layers: ["note-points-near"] }).length);
  assert.equal(dot, next[noteStatus] === "none" ? 0 : 1, "blauer Punkt auf markiertem Haus");
  await shot(p2, "4c-notiz-markiert");

  // Gedrückt halten und dabei schieben: kein Dialog, kein Zustandswechsel
  const zPan = await zoom(p);
  const sPan = await statusAt(p, cx - 120, cy + 120);
  await p.mouse.move(cx - 120, cy + 120);
  await p.mouse.down();
  await p.mouse.move(cx - 60, cy + 120, { steps: 5 });
  await p.waitForTimeout(800);
  await p.mouse.up();
  await p.waitForTimeout(800);
  assert.equal(await p.getByRole("dialog").count(), 0, "Schieben öffnet keine Notiz");
  await p.evaluate(() => window.__einwurfMap.panBy([60, 0], { duration: 0 }));
  await p.waitForTimeout(400);
  assert.equal(await statusAt(p, cx - 120, cy + 120), sPan, "Schieben schaltet nicht weiter");
  assert.equal(await zoom(p), zPan);

  // Löschen beim ersten Helfer: Haus nicht mehr blau, auch beim zweiten
  await p.mouse.click(nx, ny, { button: "right" });
  await dialog.waitFor();
  assert.equal(await dialog.getByLabel("Text der Notiz").inputValue(), "Kiste war leer", "Änderung live angekommen");
  await dialog.getByRole("button", { name: "Notiz löschen" }).click();
  await p.waitForTimeout(1200);
  assert.equal(await notePainted(p, nx, ny), false);
  assert.equal(await notePainted(p2, nx, ny), false, "gelöscht auch beim zweiten Helfer");
  // Zustand wie vorher, damit die Zähler der folgenden Schritte stimmen
  for (let i = 0; i < 2; i++) {
    await p.mouse.click(nx, ny);
    await p.waitForTimeout(1200);
  }
  assert.equal(await statusAt(p, nx, ny), noteStatus);
  assert.equal(await count(p), "2");


  // Zwei Tipps mit 350 ms Pause sind zwei einzelne Tipps (offen → gelb → dunkelgelb), kein Zoom
  const z0 = await zoom(p);
  await p.mouse.click(cx - 120, cy - 120);
  await p.waitForTimeout(350);
  await p.mouse.click(cx - 120, cy - 120);
  await p.waitForTimeout(1200);
  assert.equal(await statusAt(p, cx - 120, cy - 120), "blocked", "langsamer Doppeltipp: zwei Schritte weiter");
  assert.equal(await count(p), "2");
  assert.equal(await blocked(p), "1");
  assert.equal(await zoom(p), z0, "langsamer Doppeltipp zoomt nicht");

  // Doppeltipp zoomt genau eine Stufe und schaltet nichts weiter
  await p.mouse.dblclick(cx - 120, cy - 120);
  await p.waitForTimeout(1200);
  assert.equal(await count(p), "2", "Doppeltipp darf nicht markieren");
  assert.equal(await blocked(p), "1", "Doppeltipp darf nicht markieren");
  assert.ok(Math.abs((await zoom(p)) - (z0 + 1)) < 0.01, "Doppeltipp zoomt eine Stufe");
  await shot(p, "4-after-dblclick");

  // Doppeltipp und ziehen: mit einem Finger zoomen (nach unten = hinein), nichts markieren
  const z1 = await zoom(p);
  await p.mouse.click(cx + 120, cy + 120);
  await p.mouse.move(cx + 120, cy + 120);
  await p.mouse.down();
  await p.mouse.move(cx + 120, cy + 270, { steps: 8 });
  await p.mouse.up();
  await p.waitForTimeout(800);
  assert.equal(await count(p), "2", "Doppeltipp-und-ziehen darf nicht markieren");
  assert.equal(await blocked(p), "1", "Doppeltipp-und-ziehen darf nicht markieren");
  assert.ok(Math.abs((await zoom(p)) - (z1 + 1)) < 0.05, "150 px ziehen = eine Zoomstufe");

  // Rückt die Karte in der Wartezeit weiter (Standortverfolgung), zählt das angetippte Haus
  const before = await statusAt(p, cx, cy);
  await p.mouse.click(cx, cy);
  await p.evaluate(() => window.__einwurfMap.panBy([200, 0], { duration: 0 }));
  await p.waitForTimeout(800);
  await p.evaluate(() => window.__einwurfMap.panBy([-200, 0], { duration: 0 }));
  await p.waitForTimeout(500);
  assert.equal(await statusAt(p, cx, cy), next[before], "das angetippte Haus wurde weitergeschaltet");

  // Funkloch: Die Verbindung zu Convex reißt ab → Hinweis, dass später gespeichert wird
  const off = await browser.newContext(phone);
  await mockOsm(off);
  let online = true;
  const sockets = [];
  await off.routeWebSocket(/\/api\/.*sync/, (ws) => {
    if (!online) return ws.close();
    ws.connectToServer();
    sockets.push(ws);
  });
  const po = await off.newPage();
  await po.goto(url);
  await po.waitForTimeout(2500);
  online = false;
  for (const ws of sockets) ws.close();
  await po.getByText("Offline.").waitFor({ timeout: 15_000 });
  // Weg- und zurückschieben: Die Häuser sind noch da, ihr Markierungsstand muss neu geladen
  // werden und kommt offline nicht. Ein Tipp färbt trotzdem sofort und wird nachgeholt.
  await po.evaluate(() => window.__einwurfMap.panBy([4000, 0], { duration: 0 }));
  await po.waitForTimeout(800);
  await po.evaluate(() => window.__einwurfMap.panBy([-4000, 0], { duration: 0 }));
  await po.waitForTimeout(800);
  const tx = cx + 120, ty = cy + 120;
  assert.equal(await statusAt(po, tx, ty), "none");
  await po.mouse.click(tx, ty);
  await po.waitForTimeout(400);
  assert.equal(await statusAt(po, tx, ty), "done", "sofort gelb, obwohl der Stand noch lädt");
  const sparkPixels = await po.evaluate(() => {
    const c = document.querySelector("canvas[aria-hidden]");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  assert.ok(sparkPixels > 20, "Pixel-Funken zu sehen");
  await shot(po, "5-offline");
  assert.equal(await statusAt(p2, tx, ty), "none", "noch nicht gespeichert");
  online = true;
  await po.getByText("Offline.").waitFor({ state: "hidden", timeout: 30_000 });
  await po.waitForTimeout(1500);
  assert.equal(await statusAt(p2, tx, ty), "done", "nach dem Funkloch gespeichert, live beim anderen Helfer");
  await off.close();

  // Tipp auf ein Haus, das noch lädt (hellgrauer Platzhalter): färbt sich sofort, schaltet weiter wie jedes Haus
  overpassDelayMs = 5000;
  const ph = await browser.newContext(phone);
  await mockOsm(ph);
  const pp = await ph.newPage();
  track(pp);
  await pp.goto(url);
  await pp.waitForTimeout(2500);
  await pp.evaluate((c) => window.__einwurfMap.jumpTo({ center: [c.lng, c.lat] }), FAR);
  await pp.waitForTimeout(1200);
  assert.equal(await statusAt(pp, cx, cy), null, "Haus noch nicht geladen");
  const tapShape = () =>
    pp.evaluate(([x, y]) => {
      const m = window.__einwurfMap;
      const r = m.getCanvasContainer().getBoundingClientRect();
      return m.queryRenderedFeatures([x - r.left, y - r.top], { layers: ["tap-shapes"] })[0]?.properties.to ?? null;
    }, [cx, cy]);
  await pp.mouse.click(cx, cy);
  await pp.waitForTimeout(500);
  assert.equal(await tapShape(), "done", "graues Haus sofort gelb");
  await shot(pp, "5b-platzhalter-tipp");
  // Zweiter Tipp mit Pause: dunkelgelb, dritter: wieder offen, vierter: gelb
  for (const want of ["blocked", null, "done"]) {
    await pp.mouse.click(cx, cy);
    await pp.waitForTimeout(500);
    assert.equal(await tapShape(), want, `Platzhalter weitergeschaltet: ${want}`);
  }
  await pp.waitForFunction(() => window.__einwurfMap.queryRenderedFeatures({ layers: ["buildings-fill"] }).length > 0, null, { timeout: 20_000 });
  await expectStatus(pp, cx, cy, "done", "nach dem Laden gelb");
  assert.equal(await tapShape(), null, "vorläufige Farbe weg");
  // Gebäude nur in der Grundkarte: Hinweis, nichts gespeichert
  const gap = await pp.evaluate((c) => {
    const m = window.__einwurfMap;
    const r = m.getCanvasContainer().getBoundingClientRect();
    const q = m.project([c.lng + 3 * 0.0004, c.lat + 3 * 0.0003]);
    return [q.x + r.left, q.y + r.top];
  }, FAR);
  // Notiz an einem hellgrauen Platzhalter: Hinweis statt Dialog
  await pp.mouse.click(gap[0], gap[1], { button: "right" });
  await pp.getByText("Dieses Haus lädt noch.", { exact: false }).waitFor({ timeout: 5000 });
  assert.equal(await pp.getByRole("dialog").count(), 0, "kein Notiz-Dialog auf Platzhalter");
  await pp.mouse.click(gap[0], gap[1]);
  await pp.getByText("An dieser Stelle gibt es kein Haus zum Markieren.").waitFor({ timeout: 5000 });
  overpassDelayMs = 0;
  await ph.close();

  // „Bewegung reduzieren“ im System: Farbe wechselt, aber keine Funken
  const calm = await browser.newContext({ ...phone, reducedMotion: "reduce" });
  await mockOsm(calm);
  const pc = await calm.newPage();
  await pc.goto(url);
  await pc.waitForTimeout(2500);
  const before2 = await statusAt(pc, cx - 120, cy + 120);
  await pc.mouse.click(cx - 120, cy + 120);
  await pc.waitForTimeout(400);
  assert.equal(await statusAt(pc, cx - 120, cy + 120), next[before2], "Farbe wechselt auch ohne Bewegung");
  const calmPixels = await pc.evaluate(() => {
    const c = document.querySelector("canvas[aria-hidden]");
    if (!c.width) return 0;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  assert.equal(calmPixels, 0, "keine Funken bei „Bewegung reduzieren“");
  await calm.close();

  // Ansehen-Link: Teilen-Dialog zeigt ihn getrennt, mit ihm ändert ein Tipp nichts
  const editKey = url.split("/v/")[1];
  await p.goto(url);
  await p.waitForTimeout(2500);
  await p.getByRole("button", { name: "Link teilen" }).click();
  await p.getByRole("button", { name: /Nur ansehen/ }).click();
  const viewUrl = await p.getByLabel("Link zum Ansehen").inputValue();
  assert.match(viewUrl, /\/a\/[A-Za-z0-9]{22}$/, "eigener Ansehen-Link");
  assert.ok(!viewUrl.includes(editKey), "Ansehen-Link enthält den Bearbeiten-Schlüssel nicht");
  await shot(p, "8-share-ansehen");
  await p.getByRole("button", { name: "Schließen" }).last().click();
  // Eine Notiz für die Ansicht (Rechtsklick beim Bearbeiten)
  const vnx = cx - 120, vny = cy - 120;
  await p.mouse.click(vnx, vny, { button: "right" });
  await p.getByRole("dialog").getByLabel("Text der Notiz").fill("Nur zum Lesen");
  await p.getByRole("dialog").getByRole("button", { name: "Speichern" }).click();
  await p.getByRole("dialog").waitFor({ state: "hidden" });

  const vc = await browser.newContext({ ...phone, geolocation: { latitude: CENTER.lat + 0.001, longitude: CENTER.lng + 0.001 }, permissions: ["geolocation"] });
  await mockOsm(vc);
  const pv = await vc.newPage();
  track(pv);
  // Mitschneiden, was Convex an den Ansehen-Link schickt: Der Bearbeiten-Schlüssel darf nie dabei sein.
  const received = [];
  pv.on("websocket", (ws) => ws.on("framereceived", (f) => received.push(String(f.payload))));
  await pv.goto(viewUrl);
  await pv.getByTestId("view-only").waitFor();
  await pv.waitForTimeout(2500);
  assert.equal(await pv.getByTestId("mode-switch").count(), 0, "kein Umschalter beim Ansehen-Link");
  assert.equal(await count(pv), await count(p), "Stand wie beim Bearbeiten-Link");
  const vBefore = await statusAt(pv, cx, cy);
  assert.ok(vBefore, "Haus sichtbar");
  await pv.mouse.click(cx, cy);
  await pv.waitForTimeout(1200);
  assert.equal(await statusAt(pv, cx, cy), vBefore, "Ansehen-Link: Tipp ändert nichts");
  assert.equal(await pv.getByRole("dialog").count(), 0, "Tipp auf Haus ohne Notiz öffnet nichts");
  // Notizen: blau, Tipp oder Rechtsklick zeigt sie nur zum Lesen
  const vNoteStatus = await statusAt(pv, vnx, vny);
  assert.equal(await notePainted(pv, vnx, vny), true, "Notiz beim Ansehen blau");
  for (const button of ["left", "right"]) {
    await pv.mouse.click(vnx, vny, { button });
    const nd = pv.getByRole("dialog");
    await nd.waitFor({ timeout: 3000 });
    assert.equal(await nd.getByTestId("note-text").textContent(), "Nur zum Lesen");
    assert.equal(await nd.getByLabel("Text der Notiz").count(), 0, "kein Textfeld beim Ansehen");
    assert.equal(await nd.getByRole("button", { name: "Notiz löschen" }).count(), 0, "kein Löschen beim Ansehen");
    if (button === "right") await shot(pv, "9a-notiz-lesen");
    await nd.getByRole("button", { name: "Schließen" }).click();
    await nd.waitFor({ state: "hidden" });
  }
  assert.equal(await statusAt(pv, vnx, vny), vNoteStatus, "Tipp auf Notiz-Haus schaltet beim Ansehen nicht weiter");
  assert.equal(await count(pv), await count(p));
  // Live: Ein Helfer markiert, die Ansicht folgt
  const pBefore = await statusAt(p, cx, cy);
  await p.mouse.click(cx, cy);
  await p.waitForTimeout(1200);
  assert.equal(await count(pv), await count(p), "Ansicht zählt live mit");
  // Doppeltipp-Zoom geht auch beim Ansehen
  const zv = await zoom(pv);
  await pv.mouse.dblclick(cx, cy);
  await pv.waitForTimeout(1200);
  assert.ok(Math.abs((await zoom(pv)) - (zv + 1)) < 0.01, "Doppeltipp zoomt beim Ansehen");
  await shot(pv, "9-ansehen-link");
  // Schieben und Standort gehen auch beim Ansehen
  const centerOf = (page) => page.evaluate(() => window.__einwurfMap.getCenter().toArray());
  const c0 = await centerOf(pv);
  await pv.mouse.move(cx, cy + 100);
  await pv.mouse.down();
  await pv.mouse.move(cx + 120, cy + 100, { steps: 6 });
  await pv.mouse.up();
  await pv.waitForTimeout(600);
  assert.notDeepEqual(await centerOf(pv), c0, "Schieben beim Ansehen");
  await pv.locator(".maplibregl-ctrl-geolocate").click();
  await pv.waitForFunction(
    (c) => {
      const m = window.__einwurfMap.getCenter();
      return Math.abs(m.lat - c.lat) < 0.0002 && Math.abs(m.lng - c.lng) < 0.0002;
    },
    { lat: CENTER.lat + 0.001, lng: CENTER.lng + 0.001 },
    { timeout: 10_000 },
  );
  assert.ok(received.length > 0, "Convex-Antworten mitgeschnitten");
  assert.ok(!received.some((f) => f.includes(editKey)), "Bearbeiten-Schlüssel kommt beim Ansehen-Link nie an");
  assert.ok(!(await pv.content()).includes(editKey), "Bearbeiten-Schlüssel nicht in der Seite");
  await vc.close();

  // Ansehen-Modus mit dem Bearbeiten-Link: Tipp ändert nichts, Hinweis; bleibt nach Neuladen
  await p.getByTestId("mode-switch").getByRole("button", { name: "Ansehen" }).click();
  const mBefore = await statusAt(p, cx, cy);
  assert.equal(mBefore, next[pBefore]);
  await p.mouse.click(cx, cy);
  await p.getByText("Ansehen-Modus – zum Markieren auf Bearbeiten wechseln").waitFor({ timeout: 3000 });
  await p.waitForTimeout(800);
  assert.equal(await statusAt(p, cx, cy), mBefore, "Ansehen-Modus: Tipp ändert nichts");
  await shot(p, "10-ansehen-modus");
  // Notiz im Ansehen-Modus: nur lesen, mit Hinweis; Fokus im Dialog
  await p.mouse.click(vnx, vny, { button: "right" });
  const md = p.getByRole("dialog");
  await md.waitFor({ timeout: 3000 });
  assert.equal(await md.getByLabel("Text der Notiz").count(), 0, "Ansehen-Modus: kein Textfeld");
  assert.equal(await md.getByRole("button", { name: "Notiz löschen" }).count(), 0, "Ansehen-Modus: kein Löschen");
  await md.getByText("Ansehen-Modus – zum Ändern auf Bearbeiten wechseln.").waitFor();
  assert.equal(await p.evaluate(() => !!document.activeElement?.closest("[role=dialog]")), true, "Fokus im Dialog");
  await md.getByRole("button", { name: "Schließen" }).click();
  await md.waitFor({ state: "hidden" });
  // Rechtsklick auf ein Haus ohne Notiz: Hinweis statt Dialog
  await p.mouse.click(cx + 120, cy + 120, { button: "right" });
  await p.getByText("Ansehen-Modus – für Notizen auf Bearbeiten wechseln").waitFor({ timeout: 3000 });
  assert.equal(await p.getByRole("dialog").count(), 0);
  await p.reload();
  await p.getByTestId("view-only").waitFor();
  assert.equal(
    await p.getByTestId("mode-switch").getByRole("button", { name: "Ansehen" }).getAttribute("aria-pressed"),
    "true",
    "Modus bleibt nach Neuladen",
  );
  await p.waitForTimeout(2500);
  const zm = await zoom(p);
  await p.mouse.dblclick(cx, cy);
  await p.waitForTimeout(1200);
  assert.ok(Math.abs((await zoom(p)) - (zm + 1)) < 0.01, "Doppeltipp zoomt im Ansehen-Modus");
  await p.getByTestId("mode-switch").getByRole("button", { name: "Bearbeiten" }).click();
  const eBefore = await statusAt(p, cx, cy);
  await p.mouse.click(cx, cy);
  await p.waitForTimeout(1200);
  assert.equal(await statusAt(p, cx, cy), next[eBefore], "zurück auf Bearbeiten: Tipp markiert wieder");

  // Unbekannter Link
  await p.goto(`${BASE}/v/AAAAAAAAAAAAAAAAAAAAAA`);
  await p.getByText("Diese Verteilaktion gibt es nicht").waitFor();

  // Grundkarte lädt nicht
  const broken = await browser.newContext(phone);
  await mockOsm(broken, { styleFails: true });
  const pb = await broken.newPage();
  await pb.goto(url);
  await pb.getByText("Die Karte konnte nicht geladen werden").waitFor({ timeout: 10_000 });

  // Desktop
  const d = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await mockOsm(d.context());
  track(d);
  await d.goto(BASE);
  await shot(d, "6-home-desktop");
  await d.goto(url);
  await d.waitForTimeout(2500);
  await shot(d, "7-map-desktop");

  assert.deepEqual(errors, [], "keine Fehler in der Konsole");
  assert.equal(browserCalledOverpass, false, "Browser fragt Overpass nicht direkt");
  assert.ok(overpassCalls > 0, "Convex hat Overpass gefragt");
  console.log("OK");
} finally {
  overpass.close();
  await browser.close();
}
