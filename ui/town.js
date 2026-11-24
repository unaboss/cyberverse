// The start screen's town: one building per tower. Blue buildings on the left
// defend, red ones on the right attack, and each side climbs from intro at the
// front to advanced at the back. A building's storeys are its floors: a storey
// lights up once its floor can be played, and a tower with no floors yet is
// drawn as a building still under construction.
//
// Screen maths: the town uses the office floor's isometric grid, written in
// (d, s) = (gx - gy, gx + gy), so that x = d * TW / 2 and y = s * TH / 2 - z.

const SVG = 'http://www.w3.org/2000/svg';
const TW = 64;
const TH = 32;
const STOREY = 14;
const GROUND = 11; // the town is an 11 x 11 grid
const HALF = 0.8; // half a building's footprint, in grid cells
// Where each building stands, for the blue side (the red side mirrors d). The
// intro tower is at the front by the road, the intermediate one further out, and
// the advanced one at the back, high enough that the intro tower never hides it.
const SITE = {
  advanced: { d: 2.5, s: 6.5, sign: 'top' },
  intermediate: { d: 6, s: 11.5, sign: 'top' },
  intro: { d: 2.5, s: 17, sign: 'bottom' },
};
const STOREYS = { intro: 8, intermediate: 10, advanced: 12 };
const TIER_NAME = { intro: 'Intro', intermediate: 'Intermediate', advanced: 'Advanced' };
const DRAW_ORDER = ['advanced', 'intermediate', 'intro']; // back to front
const SIDE = {
  prey: { sign: -1, hue: 'var(--benign)', title: 'Defend', team: 'blue team' },
  predator: { sign: 1, hue: 'var(--hostile)', title: 'Attack', team: 'red team' },
};

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null && v !== false) node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

/** (d, s, z) to screen. */
function at(d, s, z = 0) {
  return [(d * TW) / 2, (s * TH) / 2 - z];
}

function pts(list) {
  return list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

/** A point part of the way along a building face, at height z. */
function along(a, b, t, z) {
  return at(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z);
}

/** What one storey shows: done, next, open (playable), or dark. */
function storeyState(floor, done, next) {
  if (!floor?.practical) return 'dark';
  if (done.has(floor.practical)) return 'done';
  return floor === next ? 'next' : 'open';
}

/** The first playable floor you have not done yet. */
export function nextFloor(tower, done) {
  return [...tower.floors].sort((a, b) => a.floor - b.floor).find((f) => f.practical && !done.has(f.practical)) ?? null;
}

/** One line on how far a tower is built. */
export function towerStatus(tower, done) {
  const open = tower.floors.filter((f) => f.practical);
  if (tower.floors.length === 0) return 'Under construction';
  if (open.length === 0) return 'Floors being designed';
  const cleared = open.filter((f) => done.has(f.practical)).length;
  if (cleared === open.length) return `All ${open.length} open floors done`;
  const next = nextFloor(tower, done);
  return next ? `Floor ${next.floor} is next` : `${open.length} floors open`;
}

export class Town {
  /**
   * @param {SVGSVGElement} svg
   * @param {{ onPick: (towerId: string) => void }} handlers
   */
  constructor(svg, handlers) {
    this.svg = svg;
    this.handlers = handlers;
  }

  /**
   * @param {{ id: string, name: string, role: 'prey' | 'predator', tier: string, floors: { floor: number, title: string, practical: string | null }[] }[]} towers
   * @param {{ selected: string | null, done: Set<string> }} options
   */
  render(towers, { selected, done }) {
    const svg = this.svg;
    svg.replaceChildren();
    const defs = el('defs', {}, svg);
    const clip = el('clipPath', { id: 'town-ground' }, defs);
    el('polygon', { points: pts([at(0, 0), at(GROUND, GROUND), at(0, 2 * GROUND), at(-GROUND, GROUND)]) }, clip);

    this.drawGround(svg);
    for (const role of ['prey', 'predator']) {
      const side = SIDE[role];
      const [x, y] = at(side.sign * 7.6, -7.4);
      const title = el('text', { x, y, class: `town-side ${role}`, 'text-anchor': 'middle' }, svg);
      title.textContent = side.title;
      const team = el('text', { x, y: y + 18, class: 'town-team', 'text-anchor': 'middle' }, svg);
      team.textContent = side.team;
    }
    for (const tier of DRAW_ORDER) { // back to front, so nearer buildings overlap farther ones
      for (const role of ['prey', 'predator']) {
        const tower = towers.find((t) => t.role === role && t.tier === tier);
        if (tower) this.drawBuilding(svg, tower, tower.id === selected, done);
      }
    }
  }

  drawGround(svg) {
    const g = el('g', { class: 'town-ground', 'aria-hidden': 'true' }, svg);
    el('polygon', { class: 'half prey', points: pts([at(0, 0), at(0, 2 * GROUND), at(-GROUND, GROUND)]) }, g);
    el('polygon', { class: 'half predator', points: pts([at(0, 0), at(GROUND, GROUND), at(0, 2 * GROUND)]) }, g);
    // A faint street grid: lines of constant gx and gy, every two cells.
    const grid = el('g', { class: 'grid', 'clip-path': 'url(#town-ground)' }, g);
    for (let k = 2; k < GROUND; k += 2) {
      el('line', { x1: at(k, k)[0], y1: at(k, k)[1], x2: at(k - GROUND, k + GROUND)[0], y2: at(k - GROUND, k + GROUND)[1] }, grid);
      el('line', { x1: at(-k, k)[0], y1: at(-k, k)[1], x2: at(GROUND - k, k + GROUND)[0], y2: at(GROUND - k, k + GROUND)[1] }, grid);
    }
    // The road between the two sides.
    const road = el('g', { class: 'road', 'clip-path': 'url(#town-ground)' }, g);
    el('line', { class: 'tar', x1: 0, y1: 0, x2: 0, y2: GROUND * TH }, road);
    el('line', { class: 'stripe', x1: 0, y1: 6, x2: 0, y2: GROUND * TH - 6 }, road);
    el('polygon', { class: 'edge', points: pts([at(0, 0), at(GROUND, GROUND), at(0, 2 * GROUND), at(-GROUND, GROUND)]) }, g);
  }

  drawBuilding(svg, tower, selected, done) {
    const side = SIDE[tower.role];
    const site = SITE[tower.tier] ?? SITE.intro;
    const dc = side.sign * site.d;
    const sc = site.s;
    const built = tower.floors.length > 0;
    const maxFloor = Math.max(-1, ...tower.floors.map((f) => f.floor));
    const storeys = Math.max(STOREYS[tower.tier] ?? 8, maxFloor + 1);
    const height = storeys * STOREY;
    const next = nextFloor(tower, done);
    const status = towerStatus(tower, done);
    const tierName = TIER_NAME[tower.tier] ?? tower.tier;

    // Footprint corners in (d, s).
    const back = [dc, sc - 2 * HALF];
    const right = [dc + 2 * HALF, sc];
    const front = [dc, sc + 2 * HALF];
    const left = [dc - 2 * HALF, sc];
    const ring = (z) => [at(...back, z), at(...right, z), at(...front, z), at(...left, z)];

    const g = el(
      'g',
      {
        class: `building ${tower.role} ${built ? 'built' : 'building-site'}${selected ? ' selected' : ''}`,
        role: 'button',
        tabindex: 0,
        'aria-pressed': selected ? 'true' : 'false',
        'aria-label': `${tower.name}. ${status}.`,
        'data-tower': tower.id,
        style: `--hue: ${side.hue}`,
      },
      svg,
    );
    const pick = () => this.handlers.onPick(tower.id);
    g.addEventListener('click', pick);
    g.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        pick();
      }
    });
    const title = el('title', {}, g);
    title.textContent = `${tower.name}: ${status}`;

    // The plot: a glow on the ground, brighter when this tower is picked.
    const plotRing = [at(dc, sc - 2 * HALF - 0.5), at(dc + 2 * HALF + 0.5, sc), at(dc, sc + 2 * HALF + 0.5), at(dc - 2 * HALF - 0.5, sc)];
    el('polygon', { class: 'plot', points: pts(plotRing) }, g);

    // Walls and roof: a solid dark body with the side's colour washed over it.
    const leftFace = [at(...left), at(...front), at(...front, height), at(...left, height)];
    const rightFace = [at(...front), at(...right), at(...right, height), at(...front, height)];
    const roof = ring(height);
    for (const [cls, face] of [['wall-left', leftFace], ['wall-right', rightFace], ['roof', roof]]) {
      el('polygon', { class: 'body', points: pts(face) }, g);
      el('polygon', { class: `face ${cls}`, points: pts(face) }, g);
    }

    if (built) {
      // One storey per floor, windows lit by what the floor holds.
      const byFloor = new Map(tower.floors.map((f) => [f.floor, f]));
      for (let k = 0; k < storeys; k++) {
        const state = storeyState(byFloor.get(k), done, next);
        const z0 = k * STOREY + 3;
        const z1 = (k + 1) * STOREY - 3;
        for (const [a, b] of [[left, front], [front, right]]) {
          for (const [t0, t1] of [[0.1, 0.3], [0.4, 0.6], [0.7, 0.9]]) {
            el('polygon', { class: `win ${state}`, points: pts([along(a, b, t0, z0), along(a, b, t1, z0), along(a, b, t1, z1), along(a, b, t0, z1)]) }, g);
          }
        }
      }
    } else {
      // Under construction: storey lines and a crane on the roof.
      for (let k = 1; k < storeys; k++) {
        el('polyline', { class: 'scaffold', points: pts([at(...left, k * STOREY), at(...front, k * STOREY), at(...right, k * STOREY)]) }, g);
      }
      const [mx, my] = at(dc, sc, height);
      el('line', { class: 'crane', x1: mx, y1: my, x2: mx, y2: my - 34 }, g);
      el('line', { class: 'crane', x1: mx - 14 * side.sign, y1: my - 34, x2: mx + 30 * side.sign, y2: my - 34 }, g);
      el('line', { class: 'crane thin', x1: mx + 24 * side.sign, y1: my - 34, x2: mx + 24 * side.sign, y2: my - 18 }, g);
    }
    el('polyline', { class: 'outline', points: pts([...leftFace.slice(0, 2), at(...right), at(...right, height), at(...back, height), at(...left, height), at(...left)]) }, g);
    el('polyline', { class: 'outline', points: pts([at(...front), at(...front, height)]) }, g);

    if (built && tower.tier === 'advanced') {
      const [mx, my] = at(dc, sc, height);
      el('line', { class: 'mast', x1: mx, y1: my, x2: mx, y2: my - 26 }, g);
      el('circle', { class: 'beacon', cx: mx, cy: my - 28, r: 3 }, g);
    }

    // The sign: tier name and how far the tower is built, above or below it.
    const [lx] = at(dc, sc);
    const topY = at(...back, height)[1] - (built && tower.tier === 'advanced' ? 34 : built ? 0 : 36);
    const [nameY, lineY] = site.sign === 'top' ? [topY - 26, topY - 11] : [at(...front)[1] + 22, at(...front)[1] + 37];
    const name = el('text', { class: 'town-label', x: lx, y: nameY, 'text-anchor': 'middle' }, g);
    name.textContent = tierName;
    const line = el('text', { class: 'town-status', x: lx, y: lineY, 'text-anchor': 'middle' }, g);
    line.textContent = status;
  }
}
