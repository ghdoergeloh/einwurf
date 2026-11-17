// Browser-Test der Statistik gegen ein Vercel-Preview (eigenes Convex-Preview-Backend, echte
// Daten: Ortssuche, Karte, Ortsteile und Häuser aus OSM).
// Ablauf: Aktion an einer Adresse anlegen (der Ortsteil dort ist vorgewählt), warten bis seine
// Häuser gezählt sind, dann tippt der Admin ein Haus gelb → dunkelgelb → offen, und ein zweites
// Gerät mit dem Ansehen-Link sieht die Zahlen live.
// Aufruf: node e2e/preview-stats.mjs <preview-url> [adresse] [ordner-für-screenshots]
// Standard ist Widdig, ein kleiner Ortsteil von Bornheim (Vorladen dauert dann nur wenige Minuten).
// (Den Header gegen die Vercel-Anmeldung setzt in der Sandbox der Proxy.)
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.argv[2];
const ADDRESS = process.argv[3] ?? "Widdig, Bornheim";
const SHOTS = process.argv[4];
if (!BASE) throw new Error("Aufruf: node e2e/preview-stats.mjs <preview-url> [adresse] [ordner]");

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
  const p = await a.newPage();
  track(p);
  // Ergebnis der Ortssuche mitlesen (Mittelpunkt der Karte)
  let center = null;
  p.on("response", async (r) => {
    if (r.url().startsWith("https://nominatim.openstreetmap.org/")) {
      const [first] = await r.json().catch(() => []);
      if (first) center = { lat: Number(first.lat), lng: Number(first.lon) };
    }
  });
  await p.goto(BASE);
  await p.fill("#place", ADDRESS);
  await p.getByRole("button", { name: "Suchen" }).click();
  await p.locator("fieldset label").first().click();
  await p.getByRole("button", { name: /Verteilaktion starten/ }).click();
  await p.waitForURL(/\/admin\/[A-Za-z0-9]{22}$/);
  // Für das zweite Gerät den Ansehen-Link (#3): Statistik dort nur lesen.
  await p.getByRole("dialog").getByRole("button", { name: /Nur ansehen/ }).click();
  const url = await p.getByLabel("Link zum Ansehen").inputValue();
  if (!/\/a\/[A-Za-z0-9]{22}$/.test(url)) throw new Error(`kein Ansehen-Link: ${url}`);
  log("Aktion angelegt", p.url());

  // Ortsteile: der an der Adresse ist vorgewählt, sobald Overpass geantwortet hat.
  await p.getByRole("button", { name: /Ortsteile festlegen/ }).click();
  const bar = p.getByTestId("area-edit-bar");
  await bar.waitFor();
  const started = Date.now();
  let retries = 0;
  const status = async () => (await bar.innerText()).replace(/\s+/g, " ");
  for (;;) {
    const s = await status();
    if (/Erneut versuchen/.test(s)) {
      if (++retries > 4) throw new Error(`Ortsteile nicht geladen: ${s}`);
      log(`Fehlschlag ${retries}, erneut:`, s);
      await p.waitForTimeout(30_000);
      await bar.getByRole("button", { name: "Erneut versuchen" }).click();
    }
    if (!/werden aus OpenStreetMap geladen/.test(s) && /\d+ gewählt/.test(s)) break;
    if (Date.now() - started > 2_400_000) throw new Error(`Zeitüberschreitung: ${s}`);
    await p.waitForTimeout(5000);
  }
  log(`Ortsteile nach ${Math.round((Date.now() - started) / 1000)} s:`, await status());
  assert.match(await status(), /1 gewählt/, "Ortsteil an der Adresse vorgewählt");
  await bar.getByRole("button", { name: "Fertig" }).click();

  // Statistik beim Admin: der Ortsteil als einziges Ziel, Häuser werden gezählt.
  await p.getByTestId("open-stats").click();
  const stats = p.getByTestId("stats-sheet");
  const sum = stats.getByTestId("stats-sum");
  await sum.getByText(/^\d+ Häuser$/).waitFor({ timeout: 900_000 });
  const AREA = (await sum.locator("h3").textContent()).trim();
  // Vorladen der Kacheln des Ortsteils (gebremst) abwarten; danach nicht mehr vorläufig.
  await sum.getByText("vorläufig").waitFor({ state: "detached", timeout: 900_000 });
  const houses = Number((await sum.getByText(/^\d+ Häuser$/).textContent()).match(/\d+/)[0]);
  log("Häuser in", AREA, houses);
  assert.ok(houses > 50, "Häuser gezählt");
  await shot(p, "statistik-admin");
  await stats.getByRole("button", { name: "Fertig" }).click();

  // Zur Adresse hineinzoomen, bis die Häuser antippbar sind.
  assert.ok(center, "Mittelpunkt aus der Ortssuche");
  await p.evaluate((c) => window.__einwurfMap.jumpTo({ center: [c.lng, c.lat], zoom: 17.5 }), center);
  await p.getByText("Haus antippen, wenn der Flyer drin ist.").waitFor({ timeout: 180_000 });
  const mapBox = await p.getByTestId("map").boundingBox();
  const cx = mapBox.x + mapBox.width / 2;
  const cy = mapBox.y + mapBox.height / 2;

  // Zweites Gerät mit dem Ansehen-Link öffnet die Statistik.
  const b = await browser.newContext(phone);
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

  // Overpass-Server ohne CORS-Freigabe: Der Browser des Admins (#2) versucht dann den nächsten, das ist kein Fehler der App.
  const relevant = errors.filter((e) => !/Failed to load resource/.test(e) && !/Access to fetch at 'https:\/\/[^']*\/(api\/)?interpreter'.*CORS policy/.test(e));
  assert.deepEqual(relevant, [], "keine Fehler in der Konsole");
  log("OK");
} finally {
  await browser.close();
}
