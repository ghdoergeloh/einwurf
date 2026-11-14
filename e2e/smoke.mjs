// Browser-Test der ganzen App gegen ein laufendes `pnpm dev` + `npx convex dev` (lokal).
// OSM-Dienste werden nachgebildet, Convex ist echt:
//  - Ortssuche und Grundkarte im Browser (Playwright-Routen),
//  - Overpass als kleiner HTTP-Server auf Port 8787, den die Convex-Action fragt.
//    Einmalig: npx convex env set OVERPASS_URLS http://127.0.0.1:8787/api/interpreter
// Aufruf: node e2e/smoke.mjs [basis-url] [ordner-für-screenshots]
import { chromium } from "playwright";
import assert from "node:assert/strict";
import http from "node:http";

const BASE = process.argv[2] ?? "http://localhost:5173";
const SHOTS = process.argv[3];
// Jeder Lauf in einem eigenen Gebiet, damit der gemeinsame Gebäude-Cache den Overpass-Weg nicht überdeckt.
const CENTER = { lat: 50.76, lng: Math.round((6 + (Date.now() % 997) * 0.01) * 1000) / 1000 };

function fakeBuildings(body) {
  const q = new URLSearchParams(body).get("data");
  const [s, w, n, e] = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/).slice(1).map(Number);
  const elements = [];
  for (let i = -80; i <= 80; i++)
    for (let j = -80; j <= 80; j++) {
      const x = CENTER.lng + i * 0.0004;
      const y = CENTER.lat + j * 0.0003;
      if (x < w || x > e || y < s || y > n) continue;
      const dx = 0.00013, dy = 0.0001;
      const ring = [[x - dx, y - dy], [x + dx, y - dy], [x + dx, y + dy], [x - dx, y + dy], [x - dx, y - dy]];
      elements.push({ type: "way", id: 100000 + (i + 80) * 1000 + (j + 80), geometry: ring.map(([lon, lat]) => ({ lat, lon })) });
    }
  return { elements };
}

let overpassCalls = 0;
const overpass = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    overpassCalls++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(fakeBuildings(body)));
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
    styleFails ? r.fulfill({ status: 500, body: "kaputt" }) : r.fulfill({ json: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#ebe8e1" } }] } }),
  );
  // Der Browser darf Overpass nie direkt fragen (CORS, Last) – das macht Convex.
  const isOverpass = (url) => /(^|\.)(overpass-api\.de|overpass\.private\.coffee|maps\.mail\.ru)$/.test(url.hostname);
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
  const url = p.url();
  assert.match(url, /\/v\/[A-Za-z0-9]{22}$/, "geheimer Link ohne ?neu");
  await p.getByRole("button", { name: "Zur Karte" }).click();
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

  // Zwei schnelle Tipps auf verschiedene Häuser: beide markiert
  await p.mouse.click(cx, cy);
  await p.mouse.click(cx + 60, cy + 40);
  await p.waitForTimeout(1200);
  assert.equal(await count(p), "2");
  assert.equal(await count(p2), "2", "live beim zweiten Helfer");
  assert.equal(await statusAt(p2, cx, cy), "done", "beim zweiten Helfer gelb");
  await shot(p2, "3-live");

  // Wer später dazukommt, sieht die Häuser gelb (Markierung vor oder nach den Umrissen geladen)
  const c3 = await browser.newContext(phone);
  await mockOsm(c3);
  const p3 = await c3.newPage();
  track(p3);
  await p3.goto(url);
  await p3.waitForTimeout(2500);
  assert.equal(await statusAt(p3, cx, cy), "done", "nach Neuladen gelb");
  assert.equal(await statusAt(p3, cx - 120, cy - 120), "none", "Nachbarhaus bleibt grau");
  // Rausgezoomt: Markierungen als gelbe Punkte, Hinweis zum Heranzoomen
  await p3.evaluate(() => window.__einwurfMap.jumpTo({ zoom: 13.5 }));
  await p3.waitForTimeout(1500);
  const dots = await p3.evaluate(() => window.__einwurfMap.queryRenderedFeatures({ layers: ["mark-points"] }).length);
  assert.ok(dots >= 1, "Punkte rausgezoomt");
  await p3.getByText("Heranzoomen, um Häuser zu sehen").waitFor();
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
  await shot(po, "5-offline");
  online = true;
  await po.getByText("Offline.").waitFor({ state: "hidden", timeout: 30_000 });
  await off.close();

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
