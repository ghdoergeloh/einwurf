import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
await p.goto(`http://127.0.0.1:5173/v/${process.argv[2]}`);
await p.waitForFunction(() => window.__einwurfMap?.getLayer("buildings-fill") && window.__einwurfMap.queryRenderedFeatures({ layers: ["buildings-fill"] }).length > 0, null, { timeout: 120000 });
for (const [dx, dy] of [[700, 0], [0, 900], [-1400, 0]]) {
  const t0 = Date.now();
  await p.evaluate(([dx, dy]) => window.__einwurfMap.panBy([dx, dy], { duration: 0 }), [dx, dy]);
  await p.waitForTimeout(300);
  await p.waitForFunction(() => !document.body.innerText.includes("Häuser werden geladen"), null, { timeout: 120000 });
  const n = await p.evaluate(() => window.__einwurfMap.queryRenderedFeatures({ layers: ["buildings-fill"] }).length);
  await p.screenshot({ path: `/home/agent/tmp/claude-1000/-Users-georg-Projects-privat-spread-list-workspace/40720e77-64b1-4a08-86af-a4f9472c2d63/scratchpad/pan-${dx}-${dy}.png` });
  console.log(`verschoben ${dx},${dy}: ${n} Häuser nach ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
await b.close();
