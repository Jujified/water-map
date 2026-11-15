// Loads the preprocessed assets written by tools/preprocess.py.

export interface Meta {
  halfWidth: number;
  sizes: number[];
  elevationOffset: number;
  distUnitKm: number;
  lonlatGrid: number;
  areaGrid: number;
  source: string;
  proj: string;
}

export interface Stats {
  levelMin: number;
  levelMax: number;
  above: number[];
  histogram: { binSize: number; binStart: number; fractions: number[] };
  elevationMin: number;
  elevationMax: number;
}

export interface MapData {
  meta: Meta;
  stats: Stats;
  size: number;
  terrain: ImageBitmap; // R,G elevation; B ice
  flood: ImageBitmap; // R,G flood level; B distance inland
  /** decoded elevation (m) for CPU-side cursor readout, row 0 = top */
  elevation: Float32Array;
  /** 513x513 (lon, lat) pairs, row 0 = top */
  lonlat: Float32Array;
  /** 513x513x3 unit vectors (x, y, z), z = north */
  sphere: Float32Array;
  /** 512x512 relative true area per map cell (max = 1), row 0 = top */
  area: Float32Array;
}

const BASE = `${import.meta.env.BASE_URL}data/`;

async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

async function bitmap(url: string): Promise<ImageBitmap> {
  const blob = await (await fetchOk(url)).blob();
  return createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
}

function decodeElevation(img: ImageBitmap, offset: number): Float32Array {
  const n = img.width;
  const c = document.createElement('canvas');
  c.width = n;
  c.height = n;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, n, n).data;
  const out = new Float32Array(n * n);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = px[j] * 256 + px[j + 1] - offset;
  c.width = c.height = 1;
  return out;
}

export function isMobile(): boolean {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(screen.width, screen.height) < 820;
  return coarse && small;
}

export async function loadData(
  size: number | 'auto',
  onProgress?: (msg: string) => void,
): Promise<MapData> {
  const metaP = fetchOk(BASE + 'meta.json').then((r) => r.json() as Promise<Meta>);
  const statsP = fetchOk(BASE + 'stats.json').then((r) => r.json() as Promise<Stats>);
  const meta = await metaP;
  const sizes = [...meta.sizes].sort((a, b) => b - a);
  let n = size === 'auto' ? (isMobile() ? sizes[sizes.length - 1] : sizes[0]) : size;
  if (!sizes.includes(n)) n = sizes[0];
  onProgress?.('Loading terrain…');
  const [terrain, flood, lonlatBuf, areaBuf, stats] = await Promise.all([
    bitmap(`${BASE}terrain_${n}.png`),
    bitmap(`${BASE}flood_${n}.png`),
    fetchOk(BASE + 'lonlat.bin').then((r) => r.arrayBuffer()),
    fetchOk(BASE + 'area.bin').then((r) => r.arrayBuffer()),
    statsP,
  ]);
  const lonlat = new Float32Array(lonlatBuf);
  const g = meta.lonlatGrid;
  const sphere = new Float32Array(g * g * 3);
  for (let i = 0; i < g * g; i++) {
    const lo = (lonlat[2 * i] * Math.PI) / 180;
    const la = (lonlat[2 * i + 1] * Math.PI) / 180;
    sphere[3 * i] = Math.cos(la) * Math.cos(lo);
    sphere[3 * i + 1] = Math.cos(la) * Math.sin(lo);
    sphere[3 * i + 2] = Math.sin(la);
  }
  const elevation = decodeElevation(terrain, meta.elevationOffset);
  return {
    meta,
    stats,
    size: n,
    terrain,
    flood,
    elevation,
    lonlat,
    sphere,
    area: new Float32Array(areaBuf),
  };
}

/** Bilinear unit vector on the lon/lat grid at map uv (v = 0 at bottom). */
export function sphereAt(d: MapData, u: number, v: number): [number, number, number] {
  const g = d.meta.lonlatGrid;
  const fx = Math.min(Math.max(u, 0), 1) * (g - 1);
  const fy = Math.min(Math.max(1 - v, 0), 1) * (g - 1);
  const x0 = Math.min(Math.floor(fx), g - 2);
  const y0 = Math.min(Math.floor(fy), g - 2);
  const tx = fx - x0;
  const ty = fy - y0;
  const s = d.sphere;
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const a = s[(y0 * g + x0) * 3 + k] * (1 - tx) + s[(y0 * g + x0 + 1) * 3 + k] * tx;
    const b = s[((y0 + 1) * g + x0) * 3 + k] * (1 - tx) + s[((y0 + 1) * g + x0 + 1) * 3 + k] * tx;
    out[k] = a * (1 - ty) + b * ty;
  }
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  return [out[0] / l, out[1] / l, out[2] / l];
}

export function lonLatAt(d: MapData, u: number, v: number): [number, number] {
  const [x, y, z] = sphereAt(d, u, v);
  return [(Math.atan2(y, x) * 180) / Math.PI, (Math.asin(Math.max(-1, Math.min(1, z))) * 180) / Math.PI];
}

export function elevationAt(d: MapData, u: number, v: number): number {
  const n = d.size;
  const c = Math.min(n - 1, Math.max(0, Math.floor(u * n)));
  const r = Math.min(n - 1, Math.max(0, Math.floor((1 - v) * n)));
  return d.elevation[r * n + c];
}

/** Fraction of Earth's surface above water at `level` (from the cumulative table). */
export function fractionAbove(s: Stats, level: number): number {
  const i = Math.round(level) - s.levelMin;
  return s.above[Math.max(0, Math.min(s.above.length - 1, i))];
}
