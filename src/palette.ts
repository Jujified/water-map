// Colour ramps shared by the shaders (generated GLSL) and the legend (canvas).
// Each ramp is a list of [metres, hex]. Land ramps take height above the
// current water level; water ramps take depth below it.

export type Stop = [number, string];

export const REAL_LAND: Stop[] = [
  [0, '#88a24f'],
  [120, '#a3b35a'],
  [400, '#cfc46a'],
  [900, '#e2bf72'],
  [1700, '#d8955c'],
  [2800, '#c88e78'],
  [4200, '#c9a59c'],
  [6000, '#e8dcd6'],
];
export const REAL_WATER: Stop[] = [
  [0, '#6b8cc6'],
  [80, '#5878b8'],
  [250, '#4864a8'],
  [1500, '#3b5598'],
  [4000, '#324b8e'],
  [7000, '#273d80'],
];
export const PAPER = '#efe9dd';
export const SPACE = '#07080f';

export const ABS_LAND: Stop[] = [
  [0, '#d9474c'],
  [120, '#e8737a'],
  [400, '#f1a2ab'],
  [900, '#f6c9c8'],
  [1700, '#efd38c'],
  [3000, '#f5e6a6'],
  [4500, '#fffaf0'],
];
export const ABS_WATER: Stop[] = [
  [0, '#d3e7f4'],
  [80, '#a9cbee'],
  [300, '#86a6e6'],
  [1500, '#6474d8'],
  [3800, '#4a4bc4'],
  [6500, '#2c2895'],
];
export const ULTRAMARINE = '#4144c8';

export function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function ramp(stops: Stop[], t: number): [number, number, number] {
  if (t <= stops[0][0]) return hexRgb(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const k = (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      const a = hexRgb(stops[i - 1][1]);
      const b = hexRgb(stops[i][1]);
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    }
  }
  return hexRgb(stops[stops.length - 1][1]);
}

const f = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const v3 = (h: string) => {
  const [r, g, b] = hexRgb(h);
  return `vec3(${f(+r.toFixed(4))},${f(+g.toFixed(4))},${f(+b.toFixed(4))})`;
};

/** GLSL function `vec3 name(float t)` matching `ramp(stops, t)`. */
export function glslRamp(name: string, stops: Stop[]): string {
  let s = `vec3 ${name}(float t){\n  vec3 c = ${v3(stops[0][1])};\n`;
  for (let i = 1; i < stops.length; i++) {
    const [a, b] = [stops[i - 1][0], stops[i][0]];
    s += `  c = mix(c, ${v3(stops[i][1])}, clamp((t-${f(a)})/${f(b - a)},0.0,1.0));\n`;
  }
  return s + '  return c;\n}\n';
}

export function cssRgb(c: [number, number, number], a = 1): string {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
}
