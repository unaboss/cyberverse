// The office floor: an isometric SVG of one organisation. Rooms are the
// departments, the blocks inside are machines. Rooms flash when an alert
// lands there, sparks show traffic the sensors saw, and every machine is
// clickable.
//
// The map grows as a tower climbs. Each floor names the rooms it draws (its
// scope); a room the floor needs later is built in when it is needed. A camera
// frames the rooms: drag to move it, scroll or pinch to zoom, double-click a room
// to fly to it. When a floor opens, the camera starts on the rooms you already
// know and pulls back as the new ones rise into place.

import { el, iso, pts, rng, TW, TH } from './iso.js';
import * as P from './props.js';

const WALL = 38; // height of a room's back walls
const SLAB = 12; // thickness of the building's floor plate
const ROOM_GAP = 0.08; // cells between a room's floor and its neighbour's

/** Pixels per map unit the camera may reach: a room never fills more than this. */
const MAX_SCALE = 2.1;
const MIN_SCALE = 0.22;

const HEIGHT_BY_KIND = {
  server: 28, database: 22, directory: 28, file: 24, backup: 26, storage: 28, git: 24, security: 26,
  web: 26, mail: 24, ai: 28, desktop: 8, laptop: 3, workstation: 8, ot: 20, decoy: 22, unknown: 16,
  iot: 8, router: 8, pos: 10,
};

/** How each kind of machine is drawn. */
const SHAPE_BY_KIND = {
  server: 'rack', directory: 'rack', file: 'rack', backup: 'rack', storage: 'rack', git: 'rack', security: 'rack',
  web: 'rack', mail: 'rack', ai: 'rack', database: 'db', desktop: 'desk', workstation: 'desk', laptop: 'laptop',
  router: 'router', iot: 'router', pos: 'till',
};

/** Each department's tint, in order, so the rooms read apart at a glance. */
const TINTS = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#22d3ee', '#fb923c', '#818cf8', '#a3e635', '#f87171', '#2dd4bf', '#e879f9', '#facc15', '#60a5fa', '#4ade80', '#fb7185'];




const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Screen bounds of a set of grid rectangles, walls included. */
/** The grid box round some rects, or null for none. */
function bbox(rects) {
  if (rects.length === 0) return null;
  return {
    x0: Math.min(...rects.map((r) => r.x)),
    y0: Math.min(...rects.map((r) => r.y)),
    x1: Math.max(...rects.map((r) => r.x + r.w)),
    y1: Math.max(...rects.map((r) => r.y + r.h)),
  };
}

function boundsOf(rects) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y, w, h } of rects) {
    for (const [gx, gy] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) {
      const [sx, sy] = iso(gx, gy);
      minX = Math.min(minX, sx);
      maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy - WALL - 6);
      maxY = Math.max(maxY, sy + SLAB);
    }
  }
  return { minX, minY, maxX, maxY };
}

function grow(b, by) {
  return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}

function union(a, b) {
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

/** Split a name over two lines near its middle. */
function twoLines(text) {
  const words = text.split(' ');
  if (words.length < 2) return null;
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const worst = Math.max(a.length, b.length);
    if (!best || worst < best.worst) best = { lines: [a, b], worst };
  }
  return best.lines;
}

export class Floor {
  /**
   * @param {SVGSVGElement} svg
   * @param {{ onHost: (key: string) => void, onRoom: (deptId: string, event: MouseEvent) => void, onCamera?: () => void }} handlers
   */
  constructor(svg, handlers) {
    this.svg = svg;
    this.handlers = handlers;
    this.rooms = new Map(); // dept id -> { group, floorPts, centre, rect }
    this.hostNodes = new Map(); // host key -> { g, badge, anchor }
    this.hostRoom = new Map(); // host key -> dept id, for every machine, drawn or not
    this.anchors = new Map(); // "internet" | "partner" -> [x, y]
    this.sparks = 0;
    this.selected = null;
    this.layoutKey = '';
    this.extra = new Set(); // rooms built in during the round
    this.opts = { map: null, known: null, intro: false };
    this.cam = null; // { x, y, w, h } in map units
    this.auto = true; // the camera frames everything until you move it
    this.content = null;
    this.pending = []; // rooms waiting for the intro to raise them
    this.bindCamera();
  }

  // ---------------------------------------------------------------- scope

  /**
   * Set up the next round's map: which rooms it draws, which you already know
   * from the floor below, and whether to hold the new ones back for the intro.
   */
  prepare({ map = null, known = null, intro = false } = {}) {
    this.opts = { map, known, intro };
    this.extra.clear();
    this.layoutKey = '';
    this.cam = null;
    this.auto = true;
    this.org = null;
  }

  /** The department ids this floor draws right now. */
  scope(org, role) {
    const all = org.departments.map((d) => d.id);
    const wanted = this.opts.map?.rooms;
    if (role === 'predator' || !wanted || wanted.length === 0) return new Set(all);
    return new Set(all.filter((id) => wanted.includes(id) || this.extra.has(id)));
  }

  /** Rooms in this floor's map that the floor below did not have. */
  newRooms(org, role) {
    const known = this.opts.known;
    const scope = this.scope(org, role);
    if (!known) return [...scope];
    return [...scope].filter((id) => !known.includes(id));
  }

  /** The room a machine sits in. */
  roomOf(hostKey) {
    return this.hostRoom.get(hostKey) ?? null;
  }

  /** A room's tint, for things outside the map that name it. */
  tint(deptId) {
    return this.tints?.get(deptId) ?? 'var(--accent)';
  }

  /** True when a room is on the map. */
  has(deptId) {
    return this.rooms.has(deptId);
  }

  /**
   * Build a room into the map mid-round, because the floor needs it now. Returns
   * the room's name when it was new, or null when it was already there.
   */
  reveal(deptId) {
    if (!deptId || this.rooms.has(deptId) || !this.org) return null;
    const dept = this.org.departments.find((d) => d.id === deptId);
    if (!dept) return null;
    this.extra.add(deptId);
    this.layoutKey = '';
    this.render(this.org, this.role, { raise: [deptId] });
    if (this.auto) this.fit({ animate: true });
    else this.show([deptId], { animate: true });
    return dept.name;
  }

  // ---------------------------------------------------------------- render

  /** Draw (or redraw) the whole floor from a snapshot's org view. */
  render(org, role, { raise = [] } = {}) {
    this.hostRoom.clear();
    for (const dept of org.departments) for (const host of dept.hosts) this.hostRoom.set(host.key, dept.id);
    const scope = this.scope(org, role);
    const map = role === 'predator' ? null : this.opts.map;
    const key = JSON.stringify([org.id, role, [...scope], map, org.departments.map((d) => [d.id, d.revealed, d.hosts.map((h) => h.key)])]);
    const firstDraw = this.org?.id !== org.id || !this.cam;
    this.org = org;
    this.role = role;
    if (key === this.layoutKey) {
      this.update(org);
      return;
    }
    this.layoutKey = key;
    this.svg.replaceChildren();
    this.rooms.clear();
    this.hostNodes.clear();
    this.svg.style.setProperty('--org', org.colour);

    const tintOf = new Map(org.departments.map((d, i) => [d.id, TINTS[i % TINTS.length]]));
    this.tints = tintOf;
    // Each site (a building, the depot, the cloud) is moved apart on the map.
    const sites = (org.sites ?? [{ id: 'building', name: org.name, kind: 'building', rooms: org.departments.map((d) => d.id), shift: { x: 0, y: 0 } }]).map((site) => ({ ...site }));
    const siteOf = new Map(sites.flatMap((site) => site.rooms.map((id) => [id, site])));
    const placed = org.departments.map((d) => {
      const at = siteOf.get(d.id)?.shift ?? { x: 0, y: 0 };
      return { ...d, room: { ...d.room, x: d.room.x + at.x, y: d.room.y + at.y } };
    });
    const depts = placed.filter((d) => scope.has(d.id));
    // A site is on the map once one of its rooms is; its plate covers the rooms that are.
    for (const site of sites) site.box = bbox(depts.filter((d) => site.rooms.includes(d.id)).map((d) => d.room));
    const open = sites.filter((site) => site.box);
    const plate = open.length > 0 ? open.map((site) => site.box).reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) })) : { x0: 0, y0: 0, x1: 4, y1: 4 };

    this.defs();
    this.ground(plate);
    const sceneryFront = this.scenery(open, plate);
    if (open.length > 1) this.roads(open);
    for (const site of open) {
      this.slab(site.box, site.kind);
      if (org.sites) this.siteSign(site, open);
    }
    // Rooms inside a building that this floor has not opened yet sit dark.
    for (const d of placed) {
      const box = siteOf.get(d.id)?.box;
      const r = d.room;
      if (scope.has(d.id) || !box || r.x < box.x0 || r.y < box.y0 || r.x + r.w > box.x1 || r.y + r.h > box.y1) continue;
      this.shell(d);
    }

    // Rooms back to front.
    this.fx = el('g', { class: 'fx' });
    this.labels = el('g', { class: 'labels' });
    const ordered = [...depts].sort((a, b) => a.room.x + a.room.y - (b.room.x + b.room.y));
    for (const dept of ordered) this.drawRoom(dept, role, tintOf.get(dept.id), siteOf.get(dept.id)?.box);
    this.svg.appendChild(sceneryFront);

    if (map?.perimeter) this.firewall(plate);

    // Beyond the walls: the internet off the left corner, partners off the right.
    const outside = map?.outside ?? ['internet', 'partners'];
    this.anchors.clear();
    const anchors = el('g', { class: 'outside' }, this.svg);
    // Site signs sit on the ground just in front of each plate.
    const front = org.sites ? 1.3 : 0;
    let content = boundsOf([{ x: plate.x0, y: plate.y0, w: plate.x1 - plate.x0, h: plate.y1 - plate.y0 + front }]);
    if (outside.includes('internet')) {
      const [lx, ly] = iso(plate.x0, plate.y1);
      const at = [lx - 96, ly - 26];
      this.anchors.set('internet', at);
      this.globe(anchors, at);
      content = union(content, { minX: at[0] - 40, minY: at[1] - 40, maxX: at[0] + 40, maxY: at[1] + 52 });
    }
    if (outside.includes('partners')) {
      const [rx, ry] = iso(plate.x1, plate.y0);
      const at = [rx + 96, ry - 26];
      this.anchors.set('partner', at);
      this.partners(anchors, at);
      content = union(content, { minX: at[0] - 40, minY: at[1] - 40, maxX: at[0] + 40, maxY: at[1] + 52 });
    }
    this.content = grow(content, 24);

    this.svg.appendChild(this.labels);
    this.svg.appendChild(this.fx);
    this.update(org);

    // Rooms that are new on this floor wait, hidden, for the intro to raise them.
    const holding = (this.opts.intro && firstDraw ? this.newRooms(org, role) : this.pending).filter((id) => this.rooms.has(id));
    this.pending = holding;
    for (const id of holding) this.rooms.get(id).group.classList.add('pending');
    for (const id of raise) this.raise([id]);

    if (firstDraw) {
      const known = holding.length > 0 && holding.length < this.rooms.size ? [...this.rooms.keys()].filter((id) => !holding.includes(id)) : null;
      if (known) this.show(known, { animate: false, tight: true });
      else if (holding.length > 0) this.fit({ animate: false, zoom: 1.7 });
      else this.fit({ animate: false });
    } else {
      this.applyCam();
    }
  }

  defs() {
    const defs = el('defs', {}, this.svg);
    const glow = el('filter', { id: 'glow', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
    el('feGaussianBlur', { stdDeviation: 2.5, result: 'b' }, glow);
    const merge = el('feMerge', {}, glow);
    el('feMergeNode', { in: 'b' }, merge);
    el('feMergeNode', { in: 'SourceGraphic' }, merge);
    const shade = el('linearGradient', { id: 'wall-shade', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el('stop', { offset: 0, 'stop-color': '#ffffff', 'stop-opacity': 0.1 }, shade);
    el('stop', { offset: 1, 'stop-color': '#000000', 'stop-opacity': 0.28 }, shade);
    const pool = el('radialGradient', { id: 'light-pool', cx: 0.5, cy: 0.5, r: 0.5 }, defs);
    el('stop', { offset: 0, 'stop-color': '#fff6dc', 'stop-opacity': 0.55 }, pool);
    el('stop', { offset: 1, 'stop-color': '#fff6dc', 'stop-opacity': 0 }, pool);
    const lamp = el('radialGradient', { id: 'lamp-pool', cx: 0.5, cy: 0.5, r: 0.5 }, defs);
    el('stop', { offset: 0, 'stop-color': '#ffd27a', 'stop-opacity': 0.5 }, lamp);
    el('stop', { offset: 1, 'stop-color': '#ffd27a', 'stop-opacity': 0 }, lamp);
    const glass = el('linearGradient', { id: 'glass', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el('stop', { offset: 0, class: 'glass-top' }, glass);
    el('stop', { offset: 1, class: 'glass-bottom' }, glass);
    const screen = el('linearGradient', { id: 'screen-glow', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el('stop', { offset: 0, 'stop-color': '#7dd3fc' }, screen);
    el('stop', { offset: 1, 'stop-color': '#2563eb' }, screen);
    const fade = el('radialGradient', { id: 'ground-fade', cx: 0.5, cy: 0.5, r: 0.5 }, defs);
    el('stop', { offset: 0.35, 'stop-color': '#fff', 'stop-opacity': 1 }, fade);
    el('stop', { offset: 1, 'stop-color': '#fff', 'stop-opacity': 0 }, fade);
  }

  /** A faint grid on the ground round the building, fading out at the edges. */
  ground(plate) {
    const pad = 4;
    const x0 = Math.floor(plate.x0 - pad);
    const y0 = Math.floor(plate.y0 - pad);
    const x1 = Math.ceil(plate.x1 + pad);
    const y1 = Math.ceil(plate.y1 + pad);
    const b = boundsOf([{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }]);
    const mask = el('mask', { id: 'ground-mask', maskUnits: 'userSpaceOnUse', x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY }, this.svg.querySelector('defs'));
    el('rect', { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY, fill: 'url(#ground-fade)' }, mask);
    const g = el('g', { class: 'ground', mask: 'url(#ground-mask)' }, this.svg);
    for (let gx = x0; gx <= x1; gx++) el('line', { x1: iso(gx, y0)[0], y1: iso(gx, y0)[1], x2: iso(gx, y1)[0], y2: iso(gx, y1)[1] }, g);
    for (let gy = y0; gy <= y1; gy++) el('line', { x1: iso(x0, gy)[0], y1: iso(x0, gy)[1], x2: iso(x1, gy)[0], y2: iso(x1, gy)[1] }, g);
  }

  /** The building's floor plate, with its thickness showing on the two front edges. */
  slab({ x0, y0, x1, y1 }, kind = 'building') {
    const g = el('g', { class: `slab site-${kind}` }, this.svg);
    const m = 0.35;
    const a = iso(x0 - m, y0 - m);
    const b = iso(x1 + m, y0 - m);
    const c = iso(x1 + m, y1 + m);
    const d = iso(x0 - m, y1 + m);
    const down = ([x, y]) => [x, y + SLAB];
    el('polygon', { class: 'slab-left', points: pts([d, c, down(c), down(d)]) }, g);
    el('polygon', { class: 'slab-right', points: pts([b, c, down(c), down(b)]) }, g);
    el('polygon', { class: 'slab-top', points: pts([a, b, c, d]) }, g);
    el('polyline', { class: 'slab-rim', points: pts([d, c, b]) }, g);
  }

  /**
   * The world round the buildings: lawns and trees behind, a street with parked
   * cars and lamps in front. Draws what lies behind now; returns the group of what
   * stands in front, to go on after the rooms.
   */
  scenery(open, plate) {
    const back = el('g', { class: 'scenery' }, this.svg);
    const front = el('g', { class: 'scenery' });
    const r = rng(this.org.id);
    const boxes = open.map((site) => site.box);
    const near = (gx, gy, pad) => boxes.some((b) => gx > b.x0 - pad && gx < b.x1 + pad && gy > b.y0 - pad && gy < b.y1 + pad);
    // The firewall and the internet stand on the left corner: keep it clear.
    const corner = (gx, gy) => Math.hypot(gx - plate.x0, gy - plate.y1) < 2.6;
    for (const b of boxes) P.lawn(back, b.x0 - 1.2, b.y0 - 1.2, b.x1 + 1.2, b.y1 + 1.2);
    for (const [n, b] of boxes.entries()) {
      // Trees along the two back sides, behind the walls.
      for (let gy = b.y0 - 0.6; gy < b.y1 + 0.4; gy += 1.5 + r() * 0.6) {
        const gx = b.x0 - 0.75 - r() * 0.3;
        if (!corner(gx, gy) && !boxes.some((o) => o !== b && gx > o.x0 - 1 && gx < o.x1 + 1 && gy > o.y0 - 1 && gy < o.y1 + 1)) P.tree(back, gx, gy, `${n}a${gy}`, 0.85 + r() * 0.35);
      }
      for (let gx = b.x0 + 0.4; gx < b.x1 + 0.6; gx += 1.5 + r() * 0.6) {
        const gy = b.y0 - 0.75 - r() * 0.3;
        if (!corner(gx, gy) && !boxes.some((o) => o !== b && gx > o.x0 - 1 && gx < o.x1 + 1 && gy > o.y0 - 1 && gy < o.y1 + 1)) P.tree(back, gx, gy, `${n}b${gx}`, 0.85 + r() * 0.35);
      }
      // Low bushes along the two front sides, so they never hide a room.
      for (let gx = b.x0 + 1.2; gx < b.x1; gx += 1.1 + r()) if (!corner(gx, b.y1 + 0.6) && !near(gx, b.y1 + 0.6, 0.1)) P.bush(front, gx, b.y1 + 0.6, `${n}c${gx}`);
      for (let gy = b.y0 + 0.4; gy < b.y1; gy += 1.1 + r()) if (!near(b.x1 + 0.6, gy, 0.1)) P.bush(front, b.x1 + 0.6, gy, `${n}d${gy}`);
    }
    // A street along the front of the first building, when nothing else stands there.
    const main = boxes[0];
    if (main) {
      const gy = main.y1 + 2.3;
      const x0 = main.x0 + 1.4;
      const x1 = main.x1 + 2;
      const blocked = boxes.some((o) => o !== main && o.x0 < x1 && x0 < o.x1 && o.y0 - 2 < gy + 0.8 && gy - 0.8 < o.y1);
      if (!blocked) {
        P.roadX(back, x0, x1, gy, 1.1);
        for (let gx = x0 + 1; gx < x1 - 0.8; gx += 1.3 + r() * 2.2) if (r() < 0.7) P.car(front, gx, gy - 0.22, `${this.org.id}${gx}`);
        for (let gx = x0 + 0.6; gx < x1; gx += 3.2) P.streetLamp(front, gx, gy - 0.85);
      }
    }
    return front;
  }

  /** Day, dusk or night, from the game clock ("08:30:00"). */
  setTime(text) {
    const hour = Number(String(text ?? '').slice(0, 2));
    if (!Number.isFinite(hour)) return;
    const phase = hour >= 7 && hour < 17 ? 'day' : (hour >= 17 && hour < 19) || (hour >= 5 && hour < 7) ? 'dusk' : 'night';
    if (this.phase === phase) return;
    this.phase = phase;
    this.svg.classList.remove('t-day', 't-dusk', 't-night');
    this.svg.classList.add(`t-${phase}`);
  }

  /** Paths on the ground from the first site to each of the others. */
  roads(sites) {
    const g = el('g', { class: 'roads' }, this.svg);
    const mid = (b) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
    const [hx, hy] = mid(sites[0].box);
    for (const site of sites.slice(1)) {
      const [sx, sy] = mid(site.box);
      // Along the grid, like a road: across, then down.
      const path = pts([iso(hx, hy), iso(sx, hy), iso(sx, sy)]);
      // The cloud and the stores hang off a network link; a building, off a road.
      if (site.kind === 'cloud' || site.kind === 'stores') {
        el('polyline', { class: `link link-${site.kind}`, points: path }, g);
      } else {
        el('polyline', { class: 'road', points: path }, g);
        el('polyline', { class: 'road-line', points: path }, g);
      }
    }
  }

  /**
   * The site's name, painted on the ground in front of it: along its front-left
   * edge, or its front-right edge when another site stands on the left one.
   */
  siteSign(site, others) {
    const { x0, y0, x1, y1 } = site.box;
    // Another site's walls rise about two squares over the ground behind them.
    const hits = (b) => others.some((o) => o !== site && o.box.x0 - 2 < b.x1 && b.x0 < o.box.x1 && o.box.y0 - 2 < b.y1 && b.y0 < o.box.y1);
    const g = el('g', { class: `site-sign site-${site.kind}` }, this.svg);
    const text = el('text', {}, g);
    text.textContent = site.name.toUpperCase();
    if (!hits({ x0, y0: y1, x1, y1: y1 + 1.4 }) || hits({ x0: x1, y0, x1: x1 + 1.4, y1 })) {
      // Clear of the firewall, which stands on the left corner.
      const [px, py] = iso(x0 + 1.6, y1 + 0.95);
      text.setAttribute('transform', `matrix(1 0.5 -1 0.5 ${px.toFixed(1)} ${py.toFixed(1)})`);
    } else {
      // Reading from the front corner back, up the right-hand edge.
      const [px, py] = iso(x1 + 0.95, y1 - 0.2);
      text.setAttribute('transform', `matrix(1 -0.5 1 0.5 ${px.toFixed(1)} ${py.toFixed(1)})`);
    }
  }

  /** A room with the lights off: its outline and a stub of wall, nothing inside. */
  shell(dept) {
    const { x, y, w, h } = dept.room;
    const i = ROOM_GAP;
    const g = el('g', { class: 'shell', 'data-shell': dept.id }, this.svg);
    const low = 6;
    el('polygon', { class: 'shell-wall', points: pts([iso(x + i, y + i), iso(x + i, y + h - i), iso(x + i, y + h - i, low), iso(x + i, y + i, low)]) }, g);
    el('polygon', { class: 'shell-wall', points: pts([iso(x + i, y + i), iso(x + w - i, y + i), iso(x + w - i, y + i, low), iso(x + i, y + i, low)]) }, g);
    const floor = el('polygon', { class: 'shell-floor', points: pts([iso(x + i, y + i), iso(x + w - i, y + i), iso(x + w - i, y + h - i), iso(x + i, y + h - i)]) }, g);
    el('title', {}, floor).textContent = 'Not open yet. You will see this room later.';
    // Painted on the floor along the back wall, where rooms in front can't hide it.
    if (w >= 3) {
      const [px, py] = iso(x + 0.45, y + 0.75);
      el('text', { class: 'shell-text', transform: `matrix(1 0.5 -1 0.5 ${px.toFixed(1)} ${py.toFixed(1)})` }, g).textContent = 'NOT OPEN YET';
    }
  }

  /** The firewall: a gate on the corner of the building that faces the internet. */
  firewall({ x0, y1 }) {
    const g = el('g', { class: 'firewall' }, this.svg);
    const [cx, cy] = iso(x0 - 0.35, y1 + 0.35);
    const h = WALL + 16;
    el('polygon', { class: 'fw-post', points: pts([[cx - 9, cy - 3], [cx - 3, cy], [cx - 3, cy - h], [cx - 9, cy - h - 3]]) }, g);
    el('polygon', { class: 'fw-post', points: pts([[cx + 3, cy], [cx + 9, cy - 3], [cx + 9, cy - h - 3], [cx + 3, cy - h]]) }, g);
    el('rect', { class: 'fw-bar', x: cx - 12, y: cy - h - 10, width: 24, height: 8, rx: 2 }, g);
    const sx = cx;
    const sy = cy - h - 30;
    el('path', { class: 'fw-shield', d: `M${sx},${sy - 11} L${sx + 10},${sy - 7} L${sx + 10},${sy + 1} Q${sx + 10},${sy + 9} ${sx},${sy + 13} Q${sx - 10},${sy + 9} ${sx - 10},${sy + 1} L${sx - 10},${sy - 7} Z` }, g);
    el('text', { class: 'fw-label', x: cx, y: cy + 22 }, g).textContent = 'Firewall';
    this.anchors.set('firewall', [cx, cy - h / 2]);
  }

  globe(parent, [x, y]) {
    const g = el('g', { class: 'anchor-node internet' }, parent);
    el('circle', { class: 'anchor', cx: x, cy: y, r: 22 }, g);
    el('ellipse', { class: 'anchor-line', cx: x, cy: y, rx: 9, ry: 22 }, g);
    el('line', { class: 'anchor-line', x1: x - 22, y1: y, x2: x + 22, y2: y }, g);
    el('path', { class: 'anchor-line', d: `M${x - 19},${y - 11} Q${x},${y - 6} ${x + 19},${y - 11} M${x - 19},${y + 11} Q${x},${y + 6} ${x + 19},${y + 11}` }, g);
    el('text', { x, y: y + 40, class: 'anchor-label' }, g).textContent = 'Internet';
  }

  partners(parent, [x, y]) {
    const g = el('g', { class: 'anchor-node partners' }, parent);
    el('circle', { class: 'anchor', cx: x, cy: y, r: 20 }, g);
    for (const [dx, w, hgt] of [[-9, 7, 14], [-1, 8, 20], [8, 6, 11]]) {
      el('rect', { class: 'anchor-line', x: x + dx - w / 2, y: y + 9 - hgt, width: w, height: hgt, rx: 1 }, g);
    }
    el('text', { x, y: y + 38, class: 'anchor-label' }, g).textContent = 'Partners';
  }

  drawRoom(dept, role, tint, box) {
    const { x, y, w, h } = dept.room;
    const g = el('g', { class: `room${dept.revealed ? '' : ' fog'}${dept.staffed ? '' : ' empty'}`, 'data-dept': dept.id, style: `--tint:${tint}` }, this.svg);
    const i = ROOM_GAP;
    const furnished = dept.revealed;
    const r = rng(dept.id);
    const floorPts = [iso(x + i, y + i), iso(x + w - i, y + i), iso(x + w - i, y + h - i), iso(x + i, y + h - i)];
    // Back walls: along the top-left (a) and top-right (b) edges.
    const wallA = [iso(x + i, y + i), iso(x + i, y + h - i), iso(x + i, y + h - i, WALL), iso(x + i, y + i, WALL)];
    const wallB = [iso(x + i, y + i), iso(x + w - i, y + i), iso(x + w - i, y + i, WALL), iso(x + i, y + i, WALL)];
    el('polygon', { class: 'room-wall-a', points: pts(wallA) }, g);
    el('polygon', { class: 'wall-shade', points: pts(wallA) }, g);
    el('polygon', { class: 'room-wall-b', points: pts(wallB) }, g);
    el('polygon', { class: 'wall-shade', points: pts(wallB) }, g);
    // A skirting board along the foot of both walls.
    el('polyline', { class: 'skirting', points: pts([iso(x + i, y + h - i, 2), iso(x + i, y + i, 2), iso(x + w - i, y + i, 2)]) }, g);

    // What hangs on the walls: windows on the outside, a board and a door inside.
    const outerA = !box || x <= box.x0;
    const outerB = !box || y <= box.y0;
    if (furnished) {
      if (outerA) P.windowsA(g, x + i, y + 0.25, y + h - 0.25, 12, WALL - 6);
      else {
        P.door(g, x + i, y + h - 0.85, y + h - 0.3, 24);
        if (h >= 3) P.whiteboard(g, x + i, y + 0.45, y + Math.min(h - 1.15, 2.1), dept.id);
      }
      if (outerB) P.windowsB(g, y + i, x + 0.25, x + w - 0.25, 9, 21);
    }

    // The floor, in the room's own finish.
    const finish = this.finishOf(dept, r);
    el('polygon', { class: `room-floor floor-${finish}`, points: pts(floorPts) }, g);
    const tiles = el('g', { class: `room-tiles tiles-${finish}` }, g);
    // A red wash over the floor that pulses while an alert is open in the room.
    el('polygon', { class: 'room-alert', points: pts(floorPts) }, g);
    if (finish === 'tile') {
      for (let gx = x + 1; gx < x + w; gx++) el('line', { x1: iso(gx, y + i)[0], y1: iso(gx, y + i)[1], x2: iso(gx, y + h - i)[0], y2: iso(gx, y + h - i)[1] }, tiles);
      for (let gy = y + 1; gy < y + h; gy++) el('line', { x1: iso(x + i, gy)[0], y1: iso(x + i, gy)[1], x2: iso(x + w - i, gy)[0], y2: iso(x + w - i, gy)[1] }, tiles);
    } else if (finish === 'wood') {
      for (let gy = y + 0.33; gy < y + h - 0.1; gy += 0.33) el('line', { x1: iso(x + i, gy)[0], y1: iso(x + i, gy)[1], x2: iso(x + w - i, gy)[0], y2: iso(x + w - i, gy)[1] }, tiles);
    }
    el('polyline', { class: 'room-trim', points: pts([iso(x + i, y + h - i, WALL), iso(x + i, y + i, WALL), iso(x + w - i, y + i, WALL)]) }, g);
    el('polyline', { class: 'room-edge', points: pts([iso(x + i, y + h - i), iso(x + w - i, y + h - i), iso(x + w - i, y + i)]) }, g);
    const hit = el('polygon', { class: 'room-hit', points: pts(floorPts) }, g);
    // The whole room answers a click (floor and walls); machines stop the click themselves.
    g.addEventListener('click', (event) => this.handlers.onRoom(dept.id, event));
    const titleNode = el('title', {}, hit);
    titleNode.textContent = dept.revealed ? dept.name : 'Not found yet';

    const centre = iso(x + w / 2, y + h / 2);
    this.rooms.set(dept.id, { group: g, floorPts, centre, rect: dept.room });

    this.namePlate(g, dept, role);
    // An alarm light on the room's back corner, lit while an alert is open there.
    const [bx, by] = iso(x + i, y + i, WALL + 2);
    const alarm = el('g', { class: 'alarm' }, g);
    el('ellipse', { class: 'alarm-glow', cx: bx, cy: by - 4, rx: 30, ry: 16 }, alarm);
    // Two beams that sweep round, like a warning beacon.
    const beams = el('g', { class: 'alarm-beams', style: `transform-origin:${bx.toFixed(1)}px ${(by - 4).toFixed(1)}px` }, alarm);
    for (const turn of [0, 180]) {
      el('path', { class: 'alarm-beam', d: `M${bx},${by - 4} l38,-9 a9,9 0 0 1 0,18 Z`, transform: `rotate(${turn} ${bx} ${by - 4})` }, beams);
    }
    el('rect', { class: 'alarm-base', x: bx - 6, y: by - 1.5, width: 12, height: 4, rx: 1.5 }, alarm);
    el('path', { class: 'alarm-dome', d: `M${bx - 5},${by - 1} a5,6.5 0 0 1 10,0 Z` }, alarm);
    el('ellipse', { class: 'alarm-shine', cx: bx - 1.6, cy: by - 4.6, rx: 1.3, ry: 2 }, alarm);

    if (!furnished) return;
    // The light falls in a pool in the middle of the room.
    P.lightPool(g, x + w / 2, y + h / 2 + 0.2, Math.min(w, h) * 0.62);
    for (const item of this.plan(dept, role, tint, r)) item.draw(g);
  }

  /** A room's floor: tiles where the machines live, carpet or wood where people work. */
  finishOf(dept, r) {
    const racks = dept.hosts.filter((hst) => ['rack', 'db'].includes(SHAPE_BY_KIND[hst.kind])).length;
    if (racks >= 3 && racks >= dept.people.length) return 'tile';
    if (/exec|strategy|manager|leadership|board/i.test(`${dept.id} ${dept.name}`)) return 'wood';
    return r() < 0.6 ? 'carpet' : 'wood';
  }

  /**
   * Lay out a room like an office: machines in a row along the back wall, a desk
   * and chair for each person (with their computer on it when they have one), the
   * AI agents by their consoles, then plants, shelves and a cooler where there is
   * room. Returns the things to draw, sorted back to front.
   */
  plan(dept, role, tint, r) {
    const { x, y, w, h } = dept.room;
    const items = [];
    const used = new Set();
    const key = (cx, cy) => `${cx},${cy}`;
    const free = (cx, cy) => cx >= 0 && cy >= 0 && cx < w && cy < h && !used.has(key(cx, cy));
    const take = (cx, cy) => used.add(key(cx, cy));
    const add = (gx, gy, draw, order = 0) => items.push({ gx, gy, order, draw });
    const shape = (hst) => SHAPE_BY_KIND[hst.kind] ?? 'box';
    const hosts = dept.hosts;
    const racks = hosts.filter((hst) => ['rack', 'db', 'box'].includes(shape(hst)));
    const deskHosts = hosts.filter((hst) => ['desk', 'laptop'].includes(shape(hst)));
    const smalls = hosts.filter((hst) => ['router', 'till'].includes(shape(hst)));
    const people = role === 'predator' ? [] : dept.people;
    const humans = people.filter((p) => p.kind !== 'agent');
    const agents = people.filter((p) => p.kind === 'agent');

    // Machines along the back wall, from the right-hand end (the room's name is on the left).
    let row = 0;
    let col = w - 1;
    for (const hst of racks) {
      while (!free(col, row)) {
        col--;
        if (col < 0) {
          col = w - 1;
          row++;
        }
        if (row >= h) break;
      }
      if (row >= h) break;
      take(col, row);
      const gx = x + col + 0.5;
      const gy = y + row + 0.42;
      add(gx, gy, (g) => this.drawHost(g, hst, gx, gy, 0.6));
    }

    // Desks, spread out: every other column first.
    const deskCells = [];
    for (let cy = 1; cy < h; cy++) for (const cx of [...Array(w).keys()].sort((a, b) => (a % 2) - (b % 2) || a - b)) deskCells.push([cx, cy]);
    // The learner's own desk, in the room the security team works in.
    if (role === 'prey' && this.org?.home === dept.id) {
      const cell = deskCells.find(([cx, cy]) => free(cx, cy));
      if (cell) {
        take(...cell);
        const gx = x + cell[0] + 0.5;
        const gy = y + cell[1] + 0.36;
        add(gx, gy, (g) => {
          const top = P.desk(g, gx, gy);
          P.monitor(g, gx - 0.12, gy - 0.08, top, { half: 0.12 });
          P.monitor(g, gx + 0.14, gy - 0.08, top, { half: 0.12 });
          P.keyboard(g, gx, gy + 0.08, top);
        });
        add(gx, gy + 0.3, (g) => {
          P.chair(g, gx, gy + 0.3, '#1e40af');
          P.person(g, gx, gy + 0.3, 'you', { tint });
          P.chairBack(g, gx, gy + 0.3, '#1e40af');
          P.youMarker(g, gx, gy + 0.3);
        });
      }
    }
    const seats = Math.max(humans.length, deskHosts.length);
    for (let n = 0; n < seats; n++) {
      const cell = deskCells.find(([cx, cy]) => free(cx, cy));
      if (!cell) break;
      take(...cell);
      const gx = x + cell[0] + 0.5;
      const gy = y + cell[1] + 0.36;
      const hst = deskHosts[n];
      const who = humans[n];
      if (hst) add(gx, gy, (g) => this.drawHost(g, hst, gx, gy, 0.6));
      else
        add(gx, gy, (g) => {
          const top = P.desk(g, gx, gy);
          P.monitor(g, gx, gy - 0.08, top);
          P.keyboard(g, gx, gy + 0.08, top);
          if (r() < 0.4) P.plant(g, gx + 0.26, gy - 0.08, { big: false, seed: `${dept.id}${n}` });
        });
      const sx = gx;
      const sy = gy + 0.3;
      add(sx, sy, (g) => {
        P.chair(g, sx, sy);
        if (who) P.person(g, sx, sy, who.name, { tint });
        P.chairBack(g, sx, sy);
      });
    }

    // AI agents hover by their consoles.
    for (const agent of agents) {
      const cell = deskCells.find(([cx, cy]) => free(cx, cy)) ?? [...Array(w).keys()].map((cx) => [cx, 0]).find(([cx, cy]) => free(cx, cy));
      if (!cell) break;
      take(...cell);
      const gx = x + cell[0] + 0.5;
      const gy = y + cell[1] + 0.45;
      add(gx, gy, (g) => {
        const b = P.bot(g, gx, gy, tint);
        el('title', {}, b).textContent = `${agent.name} (AI agent)`;
      });
    }

    // Routers, tills and other small kit wherever there is room.
    for (const hst of smalls) {
      const cell = [...Array(w).keys()].map((cx) => [cx, 0]).find(([cx, cy]) => free(cx, cy)) ?? deskCells.find(([cx, cy]) => free(cx, cy));
      if (!cell) break;
      take(...cell);
      const gx = x + cell[0] + 0.5;
      const gy = y + cell[1] + 0.45;
      add(gx, gy, (g) => this.drawHost(g, hst, gx, gy, 0.6));
    }

    // Things that make it a place: a plant in the front corner, shelves and a cooler on the back wall.
    if (free(w - 1, h - 1)) {
      take(w - 1, h - 1);
      add(x + w - 0.35, y + h - 0.35, (g) => P.plant(g, x + w - 0.35, y + h - 0.35, { seed: `${dept.id}-corner` }));
    }
    const backFree = [...Array(w).keys()].filter((cx) => free(cx, 0));
    const signCells = Math.ceil((this.signEnd ?? x) - x);
    backFree.forEach((cx, n) => {
      if (n % 2 === 1 && r() < 0.5) return;
      take(cx, 0);
      const gx = x + cx + 0.5;
      // Under the room's sign only low things, so the sign stays readable.
      const pick = cx < signCells ? 1 + Math.floor(r() * 2) : (n + Math.floor(r() * 3)) % 3;
      if (pick === 0) add(gx, y + 0.22, (g) => P.shelf(g, gx, y + 0.22, `${dept.id}-${cx}`));
      else if (pick === 1) add(gx, y + 0.3, (g) => P.cooler(g, gx, y + 0.3));
      else add(gx, y + 0.32, (g) => P.plant(g, gx, y + 0.32, { seed: `${dept.id}-${cx}` }));
    });
    // A meeting table, or a sofa by the wall, in a bigger room with space left.
    if (w * h >= 12 && people.length > 0) {
      const spot = deskCells.find(([cx, cy]) => free(cx, cy) && cy > 0 && cx > 0);
      if (spot) {
        take(...spot);
        const gx = x + spot[0] + 0.5;
        const gy = y + spot[1] + 0.5;
        if (r() < 0.55) {
          add(gx, gy, (g) => {
            P.rug(g, gx - 0.45, gy - 0.42, gx + 0.45, gy + 0.42, tint);
            P.meetingTable(g, gx, gy);
          });
        } else if (free(0, spot[1])) {
          take(0, spot[1]);
          add(x + 0.3, gy, (g) => P.sofa(g, x + 0.3, gy, tint));
        }
      }
    }
    // Spare desks and plants in what is left, so no room looks empty.
    if (dept.staffed) {
      for (const [cx, cy] of deskCells) {
        if (!free(cx, cy)) continue;
        const roll = r();
        if (roll < 0.3) {
          take(cx, cy);
          const gx = x + cx + 0.5;
          const gy = y + cy + 0.36;
          add(gx, gy, (g) => {
            const top = P.desk(g, gx, gy);
            P.monitor(g, gx, gy - 0.08, top);
          });
          add(gx, gy + 0.3, (g) => {
            P.chair(g, gx, gy + 0.3);
            P.chairBack(g, gx, gy + 0.3);
          });
        } else if (roll < 0.42) {
          take(cx, cy);
          add(x + cx + 0.5, y + cy + 0.5, (g) => P.plant(g, x + cx + 0.5, y + cy + 0.5, { seed: `${dept.id}-${cx}-${cy}` }));
        }
      }
    }
    return items.sort((a, b) => a.gx + a.gy - (b.gx + b.gy) || a.order - b.order);
  }

  /**
   * The room's name, painted on its back wall like a sign. A name too long for the
   * wall goes over two lines, then smaller; failing that, it sits on the floor.
   */
  namePlate(g, dept, role) {
    const { x, y, w, h } = dept.room;
    const name = dept.revealed ? dept.name : '?';
    const start = 0.35; // grid units in from the wall's left end
    // The wall of the room next door stands in front of this wall's right end, and
    // hides more of it the lower the text sits, so a low line has less room.
    const room = (z) => (w - start) * (TW / 2) - (WALL - z) - 4;
    const ONE = [WALL - 10];
    const TWO = [WALL - 5, WALL - 15];
    // Measure the real text where the browser can; estimate when it can't (hidden map).
    const probe = el('text', { class: 'plate-text', visibility: 'hidden' }, g);
    const fits = (text, size, z) => {
      probe.setAttribute('font-size', size);
      probe.textContent = text;
      const len = probe.getComputedTextLength?.() || text.length * size * 0.8;
      return len <= room(z);
    };
    const one = name.toUpperCase();
    const split = twoLines(one);
    for (const size of [11.5, 10.5, 9.5, 8.5]) {
      let lines = null;
      if (fits(one, size, ONE[0])) lines = [one];
      else if (split && split.every((l, n) => fits(l, size, TWO[n]))) lines = split;
      if (!lines) continue;
      const widths = lines.map((line) => {
        probe.setAttribute('font-size', size);
        probe.textContent = line;
        return probe.getComputedTextLength?.() || line.length * size * 0.8;
      });
      probe.remove();
      const plate = el('g', { class: 'plate' }, g);
      // A sign board behind the letters, like a department sign on a wall.
      const zs = lines.length === 1 ? ONE : TWO;
      const a = x + start - 0.12;
      const b = x + start + Math.max(...widths) / (TW / 2) + 0.12;
      const lo = Math.min(...zs) - 3.5;
      const hi = Math.max(...zs) + size * 0.78 + 3;
      el('polygon', { class: 'sign-board', points: pts([iso(a, y + ROOM_GAP + 0.01, lo), iso(b, y + ROOM_GAP + 0.01, lo), iso(b, y + ROOM_GAP + 0.01, hi), iso(a, y + ROOM_GAP + 0.01, hi)]) }, plate);
      this.signEnd = b;
      lines.forEach((line, n) => {
        const z = lines.length === 1 ? ONE[0] : TWO[n];
        const [px, py] = iso(x + start, y + ROOM_GAP, z);
        const t = el('text', { class: 'plate-text', transform: `matrix(1 0.5 0 1 ${px.toFixed(1)} ${py.toFixed(1)})`, 'font-size': size }, plate);
        t.textContent = line;
      });
      this.subLabel(g, dept, role);
      return;
    }
    probe.remove();
    this.signEnd = x;
    const [cx, cy] = iso(x + w / 2, y + h / 2);
    el('text', { x: cx, y: cy + ((w + h) * TH) / 4 * 0.55 + 4, class: 'room-label' }, this.labels).textContent = name;
    this.subLabel(g, dept, role);
  }

  subLabel(g, dept, role) {
    if (!(dept.revealed && !dept.staffed && role === 'prey')) return;
    const { x, y, w, h } = dept.room;
    const [cx, cy] = iso(x + w / 2, y + h / 2);
    el('text', { x: cx, y: cy + ((w + h) * TH) / 4 * 0.55 + 4, class: 'room-sub' }, this.labels).textContent = 'not staffed yet';
  }

  drawHost(parent, host, gx, gy, size) {
    const s = size / 2;
    const z = HEIGHT_BY_KIND[host.kind] ?? 18;
    const shape = SHAPE_BY_KIND[host.kind] ?? 'box';
    const g = el('g', { class: `host k-${host.kind} s-${shape}`, 'data-host': host.key, tabindex: 0, role: 'button', 'aria-label': host.name }, parent);
    const r = rng(host.key);

    let topZ = z;
    let mid = z / 2;
    if (shape === 'desk' || shape === 'laptop') {
      // A computer on a desk: the desk is furniture, the computer is the machine.
      if (shape === 'desk') this.prism(g, gx + 0.25, gy + 0.02, 0.05, 0.11, 11);
      const top = P.desk(g, gx, gy);
      if (shape === 'desk') {
        P.monitor(g, gx - 0.02, gy - 0.08, top, { cls: 'screen face' });
        P.keyboard(g, gx, gy + 0.08, top);
        topZ = top + 15;
      } else {
        el('polygon', { class: 'top face', points: pts([iso(gx - 0.14, gy - 0.02, top + 0.5), iso(gx + 0.14, gy - 0.02, top + 0.5), iso(gx + 0.14, gy + 0.1, top + 0.5), iso(gx - 0.14, gy + 0.1, top + 0.5)]) }, g);
        el('polygon', { class: 'screen face', points: pts([iso(gx - 0.14, gy - 0.02, top + 0.5), iso(gx + 0.14, gy - 0.02, top + 0.5), iso(gx + 0.14, gy - 0.07, top + 10), iso(gx - 0.14, gy - 0.07, top + 10)]) }, g);
        topZ = top + 10;
      }
      mid = top + 4;
    } else {
      const [shx, shy] = iso(gx + s * 0.25, gy + s * 0.25);
      el('ellipse', { class: 'shadow', cx: shx, cy: shy, rx: s * TW * 0.95, ry: s * TH * 0.95 }, g);
      if (shape === 'db') {
        topZ = this.cylinder(g, gx, gy, s * 0.85, z);
      } else if (shape === 'router') {
        this.prism(g, gx, gy, s * 0.6, s * 0.4, z);
        for (const dx of [-0.5, 0.5]) {
          const [ax, ay] = iso(gx + s * dx * 0.8, gy - s * 0.3, z);
          el('line', { class: 'antenna', x1: ax, y1: ay, x2: ax, y2: ay - 12 }, g);
        }
        const [lx, ly] = iso(gx - s * 0.2, gy + s * 0.4, z * 0.5);
        el('circle', { class: 'led blink', cx: lx, cy: ly, r: 1.3, style: `animation-delay:${(-r() * 2).toFixed(2)}s` }, g);
        topZ = z + 12;
      } else if (shape === 'till') {
        this.prism(g, gx, gy, s * 0.8, s * 0.55, z);
        const back = gy - s * 0.2;
        el('polygon', { class: 'screen face', points: pts([iso(gx - s * 0.5, back, z), iso(gx + s * 0.5, back, z), iso(gx + s * 0.5, back, z + 10), iso(gx - s * 0.5, back, z + 10)]) }, g);
        topZ = z + 10;
      } else {
        // A rack: a tall cabinet with a front of blinking lights.
        this.prism(g, gx, gy, s * 0.82, s * 0.7, z);
        if (shape === 'rack') {
          const fy = gy + s * 0.7;
          for (let n = 0; n < 4; n++) {
            const zz = z * (0.2 + n * 0.2);
            const [ax, ay] = iso(gx - s * 0.72, fy, zz);
            const [bx2, by2] = iso(gx + s * 0.72, fy, zz);
            el('line', { class: 'rack-line', x1: ax, y1: ay, x2: bx2, y2: by2 }, g);
            const [lx, ly] = iso(gx - s * 0.5, fy, zz + 2.6);
            el('circle', { class: `led${r() < 0.7 ? ' blink' : ''}`, cx: lx, cy: ly, r: 1.1, style: `animation-delay:${(-r() * 3).toFixed(2)}s;animation-duration:${(0.6 + r() * 1.6).toFixed(2)}s` }, g);
            const [mx, my] = iso(gx - s * 0.25, fy, zz + 2.6);
            el('circle', { class: `led amber${r() < 0.5 ? ' blink' : ''}`, cx: mx, cy: my, r: 0.9, style: `animation-delay:${(-r() * 3).toFixed(2)}s` }, g);
          }
        }
      }
    }

    // What happens to a machine shows on it: smoke when down, a padlock when
    // encrypted, hazard tape when isolated, a spinner while it is rebuilt.
    const [tx, ty] = iso(gx, gy, topZ);
    const fx = el('g', { class: 'host-fx' }, g);
    const smoke = el('g', { class: 'fx-smoke' }, fx);
    for (let n = 0; n < 5; n++) el('circle', { cx: tx + ((n % 3) - 1) * 3.5, cy: ty - 4, r: 4 + (n % 3) * 1.6, style: `animation-delay:${(n * 0.45).toFixed(2)}s` }, smoke);
    // A little flicker of fire at the base of the smoke.
    el('path', { class: 'fx-fire', d: `M${tx - 4},${ty - 1} q1,-7 4,-10 q-0.5,4 2,5 q1,-3 0.5,-6 q3.5,4 1.5,11 Z` }, smoke);
    const lock = el('g', { class: 'fx-lock' }, fx);
    el('path', { d: `M${tx - 3},${ty - 12} v-3 a3,3 0 0 1 6,0 v3`, fill: 'none', stroke: '#e9d5ff', 'stroke-width': 1.6 }, lock);
    el('rect', { x: tx - 4.5, y: ty - 12, width: 9, height: 7, rx: 1.5, fill: '#a855f7' }, lock);
    const [hx, hy] = iso(gx, gy);
    el('ellipse', { class: 'fx-hazard', cx: hx, cy: hy, rx: 22, ry: 11 }, fx);
    el('circle', { class: 'fx-spinner', cx: tx, cy: ty - 9, r: 5 }, fx);
    el('ellipse', { class: 'fx-owned', cx: hx, cy: hy, rx: 20, ry: 10 }, fx);

    if (host.critical) {
      el('circle', { class: 'crown', cx: tx, cy: ty - 4, r: 2.6 }, g);
    }
    const [bx, by] = iso(gx + 0.3, gy - 0.3, topZ + 6);
    const badge = el('g', { class: 'badge-g', visibility: 'hidden' }, g);
    el('circle', { class: 'badge', cx: bx, cy: by, r: 7 }, badge);
    el('text', { class: 'badge-text', x: bx, y: by + 3 }, badge);
    const tip = el('title', {}, g);
    tip.textContent = `${host.name}\n${host.fqdn} · ${host.ip}`;
    g.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.dragged) return;
      this.handlers.onHost(host.key);
    });
    g.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.handlers.onHost(host.key);
      }
    });
    this.hostNodes.set(host.key, { g, badge, anchor: iso(gx, gy, mid) });
  }

  /** A box: sx and sy are its half-width along each grid axis, z its height. */
  prism(g, gx, gy, sx, sy, z) {
    el('polygon', { class: 'left face', points: pts([iso(gx - sx, gy + sy, z), iso(gx + sx, gy + sy, z), iso(gx + sx, gy + sy), iso(gx - sx, gy + sy)]) }, g);
    el('polygon', { class: 'right face', points: pts([iso(gx + sx, gy - sy, z), iso(gx + sx, gy + sy, z), iso(gx + sx, gy + sy), iso(gx + sx, gy - sy)]) }, g);
    el('polygon', { class: 'top face', points: pts([iso(gx - sx, gy - sy, z), iso(gx + sx, gy - sy, z), iso(gx + sx, gy + sy, z), iso(gx - sx, gy + sy, z)]) }, g);
  }

  /** A database: a short cylinder with a band round it. Returns its top height. */
  cylinder(g, gx, gy, r, z) {
    const [cx, cy] = iso(gx, gy);
    const rx = r * (TW / Math.SQRT2);
    const ry = r * (TH / Math.SQRT2);
    const top = cy - z;
    el('path', { class: 'left face', d: `M${cx - rx},${top} L${cx - rx},${cy} A${rx},${ry} 0 0 0 ${cx + rx},${cy} L${cx + rx},${top} Z` }, g);
    el('path', { class: 'band', d: `M${cx - rx},${top + z * 0.5} A${rx},${ry} 0 0 0 ${cx + rx},${top + z * 0.5}` }, g);
    el('ellipse', { class: 'top face', cx, cy: top, rx, ry }, g);
    return z;
  }

  /** Refresh state on an existing layout: host status, alert badges, room heat. */
  update(org) {
    for (const dept of org.departments) {
      for (const host of dept.hosts) {
        const node = this.hostNodes.get(host.key);
        if (!node) continue;
        node.g.classList.toggle('isolated', host.status === 'isolated');
        node.g.classList.toggle('down', host.status === 'down' || host.status === 'encrypted');
        node.g.classList.toggle('encrypted', host.status === 'encrypted');
        node.g.classList.toggle('rebuilding', host.status === 'rebuilding');
        node.g.classList.toggle('owned', !!host.owned);
        node.g.classList.toggle('critical-sys', !!host.critical);
        node.g.classList.toggle('selected', this.selected === host.key);
        const count = host.alerts ?? 0;
        node.badge.setAttribute('visibility', count > 0 ? 'visible' : 'hidden');
        node.badge.querySelector('text').textContent = count > 9 ? '9+' : String(count);
      }
    }
  }

  // ----------------------------------------------------------------- intro

  /** True while new rooms wait for the intro. */
  get waiting() {
    return this.pending.length > 0;
  }

  /**
   * Raise the rooms that are new on this floor, one after another, while the camera
   * pulls back from the rooms you know to the whole floor.
   */
  playIntro() {
    const ids = this.pending;
    this.pending = [];
    if (ids.length === 0) return;
    this.raise(ids, 380);
    setTimeout(() => this.fit({ animate: true, ms: 1300 }), 220);
  }

  raise(ids, delay = 0) {
    ids.forEach((id, n) => {
      const room = this.rooms.get(id);
      if (!room) return;
      const g = room.group;
      g.classList.remove('pending');
      if (matchMedia('(prefers-reduced-motion: reduce)').matches || !g.animate) return;
      g.animate(
        [
          { transform: 'translateY(-54px)', opacity: 0 },
          { transform: 'translateY(4px)', opacity: 1, offset: 0.75 },
          { transform: 'translateY(0)', opacity: 1 },
        ],
        { duration: 760, delay: delay + n * 170, easing: 'cubic-bezier(.2,.8,.25,1)', fill: 'backwards' },
      );
      const ring = el('polygon', { class: 'arrive', points: pts(room.floorPts) }, this.fx);
      ring.animate?.([{ opacity: 0 }, { opacity: 0.9, offset: 0.35 }, { opacity: 0 }], { duration: 1500, delay: delay + n * 170 + 300, fill: 'both' }).finished.then(() => ring.remove(), () => ring.remove());
      if (!ring.animate) ring.remove();
    });
  }

  // ---------------------------------------------------------------- camera

  bindCamera() {
    const svg = this.svg;
    this.pointers = new Map();
    this.dragged = false;
    svg.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.dragged = false;
      this.startPan = { x: event.clientX, y: event.clientY, cam: this.cam && { ...this.cam } };
      if (this.pointers.size === 2) this.startPinch();
    });
    svg.addEventListener('pointermove', (event) => {
      if (!this.pointers.has(event.pointerId) || !this.cam) return;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size >= 2 && this.pinch) {
        this.movePinch();
        return;
      }
      const start = this.startPan;
      if (!start?.cam) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (!this.dragged && Math.hypot(dx, dy) < 5) return;
      if (!this.dragged) {
        this.dragged = true;
        svg.setPointerCapture?.(event.pointerId);
        svg.classList.add('grabbing');
        this.stopAnimation();
      }
      const k = this.scale();
      this.auto = false;
      this.cam = this.clampCam({ ...start.cam, x: start.cam.x - dx / k, y: start.cam.y - dy / k });
      this.applyCam();
    });
    const end = (event) => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 0) {
        svg.classList.remove('grabbing');
        // A drag is not a click: the click that follows it must not open a room.
        if (this.dragged) setTimeout(() => (this.dragged = false), 0);
      }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('click', (event) => {
      if (this.dragged) {
        event.stopPropagation();
        event.preventDefault();
      }
    }, true);
    svg.addEventListener('wheel', (event) => {
      if (!this.cam) return;
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0016));
      this.zoomAt(factor, event.clientX, event.clientY);
    }, { passive: false });
    svg.addEventListener('dblclick', (event) => {
      const room = event.target.closest?.('[data-dept]');
      if (room && !event.target.closest('.host')) this.show([room.dataset.dept], { animate: true, tight: true });
      else this.zoomAt(1.6, event.clientX, event.clientY, true);
    });
    new ResizeObserver(() => {
      if (!this.cam || !this.content) return;
      if (this.auto && !this.animating) this.fit({ animate: false });
      else this.applyCam();
    }).observe(svg);
  }

  startPinch() {
    const [a, b] = [...this.pointers.values()];
    this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), cam: { ...this.cam }, mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
    this.dragged = true;
  }

  movePinch() {
    const [a, b] = [...this.pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (!this.pinch || this.pinch.dist === 0) return;
    this.cam = { ...this.pinch.cam };
    this.auto = false;
    this.zoomAt(dist / this.pinch.dist, this.pinch.mid[0], this.pinch.mid[1]);
  }

  /** Pixels per map unit right now. */
  scale() {
    const { width } = this.svg.getBoundingClientRect();
    return this.cam ? width / this.cam.w : 1;
  }

  size() {
    const r = this.svg.getBoundingClientRect();
    return { W: Math.max(1, r.width), H: Math.max(1, r.height), left: r.left, top: r.top };
  }

  /** Zoom by a factor about a point on screen. */
  zoomAt(factor, clientX, clientY, animate = false) {
    if (!this.cam) return;
    const { W, H, left, top } = this.size();
    const k = W / this.cam.w;
    const nk = Math.min(MAX_SCALE * 1.6, Math.max(MIN_SCALE, k * factor));
    const px = this.cam.x + (clientX - left) / k;
    const py = this.cam.y + (clientY - top) / k;
    const w = W / nk;
    const h = H / nk;
    const next = this.clampCam({ x: px - (clientX - left) / nk, y: py - (clientY - top) / nk, w, h });
    this.auto = false;
    if (animate) this.animateTo(next, 420);
    else {
      this.stopAnimation();
      this.cam = next;
      this.applyCam();
    }
  }

  /** Zoom about the middle of the view: the + and - buttons. */
  zoomBy(factor) {
    const { W, H, left, top } = this.size();
    this.zoomAt(factor, left + W / 2, top + H / 2, true);
  }

  /** Frame the whole floor. The fit button, and the camera's resting place. */
  fit({ animate = true, ms = 700, zoom = 1 } = {}) {
    if (!this.content) return;
    this.auto = true;
    const target = this.frame(this.content, { maxScale: MAX_SCALE * 0.8, zoom });
    if (animate && this.cam) this.animateTo(target, ms);
    else {
      this.stopAnimation();
      this.cam = target;
      this.applyCam();
    }
  }

  /** Bring rooms (and machines) into view. tight frames just them; otherwise only what's needed. */
  show(ids, { animate = true, tight = false, hosts = [] } = {}) {
    const rects = ids.map((id) => this.rooms.get(id)?.rect).filter(Boolean);
    let b = rects.length > 0 ? boundsOf(rects) : null;
    for (const key of hosts) {
      const n = this.hostNodes.get(key);
      if (!n) continue;
      const [x, y] = n.anchor;
      b = union(b ?? { minX: x, minY: y, maxX: x, maxY: y }, { minX: x - 50, minY: y - 50, maxX: x + 50, maxY: y + 40 });
    }
    if (!b) return;
    b = grow(b, 30);
    if (!tight && this.cam && this.contains(b)) return;
    const target = tight || !this.cam ? this.frame(b, { maxScale: MAX_SCALE }) : this.pan(b);
    if (tight) this.auto = false;
    if (animate && this.cam) this.animateTo(target, 650);
    else {
      this.cam = target;
      this.applyCam();
    }
  }

  /** Camera that holds bounds b, as big as it may be. */
  frame(b, { maxScale = MAX_SCALE, zoom = 1 } = {}) {
    const { W, H } = this.size();
    const bw = Math.max(1, b.maxX - b.minX);
    const bh = Math.max(1, b.maxY - b.minY);
    const k = Math.min(maxScale, Math.max(MIN_SCALE, Math.min(W / bw, H / bh) * 0.94)) * zoom;
    const w = W / k;
    const h = H / k;
    return { x: (b.minX + b.maxX) / 2 - w / 2, y: (b.minY + b.maxY) / 2 - h / 2, w, h };
  }

  /** The camera at its current zoom, moved just enough to hold bounds b. */
  pan(b) {
    const c = { ...this.cam };
    const { W, H } = this.size();
    c.w = W / this.scale();
    c.h = H / this.scale();
    if (b.maxX - b.minX > c.w || b.maxY - b.minY > c.h) return this.frame(b);
    if (b.minX < c.x) c.x = b.minX;
    if (b.maxX > c.x + c.w) c.x = b.maxX - c.w;
    if (b.minY < c.y) c.y = b.minY;
    if (b.maxY > c.y + c.h) c.y = b.maxY - c.h;
    return c;
  }

  contains(b) {
    const c = this.cam;
    return b.minX >= c.x && b.maxX <= c.x + c.w && b.minY >= c.y && b.maxY <= c.y + c.h;
  }

  /** Keep the floor on screen: the camera may not wander off it. */
  clampCam(c) {
    if (!this.content) return c;
    const b = this.content;
    const cx = Math.min(b.maxX, Math.max(b.minX, c.x + c.w / 2));
    const cy = Math.min(b.maxY, Math.max(b.minY, c.y + c.h / 2));
    return { ...c, x: cx - c.w / 2, y: cy - c.h / 2 };
  }

  applyCam() {
    if (!this.cam) return;
    // The camera's shape follows the view's, so zooming about a point stays exact.
    const { W, H } = this.size();
    const k = W / this.cam.w;
    const cx = this.cam.x + this.cam.w / 2;
    const cy = this.cam.y + this.cam.h / 2;
    const w = W / k;
    const h = H / k;
    this.cam = { x: cx - w / 2, y: cy - h / 2, w, h };
    this.svg.setAttribute('viewBox', `${this.cam.x.toFixed(1)} ${this.cam.y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.svg.classList.toggle('zoomed', k > MAX_SCALE * 0.95);
    this.handlers.onCamera?.();
  }

  animateTo(target, ms = 700) {
    this.stopAnimation();
    if (!this.cam || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.cam = target;
      this.applyCam();
      return;
    }
    const from = { ...this.cam };
    const start = performance.now();
    this.animating = true;
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const e = ease(t);
      // Zoom in log space so a big pull-back doesn't race at the start.
      const w = Math.exp(Math.log(from.w) + (Math.log(target.w) - Math.log(from.w)) * e);
      const h = Math.exp(Math.log(from.h) + (Math.log(target.h) - Math.log(from.h)) * e);
      const cx = from.x + from.w / 2 + (target.x + target.w / 2 - (from.x + from.w / 2)) * e;
      const cy = from.y + from.h / 2 + (target.y + target.h / 2 - (from.y + from.h / 2)) * e;
      this.cam = { x: cx - w / 2, y: cy - h / 2, w, h };
      this.applyCam();
      if (t < 1) this.frameId = requestAnimationFrame(step);
      else this.animating = false;
    };
    this.frameId = requestAnimationFrame(step);
  }

  stopAnimation() {
    cancelAnimationFrame(this.frameId);
    this.animating = false;
  }

  // ------------------------------------------------------------- live state

  /** Persistent tint for rooms with open alerts, by worst severity. */
  setHeat(alerts) {
    const worst = new Map();
    for (const a of alerts) {
      if (!a.room || a.status === 'closed') continue;
      if ((SEVERITY_RANK[a.severity] ?? 0) > (SEVERITY_RANK[worst.get(a.room)] ?? 0)) worst.set(a.room, a.severity);
    }
    for (const [id, room] of this.rooms) {
      room.group.classList.remove('hot-low', 'hot-medium', 'hot-high', 'hot-critical');
      const sev = worst.get(id);
      if (sev) room.group.classList.add(`hot-${sev}`);
    }
  }

  select(key) {
    this.selected = key;
    for (const [k, node] of this.hostNodes) node.g.classList.toggle('selected', k === key);
  }

  /** Point at a room or a machine for a guided step: it glows and a beacon ripples over it. */
  highlight({ room, host } = {}) {
    clearTimeout(this.glowTimer);
    for (const node of this.svg.querySelectorAll('.glow')) node.classList.remove('glow');
    for (const node of this.fx?.querySelectorAll('.beacon') ?? []) node.remove();
    const targets = [];
    if (room && this.rooms.has(room)) {
      const r = this.rooms.get(room);
      targets.push({ node: r.group, at: r.centre });
    }
    if (host && this.hostNodes.has(host)) {
      const n = this.hostNodes.get(host);
      targets.push({ node: n.g, at: n.anchor });
    }
    if (targets.length > 0) this.show(room && this.rooms.has(room) ? [room] : [], { animate: true, hosts: host ? [host] : [] });
    for (const { node, at } of targets) {
      node.classList.add('glow');
      const ring = el('circle', { class: 'beacon', cx: at[0], cy: at[1], r: 6 }, this.fx);
      el('animate', { attributeName: 'r', from: 6, to: 34, dur: '1.2s', repeatCount: 'indefinite' }, ring);
      el('animate', { attributeName: 'opacity', from: 0.9, to: 0, dur: '1.2s', repeatCount: 'indefinite' }, ring);
    }
    this.glowTimer = setTimeout(() => {
      for (const { node } of targets) node.classList.remove('glow');
      for (const ring of this.fx.querySelectorAll('.beacon')) ring.remove();
    }, 6000);
  }

  /** Flash a room: an alert just landed there. */
  pulse(deptId, severity) {
    const room = this.rooms.get(deptId);
    if (!room) return;
    const p = el('polygon', { class: `pulse ${severity}`, points: pts(room.floorPts) }, this.fx);
    setTimeout(() => p.remove(), severity === 'critical' ? 4600 : 3800);
  }

  point(id) {
    if (this.anchors.has(id)) return this.anchors.get(id);
    const room = this.rooms.get(id);
    return room ? [room.centre[0], room.centre[1] - 8] : null;
  }

  /** A spark of traffic from one room (or the internet) to another. */
  spark(from, to, hostile) {
    if (this.sparks > 40) return;
    const a = this.point(from);
    const b = this.point(to);
    if (!a || !b) return;
    this.sparks++;
    const kind = hostile ? 'hostile' : 'benign';
    // Traffic from the internet comes in through the firewall when there is one.
    const gate = from === 'internet' && this.anchors.get('firewall');
    const mid = gate ? [gate[0], gate[1] - 10] : [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - 40];
    const d = `M${a[0]},${a[1]} Q${mid[0]},${mid[1]} ${b[0]},${b[1]}`;
    const trail = el('path', { class: `trail ${kind}`, d, 'stroke-opacity': 0.5 }, this.fx);
    const dot = el('circle', { class: `spark ${kind}`, r: hostile ? 4 : 3, filter: 'url(#glow)' }, this.fx);
    const length = trail.getTotalLength();
    trail.setAttribute('stroke-dasharray', `${length}`);
    trail.setAttribute('stroke-dashoffset', `${length}`);
    const start = performance.now();
    const duration = hostile ? 900 : 1300;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const p = trail.getPointAtLength(length * t);
      dot.setAttribute('cx', p.x);
      dot.setAttribute('cy', p.y);
      trail.setAttribute('stroke-dashoffset', `${length * (1 - t)}`);
      trail.setAttribute('stroke-opacity', String(0.5 * (1 - t * 0.6)));
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        dot.remove();
        trail.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 500 }).finished.then(() => trail.remove(), () => trail.remove());
        if (!trail.animate) trail.remove();
        this.sparks--;
      }
    };
    requestAnimationFrame(step);
  }
}
