// Browser-Test der Statistik gegen ein Vercel-Preview (eigenes Convex-Preview-Backend, echte
// Overpass-Daten über Convex). Nachgebildet werden nur Ortssuche und Grundkarte im Browser.
// Ablauf: Aktion in Bornheim anlegen, nur einen kleinen Ortsteil wählen, warten bis seine Häuser
// gezählt sind, dann tippt der Admin ein Haus gelb → dunkelgelb → offen, und ein zweites Gerät
// mit dem Ansehen-Link sieht die Zahlen live.
// Aufruf: node e2e/preview-stats.mjs <preview-url> [ortsteil] [ordner-für-screenshots]
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const GLYPHS = readFileSync(new URL("./fixtures/noto-sans-bold-0-255.pbf", import.meta.url));
const BASE = process.argv[2];
const AREA = process.argv[3] ?? "Widdig";
const SHOTS = process.argv[4];
if (!BASE) throw new Error("Aufruf: node e2e/preview-stats.mjs <preview-url> [ortsteil] [ordner]");

async function mockBrowserOsm(ctx) {
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
  // Für das zweite Gerät den Ansehen-Link (#3): Statistik dort nur lesen.
  await p.getByRole("dialog").getByRole("button", { name: /Nur ansehen/ }).click();
  const url = await p.getByLabel("Link zum Ansehen").inputValue();
  if (!/\/a\/[A-Za-z0-9]{22}$/.test(url)) throw new Error(`kein Ansehen-Link: ${url}`);
  log("Aktion angelegt", p.url());

  // Nur einen kleinen Ortsteil wählen (echte Grenzen aus OSM).
  await p.getByRole("button", { name: /Ortsteile festlegen/ }).click();
  const areas = p.getByTestId("areas-sheet");
  // Gebiete kommen von Overpass über Convex (zwei Abfragen, bis zu drei Versuche); Fehler gleich melden.
  await Promise.race([
    areas.getByLabel(AREA).waitFor({ timeout: 480_000 }),
    areas.getByText("konnten nicht geladen werden").waitFor({ timeout: 480_000 }).then(() => {
      throw new Error("Ortsteile konnten nicht geladen werden (Overpass vom Convex-Backend aus)");
    }),
  ]);
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
  // Hineinzoomen bis die Häuser antippbar sind (die Karte selbst ist im Preview-Build nicht erreichbar).
  const mapBox = await p.getByTestId("map").boundingBox();
  const cx = mapBox.x + mapBox.width / 2;
  const cy = mapBox.y + mapBox.height / 2;
  await p.mouse.move(cx, cy);
  for (let i = 0; i < 8; i++) {
    await p.mouse.wheel(0, -300);
    await p.waitForTimeout(250);
  }
  await p.getByText("Haus antippen, wenn der Flyer drin ist.").waitFor({ timeout: 180_000 });

  // Zweites Gerät mit dem Ansehen-Link öffnet die Statistik.
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

  // Ein Haus beim Admin finden: Punkte um die Bildmitte antippen, bis der Zähler oben steigt.
  const adminCount = async () => Number(await p.getByTestId("count").textContent());
  const start = await adminCount();
  const target = await (async () => {
    for (let r = 0; r <= 6; r++)
      for (let dx = -r; dx <= r; dx++)
        for (const dy of r === 0 ? [0] : Math.abs(dx) === r ? [...Array(2 * r + 1).keys()].map((k) => k - r) : [-r, r]) {
          const pt = [cx + dx * 30, cy + dy * 30];
          await p.mouse.click(...pt);
          await p.waitForTimeout(1200);
          if ((await adminCount()) > start) return pt;
        }
    throw new Error("Kein Haus nahe der Bildmitte gefunden");
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
