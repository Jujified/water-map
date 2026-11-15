import type { Stats } from './data';
import { ABS_LAND, ABS_WATER, REAL_LAND, REAL_WATER, cssRgb, ramp } from './palette';

/**
 * Vertical hypsometric chart: one row per 100 m bin, drawn as dots of the
 * same size and colour the abstract field uses, with a line at the water level.
 */
export class Legend {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private jitter: Float32Array;
  private fmax: number;

  constructor(
    private stats: Stats,
    parent: HTMLElement,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'legend-canvas';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.fmax = Math.max(...stats.histogram.fractions);
    this.jitter = new Float32Array(4096);
    for (let i = 0; i < this.jitter.length; i++) this.jitter[i] = Math.random();
  }

  draw(level: number, mode: number) {
    const c = this.canvas;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const hs = this.stats.histogram;
    const nb = hs.fractions.length;
    const top = 8;
    const bottom = h - 8;
    const left = 40;
    const width = w - left - 8;
    const lo = hs.binStart;
    const hi = hs.binStart + nb * hs.binSize;
    const y = (e: number) => top + ((hi - e) / (hi - lo)) * (bottom - top);
    const abstract = mode > 0.5;
    const rmax = 3.2;

    let j = 0;
    for (let b = 0; b < nb; b++) {
      const f = hs.fractions[b];
      if (f <= 0) continue;
      const e0 = lo + b * hs.binSize;
      const mid = e0 + hs.binSize / 2;
      const hrel = mid - level;
      const wet = mid <= level;
      const col = wet
        ? ramp(abstract ? ABS_WATER : REAL_WATER, -hrel)
        : ramp(abstract ? ABS_LAND : REAL_LAND, hrel);
      const r = Math.max(0.5, rmax * Math.sqrt(f / this.fmax));
      const len = (f / this.fmax) * width;
      const yc = (y(e0) + y(e0 + hs.binSize)) / 2;
      const step = Math.max(r * 1.1, 1.2);
      ctx.fillStyle = cssRgb(col, 0.9);
      for (let x = 0; x <= len; x += step) {
        const jx = (this.jitter[j++ & 4095] - 0.5) * step * 0.6;
        const jy = (this.jitter[j++ & 4095] - 0.5) * 1.6;
        ctx.beginPath();
        ctx.arc(left + x + jx, yc + jy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // axis
    const ink = abstract ? 'rgba(255,255,255,0.75)' : 'rgba(40,40,50,0.7)';
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let e = -10000; e <= 8000; e += 2000) {
      const yy = y(e);
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(left - 4, yy);
      ctx.lineTo(left - 1, yy);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(e === 0 ? '0' : `${e / 1000}k`, left - 6, yy);
    }

    // water level line
    const yl = y(Math.max(lo, Math.min(hi, level)));
    ctx.strokeStyle = abstract ? '#ffffff' : '#1f2f6e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(left - 2, yl);
    ctx.lineTo(w - 2, yl);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = abstract ? '#ffffff' : '#1f2f6e';
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(`${level > 0 ? '+' : ''}${Math.round(level)} m`, w - 4, yl - 2);
  }
}
