// Browser-Test der Statistik gegen ein Vercel-Preview (eigenes Convex-Preview-Backend, echte
// Overpass-Daten über Convex). Nachgebildet werden nur Ortssuche und Grundkarte im Browser.
// Ablauf: Aktion in Bornheim anlegen, nur einen kleinen Ortsteil wählen, warten bis seine Häuser
// gezählt sind, dann tippt der Admin ein Haus gelb → dunkelgelb → offen, und ein zweites Gerät
// sieht die Zahlen live.
// Aufruf: node e2e/preview-stats.mjs <preview-url> [ortsteil] [ordner-für-screenshots]
// Ist das Preview geschützt (Vercel Deployment Protection): VERCEL_BYPASS_FILE=<datei mit dem
// „Protection Bypass for Automation“-Geheimnis> oder VERCEL_BYPASS=<geheimnis> setzen.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BYPASS = process.env.VERCEL_BYPASS_FILE ? readFileSync(process.env.VERCEL_BYPASS_FILE, "utf8").trim() : process.env.VERCEL_BYPASS;
const bypassHeaders = BYPASS ? { "x-vercel-protection-bypass": BYPASS, "x-vercel-set-bypass-cookie": "true" } : {};

const GLYPHS = readFileSync(new URL("./fixtures/noto-sans-bold-0-255.pbf", import.meta.url));
const BASE = process.argv[2];
const AREA = process.argv[3] ?? "Widdig";
const SHOTS = process.argv[4];
if (!BASE) throw new Error("Aufruf: node e2e/preview-stats.mjs <preview-url> [ortsteil] [ordner]");

async function mockBrowserOsm(ctx) {
  // Bypass-Geheimnis nur an das Preview selbst schicken, nie an Convex oder andere Dienste.
  if (BYPASS) {
    const host = new URL(BASE).host;
    await ctx.route((u) => u.host === host, (r) => r.continue({ headers: { ...r.request().headers(), ...bypassHeaders } }));
  }
  // Ortssuche: Bornheim (Rheinland), echte Koordinaten.
  await ctx.route("https://nominatim.openstreetmap.org/**", (r) =>
    r.fulfill({
      json: [
        { display_name: "Bornheim, Rhein-Sieg-Kreis, Nordrhein-Westfalen, Deutschland", name: "Bornheim", lat: "50.7596", lon: "6.9917", boundingbox: ["50.7076", "50.8035", "6.8873", "7.0596"] },
      ],
    }),
  );
  await ctx.route("https://tiles.openfreemap.org/**", (r) =>
    r.request().url().includes("/fonts/")
      ? r.fulfill({ body: GLYPHS, contentType: "application/x-protobuf" })
      : r.fulfill({
          json: {
            version: 8,
            glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
            sources: { leer: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
            layers: [
              { id: "bg", type: "background", paint: { "background-color": "#ebe8e1" } },
              { id: "ortsnamen", type: "symbol", source: "leer", layout: { "text-field": "x", "text-font": ["Noto Sans Regular"] } },
            ],
          },
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
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

try {
  const a = await browser.newContext(phone);
  await mockBrowserOsm(a);
  const p = await a.newPage();
  track(p);
  await p.goto(BASE);
  await p.fill("#place", "Bornheim");
  await p.getByRole("button", { name: "Suchen" }).click();
  await p.getByText("Bornheim, Rhein-Sieg-Kreis").click();
  await p.getByRole("button", { name: /Verteilaktion starten/ }).click();
  await p.getByRole("dialog").waitFor();
  const url = await p.getByLabel("Link zur Verteilaktion").inputValue();
  log("Aktion angelegt", p.url());

  // Nur einen kleinen Ortsteil wählen (echte Grenzen aus OSM).
  await p.getByRole("button", { name: /Ortsteile festlegen/ }).click();
  const areas = p.getByTestId("areas-sheet");
  await areas.getByLabel(AREA).waitFor({ timeout: 180_000 });
  log("Ortsteile:", (await areas.getByRole("checkbox").count()));
  await areas.getByRole("button", { name: "Keine" }).click();
  await areas.getByLabel(AREA).check();
  await areas.getByRole("button", { name: "Fertig" }).click();

  // Statistik beim Admin: der Ortsteil als einziges Ziel, Häuser werden gezählt.
  await p.getByTestId("open-stats").click();
  const stats = p.getByTestId("stats-sheet");
  const sum = stats.getByTestId("stats-sum");
  await sum.getByText(AREA, { exact: true }).waitFor({ timeout: 30_000 });
  // Vorladen der Kacheln des Ortsteils (gebremst) abwarten; danach nicht mehr vorläufig.
  await sum.getByText(/^\d+ Häuser$/).waitFor({ timeout: 600_000 });
  await sum.getByText("vorläufig").waitFor({ state: "detached", timeout: 600_000 });
  const houses = Number((await sum.getByText(/^\d+ Häuser$/).textContent()).match(/\d+/)[0]);
  log("Häuser in", AREA, houses);
  assert.ok(houses > 50, "Häuser gezählt");
  await shot(p, "statistik-admin");

  // „Zeigen“ gibt es nur bei mehreren Zielgebieten; mit einem Ziel zum Ortsteil über das Gebiete-Panel.
  await stats.getByRole("button", { name: "Fertig" }).click();
  await p.getByRole("button", { name: "Gebiete" }).click();
  await areas.getByRole("button", { name: `${AREA} auf der Karte zeigen` }).click();
  await p.evaluate(() => window.__einwurfMap.jumpTo({ zoom: 17.5 }));

  // Zweites Gerät mit dem Link zum Mitmachen öffnet die Statistik.
  const b = await browser.newContext(phone);
  await mockBrowserOsm(b);
  const p2 = await b.newPage();
  track(p2);
  await p2.goto(url);
  await p2.getByTestId("open-stats").click();
  const sum2 = p2.getByTestId("stats-sheet").getByTestId("stats-sum");
  await sum2.getByText(`${houses} Häuser`).waitFor({ timeout: 30_000 });
  const counts = async () => {
    const t = await sum2.textContent();
    return { done: Number(t.match(/(\d+) Flyer drin/)[1]), blocked: Number(t.match(/(\d+) nicht möglich/)[1]) };
  };
  const before = await counts();

  // Ein offenes Haus nahe der Bildmitte beim Admin antippen.
  const target = await (async () => {
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const pt = await p.evaluate(() => {
        const m = window.__einwurfMap;
        const r = m.getCanvasContainer().getBoundingClientRect();
        const c = [r.width / 2, r.height / 2];
        const fs = m.queryRenderedFeatures([[c[0] - 120, c[1] - 160], [c[0] + 120, c[1] + 160]], { layers: ["buildings-fill"] });
        for (const f of fs) {
          if ((m.getFeatureState({ source: "buildings", id: f.properties.osmId }).status ?? "none") !== "none") continue;
          const ring = f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
          const lng = ring.reduce((s, q) => s + q[0], 0) / ring.length;
          const lat = ring.reduce((s, q) => s + q[1], 0) / ring.length;
          const q = m.project([lng, lat]);
          const hit = m.queryRenderedFeatures([q.x, q.y], { layers: ["buildings-fill"] })[0];
          if (hit?.properties.osmId === f.properties.osmId) return [q.x + r.left, q.y + r.top];
        }
        return null;
      });
      if (pt) return pt;
      await p.waitForTimeout(1000);
    }
    throw new Error("Kein offenes Haus gefunden");
  })();
  const waitCounts = async (want, msg) => {
    const until = Date.now() + 15_000;
    let got = await counts();
    while ((got.done !== want.done || got.blocked !== want.blocked) && Date.now() < until) {
      await p2.waitForTimeout(250);
      got = await counts();
    }
    assert.deepEqual(got, want, msg);
  };
  await p.mouse.click(...target);
  await waitCounts({ done: before.done + 1, blocked: before.blocked }, "gelb live beim zweiten Gerät");
  await p.waitForTimeout(700);
  await p.mouse.click(...target);
  await waitCounts({ done: before.done, blocked: before.blocked + 1 }, "dunkelgelb live");
  await shot(p2, "statistik-helfer");
  await p.waitForTimeout(700);
  await p.mouse.click(...target);
  await waitCounts(before, "wieder offen");
  log("Statistik live: gelb → dunkelgelb → offen ✓");

  const relevant = errors.filter((e) => !/Failed to load resource/.test(e));
  assert.deepEqual(relevant, [], "keine Fehler in der Konsole");
  log("OK");
} finally {
  await browser.close();
}
