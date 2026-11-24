// Isometric drawing basics shared by the floor and its furniture.

export const SVG = 'http://www.w3.org/2000/svg';
export const TW = 64; // width of one grid cell on screen
export const TH = 32; // height of one grid cell on screen

export function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

/** Grid position (and height) to screen. */
export function iso(gx, gy, z = 0) {
  return [(gx - gy) * (TW / 2), (gx + gy) * (TH / 2) - z];
}

export function pts(list) {
  return list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

/** A repeatable random number source, seeded from some text. */
export function rng(seed) {
  let a = 2166136261;
  for (const ch of String(seed)) a = Math.imul(a ^ ch.charCodeAt(0), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A colour darker (f < 1) or lighter (f > 1). */
export function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => (f <= 1 ? c * f : c + (255 - c) * (f - 1)));
  return `rgb(${ch.map((c) => Math.round(Math.max(0, Math.min(255, c)))).join(' ')})`;
}
