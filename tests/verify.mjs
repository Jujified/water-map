// Visual + behavioural verification with Playwright.
//   npm run build && npm run verify
// Starts `vite preview`, screenshots both modes at 0 m, and checks:
//   - Caspian depression stays dry at +10 m (the sea itself is a lake)
//   - present-day lakes are water at 0 m and at -120 m
//   - the zoom buttons zoom in, out and reset
//   - Bering land bridge is exposed at -120 m (and submerged at 0 m)
//   - percent of Earth above water at 0 m is about 29 %
//   - frame rate while the slider is being dragged
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = 4179;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((res, rej) => {
  server.stdout.on('data', (d) => d.toString().includes(String(PORT)) && res());
  server.on('exit', rej);
});

const base = `http://localhost:${PORT}/`;
// Caspian Depression lowlands: below sea level, dry, not part of the lake
const CASPIAN_DEPRESSION = [[46.5, 44.0], [46.75, 44.0], [46.25, 44.25]];
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
};

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  // Software GL in CI is slow with a million points, so every step gets a
  // fresh page and generous timeouts.
  let page = null;
  async function newPage(q, viewport = { width: 1400, height: 1000 }) {
    if (page) await page.close();
    page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    page.setDefaultTimeout(300_000);
    page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
    page.on('pageerror', (e) => console.log('pageerror:', e.message));
    await page.goto(`${base}?${q}`);
    await page.waitForFunction(() => window.__waterMap?.ready, null, { timeout: 300_000 });
  }
  async function open(q) {
    await newPage(`intro=0&${q}`);
    await page.waitForTimeout(1800);
  }

  for (const mode of ['realistic', 'abstract']) {
    await open(`mode=${mode}&level=0`);
    await page.screenshot({ path: `${OUT}${mode}-0m.png` });
    console.log(`screenshot ${mode}-0m.png`);
  }

  const wm = (fn, ...a) => page.evaluate(([f, args]) => window.__waterMap[f](...args), [fn, a]);

  await open('mode=realistic&level=0');
  const above0 = await wm('above');
  check('surface above water at 0 m ≈ 29 %', Math.abs(above0 * 100 - 29.2) < 1.0, `${(above0 * 100).toFixed(2)} %`);

  // Caspian: the sea is a present-day lake; the dry depression around it
  // (below sea level, not connected to the ocean) must stay dry at +10 m
  await wm('setLevel', 10);
  await page.waitForTimeout(200);
  const caspSea = [await wm('isWater', 51.0, 39.5), await wm('isWater', 50.0, 42.5)];
  check('Caspian Sea shown as a lake', caspSea.every((c) => c.lake && c.water), JSON.stringify(caspSea.map((c) => [c.elev.toFixed(0), c.lake])));
  const caspDry = [];
  for (const [lon, lat] of CASPIAN_DEPRESSION) caspDry.push(await wm('isWater', lon, lat));
  check('Caspian depression dry at +10 m', caspDry.every((c) => !c.water && c.elev < 10), JSON.stringify(caspDry.map((c) => [c.elev.toFixed(0), c.flood.toFixed(0)])));
  await wm('setLevel', 0);
  const lakes0 = [await wm('isWater', -87.5, 47.7), await wm('isWater', 108.0, 53.5), await wm('isWater', 33.0, -1.0)];
  await wm('setLevel', -120);
  const lakesLow = [await wm('isWater', -87.5, 47.7), await wm('isWater', 108.0, 53.5), await wm('isWater', 33.0, -1.0)];
  check('Superior, Baikal, Victoria are water at 0 m and −120 m', [...lakes0, ...lakesLow].every((c) => c.water));
  await page.screenshot({ path: `${OUT}realistic-+10m.png` });

  // Bering Strait, the centre of the land bridge
  await wm('setLevel', 0);
  const ber0 = await wm('isWater', -168.8, 65.8);
  await wm('setLevel', -120);
  await page.waitForTimeout(200);
  const berA = await wm('isWater', -168.8, 65.8);
  const berB = await wm('isWater', -170.0, 63.0);
  check('Bering Strait is sea at 0 m', ber0.water, `elev ${ber0.elev.toFixed(0)} m`);
  check('Bering land bridge exposed at −120 m', !berA.water && !berB.water, `elev ${berA.elev.toFixed(0)} / ${berB.elev.toFixed(0)} m`);
  await page.screenshot({ path: `${OUT}realistic--120m.png` });
  await open('mode=abstract&level=-120');
  await page.screenshot({ path: `${OUT}abstract--120m.png` });
  await open('mode=abstract&level=66');
  await page.screenshot({ path: `${OUT}abstract-+66m.png` });

  // zoom buttons
  await open('mode=realistic&level=0');
  // software GL renders slowly, so wait for the animation to land instead of a fixed time
  const settle = (z) => page.waitForFunction((t) => Math.abs(window.__waterMap.zoom() - t) < 1e-3, z);
  const z0 = await wm('zoom');
  await page.click('#z-in');
  await settle(2);
  const z1 = await wm('zoom');
  await page.click('#z-out');
  await settle(1);
  const z2 = await wm('zoom');
  await page.click('#z-in');
  await page.click('#z-in');
  await settle(4);
  await page.screenshot({ path: `${OUT}realistic-zoomed.png` });
  await page.click('#z-reset');
  await settle(1);
  const z3 = await wm('zoom');
  check('zoom buttons', z0 === 1 && Math.abs(z1 - 2) < 0.01 && Math.abs(z2 - 1) < 0.01 && Math.abs(z3 - 1) < 0.01, `${z0} → ${z1.toFixed(2)} → ${z2.toFixed(2)} → reset ${z3}`);

  // globe button: fold the map onto the globe, spin it, unfold again
  for (const mode of ['realistic', 'abstract']) {
    await open(`mode=${mode}&level=0${mode === 'abstract' ? '&dots=300000' : ''}`);
    await page.click('#z-globe');
    await page.waitForFunction(() => window.__waterMap.globe() >= 1);
    const box = await page.locator('#stage canvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2 + 40, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}globe-${mode}.png` });
    await page.click('#z-globe');
    await page.waitForFunction(() => window.__waterMap.globe() <= 0);
    check(`globe button round trip (${mode})`, true, 'map → globe → map');
  }

  // slider drag fps (software GL here, so this is a lower bound)
  for (const mode of ['realistic', 'abstract']) {
    await open(`mode=${mode}&level=0`);
    const box = await page.locator('#slider').boundingBox();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
    await page.mouse.down();
    const t0 = Date.now();
    let frames = 0;
    const counter = await page.evaluateHandle(() => {
      const s = { n: 0, on: true };
      const tick = () => { s.n++; if (s.on) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      return s;
    });
    for (let i = 0; i < 60; i++) {
      await page.mouse.move(box.x + box.width * (0.4 + 0.5 * Math.sin(i / 8) ** 2), box.y + box.height / 2);
      await page.waitForTimeout(16);
    }
    frames = await counter.evaluate((s) => { s.on = false; return s.n; });
    await page.mouse.up();
    const fps = frames / ((Date.now() - t0) / 1000);
    console.log(`INFO  ${mode} fps while dragging (headless, software GL): ${fps.toFixed(1)}`);
  }

  // intro frames at fixed times (the intro clock can be frozen for capture)
  for (const mode of ['realistic', 'abstract']) {
    for (const t of [1.0, 3.0, 4.8, 6.0]) {
      await newPage(`mode=${mode}&introAt=${t}${mode === 'abstract' ? '&dots=300000' : ''}`);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${OUT}intro-${mode}-${t}s.png` });
    }
  }

  // mobile layout with the 2048 fallback
  await newPage('intro=0&mode=abstract&size=2048&dots=300000', { width: 390, height: 844 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}mobile-abstract.png` });
  await newPage('intro=0&mode=realistic&size=2048', { width: 390, height: 844 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}mobile-realistic.png` });
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} check(s) failed` : 'all checks passed');
process.exit(failed.length ? 1 : 0);
