// Browser-Test der Gebiete gegen ein Preview-Deployment (Vercel + Convex-Preview-Backend), mit
// echten Daten: Convex fragt Overpass in der Cloud. Prüft Bornheim (Rheinland) und eine Großstadt
// mit anderer Gliederung. Nominatim und Kartenkacheln kommen echt, außer mit --mock-osm.
// Aufruf: node e2e/preview-gebiete.mjs <preview-url> [ordner-für-screenshots] [--mock-osm]
import { chromium } from "playwright";
import assert from "node:assert/strict";

const args = process.argv.slice(2);
const MOCK = args.includes("--mock-osm");
const [BASE, SHOTS] = args.filter((a) => !a.startsWith("--"));
if (!BASE) throw new Error("Aufruf: node e2e/preview-gebiete.mjs <preview-url> [screenshots] [--mock-osm]");

// Ergebnisse der Ortssuche, falls Nominatim nachgebildet wird (Ausdehnung wie bei Nominatim).
const PLACES = {
  Bornheim: { display_name: "Bornheim, Rhein-Sieg-Kreis, Nordrhein-Westfalen, Deutschland", name: "Bornheim", lat: "50.7592", lon: "6.9985", boundingbox: ["50.7090", "50.8080", "6.8925", "7.0640"] },
  Bonn: { display_name: "Bonn, Nordrhein-Westfalen, Deutschland", name: "Bonn", lat: "50.7354", lon: "7.1007", boundingbox: ["50.6326", "50.7744", "7.0225", "7.2111"] },
};
const MIN_STYLE = { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#ebe8e1" } }] };

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const errors = [];
const shot = (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

async function context() {
  const ctx = await browser.newContext(phone);
  if (MOCK) {
    await ctx.route("https://nominatim.openstreetmap.org/**", (r) => {
      const q = new URL(r.request().url()).searchParams.get("q") ?? "";
      const hit = Object.entries(PLACES).find(([k]) => q.includes(k));
      return r.fulfill({ json: hit ? [hit[1]] : [] });
    });
    await ctx.route("https://tiles.openfreemap.org/**", (r) => r.fulfill({ json: MIN_STYLE }));
  }
  return ctx;
}

/** Legt eine Aktion für den Ort an und liefert Admin-Seite, Bearbeiten-Link und Namen der Gebiete. */
async function createAndLoadAreas(query) {
  const ctx = await context();
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${query}: ${e.message}`));
  await p.goto(BASE);
  await p.fill("#place", query);
  await p.getByRole("button", { name: "Suchen" }).click();
  await p.locator("fieldset label").first().click();
  await p.getByRole("button", { name: /Verteilaktion starten/ }).click();
  await p.getByRole("dialog").waitFor();
  await p.waitForURL(/\/admin\/[A-Za-z0-9]{22}$/);
  const editUrl = await p.getByLabel("Link zum Mitmachen").inputValue();
  assert.match(editUrl, /\/v\/[A-Za-z0-9]{22}$/);
  await p.getByRole("button", { name: /Ortsteile festlegen/ }).click();
  const sheet = p.getByTestId("areas-sheet");
  // Overpass in der Cloud: bis zu drei Versuche mit Pausen; großzügig warten.
  const started = Date.now();
  // Bis zu drei Versuche über alle Server (je bis 7 min) mit Pausen: höchstens etwa 23 Minuten.
  await sheet.getByRole("checkbox").first().or(sheet.getByText("konnten nicht geladen werden")).waitFor({ timeout: 1_500_000 });
  if (await sheet.getByText("konnten nicht geladen werden").count()) {
    const why = (await sheet.getByTestId("areas-error").count()) ? await sheet.getByTestId("areas-error").innerText() : "(keine Angabe)";
    throw new Error(`${query}: Gebiete nicht geladen. Antwort der Overpass-Server: ${why}`);
  }
  const names = await sheet.locator("li label span").allTextContents();
  console.log(`${query}: ${names.length} Gebiete nach ${Math.round((Date.now() - started) / 1000)} s:`, names.join(", "));
  const whole = await sheet.getByText("keine Ortsteile eingetragen").count();
  await shot(p, `${query}-gebiete`);
  return { ctx, p, sheet, editUrl, names, whole };
}

try {
  // Bornheim: Ortsteile wie im Issue
  const b = await createAndLoadAreas("Bornheim, Rhein-Sieg-Kreis");
  for (const n of ["Brenig", "Hersel", "Roisdorf", "Sechtem", "Walberberg", "Widdig"]) {
    assert.ok(b.names.some((x) => x.includes(n)), `Bornheim: Ortsteil ${n} fehlt`);
  }
  assert.equal(b.whole, 0, "Bornheim ist unterteilt");

  // Auswahl live beim Helfer: nur Roisdorf
  const helperCtx = await context();
  const h = await helperCtx.newPage();
  h.on("pageerror", (e) => errors.push(`Helfer: ${e.message}`));
  await h.goto(b.editUrl);
  await h.waitForTimeout(3000);
  assert.equal(await h.getByRole("button", { name: "Gebiete" }).count(), 0, "keine Gebietsauswahl im Bearbeiten-Link");
  await b.sheet.getByRole("button", { name: "Keine" }).click();
  await b.sheet.getByLabel("Roisdorf").check();
  await b.sheet.getByRole("button", { name: "Fertig" }).click();
  await h.evaluate(() => window.__einwurfMap?.jumpTo({ zoom: 12 }));
  const labels = () =>
    h.evaluate(() => window.__einwurfMap?.queryRenderedFeatures({ layers: ["area-labels"] }).map((f) => f.properties.name) ?? null);
  let seen = null;
  for (let i = 0; i < 20 && !(seen && seen.length === 1); i++) {
    await h.waitForTimeout(500);
    seen = await labels();
  }
  // In Produktionsbuilds gibt es window.__einwurfMap nicht; dann nur Bildschirmfotos.
  if (seen !== null) assert.deepEqual(seen, ["Roisdorf"], "Helfer sieht live nur das gewählte Gebiet");
  await shot(h, "Bornheim-helfer-roisdorf");
  await helperCtx.close();
  await b.ctx.close();

  // Großstadt mit anderer Gliederung (Stadtbezirke/Ortsteile)
  const c = await createAndLoadAreas("Bonn");
  assert.ok(c.names.length >= 2, "Bonn ist unterteilt");
  assert.equal(c.whole, 0);
  await c.ctx.close();

  assert.deepEqual(errors, [], "keine Fehler auf der Seite");
  console.log("OK");
} finally {
  await browser.close();
}
