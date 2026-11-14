import { chromium } from "playwright";
const slug = process.argv[2], secs = Number(process.argv[3] ?? 120);
const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
const t0 = Date.now();
await p.goto(`http://127.0.0.1:5173/v/${slug}`);
let last = "";
while (Date.now() - t0 < secs * 1000) {
  const s = await p.evaluate(() => {
    const m = window.__einwurfMap; if (!m?.getLayer("buildings-fill")) return "start";
    const pill = document.querySelector("[role=status],[role=alert]")?.textContent ?? document.body.innerText.match(/Häuser werden geladen|Häuser konnten nicht|Haus antippen/)?.[0];
    return `${m.queryRenderedFeatures({ layers: ["buildings-fill"] }).length} Häuser | ${pill}`;
  });
  if (s !== last) { console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${s}`); last = s; }
  await p.waitForTimeout(1000);
}
await p.screenshot({ path: process.argv[4] });
await b.close();
