import * as THREE from 'three';
import './style.css';
import { elevationAt, fractionAbove, isMobile, loadData, lonLatAt, sphereAt } from './data';
import { decodeData, sphereTexture } from './gpu';
import { Intro, T_END } from './intro';
import { Legend } from './legend';
import { PAPER, SPACE, ULTRAMARINE } from './palette';
import { AbstractLayer } from './abstract';
import { RealisticLayer } from './realistic';
import { View } from './view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode etc. */
    }
  },
};

const LIMITED: [number, number] = [-200, 300];
const FULL: [number, number] = [-11000, 9000];

// Palette hex values are display colours; don't convert them to linear.
THREE.ColorManagement.enabled = false;

async function main() {
  // apply the remembered theme before anything is visible
  const early = params.get('mode') ?? store.get('waterMap.mode');
  document.body.classList.toggle('abstract', early === 'abstract');
  document.body.classList.add('intro');
  const mobile = isMobile();
  const sizeParam = params.get('size');
  const data = await loadData(sizeParam ? Number(sizeParam) : 'auto', (m) => ($('loading-msg').textContent = m));

  // ---------------- renderer ----------------
  const stage = $('stage');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  const dpr = Math.min(window.devicePixelRatio || 1, mobile ? 2 : 2);
  renderer.setPixelRatio(dpr);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // palette values are display-referred
  stage.appendChild(renderer.domElement);

  const dataRT = decodeData(renderer, data);
  const sphereTex = sphereTexture(data);
  const real = new RealisticLayer(data, dataRT.texture);
  const dots = Number(params.get('dots')) || (mobile ? 300_000 : 1_000_000);
  const abs = new AbstractLayer(data, dataRT.texture, sphereTex, dots);
  const scene = new THREE.Scene();
  scene.add(real.mesh, abs.points);

  const view = new View();
  view.attach(renderer.domElement);
  const intro = new Intro(data);
  const legend = new Legend(data.stats, $('legend-host'));

  // ---------------- state ----------------
  const savedMode = store.get('waterMap.mode');
  let mode: 0 | 1 = params.get('mode') === 'abstract' ? 1 : params.get('mode') === 'realistic' ? 0 : savedMode === 'abstract' ? 1 : 0;
  let modeT: number = mode;
  let level = Number(params.get('level') ?? 0) || 0;
  let full = params.get('full') === '1' || Math.abs(level) > 300 || level < -200;
  let playing = false;
  let playDir = 1;
  let introT = params.get('intro') === '0' || reducedMotion ? T_END : 0;
  let legendDirty = true;
  // globe view: 0 = flat map, 1 = globe; animated toward globeTarget
  let globeTarget = params.get('globe') === '1' ? 1 : 0;
  let globeT = globeTarget;
  let globeSpin = !reducedMotion;
  const userQ = intro.finalQuat();
  // ?introAt=<s> freezes the intro at a given time (used for screenshots)
  const frozenIntro = params.has('introAt');

  const slider = $<HTMLInputElement>('slider');
  const fullBox = $<HTMLInputElement>('full');

  function setRange() {
    const [lo, hi] = full ? FULL : LIMITED;
    slider.min = String(lo);
    slider.max = String(hi);
    fullBox.checked = full;
    $('s-min').textContent = `${lo.toLocaleString('en-US').replace('-', '−')} m`;
    $('s-max').textContent = `+${hi.toLocaleString('en-US')} m`;
    slider.style.setProperty('--zero', `${((0 - lo) / (hi - lo)) * 100}%`);
  }

  function fmtLevel(v: number) {
    const r = Math.round(v);
    return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toLocaleString('en-US')} m`;
  }

  function setLevel(v: number, fromSlider = false) {
    const [lo, hi] = full ? FULL : LIMITED;
    level = Math.max(lo, Math.min(hi, v));
    if (!fromSlider) slider.value = String(Math.round(level));
    $('r-level').textContent = fmtLevel(level);
    $('r-above').textContent = `${(fractionAbove(data.stats, level) * 100).toFixed(1)}%`;
    document.querySelectorAll<HTMLButtonElement>('.presets button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.level) === Math.round(level));
    });
    legendDirty = true;
  }

  function setMode(m: 0 | 1) {
    mode = m;
    store.set('waterMap.mode', m ? 'abstract' : 'realistic');
    $('m-real').setAttribute('aria-checked', String(m === 0));
    $('m-abs').setAttribute('aria-checked', String(m === 1));
    document.body.classList.toggle('abstract', m === 1);
    legendDirty = true;
  }

  function setPlaying(p: boolean) {
    playing = p;
    $('play-icon').setAttribute('d', p ? 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z' : 'M7 5v14l12-7z');
    $('play').setAttribute('aria-label', p ? 'Pause sweep' : 'Play sweep');
  }

  function setGlobe(on: boolean) {
    if (on && globeTarget === 0) {
      userQ.copy(intro.finalQuat()); // start from the map's own orientation
      globeSpin = !reducedMotion;
      setPlaying(false);
    }
    globeTarget = on ? 1 : 0;
    view.lockCenter = on;
    view.animateTo(1, 0, 0, reducedMotion ? 0 : 0.5);
    const b = $('z-globe');
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? 'Map view' : 'Globe view');
    b.title = on ? 'Back to the map (G)' : 'Globe view (G)';
    document.body.classList.toggle('globe', on);
  }

  function startIntro() {
    if (globeTarget) setGlobe(false);
    globeT = 0;
    introT = reducedMotion ? T_END : 0;
    view.reset();
    view.enabled = introT >= T_END;
    document.body.classList.toggle('intro', introT < T_END);
    $('replay').hidden = true;
  }

  // ---------------- UI wiring ----------------
  slider.addEventListener('input', () => setLevel(Number(slider.value), true));
  fullBox.addEventListener('change', () => {
    full = fullBox.checked;
    setRange();
    setLevel(level);
  });
  document.querySelectorAll<HTMLButtonElement>('.presets button').forEach((b) =>
    b.addEventListener('click', () => {
      setPlaying(false);
      setLevel(Number(b.dataset.level));
    }),
  );
  $('m-real').addEventListener('click', () => setMode(0));
  $('m-abs').addEventListener('click', () => setMode(1));
  $('play').addEventListener('click', () => setPlaying(!playing));
  $('info-btn').addEventListener('click', () => $<HTMLDialogElement>('info').showModal());
  $('skip').addEventListener('click', () => (introT = T_END));
  $('replay').addEventListener('click', startIntro);
  const zoomDur = reducedMotion ? 0 : 0.35;
  const zoomIn = () => view.enabled && view.animateTo(view.targetZoom() * 2, view.cx, view.cy, zoomDur);
  const zoomOut = () => view.enabled && view.animateTo(view.targetZoom() / 2, view.cx, view.cy, zoomDur);
  const zoomReset = () => view.enabled && view.animateTo(1, 0, 0, zoomDur);
  $('z-in').addEventListener('click', zoomIn);
  $('z-out').addEventListener('click', zoomOut);
  $('z-reset').addEventListener('click', zoomReset);
  $('z-globe').addEventListener('click', () => view.enabled && setGlobe(globeTarget === 0));
  // one-finger drag spins the globe instead of panning
  view.onDrag = (dx, dy) => {
    if (globeTarget === 0 && globeT <= 0) return false;
    if (globeT < 1) return true;
    const k = 1 / (view.pxPerUnit() * real.material.uniforms.uRadius.value);
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * k);
    const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * k);
    userQ.premultiply(qx).premultiply(qy);
    globeSpin = false;
    return true;
  };
  function updateZoomButtons() {
    const z = view.targetZoom();
    $<HTMLButtonElement>('z-in').disabled = z >= 40;
    $<HTMLButtonElement>('z-out').disabled = z <= 1;
    $<HTMLButtonElement>('z-reset').disabled = view.isHome();
  }
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === ' ' && introT >= T_END) {
      e.preventDefault();
      setPlaying(!playing);
    } else if (e.key === 'Escape' && introT < T_END) introT = T_END;
    else if (e.key === '+' || e.key === '=') zoomIn();
    else if (e.key === '-' || e.key === '_') zoomOut();
    else if (e.key === '0') zoomReset();
    else if ((e.key === 'g' || e.key === 'G') && view.enabled) setGlobe(globeTarget === 0);
  });

  let cursor: [number, number] | null = null;
  renderer.domElement.addEventListener('pointermove', (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    cursor = [e.clientX - r.left, e.clientY - r.top];
  });
  renderer.domElement.addEventListener('pointerleave', () => (cursor = null));

  function updateCursor() {
    const el = $('r-cursor');
    if (!cursor || introT < T_END || globeT > 0) {
      el.textContent = '—';
      return;
    }
    const [u, v] = view.screenToUv(cursor[0], cursor[1]);
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      el.textContent = '—';
      return;
    }
    const [lon, lat] = lonLatAt(data, u, v);
    const e = elevationAt(data, u, v);
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lon >= 0 ? 'E' : 'W';
    el.textContent = `${Math.abs(lat).toFixed(1)}°${ns} ${Math.abs(lon).toFixed(1)}°${ew} · ${fmtLevel(e).replace(' m', '')} m`;
  }

  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    renderer.setSize(w, h, false);
    view.resize(w, h);
    legendDirty = true;
  }
  window.addEventListener('resize', resize);
  resize();
  setRange();
  setLevel(level);
  setMode(mode);
  modeT = mode;
  startIntro();
  if (params.get('intro') === '0') introT = T_END;
  if (params.get('globe') === '1') {
    setGlobe(true);
    globeT = 1; // start on the globe (no animation) when asked by URL
  }
  if (frozenIntro) introT = Math.min(T_END - 1e-3, Number(params.get('introAt')) || 0);

  // ---------------- loop ----------------
  const bgPaper = new THREE.Color(PAPER);
  const bgUltra = new THREE.Color(ULTRAMARINE);
  const bgSpace = new THREE.Color(SPACE);
  const bg = new THREE.Color();
  let last = performance.now();
  let time = 0;
  const fps = { frames: 0, t0: last, value: 0 };
  let wasAbsVisible = false;

  function frame(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    time += dt;
    fps.frames++;
    if (now - fps.t0 > 500) {
      fps.value = (fps.frames * 1000) / (now - fps.t0);
      fps.frames = 0;
      fps.t0 = now;
    }

    // intro
    const inIntro = introT < T_END;
    if (inIntro && !frozenIntro) introT = Math.min(T_END, introT + dt);
    if (!inIntro) {
      const rate = reducedMotion ? 100 : 1 / 1.6;
      globeT += Math.sign(globeTarget - globeT) * Math.min(Math.abs(globeTarget - globeT), dt * rate);
      if (globeT >= 1 && globeSpin) {
        // slow eastward spin about Earth's axis as seen on screen
        const north = new THREE.Vector3(0, 0, 1).applyQuaternion(userQ);
        userQ.premultiply(new THREE.Quaternion().setFromAxisAngle(north, dt * 0.12));
      }
    }
    const f = inIntro || globeT <= 0 ? intro.frame(introT) : intro.globe(globeT, userQ);
    if (inIntro && introT >= T_END) {
      document.body.classList.remove('intro');
      view.enabled = true;
      $('replay').hidden = false;
    }
    if (!inIntro && document.body.classList.contains('intro')) {
      document.body.classList.remove('intro');
      view.enabled = true;
      $('replay').hidden = false;
    }

    view.tick(dt);
    updateZoomButtons();

    // sweep
    if (playing) {
      const [lo, hi] = full ? FULL : LIMITED;
      const speed = (hi - lo) / (full ? 24 : 12);
      let nl = level + playDir * speed * dt;
      if (nl >= hi) {
        nl = hi;
        playDir = -1;
      } else if (nl <= lo) {
        nl = lo;
        playDir = 1;
      }
      setLevel(nl);
    }

    // crossfade (1 s)
    const fadeRate = reducedMotion ? 5 : 1;
    modeT += Math.sign(mode - modeT) * Math.min(Math.abs(mode - modeT), dt * fadeRate);

    const realOp = 1 - modeT;
    const absOp = modeT;
    const ru = real.material.uniforms;
    ru.uLevel.value = level;
    ru.uOpacity.value = realOp;
    ru.uEdge.value = f.edge;
    ru.uMorph.value = f.morph;
    (ru.uRot.value as THREE.Matrix3).copy(f.rot);
    real.mesh.visible = realOp > 0.001;
    real.material.depthWrite = f.morph < 0.999;

    const au = abs.material.uniforms;
    abs.points.visible = absOp > 0.001;
    if (abs.points.visible) {
      if (!wasAbsVisible) abs.snap();
      abs.update(renderer, level, dt);
      au.uLevel.value = level;
      au.uOpacity.value = absOp;
      au.uMorph.value = f.morph;
      (au.uRot.value as THREE.Matrix3).copy(f.rot);
      au.uTime.value = reducedMotion ? 0 : time;
      au.uPxPerUnit.value = view.pxPerUnit();
      au.uDpr.value = renderer.getPixelRatio();
    }
    wasAbsVisible = abs.points.visible;

    bg.copy(bgPaper).lerp(bgUltra, modeT);
    // the globe view sits in space for Realistic; Abstract keeps its ultramarine
    // ground so the gaps between land dots read the same as on the map
    const inGlobe = !inIntro && globeT > 0;
    bg.lerp(bgSpace, (1 - f.bg) * (inGlobe ? 1 - modeT : 1));
    renderer.setClearColor(bg, 1);
    document.body.style.background = `#${bg.getHexString()}`;

    renderer.render(scene, view.camera);

    if (legendDirty) {
      // use the selected mode, not the crossfade value: the redraw happens on the
      // first frame after the switch, when the fade has barely started
      legend.draw(level, mode);
      legendDirty = false;
    }
    updateCursor();
    requestAnimationFrame(frame);
  }

  $('loading').classList.add('done');
  requestAnimationFrame(frame);

  // hooks for automated verification
  Object.assign(window, {
    __waterMap: {
      setLevel: (v: number) => {
        if (Math.abs(v) > 300 || v < -200) {
          full = true;
          setRange();
        }
        setLevel(v);
      },
      setMode: (m: 'realistic' | 'abstract') => {
        setMode(m === 'abstract' ? 1 : 0);
        modeT = mode;
      },
      skipIntro: () => (introT = T_END),
      fps: () => fps.value,
      above: () => fractionAbove(data.stats, level),
      zoom: () => view.zoom,
      globe: () => globeT,
      isWater: (lon: number, lat: number) => isWaterAt(lon, lat),
      ready: true,
    },
  });

  // CPU-side water test for verification: find the map pixel nearest a lon/lat.
  function isWaterAt(lon: number, lat: number) {
    const g = data.meta.lonlatGrid;
    const lo = (lon * Math.PI) / 180;
    const la = (lat * Math.PI) / 180;
    const t = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    let best = -2;
    let bi = 0;
    for (let i = 0; i < g * g; i++) {
      const d = data.sphere[3 * i] * t[0] + data.sphere[3 * i + 1] * t[1] + data.sphere[3 * i + 2] * t[2];
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    // refine within the neighbouring grid cells to ~1/64 of a cell
    let u = (bi % g) / (g - 1);
    let v = 1 - Math.floor(bi / g) / (g - 1);
    const cell = 1 / (g - 1);
    const [u0, v0] = [u, v];
    for (let a = -64; a <= 64; a++) {
      for (let b = -64; b <= 64; b++) {
        const uu = u0 + (a / 64) * cell;
        const vv = v0 + (b / 64) * cell;
        if (uu < 0 || uu > 1 || vv < 0 || vv > 1) continue;
        const s = sphereAt(data, uu, vv);
        const dd = s[0] * t[0] + s[1] * t[1] + s[2] * t[2];
        if (dd > best) {
          best = dd;
          u = uu;
          v = vv;
        }
      }
    }
    const n = data.size;
    const px = new Uint16Array(4);
    renderer.readRenderTargetPixels(dataRT, Math.min(n - 1, Math.round(u * n)), Math.min(n - 1, Math.round(v * n)), 1, 1, px);
    const elev = THREE.DataUtils.fromHalfFloat(px[0]);
    const flood = THREE.DataUtils.fromHalfFloat(px[1]);
    const lake = flood < -10000 && elev > -10000;
    const water = level >= 0 ? flood <= level : Math.min(elev, flood) <= level;
    return { u, v, elev, flood, water, lake };
  }
}

main().catch((err) => {
  console.error(err);
  $('loading-msg').textContent = `Could not start: ${err.message ?? err}`;
});
