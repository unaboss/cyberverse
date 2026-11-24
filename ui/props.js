// Furniture, people and the world outside: what makes the floor read like a
// place rather than a diagram. Everything here is decoration: it never answers a
// click itself (a click on a person or a plant opens the room it stands in).
// Positions are grid units; heights are screen pixels.

import { el, iso, pts, rng, shade } from './iso.js';

// ---------------------------------------------------------------- materials

const WOOD = '#a67c52';
const DESK_TOP = '#c9a477';
const METAL = '#5b6776';
const CHAIR = '#2b3542';
const POT = '#b5653f';
const LEAVES = ['#3f9b5f', '#57b874', '#2f7a4a', '#6cc488'];
const SKIN = ['#8d5524', '#c68642', '#e0ac69', '#f1c27d', '#ffdbac', '#5c3a21', '#a0663c'];
const HAIR = ['#1b1b1b', '#2e1e12', '#4a2f1b', '#6b4426', '#b07a3c', '#d6c08a', '#3b3b46'];
const SHIRT = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b', '#e2e8f0'];
const CARS = ['#e11d48', '#2563eb', '#f8fafc', '#0f172a', '#facc15', '#16a34a', '#94a3b8'];

// ---------------------------------------------------------------- primitives

/** A box sitting at height z0: sx, sy are half-sizes along each axis, h its height. */
export function box(g, gx, gy, sx, sy, z0, h, colour, cls) {
  const t = z0 + h;
  const b = el('g', cls ? { class: cls } : {}, g);
  el('polygon', { class: 'pf-l', points: pts([iso(gx - sx, gy + sy, t), iso(gx + sx, gy + sy, t), iso(gx + sx, gy + sy, z0), iso(gx - sx, gy + sy, z0)]), fill: shade(colour, 0.78) }, b);
  el('polygon', { class: 'pf-r', points: pts([iso(gx + sx, gy - sy, t), iso(gx + sx, gy + sy, t), iso(gx + sx, gy + sy, z0), iso(gx + sx, gy - sy, z0)]), fill: shade(colour, 0.6) }, b);
  el('polygon', { class: 'pf-t', points: pts([iso(gx - sx, gy - sy, t), iso(gx + sx, gy - sy, t), iso(gx + sx, gy + sy, t), iso(gx - sx, gy + sy, t)]), fill: colour }, b);
  return b;
}

/** A soft shadow on the floor. */
export function shadow(g, gx, gy, r, squash = 1) {
  const [x, y] = iso(gx, gy);
  return el('ellipse', { class: 'prop-shadow', cx: x, cy: y, rx: r * 32 * 1.25, ry: r * 16 * 1.25 * squash }, g);
}

/** A flat quad on the floor. */
function floorQuad(g, x0, y0, x1, y1, attrs) {
  return el('polygon', { points: pts([iso(x0, y0), iso(x1, y0), iso(x1, y1), iso(x0, y1)]), ...attrs }, g);
}

/** A quad standing up along x (a screen, a board) at depth gy, facing the viewer. */
function standX(g, gx0, gx1, gy, z0, z1, attrs) {
  return el('polygon', { points: pts([iso(gx0, gy, z0), iso(gx1, gy, z0), iso(gx1, gy, z1), iso(gx0, gy, z1)]), ...attrs }, g);
}

/** A quad standing up along y at gx (on wall a's plane), facing the viewer. */
function standY(g, gx, gy0, gy1, z0, z1, attrs) {
  return el('polygon', { points: pts([iso(gx, gy0, z0), iso(gx, gy1, z0), iso(gx, gy1, z1), iso(gx, gy0, z1)]), ...attrs }, g);
}

// ---------------------------------------------------------------- furniture

/** A desk: a top on two side panels. Returns the height of its top. */
export function desk(g, gx, gy, { sx = 0.36, sy = 0.2, colour = DESK_TOP } = {}) {
  shadow(g, gx + 0.04, gy + 0.04, 0.38, 0.8);
  box(g, gx - sx + 0.03, gy, 0.03, sy - 0.02, 0, 10, shade(colour, 0.7));
  box(g, gx + sx - 0.03, gy, 0.03, sy - 0.02, 0, 10, shade(colour, 0.7));
  box(g, gx, gy - sy + 0.04, sx - 0.05, 0.02, 3, 7, shade(colour, 0.6));
  box(g, gx, gy, sx, sy, 10, 2, colour);
  return 12;
}

/** A monitor on a stand, its screen facing the person at the desk. */
export function monitor(g, gx, gy, z, { half = 0.17, tall = 11, cls = 'screen-glow' } = {}) {
  box(g, gx, gy - 0.02, 0.03, 0.03, z, 3, '#20262e');
  const frame = standX(g, gx - half - 0.02, gx + half + 0.02, gy, z + 2, z + 4 + tall, { fill: '#151a21' });
  frame.classList.add('monitor');
  const screen = standX(g, gx - half, gx + half, gy + 0.005, z + 3.5, z + 3 + tall, { class: `screen ${cls}` });
  // A couple of lines of "work" on the screen.
  const [ax, ay] = iso(gx - half * 0.7, gy + 0.01, z + 3 + tall * 0.72);
  const [bx, by] = iso(gx + half * 0.3, gy + 0.01, z + 3 + tall * 0.72);
  el('line', { class: 'screen-text', x1: ax, y1: ay, x2: bx, y2: by }, g);
  const [cx, cy] = iso(gx - half * 0.7, gy + 0.01, z + 3 + tall * 0.45);
  const [dx, dy] = iso(gx + half * 0.6, gy + 0.01, z + 3 + tall * 0.45);
  el('line', { class: 'screen-text', x1: cx, y1: cy, x2: dx, y2: dy }, g);
  return screen;
}

/** A keyboard on the desk top. */
export function keyboard(g, gx, gy, z) {
  el('polygon', { points: pts([iso(gx - 0.12, gy - 0.04, z), iso(gx + 0.12, gy - 0.04, z), iso(gx + 0.12, gy + 0.04, z), iso(gx - 0.12, gy + 0.04, z)]), fill: '#2b323c' }, g);
}

/** An office chair whose back faces the viewer. */
export function chair(g, gx, gy, colour = CHAIR) {
  shadow(g, gx, gy, 0.14);
  box(g, gx, gy, 0.015, 0.015, 0, 6, '#1d232b');
  box(g, gx, gy, 0.12, 0.11, 6, 2.5, colour);
}

/** The chair's back, drawn after its sitter so it hides their lower back. */
export function chairBack(g, gx, gy, colour = CHAIR) {
  box(g, gx, gy + 0.11, 0.11, 0.02, 8, 9, colour);
}

/**
 * A person. Seated people face their screen (away from the viewer); standing
 * people face the viewer. Their look comes from their name, so it never changes.
 */
export function person(g, gx, gy, name, { seated = true, tint } = {}) {
  const r = rng(name);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const skin = pick(SKIN);
  const hair = pick(HAIR);
  const shirt = tint && r() < 0.35 ? tint : pick(SHIRT);
  const long = r() < 0.45;
  const p = el('g', { class: `person${seated ? ' seated' : ' standing'}`, style: `animation-delay:${(-r() * 3).toFixed(2)}s` }, g);
  const [x, y] = iso(gx, gy);
  const seat = seated ? 8.5 : 0;
  if (!seated) {
    el('ellipse', { class: 'prop-shadow', cx: x, cy: y, rx: 6, ry: 3 }, p);
    el('rect', { x: x - 3.2, y: y - 8, width: 2.6, height: 8, rx: 1, fill: '#1f2937' }, p);
    el('rect', { x: x + 0.6, y: y - 8, width: 2.6, height: 8, rx: 1, fill: '#1f2937' }, p);
  }
  const top = y - seat - 11;
  const body = el('g', { class: 'p-body' }, p);
  el('path', { d: `M${x - 4.6},${y - seat} L${x - 4.2},${top + 3} Q${x - 4},${top} ${x},${top} Q${x + 4},${top} ${x + 4.2},${top + 3} L${x + 4.6},${y - seat} Z`, fill: shirt }, body);
  el('path', { d: `M${x - 4.6},${y - seat} L${x - 4.2},${top + 3} Q${x - 4},${top} ${x},${top}`, fill: 'none', stroke: 'rgb(0 0 0 / 0.18)', 'stroke-width': 1 }, body);
  const head = el('g', { class: 'p-head' }, p);
  el('rect', { x: x - 1.2, y: top - 2, width: 2.4, height: 3, fill: shade(skin, 0.85) }, head);
  el('circle', { cx: x, cy: top - 4.6, r: 3.9, fill: skin }, head);
  if (seated) {
    // From behind: mostly hair.
    el('path', { d: `M${x - 4.1},${top - 4} Q${x - 4.2},${top - 9.2} ${x},${top - 9.1} Q${x + 4.2},${top - 9.2} ${x + 4.1},${top - 4} ${long ? `L${x + 4},${top + 1.5} L${x - 4},${top + 1.5}` : `Q${x},${top - 2.2} ${x - 4.1},${top - 4}`} Z`, fill: hair }, head);
  } else {
    el('path', { d: `M${x - 4},${top - 4.4} Q${x - 4.1},${top - 9.2} ${x},${top - 9.1} Q${x + 4.1},${top - 9.2} ${x + 4},${top - 4.4} Q${x + 1},${top - 7} ${x - 4},${top - 4.4} Z`, fill: hair }, head);
    el('circle', { cx: x - 1.4, cy: top - 4.2, r: 0.55, fill: '#111' }, head);
    el('circle', { cx: x + 1.4, cy: top - 4.2, r: 0.55, fill: '#111' }, head);
  }
  return p;
}

/** "You": a marker bobbing over the learner's own seat. */
export function youMarker(g, gx, gy) {
  const [x, y] = iso(gx, gy);
  const m = el('g', { class: 'you-marker' }, g);
  el('rect', { x: x - 11, y: y - 48, width: 22, height: 11, rx: 5.5, class: 'you-pill' }, m);
  el('text', { x, y: y - 39.6, class: 'you-text' }, m).textContent = 'YOU';
  el('path', { d: `M${x - 3},${y - 37} L${x + 3},${y - 37} L${x},${y - 33} Z`, class: 'you-pill' }, m);
}

/** An AI agent: a small bot hovering by its console, glowing in the room's colour. */
export function bot(g, gx, gy, tint) {
  const [x, y] = iso(gx, gy);
  // Its console: a low pedestal with a hologram ring.
  box(g, gx, gy + 0.05, 0.1, 0.1, 0, 5, '#273141');
  el('ellipse', { class: 'holo-ring', cx: x, cy: y - 6, rx: 9, ry: 4.5, stroke: tint }, g);
  const b = el('g', { class: 'bot', style: `--tint:${tint}` }, g);
  el('ellipse', { class: 'prop-shadow bot-shadow', cx: x, cy: y - 5, rx: 5, ry: 2.5 }, g);
  el('ellipse', { cx: x, cy: y - 20, rx: 5.6, ry: 6.8, fill: '#e5ebf2' }, b);
  el('ellipse', { cx: x + 1.6, cy: y - 18.5, rx: 3.2, ry: 4.6, fill: 'rgb(0 0 0 / 0.12)' }, b);
  el('rect', { class: 'bot-eye', x: x - 4, y: y - 22.5, width: 8, height: 3.2, rx: 1.6, fill: tint }, b);
  el('line', { x1: x, y1: y - 26.8, x2: x, y2: y - 30, stroke: '#cbd5e1', 'stroke-width': 1 }, b);
  el('circle', { class: 'bot-tip', cx: x, cy: y - 30.6, r: 1.3, fill: tint }, b);
  return b;
}

/** A pot plant. Big ones are leafy shrubs, small ones sit on a desk or shelf. */
export function plant(g, gx, gy, { big = true, seed = 'p' } = {}) {
  const r = rng(seed);
  shadow(g, gx, gy, big ? 0.16 : 0.08);
  const ph = big ? 7 : 4;
  box(g, gx, gy, big ? 0.09 : 0.05, big ? 0.09 : 0.05, 0, ph, POT);
  const [x, y] = iso(gx, gy, ph);
  const leaves = el('g', { class: 'leaves' }, g);
  const n = big ? 6 : 3;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r();
    const d = big ? 3 + r() * 3 : 1.5 + r();
    const rr = big ? 3.6 + r() * 2.2 : 2 + r();
    el('circle', { cx: x + Math.cos(a) * d, cy: y - (big ? 8 : 3) - Math.sin(a) * d * 0.7 - r() * (big ? 6 : 2), r: rr, fill: LEAVES[Math.floor(r() * LEAVES.length)] }, leaves);
  }
  el('circle', { cx: x, cy: y - (big ? 14 : 5), r: big ? 3.4 : 1.8, fill: LEAVES[3] }, leaves);
}

/** A water cooler. */
export function cooler(g, gx, gy) {
  shadow(g, gx, gy, 0.12);
  box(g, gx, gy, 0.08, 0.08, 0, 12, '#dfe5ec');
  const [x, y] = iso(gx, gy, 12);
  el('ellipse', { cx: x, cy: y - 5, rx: 4.2, ry: 6, fill: '#7cc4f0', 'fill-opacity': 0.85 }, g);
  el('ellipse', { cx: x - 1.4, cy: y - 7, rx: 1, ry: 2.4, fill: '#fff', 'fill-opacity': 0.6 }, g);
}

/** A bookshelf against the back wall, with books in a few colours. */
export function shelf(g, gx, gy, seed) {
  const r = rng(seed);
  shadow(g, gx, gy, 0.3, 0.5);
  box(g, gx, gy, 0.3, 0.1, 0, 22, WOOD);
  for (const z of [6, 13, 20]) {
    let at = gx - 0.26;
    while (at < gx + 0.22) {
      const w = 0.03 + r() * 0.04;
      const hgt = 4 + r() * 2;
      el('polygon', { points: pts([iso(at, gy + 0.105, z - 5.5), iso(at + w, gy + 0.105, z - 5.5), iso(at + w, gy + 0.105, z - 5.5 + hgt), iso(at, gy + 0.105, z - 5.5 + hgt)]), fill: SHIRT[Math.floor(r() * SHIRT.length)] }, g);
      at += w + 0.012;
    }
  }
}

/** A sofa against wall a, facing into the room. */
export function sofa(g, gx, gy, tint) {
  shadow(g, gx, gy, 0.34, 0.8);
  const c = tint.startsWith('#') ? tint : '#64748b';
  box(g, gx - 0.13, gy, 0.07, 0.32, 0, 13, shade(c, 0.8));
  box(g, gx + 0.04, gy, 0.14, 0.32, 0, 7, c);
  box(g, gx + 0.04, gy - 0.29, 0.14, 0.04, 0, 10, shade(c, 0.9));
  box(g, gx + 0.04, gy + 0.29, 0.14, 0.04, 0, 10, shade(c, 0.9));
}

/** A small round meeting table with chairs. */
export function meetingTable(g, gx, gy) {
  for (const [dx, dy] of [[-0.24, 0], [0, -0.22]]) chair(g, gx + dx, gy + dy, '#334155');
  shadow(g, gx, gy, 0.24);
  box(g, gx, gy, 0.02, 0.02, 0, 10, '#1f2937');
  const [x, y] = iso(gx, gy, 10);
  el('ellipse', { cx: x, cy: y + 1.5, rx: 14, ry: 7, fill: shade(DESK_TOP, 0.65) }, g);
  el('ellipse', { cx: x, cy: y, rx: 14, ry: 7, fill: DESK_TOP }, g);
  el('rect', { x: x - 3, y: y - 2, width: 5, height: 3, fill: '#e2e8f0', transform: `rotate(18 ${x} ${y})` }, g);
  for (const [dx, dy] of [[0.24, 0], [0, 0.22]]) chair(g, gx + dx, gy + dy, '#334155');
}

/** A rug on the floor. */
export function rug(g, x0, y0, x1, y1, tint) {
  floorQuad(g, x0, y0, x1, y1, { class: 'rug', fill: tint });
  floorQuad(g, x0 + 0.08, y0 + 0.08, x1 - 0.08, y1 - 0.08, { class: 'rug-inner', stroke: tint });
}

/** A whiteboard on wall a (the plane gx = wallX), with a few coloured scribbles. */
export function whiteboard(g, wallX, gy0, gy1, seed) {
  const r = rng(seed);
  standY(g, wallX + 0.02, gy0, gy1, 12, 30, { fill: '#9aa5b1' });
  standY(g, wallX + 0.03, gy0 + 0.04, gy1 - 0.04, 13, 29, { class: 'board', fill: '#eef2f6' });
  for (let i = 0; i < 4; i++) {
    const z = 26 - i * 3.5;
    const a = gy0 + 0.1 + r() * 0.1;
    const b = a + 0.2 + r() * (gy1 - gy0 - 0.45);
    const [x1, y1] = iso(wallX + 0.04, a, z);
    const [x2, y2] = iso(wallX + 0.04, b, z);
    el('line', { x1, y1, x2, y2, stroke: ['#2563eb', '#dc2626', '#16a34a', '#1f2937'][i], 'stroke-width': 1.1, 'stroke-linecap': 'round' }, g);
  }
}

/** A door in wall a. */
export function door(g, wallX, gy0, gy1, height) {
  standY(g, wallX + 0.01, gy0, gy1, 0, height, { class: 'door' });
  standY(g, wallX + 0.015, gy0 + 0.03, gy1 - 0.03, 0, height - 1.5, { class: 'door-leaf' });
  const [x, y] = iso(wallX + 0.02, gy1 - 0.08, height * 0.45);
  el('circle', { cx: x, cy: y, r: 0.9, fill: '#cbd5e1' }, g);
}

/** A row of windows along wall a (constant gx), between gy0 and gy1. */
export function windowsA(g, wallX, gy0, gy1, z0, z1) {
  const n = Math.max(1, Math.round((gy1 - gy0) / 0.85));
  const step = (gy1 - gy0) / n;
  for (let i = 0; i < n; i++) {
    const a = gy0 + i * step + 0.06;
    const b = gy0 + (i + 1) * step - 0.06;
    standY(g, wallX + 0.01, a, b, z0, z1, { class: 'window-pane' });
    const [x1, y1] = iso(wallX + 0.012, a + (b - a) * 0.25, z1 - 2);
    const [x2, y2] = iso(wallX + 0.012, a + (b - a) * 0.6, z0 + 2);
    el('line', { class: 'window-glare', x1, y1, x2, y2 }, g);
  }
}

/** A row of windows along wall b (constant gy), between gx0 and gx1. */
export function windowsB(g, wallY, gx0, gx1, z0, z1) {
  const n = Math.max(1, Math.round((gx1 - gx0) / 0.85));
  const step = (gx1 - gx0) / n;
  for (let i = 0; i < n; i++) {
    const a = gx0 + i * step + 0.06;
    const b = gx0 + (i + 1) * step - 0.06;
    standX(g, a, b, wallY + 0.01, z0, z1, { class: 'window-pane' });
    const [x1, y1] = iso(a + (b - a) * 0.25, wallY + 0.012, z1 - 2);
    const [x2, y2] = iso(a + (b - a) * 0.6, wallY + 0.012, z0 + 2);
    el('line', { class: 'window-glare', x1, y1, x2, y2 }, g);
  }
}

/** A ceiling light's pool on the floor; it shows most at night. */
export function lightPool(g, gx, gy, rx) {
  const [x, y] = iso(gx, gy);
  el('ellipse', { class: 'light-pool', cx: x, cy: y, rx: rx * 32, ry: rx * 16 }, g);
}

// ---------------------------------------------------------------- outside

export function tree(g, gx, gy, seed, scale = 1) {
  const r = rng(seed);
  const [x, y] = iso(gx, gy);
  el('ellipse', { class: 'prop-shadow', cx: x + 4, cy: y + 1, rx: 13 * scale, ry: 6.5 * scale }, g);
  el('rect', { x: x - 1.6 * scale, y: y - 14 * scale, width: 3.2 * scale, height: 14 * scale, fill: '#5b3a22' }, g);
  const crown = el('g', { class: 'tree-crown', style: `animation-delay:${(-r() * 4).toFixed(2)}s` }, g);
  const greens = ['#1f6f43', '#2b8a52', '#237a4a', '#3a9d5d'];
  for (let i = 0; i < 6; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * 6 * scale;
    el('circle', { cx: x + Math.cos(a) * d, cy: y - 22 * scale - Math.sin(a) * d * 0.8, r: (6 + r() * 3) * scale, fill: greens[i % greens.length] }, crown);
  }
  el('circle', { cx: x - 2 * scale, cy: y - 26 * scale, r: 4.5 * scale, fill: '#4fb071', 'fill-opacity': 0.8 }, crown);
}

export function bush(g, gx, gy, seed) {
  const r = rng(seed);
  const [x, y] = iso(gx, gy);
  el('ellipse', { class: 'prop-shadow', cx: x + 2, cy: y + 1, rx: 8, ry: 4 }, g);
  for (let i = 0; i < 4; i++) el('circle', { cx: x - 4 + i * 2.6 + r(), cy: y - 3 - r() * 3, r: 3 + r() * 1.6, fill: ['#2b8a52', '#237a4a', '#3a9d5d'][i % 3] }, g);
}

/** A car parked along x. */
export function car(g, gx, gy, seed) {
  const r = rng(seed);
  const c = CARS[Math.floor(r() * CARS.length)];
  shadow(g, gx, gy, 0.42, 0.55);
  box(g, gx, gy, 0.42, 0.2, 2, 7, c);
  box(g, gx - 0.04, gy, 0.22, 0.17, 9, 5, shade(c, 0.92));
  // Windows on the cabin.
  el('polygon', { points: pts([iso(gx - 0.24, gy + 0.175, 13.5), iso(gx + 0.16, gy + 0.175, 13.5), iso(gx + 0.16, gy + 0.175, 9.5), iso(gx - 0.24, gy + 0.175, 9.5)]), class: 'car-glass' }, g);
  el('polygon', { points: pts([iso(gx + 0.185, gy - 0.15, 13.5), iso(gx + 0.185, gy + 0.15, 13.5), iso(gx + 0.185, gy + 0.15, 9.5), iso(gx + 0.185, gy - 0.15, 9.5)]), class: 'car-glass' }, g);
  for (const dx of [-0.26, 0.26]) {
    const [wx, wy] = iso(gx + dx, gy + 0.2, 2);
    el('ellipse', { cx: wx, cy: wy, rx: 3.4, ry: 2.6, fill: '#0b0f14' }, g);
  }
  const [hx, hy] = iso(gx + 0.42, gy + 0.1, 6);
  el('circle', { class: 'headlight', cx: hx, cy: hy, r: 1.3 }, g);
}

/** A street lamp; its light shows at night. */
export function streetLamp(g, gx, gy) {
  const [x, y] = iso(gx, gy);
  el('ellipse', { class: 'lamp-pool', cx: x, cy: y, rx: 34, ry: 17 }, g);
  el('rect', { x: x - 0.9, y: y - 34, width: 1.8, height: 34, fill: '#475569' }, g);
  el('path', { d: `M${x},${y - 34} q 0,-4 6,-4`, stroke: '#475569', 'stroke-width': 1.8, fill: 'none' }, g);
  el('circle', { class: 'lamp-bulb', cx: x + 6.5, cy: y - 37.5, r: 2.2 }, g);
}

/** A road along x from gx0 to gx1 at depth gy, with a dashed centre line. */
export function roadX(g, gx0, gx1, gy, width = 1) {
  floorQuad(g, gx0, gy - width / 2, gx1, gy + width / 2, { class: 'street' });
  floorQuad(g, gx0, gy - width / 2 - 0.12, gx1, gy - width / 2, { class: 'kerb' });
  const [x1, y1] = iso(gx0, gy);
  const [x2, y2] = iso(gx1, gy);
  el('line', { class: 'street-line', x1, y1, x2, y2 }, g);
}

/** A patch of lawn round a building. */
export function lawn(g, x0, y0, x1, y1) {
  floorQuad(g, x0, y0, x1, y1, { class: 'lawn' });
}
