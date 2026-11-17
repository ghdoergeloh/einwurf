// Browser-Test gegen eine Vercel-Preview (mit eigenem Convex-Preview-Backend in der Cloud).
// Anders als e2e/smoke.mjs kommen die Häuser echt von Overpass (über Convex in der Cloud);
// nachgebildet wird nur, was der Browser selbst abruft (Ortssuche).
// Schwerpunkt: Ansehen-Link und Ansehen-Modus (#3), Notizen beim Ansehen (#1).
// Aufruf: node e2e/preview.mjs <preview-url> [ordner-für-screenshots]
import { chromium } from "playwright";
import { ConvexHttpClient } from "convex/browser";
import assert from "node:assert/strict";

const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
const SHOTS = process.argv[3];
if (!BASE) throw new Error("Aufruf: node e2e/preview.mjs <preview-url> [screenshots]");

// Ein kleiner, dicht bebauter Ausschnitt in Bornheim (Rheinland).
const PLACE = { lat: 50.7606, lng: 6.9924 };

async function mockNominatim(ctx) {
  await ctx.route("https://nominatim.openstreetmap.org/**", (r) =>
    r.fulfill({
      json: [
        {
          display_name: "Bornheim, Rhein-Sieg-Kreis, Nordrhein-Westfalen, Deutschland",
          name: "Bornheim",
          lat: String(PLACE.lat),
          lon: String(PLACE.lng),
          boundingbox: [String(PLACE.lat - 0.002), String(PLACE.lat + 0.002), String(PLACE.lng - 0.003), String(PLACE.lng + 0.003)],
        },
      ],
    }),
  );
}

const shot = (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const errors = [];
const track = (p) => {
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
};

const count = (page) => page.getByTestId("count").textContent();
const zoom = (page) => page.evaluate(() => window.__einwurfMap.getZoom());
const centerOfMap = (page) => page.evaluate(() => window.__einwurfMap.getCenter().toArray());
/** Zustand des Hauses mit dieser OSM-ID laut Einfärbung: none, done, blocked (oder null, falls nicht geladen). */
const statusOf = (page, osmId) =>
  page.evaluate((id) => {
    const map = window.__einwurfMap;
    if (!map.getSource("buildings")) return null;
    return map.getFeatureState({ source: "buildings", id }).status ?? "none";
  }, osmId);
const noteOf = (page, osmId) =>
  page.evaluate((id) => Boolean(window.__einwurfMap.getFeatureState({ source: "buildings", id }).note), osmId);
/** Bildschirmpunkt (Seitenkoordinaten) eines Hauses, an dem genau dieses Haus liegt; null, wenn nicht sichtbar. */
const pointOf = (page, osmId) =>
  page.evaluate((id) => {
    const map = window.__einwurfMap;
    const r = map.getCanvasContainer().getBoundingClientRect();
    for (const f of map.queryRenderedFeatures({ layers: ["buildings-fill"] })) {
      if (f.properties.osmId !== id) continue;
      const ring = f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
      const [lng, lat] = ring.reduce(([a, b], [x, y]) => [a + x / ring.length, b + y / ring.length], [0, 0]);
      const p = map.project([lng, lat]);
      const [hit] = map.queryRenderedFeatures(p, { layers: ["buildings-fill"] });
      if (hit?.properties.osmId === id) return [p.x + r.left, p.y + r.top];
    }
    return null;
  }, osmId);
/** Wartet, bis Häuser da sind, und wählt zwei gut antippbare Häuser nahe der Mitte. */
async function pickHouses(page) {
  await page.waitForFunction(
    () => window.__einwurfMap?.getLayer("buildings-fill") && window.__einwurfMap.queryRenderedFeatures({ layers: ["buildings-fill"] }).length > 10,
    null,
    { timeout: 120_000 },
  );
  return page.evaluate(() => {
    const map = window.__einwurfMap;
    const { width, height } = map.getCanvas().getBoundingClientRect();
    const seen = new Set();
    const out = [];
    for (const f of map.queryRenderedFeatures({ layers: ["buildings-fill"] })) {
      const id = f.properties.osmId;
      if (seen.has(id)) continue;
      seen.add(id);
      const ring = f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
      const [lng, lat] = ring.reduce(([a, b], [x, y]) => [a + x / ring.length, b + y / ring.length], [0, 0]);
      const p = map.project([lng, lat]);
      // Mittleres Feld, weg von Kopfleiste, Umschalter, Hinweis und Knöpfen.
      if (p.x < width * 0.2 || p.x > width * 0.8 || p.y < height * 0.3 || p.y > height * 0.65) continue;
      const [hit] = map.queryRenderedFeatures(p, { layers: ["buildings-fill"] });
      if (hit?.properties.osmId === id) out.push({ id, d: Math.hypot(p.x - width / 2, p.y - height / 2) });
    }
    out.sort((a, b) => a.d - b.d);
    // Zwei Häuser mit etwas Abstand, damit kein Tipp das falsche trifft.
    return [out[0]?.id, out.find((o) => o.d > (out[0]?.d ?? 0) + 60)?.id];
  });
}
const tapHouse = async (page, osmId, opts) => {
  const pt = await pointOf(page, osmId);
  assert.ok(pt, `Haus ${osmId} sichtbar`);
  await page.mouse.click(pt[0], pt[1], opts);
};
const waitStatus = async (page, osmId, want, msg) => {
  const until = Date.now() + 15_000;
  let got = await statusOf(page, osmId);
  while (got !== want && Date.now() < until) {
    await page.waitForTimeout(250);
    got = await statusOf(page, osmId);
  }
  assert.equal(got, want, msg);
};

try {
  // Aktion anlegen
  const a = await browser.newContext(phone);
  await mockNominatim(a);
  const p = await a.newPage();
  track(p);
  await p.goto(BASE);
  // Die Karte ist nur in Previews für Tests erreichbar (VITE_VERCEL_ENV=preview, siehe BuildingMap.tsx).
  await p.fill("#place", "Bornheim");
  await p.getByRole("button", { name: "Suchen" }).click();
  await p.getByRole("button", { name: /Verteilaktion starten/ }).click();
  const share = p.getByRole("dialog");
  await share.waitFor();
  const editUrl = p.url();
  assert.match(editUrl, /\/v\/[A-Za-z0-9]{22}$/);
  const editKey = editUrl.split("/v/")[1];

  // Teilen-Dialog: beide Links getrennt, Ansehen-Link ohne Bearbeiten-Schlüssel
  assert.equal(await share.getByRole("button", { name: /Zum Mitmachen/ }).getAttribute("aria-pressed"), "true");
  await share.getByRole("button", { name: /Nur ansehen/ }).click();
  const viewUrl = await share.getByLabel("Link zum Ansehen").inputValue();
  assert.match(viewUrl, /\/a\/[A-Za-z0-9]{22}$/, "eigener Ansehen-Link");
  assert.ok(!viewUrl.includes(editKey));
  const viewKey = viewUrl.split("/a/")[1];
  await shot(p, "p1-share-ansehen");
  await share.getByRole("button", { name: "Zur Karte" }).click();
  await p.getByTestId("map").waitFor();
  await p.waitForFunction(() => window.__einwurfMap, null, { timeout: 15_000 }).catch(() => {
    throw new Error("window.__einwurfMap fehlt: Preview ohne VITE_VERCEL_ENV=preview gebaut?");
  });

  const [h1, h2] = await pickHouses(p);
  assert.ok(h1 && h2, "zwei Häuser gefunden");
  // h1 gelb markieren, h2 bekommt eine Notiz
  await tapHouse(p, h1);
  await waitStatus(p, h1, "done", "Tipp markiert");
  await tapHouse(p, h2, { button: "right" });
  await p.getByRole("dialog").getByLabel("Text der Notiz").fill("Kasten 2 leer");
  await p.getByRole("dialog").getByRole("button", { name: "Speichern" }).click();
  await p.getByRole("dialog").waitFor({ state: "hidden" });
  const h2Status = await statusOf(p, h2);

  // Ansehen-Link in einem zweiten Browser
  const lat = PLACE.lat + 0.0005, lng = PLACE.lng + 0.0005;
  const vc = await browser.newContext({ ...phone, geolocation: { latitude: lat, longitude: lng }, permissions: ["geolocation"] });
  await mockNominatim(vc);
  const pv = await vc.newPage();
  track(pv);
  const received = [];
  let convexUrl = null;
  pv.on("websocket", (ws) => {
    const m = ws.url().match(/^wss:\/\/([^/]+\.convex\.cloud)\//);
    if (m) convexUrl = `https://${m[1]}`;
    ws.on("framereceived", (f) => received.push(String(f.payload)));
  });
  await pv.goto(viewUrl);
  await pv.getByTestId("view-only").waitFor();
  assert.equal(await pv.getByTestId("mode-switch").count(), 0, "kein Umschalter beim Ansehen-Link");
  await pickHouses(pv);
  await waitStatus(pv, h1, "done", "Markierung beim Ansehen sichtbar");
  assert.equal(await count(pv), await count(p));
  // Tipp ändert nichts
  await tapHouse(pv, h1);
  await pv.waitForTimeout(1500);
  assert.equal(await statusOf(pv, h1), "done", "Ansehen-Link: Tipp ändert nichts");
  assert.equal(await statusOf(p, h1), "done", "auch nicht beim Helfer");
  assert.equal(await pv.getByRole("dialog").count(), 0);
  // Notiz: blau, nur lesen
  assert.equal(await noteOf(pv, h2), true, "Notiz beim Ansehen blau");
  for (const button of ["left", "right"]) {
    await tapHouse(pv, h2, { button });
    const nd = pv.getByRole("dialog");
    await nd.waitFor({ timeout: 3000 });
    assert.equal(await nd.getByTestId("note-text").textContent(), "Kasten 2 leer");
    assert.equal(await nd.getByLabel("Text der Notiz").count(), 0, "kein Textfeld beim Ansehen");
    if (button === "right") await shot(pv, "p2-notiz-lesen");
    await nd.getByRole("button", { name: "Schließen" }).click();
    await nd.waitFor({ state: "hidden" });
  }
  assert.equal(await statusOf(pv, h2), h2Status, "Notiz-Haus nicht weitergeschaltet");
  // Live: Helfer schaltet h1 weiter, die Ansicht folgt
  await tapHouse(p, h1);
  await waitStatus(pv, h1, "blocked", "Ansicht live");
  await shot(pv, "p3-ansehen-link");
  // Doppeltipp, Schieben, Standort
  const z = await zoom(pv);
  const pt = await pointOf(pv, h1);
  await pv.mouse.dblclick(pt[0], pt[1]);
  await pv.waitForTimeout(1200);
  assert.ok(Math.abs((await zoom(pv)) - (z + 1)) < 0.01, "Doppeltipp zoomt beim Ansehen");
  assert.equal(await statusOf(pv, h1), "blocked", "Doppeltipp ändert nichts");
  const c0 = await centerOfMap(pv);
  await pv.mouse.move(200, 500);
  await pv.mouse.down();
  await pv.mouse.move(320, 500, { steps: 6 });
  await pv.mouse.up();
  await pv.waitForTimeout(600);
  assert.notDeepEqual(await centerOfMap(pv), c0, "Schieben beim Ansehen");
  await pv.locator(".maplibregl-ctrl-geolocate").click();
  await pv.waitForFunction(
    ([lat, lng]) => {
      const m = window.__einwurfMap.getCenter();
      return Math.abs(m.lat - lat) < 0.0002 && Math.abs(m.lng - lng) < 0.0002;
    },
    [lat, lng],
    { timeout: 10_000 },
  );
  // Der Bearbeiten-Schlüssel kommt beim Ansehen-Link nie an
  assert.ok(received.length > 0);
  assert.ok(!received.some((f) => f.includes(editKey)), "Bearbeiten-Schlüssel nicht im Convex-Verkehr");
  assert.ok(!(await pv.content()).includes(editKey), "Bearbeiten-Schlüssel nicht in der Seite");
  await vc.close();

  // Direkt an Convex mit dem Ansehen-Schlüssel: lesen ja, ändern nein
  assert.ok(convexUrl, "Convex-Adresse der Preview gefunden");
  const client = new ConvexHttpClient(convexUrl);
  const viewed = await client.query("campaigns:get", { slug: viewKey });
  assert.equal(viewed.role, "view");
  assert.ok(!JSON.stringify(viewed).includes(editKey));
  await assert.rejects(client.mutation("marks:set", { slug: viewKey, osmId: h1, status: "none", center: [PLACE.lng, PLACE.lat] }), /nichts ändern/);
  await assert.rejects(client.mutation("notes:remove", { slug: viewKey, osmId: h2 }), /nichts ändern/);
  await assert.rejects(client.mutation("buildings:prefetch", { slug: viewKey }), /nichts ändern/);
  assert.equal(await statusOf(p, h1), "blocked", "direkter Aufruf hat nichts geändert");
  assert.equal(await noteOf(p, h2), true);

  // Ansehen-Modus mit dem Bearbeiten-Link
  await p.getByTestId("mode-switch").getByRole("button", { name: "Ansehen" }).click();
  await tapHouse(p, h1);
  await p.getByText("Ansehen-Modus – zum Markieren auf Bearbeiten wechseln").waitFor({ timeout: 3000 });
  await p.waitForTimeout(800);
  assert.equal(await statusOf(p, h1), "blocked", "Ansehen-Modus: Tipp ändert nichts");
  await shot(p, "p4-ansehen-modus");
  await p.reload();
  await p.getByTestId("view-only").waitFor();
  assert.equal(await p.getByTestId("mode-switch").getByRole("button", { name: "Ansehen" }).getAttribute("aria-pressed"), "true", "Modus bleibt nach Neuladen");
  await pickHouses(p);
  await waitStatus(p, h1, "blocked");
  await tapHouse(p, h2);
  await p.getByRole("dialog").waitFor({ timeout: 3000 });
  assert.equal(await p.getByRole("dialog").getByLabel("Text der Notiz").count(), 0, "Ansehen-Modus: Notiz nur lesen");
  await p.getByRole("dialog").getByText("Ansehen-Modus – zum Ändern auf Bearbeiten wechseln.").waitFor();
  assert.equal(await p.evaluate(() => !!document.activeElement?.closest("[role=dialog]")), true, "Fokus im Dialog");
  await p.getByRole("dialog").getByRole("button", { name: "Schließen" }).click();
  await p.getByTestId("mode-switch").getByRole("button", { name: "Bearbeiten" }).click();
  await tapHouse(p, h1);
  await waitStatus(p, h1, "none", "zurück auf Bearbeiten: Tipp markiert wieder");

  assert.deepEqual(errors, [], "keine Fehler in der Konsole");
  console.log("OK");
} finally {
  await browser.close();
}
