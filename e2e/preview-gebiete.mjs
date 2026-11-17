// Browser-Test der Gebiete gegen ein Preview-Deployment (Vercel + Convex-Preview-Backend), mit
// echten Daten: Convex fragt Overpass in der Cloud. Legt eine Aktion an einer Adresse in
// Bornheim an, prüft den vorgewählten Ortsteil und wählt auf der Karte einen Ortsteil der
// Nachbargemeinde Alfter dazu. Ortssuche und Kartenkacheln kommen echt.
// Aufruf: node e2e/preview-gebiete.mjs <preview-url> [ordner-für-screenshots]
// (Den Header gegen die Vercel-Anmeldung setzt in der Sandbox der Proxy.)
import { chromium } from "playwright";
import assert from "node:assert/strict";

const [BASE, SHOTS] = process.argv.slice(2);
if (!BASE) throw new Error("Aufruf: node e2e/preview-gebiete.mjs <preview-url> [screenshots]");
const ADDRESS = "Rathausstraße 2, Bornheim";
/** Ein Punkt in Alfter (Nachbargemeinde im Süden). */
const IN_ALFTER = { lat: 50.7356, lng: 7.0086 };

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const errors = [];
const shot = (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const track = (p, who) => p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));

/** Bildschirmpunkt eines Orts bei bekannter Kartenmitte und Zoomstufe (Web-Mercator, 512-px-Kacheln wie MapLibre). */
function project(center, zoom, point, box) {
  const world = 512 * 2 ** zoom;
  const x = (lng) => ((lng + 180) / 360) * world;
  const y = (lat) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * world;
  return [box.x + box.width / 2 + x(point.lng) - x(center.lng), box.y + box.height / 2 + y(point.lat) - y(center.lat)];
}

try {
  const ctx = await browser.newContext(phone);
  const p = await ctx.newPage();
  track(p, "Admin");
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
  const editUrl = await p.getByLabel("Link zum Mitmachen").inputValue();
  assert.match(editUrl, /\/v\/[A-Za-z0-9]{22}$/);
  await p.getByText("Diesen Link für dich behalten").waitFor();
  await p.getByRole("button", { name: /Ortsteile festlegen/ }).click();
  const bar = p.getByTestId("area-edit-bar");
  await bar.waitFor();

  // Angebot und Vorauswahl: Bis Overpass geantwortet hat, kann es dauern (öffentliche Server).
  const started = Date.now();
  const status = async () => (await bar.innerText()).replace(/\s+/g, " ");
  for (;;) {
    const s = await status();
    if (/Erneut versuchen/.test(s)) throw new Error(`Ortsteile nicht geladen: ${s}`);
    if (!/werden aus OpenStreetMap geladen/.test(s) && /\d+ gewählt/.test(s)) break;
    if (Date.now() - started > 900_000) throw new Error(`Zeitüberschreitung: ${s}`);
    await p.waitForTimeout(5000);
  }
  console.log(`Geladen nach ${Math.round((Date.now() - started) / 1000)} s:`, await status());
  assert.match(await status(), /1 gewählt/, "Ortsteil an der Adresse vorgewählt");
  await p.waitForTimeout(1500);
  await shot(p, "1-bearbeiten");

  // Ortsteil in Alfter antippen: kommt dazu (Angebot über die Gemeindegrenze hinweg)
  assert.ok(center, "Mittelpunkt aus der Ortssuche");
  const box = await p.getByTestId("map").boundingBox();
  const [ax, ay] = project(center, 12, IN_ALFTER, box);
  assert.ok(ay > 260 && ay < box.height - 80, `Punkt in Alfter liegt sichtbar auf der Karte (${Math.round(ax)}, ${Math.round(ay)})`);
  await p.mouse.click(ax, ay);
  await bar.getByText("2 gewählt").waitFor({ timeout: 20_000 });
  await p.waitForTimeout(1500);
  await shot(p, "2-alfter-dazu");
  await bar.getByRole("button", { name: "Fertig" }).click();

  // Helfer: keine Gebietsauswahl, Karte mit den gewählten Gebieten
  const h = await (await browser.newContext(phone)).newPage();
  track(h, "Helfer");
  await h.goto(editUrl);
  await h.waitForTimeout(4000);
  assert.equal(await h.getByRole("button", { name: "Gebiete bearbeiten" }).count(), 0, "keine Gebietsauswahl im Bearbeiten-Link");
  await shot(h, "3-helfer");

  assert.deepEqual(errors, [], "keine Fehler auf der Seite");
  console.log("OK");
} finally {
  await browser.close();
}
