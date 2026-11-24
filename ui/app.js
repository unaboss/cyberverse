// Cyberverse in the browser. Everything shown here comes from the server's
// projection of the round (what the learner is allowed to see), never from
// the raw world.

import { Floor } from './floor.js';
import { Town, nextFloor, towerStatus } from './town.js';
import { Desk } from './windows.js';
import { besideRect, clamp, cornerSpot, freeArea } from './geometry.js';
import { alertSound, doneSound, floorSound, isMuted, setMuted, stepSound, unlockSound } from './sound.js';
import { renderMarkdown } from './markdown.js';
import { ToolDesk } from './tools.js';
import { Tour, tourSeen } from './tour.js';

const $ = (id) => document.getElementById(id);

/** Build an element. Text always goes in as text, never as HTML. */
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  return node;
}

const api = {
  async get(path) {
    const res = await fetch(path, { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
    return body;
  },
  async post(path, body = {}) {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) throw new Error(data.error ?? `Request failed (${res.status}).`);
    return data;
  },
};

const tour = new Tour();

const state = {
  practicals: [],
  towers: [],
  tower: null,
  pending: null,
  snap: null,
  id: null,
  es: null,
  alerts: new Map(),
  expanded: null,
  host: null,
  logsTimer: null,
  pollTimer: null,
  refreshQueued: false,
  history: [],
  historyAt: 0,
  busy: 0,
  lanes: new Set(['attacker', 'detection', 'response', 'business']),
  seenAlerts: new Set(),
  // Guided floors
  guideDone: 0,
  guideStep: null,
  guideStepAt: 0,
  hintShown: null,
  hintTimer: null,
  guideKey: null,
  glowAlert: null,
  verdictSeq: 0,
  // The round screen's windows
  lastWin: null,
  free: null,
  feedCount: 0,
  noteTimer: 0,
};

/** Seconds on one step before Show me starts to glow. */
const HINT_AFTER_MS = 45_000;
const DONE_KEY = 'cyberverse.floorsDone';
const TOWER_KEY = 'cyberverse.tower';
/** This tab's round, so a refresh puts you back in it. */
const ROUND_KEY = 'cyberverse.round';
/** Why the page last reloaded itself in dev mode. */
const RELOAD_KEY = 'cyberverse.reloaded';
const TIER_NAME = { intro: 'Intro', intermediate: 'Intermediate', advanced: 'Advanced' };

const floor = new Floor($('floor'), {
  onHost: (key) => openHost(key),
  onRoom: (dept) => openRoom(dept),
});

// ------------------------------------------------------------------ windows

// Every panel on the round screen is a window over the floor. These are the places
// they start in; drag, resize or fold one and it stays the way you left it.
const M = 12;
const NOTE_W = 320;
const FEED_H = 170;
const FEED_BAR = 36; // a folded window is just its bar
const sideWidth = (W) => Math.round(clamp(W * 0.3, 320, 440));
const termWidth = (W) => Math.round(clamp(W * 0.38, 380, 600));
const rightWidth = (W) => (state.snap?.role === 'predator' ? termWidth(W) : sideWidth(W));

const desk = new Desk($('stage'), { onChange: () => fitFloor() });

desk.add('guide', $('guide'), {
  title: 'Guide',
  defaults: (W, H) => {
    const w = sideWidth(W);
    return { x: W - w - M, y: M, w, h: null, maxH: Math.round(H * 0.64) };
  },
});
desk.add('soc', $('soc'), {
  title: 'SOC console',
  fills: true,
  defaults: (W, H) => {
    const w = sideWidth(W);
    const x = W - w - M;
    // Until you move it, the console takes whatever the guide (above) and "Your actions"
    // (below) leave of the right-hand column.
    let top = M;
    let bottom = H - M;
    for (const id of ['guide', 'feed']) {
      const r = desk.rect(id);
      if (!r || r.right <= x + 24 || r.left >= x + w - 24) continue;
      if (r.top + r.bottom < H) top = Math.max(top, Math.round(r.bottom) + M);
      else bottom = Math.min(bottom, Math.round(r.top) - M);
    }
    return { x, y: top, w, h: Math.max(160, bottom - top) };
  },
});
desk.add('feed', $('feed-panel'), {
  title: 'Your actions',
  defaults: (W, H) => {
    const w = sideWidth(W);
    const h = desk.savedValue('feed', 'h') ?? FEED_H;
    // Folded, it is a bar at the foot of the column; open, it grows upwards from there.
    const tall = desk.savedValue('feed', 'folded') === false ? h : FEED_BAR;
    return { x: W - w - M, y: H - M - tall, w, h, folded: true };
  },
});
desk.add('host', $('host'), {
  title: 'Machine',
  bar: $('host').querySelector('.drawer-head'),
  defaults: (W, H) => {
    const h = Math.round(clamp(H * 0.44, 260, 440));
    return { x: M, y: H - h - M, w: Math.max(320, W - rightWidth(W) - 3 * M), h };
  },
});
desk.add('term', $('term'), {
  title: 'Terminal',
  bar: $('term').querySelector('.term-head'),
  defaults: (W, H) => {
    const w = termWidth(W);
    // On a guided attack floor the guide card keeps the right rail, the terminal
    // takes the lower left, and the map above it fills in as you find things.
    if (state.snap?.guide) {
      const gw = sideWidth(W);
      const top = Math.round(clamp(H * 0.45, 220, H - 280));
      return { x: M, y: top, w: Math.max(380, W - gw - 3 * M), h: H - top - M };
    }
    return { x: W - w - M, y: M, w, h: H - 2 * M };
  },
});

// The floor's desk tools: one window each, over the left of the floor.
const toolDesk = new ToolDesk({
  desk,
  stage: $('stage'),
  act: (tool, op, args) => act({ type: 'tool', tool, op, args }),
  look: (id) => look('tab', id),
  ctx: { snap: () => state.snap, openHost: (key) => openHost(key), toast: (text, sev) => toast(text, sev) },
});

/** Fit the floor into the part of the stage the open windows leave free. */
function fitFloor() {
  const view = $('floor-view');
  const sides = ['left', 'top', 'width', 'height'];
  if (desk.onPhone) {
    for (const side of sides) view.style[side] = '';
    state.free = null;
    return;
  }
  const { width: W, height: H } = $('stage').getBoundingClientRect();
  if (!W || !H) return;
  const free = freeArea(W, H, desk.visibleRects({ open: true }));
  state.free = free;
  for (const side of sides) view.style[side] = `${Math.round(free[side])}px`;
}

$('layout-reset').addEventListener('click', () => {
  desk.reset();
  toast('Every window is back where it started.');
});

/** Which window an action happened in, so its "Done" note can appear beside it. */
function windowFor(action) {
  if (action.type === 'tool') return `tool-${action.tool}`;
  if (action.type === 'look' && action.what === 'tab' && toolDesk.has(action.id)) return `tool-${action.id}`;
  if (action.type === 'look') return action.what === 'host' ? 'host' : action.what === 'room' ? 'room' : 'soc';
  if (action.type === 'answer') return 'guide';
  if (['isolate', 'release', 'rebuild', 'lock', 'reset'].includes(action.type)) return 'host';
  return 'soc';
}

/** The note that says a step is done, beside the window you were working in. */
function showNote(last) {
  const box = $('notes');
  clearTimeout(state.noteTimer);
  const close = h('button', { class: 'icon step-note-close', type: 'button', 'aria-label': 'Close the note', title: 'Close' }, '✕');
  const note = h(
    'div',
    { class: `step-note${last.wrong ? ' wrong' : ''}`, role: 'status' },
    h('span', { class: 'step-note-mark', 'aria-hidden': 'true' }, last.wrong ? '!' : '✓'),
    h('div', { class: 'step-note-text' }, h('b', {}, last.heading ?? (last.wrong ? `Not quite: ${last.title}` : `Done: ${last.title}`)), ...last.text.split(/\n\n+/).map((para) => h('p', {}, para))),
    close,
  );
  box.replaceChildren(note);
  close.addEventListener('click', () => hideNote());

  if (!desk.onPhone) {
    const { width: W, height: H } = $('stage').getBoundingClientRect();
    const w = Math.min(NOTE_W, W - 16);
    note.style.width = `${w}px`;
    const height = note.offsetHeight;
    const anchor = noteAnchor();
    const others = desk.visibleRects({ except: state.lastWin });
    const spot = anchor
      ? besideRect(anchor, w, height, W, H, others)
      : cornerSpot(state.free ?? { left: 0, top: 0, right: W, bottom: H }, w, height, others);
    note.style.left = `${Math.round(spot.x)}px`;
    note.style.top = `${Math.round(spot.y)}px`;
    note.dataset.side = spot.side ?? 'corner';
  }

  // Long enough to read, and it waits while the pointer or focus is on it.
  const words = last.text.split(/\s+/).length;
  const ms = Math.max(last.wrong ? 12_000 : 8_000, 4_000 + words * 330);
  let left = ms;
  let since = Date.now();
  const run = () => {
    since = Date.now();
    state.noteTimer = setTimeout(() => hideNote(note), left);
  };
  const hold = () => {
    clearTimeout(state.noteTimer);
    left = Math.max(2_000, left - (Date.now() - since));
  };
  note.addEventListener('pointerenter', hold);
  note.addEventListener('pointerleave', run);
  note.addEventListener('focusin', hold);
  note.addEventListener('focusout', run);
  run();
}

function hideNote(note) {
  const box = $('notes');
  if (note && !box.contains(note)) return;
  clearTimeout(state.noteTimer);
  const current = box.firstElementChild;
  if (!current) return;
  current.classList.add('leaving');
  setTimeout(() => current.remove(), 180);
}

/** The rectangle the "Done" note sits beside: the window you just used, else the guide. */
function noteAnchor() {
  if (state.lastWin === 'room' && !$('room').hidden) return desk.relative($('room').getBoundingClientRect());
  for (const id of [state.lastWin, 'guide']) {
    if (!id || id === 'room' || desk.folded(id)) continue;
    const r = desk.rect(id);
    if (r) return r;
  }
  return null;
}

// ------------------------------------------------------------------ helpers

function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

function inCidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const a = ipToInt(ip);
  const b = ipToInt(base);
  if (a === null || b === null) return false;
  const size = 2 ** (32 - Number(bits));
  return Math.floor(a / size) === Math.floor(b / size);
}

function isOutside(ip) {
  return !!ip && !state.snap.org.zones.some((z) => inCidr(ip, z.cidr));
}

function rands(n) {
  return `R${Math.round(n).toLocaleString('en-ZA')}`;
}

function mmss(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function hostByKey(key) {
  for (const dept of state.snap?.org.departments ?? []) {
    const host = dept.hosts.find((x) => x.key === key);
    if (host) return { host, dept };
  }
  return null;
}

function toast(text, severity) {
  const node = h('div', { class: 'toast' }, text);
  if (severity) node.style.setProperty('--sev', `var(--${severity})`);
  $('toasts').appendChild(node);
  setTimeout(() => node.remove(), 6000);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}

function feed(text) {
  const time = state.snap?.clock.text ?? '';
  $('feed').prepend(h('li', {}, h('b', {}, time), ' ', text));
  state.feedCount++;
  desk.setTitle('feed', `Your actions · ${state.feedCount}`);
}

function show(screen) {
  $('start').hidden = screen !== 'start';
  $('round').hidden = screen !== 'round';
}

// ------------------------------------------------------------- start screen

async function loadPracticals() {
  const list = $('towers');
  try {
    const [practicals, towers] = await Promise.all([api.get('/api/practicals'), api.get('/api/towers')]);
    state.practicals = practicals;
    state.towers = towers;
  } catch (err) {
    list.replaceChildren(h('p', { class: 'note' }, `Could not reach the lab server: ${err.message}`));
    return;
  }
  renderStart();
}

function doneSet() {
  try {
    const raw = JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function markDone(practicalId) {
  const done = doneSet();
  done.add(practicalId);
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify([...done]));
  } catch {
    /* a private window: the tick just won't stick */
  }
}

/** Where a practical sits in the towers, if anywhere. */
function towerSpot(practicalId) {
  for (const tower of state.towers) {
    const index = tower.floors.findIndex((f) => f.practical === practicalId);
    if (index >= 0) return { tower, floor: tower.floors[index], next: tower.floors[index + 1] ?? null };
  }
  return null;
}

function durationText(p) {
  return p.durationMin > 0 ? `${p.durationMin} min` : 'no time limit';
}

const town = new Town($('town'), {
  onPick: (towerId) => {
    state.tower = towerId;
    try {
      localStorage.setItem(TOWER_KEY, towerId);
    } catch {
      /* a private window: the choice just won't stick */
    }
    renderStart();
    if (window.matchMedia('(max-width: 900px)').matches) $('towers').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
});

/** The tower the town has picked: the last one you chose, else the intro defend tower. */
function pickedTower() {
  let saved = null;
  try {
    saved = localStorage.getItem(TOWER_KEY);
  } catch {
    /* no storage: fall through to the default */
  }
  const id = state.tower ?? saved;
  return state.towers.find((t) => t.id === id) ?? state.towers.find((t) => t.role === 'prey' && t.tier === 'intro') ?? state.towers[0] ?? null;
}

function renderStart() {
  const done = doneSet();
  const tower = pickedTower();
  state.tower = tower?.id ?? null;
  town.render(state.towers, { selected: state.tower, done });
  $('towers').replaceChildren(...(tower ? [towerCard(tower, done)] : []));
  const inTower = new Set(state.towers.flatMap((t) => t.floors.map((f) => f.practical).filter(Boolean)));
  const others = state.practicals.filter((p) => !inTower.has(p.id));
  $('others-head').hidden = others.length === 0;
  $('practicals').replaceChildren(...others.map((p) => practicalCard(p)));
}

function towerCard(tower, done) {
  const next = nextFloor(tower, done);
  const floors = [...tower.floors].sort((a, b) => b.floor - a.floor);
  const side = tower.role === 'prey' ? 'Defend' : 'Attack';
  return h(
    'article',
    { class: `tower ${tower.role}` },
    h(
      'header',
      { class: 'tower-head' },
      h('div', { class: 'chips' }, h('span', { class: `chip ${tower.role}` }, side), h('span', { class: 'chip tier' }, TIER_NAME[tower.tier] ?? tower.tier)),
      h('h2', {}, tower.name),
      h('p', { class: 'note' }, tower.blurb),
      h('small', { class: 'tower-status' }, towerStatus(tower, done)),
    ),
    floors.length
      ? h('ol', { class: 'tower-floors' }, ...floors.map((f) => floorRow(f, done, next)))
      : h(
          'div',
          { class: 'tower-empty' },
          h('b', {}, 'No floors yet'),
          h('p', { class: 'note' }, "This tower's floors get designed with you, one at a time, once the intro towers are built. Each one will climb from easy to hard, like the intro tower does."),
        ),
  );
}

function floorRow(f, done, next) {
  const p = f.practical ? state.practicals.find((x) => x.id === f.practical) : null;
  const isDone = !!p && done.has(p.id);
  const isNext = next === f;
  return h(
    'li',
    { class: `floor-row ${p ? 'open' : 'coming'}${isDone ? ' done' : ''}${isNext ? ' next' : ''}` },
    h('span', { class: 'floor-no mono' }, isDone ? '✓' : String(f.floor)),
    h(
      'div',
      { class: 'floor-info' },
      h('b', {}, `Floor ${f.floor}: ${f.title}`, p?.status === 'placeholder' ? h('span', { class: 'tag' }, '  placeholder') : null),
      h('small', {}, f.teaches),
      p ? h('small', { class: 'meta' }, `${p.orgName} · starts ${p.startTime} · ${durationText(p)}${p.guided ? ' · guided' : ''}`) : null,
    ),
    p
      ? h('button', { class: isNext ? 'primary small' : 'small', onclick: () => prepare(p) }, isDone ? 'Play again' : isNext ? 'Start here' : 'Play')
      : h('span', { class: 'coming-tag' }, 'Coming'),
  );
}

function practicalCard(p) {
  return h(
    'article',
    { class: 'card' },
    h('div', {}, h('span', { class: `chip ${p.role}` }, p.role === 'prey' ? 'Defend' : 'Attack'), p.status === 'placeholder' ? h('span', { class: 'tag' }, '  placeholder') : null),
    h('h2', {}, p.title),
    h('div', { class: 'meta' }, `${p.orgName} · starts ${p.startTime} · ${durationText(p)}`),
    h('p', {}, p.briefing),
    h('button', { class: 'primary', onclick: () => prepare(p) }, p.role === 'prey' ? 'Take the shift' : 'Start the test'),
  );
}

async function prepare(practical) {
  unlockSound();
  const seedText = $('seed').value.trim();
  const body = { practical: practical.id, speed: Number($('speed').value) };
  if (seedText !== '') body.seed = Number(seedText);
  try {
    const snap = await api.post('/api/sessions', body);
    state.pending = practical;
    startRound(snap);
    brief(practical);
  } catch (err) {
    toast(err.message, 'high');
  }
}

function brief(practical) {
  const spot = towerSpot(practical.id);
  $('brief-role').className = `chip ${practical.role}`;
  $('brief-role').textContent = spot ? `${spot.tower.name} · floor ${spot.floor.floor}` : practical.role === 'prey' ? 'You defend' : 'You attack';
  $('brief-title').textContent = practical.title;
  $('brief-go').textContent = practical.guided ? 'Start' : 'Begin';
  $('brief-text').textContent = practical.briefing;
  $('brief-placeholder').hidden = practical.status !== 'placeholder';
  $('briefing').hidden = false;
  $('brief-go').focus();
}

/** After a refresh, go back into this tab's round if the server still has it. */
async function rejoin() {
  const id = tab.get(ROUND_KEY);
  if (!id) return false;
  try {
    const snap = await api.get(`/api/sessions/${encodeURIComponent(id)}`);
    const practical = state.practicals.find((p) => p.id === snap.practical.id);
    state.pending = practical ?? null;
    startRound(snap, { rejoin: true });
    if (snap.status === 'briefing' && practical) brief(practical);
    return true;
  } catch {
    tab.set(ROUND_KEY, null);
    return false;
  }
}

// ------------------------------------------------------------ dev reloads

// Under npm run dev the page reloads itself when the server restarts (new code,
// world or practicals) or the UI files change, and a refresh keeps your round.
async function watchVersion() {
  let first;
  try {
    first = await api.get('/api/version');
  } catch {
    return;
  }
  if (!first.dev) return;
  setInterval(async () => {
    let now;
    try {
      now = await api.get('/api/version');
    } catch {
      return; // restarting: try again shortly
    }
    if (now.boot !== first.boot || now.ui !== first.ui) {
      tab.set(RELOAD_KEY, now.boot !== first.boot ? 'server' : 'ui');
      location.reload();
    }
  }, 2000);
}

/** Say why the page just reloaded itself, once. */
function reloadedNote(inRound) {
  const why = tab.get(RELOAD_KEY);
  tab.set(RELOAD_KEY, null);
  if (why === 'server' && !inRound) toast('The lab restarted with an update. Any round you were in has ended, so start it again from the town.');
  else if (why) toast('The page reloaded with the latest update.');
}

$('brief-go').addEventListener('click', async () => {
  $('briefing').hidden = true;
  const snap = await api.post(`/api/sessions/${state.id}/begin`);
  apply(snap);
  if (snap.role === 'predator') $('term-input').focus();
  else introMap(snap);
});

$('brief-back').addEventListener('click', async () => {
  $('briefing').hidden = true;
  await api.post(`/api/sessions/${state.id}/stop`).catch(() => {});
  leaveRound();
});

// -------------------------------------------------------------------- round

/** sessionStorage, which a private window or a locked-down browser may refuse. */
const tab = {
  get(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch {
      /* the round just won't survive a refresh */
    }
  },
};

function startRound(snap, { rejoin = false } = {}) {
  state.id = snap.session;
  tab.set(ROUND_KEY, snap.session);
  state.alerts.clear();
  state.seenAlerts.clear();
  state.expanded = null;
  state.busy = 0;
  // Coming back to a round after a refresh, the steps already done are not news.
  state.guideDone = rejoin ? (snap.guide?.steps.filter((s) => s.status === 'done').length ?? 0) : 0;
  if (rejoin) for (const alert of snap.alerts) state.seenAlerts.add(alert.id);
  state.verdictSeq = rejoin ? (snap.guide?.verdict?.seq ?? 0) : 0;
  state.guideStep = null;
  state.hintShown = null;
  state.guideKey = null;
  state.glowAlert = null;
  state.lastWin = null;
  state.feedCount = 0;
  clearTimeout(state.hintTimer);
  hideNote();
  $('complete').hidden = true;
  $('feed').replaceChildren();
  desk.setTitle('feed', 'Your actions');
  $('term-out').replaceChildren();
  $('debrief').hidden = true;
  closeHost();
  show('round');
  const prey = snap.role === 'prey';
  $('role-chip').className = `chip ${snap.role}`;
  $('role-chip').textContent = prey ? 'Defend' : 'Attack';
  const spot = towerSpot(snap.practical.id);
  $('round-name').textContent = spot ? `Floor ${spot.floor.floor}: ${snap.practical.title}` : snap.practical.title;
  $('soc').hidden = !prey;
  $('feed-panel').hidden = !prey;
  $('term').hidden = prey;
  $('stop').textContent = snap.guide ? 'Leave floor' : 'End round';
  $('pause').hidden = false;
  hideCaption(true);
  floor.prepare({ map: prey ? snap.practical.map : null, known: prey ? knownRooms(snap) : null, intro: prey && !rejoin });
  state.introDone = false;
  legend(prey);
  if (!prey) {
    termPrint(`${snap.practical.briefing.trim()}\n\nType help to see the tools. Recon first: the map fills in as you find things.\n`, 'sys');
  }
  apply(snap);
  connect();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => queueRefresh(), 2500);
}

function legend(prey) {
  const items = prey
    ? [['var(--hostile)', 'Hostile traffic the sensors saw'], ['var(--benign)', 'Normal traffic'], ['var(--medium)', 'Business-critical machine'], ['#7f1d1d', 'Machine down']]
    : [['var(--hostile)', 'Machine you own'], ['#3a4450', 'Found, not owned'], ['#0d1217', 'Not found yet']];
  $('legend').replaceChildren(...items.map(([c, t]) => h('span', {}, h('i', { style: `background:${c}` }), t)));
}

function apply(snap) {
  state.snap = snap;
  for (const alert of snap.alerts) state.alerts.set(alert.id, alert);
  floor.render(snap.org, snap.role);
  floor.setHeat([...state.alerts.values()]);
  floor.select(state.host);
  meters(snap);
  toolDesk.sync(snap);
  if (snap.role === 'prey') {
    renderAlerts();
    renderControls();
    renderBlocks();
  } else if (snap.terminal) {
    $('term-ip').textContent = snap.terminal.ip;
    if (state.busy === 0) $('term-prompt').textContent = snap.terminal.prompt;
  }
  if (state.host) renderHost();
  renderGuide(snap);
  $('pause').textContent = snap.status === 'paused' ? 'Resume' : 'Pause';
  if (snap.status === 'ended') ended(snap);
}

function meters(snap) {
  $('clock').textContent = snap.clock.text;
  floor.setTime(snap.clock.text);
  $('remaining').textContent = mmss(snap.clock.remainingMs);
  $('remaining-meter').hidden = !snap.clock.timed;
  const time = snap.guide?.time;
  $('target-meter').hidden = !time?.targetMs;
  if (time?.targetMs) {
    const left = time.targetMs - time.tookMs;
    $('target').textContent = left >= 0 ? mmss(left) : `+${mmss(-left)}`;
    $('target-meter').classList.toggle('over', left < 0);
  }
  const b = snap.business;
  $('business-meter').hidden = !b;
  if (b) {
    $('health-bar').style.width = `${b.health}%`;
    $('health-bar').style.background = b.health > 70 ? 'var(--ok)' : b.health > 40 ? 'var(--medium)' : 'var(--critical)';
    $('health-text').textContent = `${b.health}%${b.lostRands > 0 ? ` · ${rands(b.lostRands)} lost` : ''}`;
  }
}

function queueRefresh() {
  if (state.refreshQueued || !state.id) return;
  state.refreshQueued = true;
  setTimeout(async () => {
    state.refreshQueued = false;
    if (!state.id) return;
    let snap;
    try {
      snap = await api.get(`/api/sessions/${state.id}`);
    } catch {
      return; // the next poll tries again
    }
    apply(snap);
  }, 400);
}

function connect() {
  state.es?.close();
  const es = new EventSource(`/api/sessions/${state.id}/events`);
  state.es = es;
  es.onmessage = (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    onEvent(event);
  };
}

function onEvent(event) {
  switch (event.type) {
    case 'tick':
      $('clock').textContent = event.clock;
      floor.setTime(event.clock);
      $('remaining').textContent = mmss(event.remainingMs);
      if (event.status === 'ended' && state.snap?.status !== 'ended') queueRefresh();
      break;
    case 'alert': {
      const alert = event.alert;
      const isNew = !state.seenAlerts.has(alert.id);
      state.alerts.set(alert.id, alert);
      if (isNew) {
        state.seenAlerts.add(alert.id);
        alertSound(alert.severity);
        if (alert.room) {
          revealRoom(alert.room, 'An alert came from a room you had not seen yet.');
          floor.pulse(alert.room, alert.severity);
        }
        if (alert.severity !== 'low') toast(`${alert.name}: ${alert.summary.split(': ').slice(1).join(': ')}`, alert.severity);
        if (desk.folded('soc')) desk.ping('soc');
      }
      floor.setHeat([...state.alerts.values()]);
      renderAlerts(isNew ? alert.id : null);
      break;
    }
    case 'flow':
      floor.spark(event.from, event.to, event.hostile);
      break;
    case 'action':
      feed(event.text);
      queueRefresh();
      break;
    case 'host':
    case 'discovered':
    case 'guide':
    case 'tool':
      queueRefresh();
      break;
    case 'console':
      state.busy = Math.max(0, state.busy - 1);
      $('term-busy').hidden = state.busy === 0;
      if (event.text) termPrint(`${event.text}\n`);
      if (event.prompt) $('term-prompt').textContent = event.prompt;
      doneSound();
      queueRefresh();
      break;
    case 'terminal':
      termPrint(`${event.text}\n`, 'sys');
      alertSound('medium');
      queueRefresh();
      break;
    case 'round':
      if (event.status === 'ended') queueRefresh();
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- SOC panel

let alertsFrame = 0;
let freshId = null;

function renderAlerts(fresh = null) {
  if (fresh !== null) freshId = fresh;
  if (alertsFrame) return;
  alertsFrame = requestAnimationFrame(() => {
    alertsFrame = 0;
    drawAlerts();
    freshId = null;
  });
}

function drawAlerts() {
  const alerts = [...state.alerts.values()].sort((a, b) => b.t - a.t);
  const open = alerts.filter((a) => a.status !== 'closed').length;
  $('alert-count').textContent = String(open);
  desk.setTitle('soc', open > 0 ? `SOC console · ${open} open` : 'SOC console');
  const list = $('alerts');
  if (alerts.length === 0) {
    list.replaceChildren(h('li', { class: 'note', style: 'padding:14px' }, 'Quiet so far. Alerts land here the moment a sensor sees something it has a rule for.'));
    return;
  }
  list.replaceChildren(...alerts.map((a) => alertItem(a)));
}

function alertItem(a) {
  const expanded = state.expanded === a.id;
  const li = h(
    'li',
    { class: `alert sev-${a.severity}${a.status === 'closed' ? ' closed' : ''}${freshId === a.id ? ' fresh' : ''}${a.drill ? ' drill' : ''}${state.glowAlert?.id === a.id && Date.now() < state.glowAlert.until ? ' guide-glow' : ''}`, 'data-alert': a.id },
    h('div', { class: 'alert-top' }, h('span', { class: 'alert-sev' }, a.severity), a.drill ? h('span', { class: 'drill-tag' }, 'Test') : null, h('span', { class: 'alert-name' }, a.name), h('span', { class: 'alert-time' }, a.clock)),
    h('div', { class: 'alert-sum' }, a.summary),
  );
  li.addEventListener('click', () => {
    state.expanded = expanded ? null : a.id;
    if (!expanded) look('alert', String(a.id));
    renderAlerts();
  });
  if (expanded) {
    const more = h(
      'div',
      { class: 'alert-more', onclick: (e) => e.stopPropagation() },
      a.src ? h('p', { class: 'alert-from' }, h('b', {}, 'From '), h('span', { class: 'mono' }, a.src), ` · ${fromWho(a)}`) : null,
      h('p', {}, a.response),
      h('div', { class: 'tag' }, `${a.drill ? 'Practice alert' : `${a.rule} · ATT&CK ${a.attack} · ${a.sensor}`} · seen ${a.count} time${a.count === 1 ? '' : 's'} · ${a.verdict ? `closed as ${a.verdict.replace('-', ' ')}` : a.status}`),
      h(
        'div',
        { class: 'alert-buttons' },
        a.status === 'new' ? h('button', { class: 'small', onclick: () => act({ type: 'acknowledge', alert: a.id }) }, 'Pick it up') : null,
        a.status !== 'closed' ? h('button', { class: 'small', onclick: () => act({ type: 'classify', alert: a.id, verdict: 'true-positive' }) }, 'True positive') : null,
        a.status !== 'closed' ? h('button', { class: 'small', onclick: () => act({ type: 'classify', alert: a.id, verdict: 'false-positive' }) }, 'False positive') : null,
        a.src && isOutside(a.src) && !state.snap.blocks.includes(a.src) ? lockable('block', h('button', { class: 'small danger', onclick: () => act({ type: 'block', src: a.src }) }, `Block ${a.src}`)) : null,
        a.host ? h('button', { class: 'small', onclick: () => openHost(a.host) }, 'Open machine') : null,
        a.srcHost && a.srcHost !== a.host ? h('button', { class: 'small', onclick: () => openHost(a.srcHost) }, 'Open where it came from') : null,
      ),
    );
    li.appendChild(more);
  }
  return li;
}

/** Who an alert's source address belongs to, as the asset register knows it. */
function fromWho(a) {
  const mine = a.srcHost ? hostByKey(a.srcHost) : null;
  if (mine) return `${mine.host.name}, one of ours`;
  return isOutside(a.src) ? 'not one of ours' : 'inside our network';
}

function renderControls() {
  const list = $('controls-list');
  list.replaceChildren(
    ...state.snap.controls.map((c) => {
      const input = h('input', { type: 'checkbox', class: 'switch', 'aria-label': c.name });
      input.checked = c.on;
      lockable('control', input);
      input.addEventListener('change', () => {
        // A project isn't a switch: the server says why, and the switch goes back.
        if (c.project) input.checked = false;
        act({ type: 'control', control: c.id, on: c.project ? true : input.checked });
      });
      const tag = c.project ? h('span', { class: 'chip project-chip', title: 'Needs a budget and a plan, not a switch' }, 'Project') : null;
      return h('li', { class: c.project ? 'project' : null }, input, h('div', { class: 'grow' }, h('b', {}, c.name, tag ? ' ' : null, tag), h('small', {}, `${c.kind}. ${c.description}`)));
    }),
  );
}

function renderBlocks() {
  const blocks = state.snap.blocks;
  $('blocks-list').replaceChildren(
    ...(blocks.length === 0
      ? [h('li', { class: 'note' }, 'Nothing blocked at the perimeter yet.')]
      : blocks.map((ip) => {
          const stopped = state.snap.stopped?.[ip] ?? 0;
          return h(
            'li',
            {},
            h('div', { class: 'grow' }, h('span', { class: 'mono' }, ip), h('small', { class: 'block-stopped' }, stopped === 0 ? 'Nothing stopped yet' : `${stopped} ${stopped === 1 ? 'try' : 'tries'} stopped at the perimeter`)),
            lockable('unblock', h('button', { class: 'small', onclick: () => act({ type: 'unblock', src: ip }) }, 'Unblock')),
          );
        })),
  );
  const blockFloor = lockedOn('block');
  $('block-ip').disabled = blockFloor !== null;
  $('block-form').querySelector('button').disabled = blockFloor !== null;
  $('block-ip').placeholder = blockFloor !== null ? `Blocking unlocks on floor ${blockFloor}` : '10.88.0.143';
}

/** The floor that unlocks an action, when this floor locks it. */
function lockedOn(type) {
  const floorNo = state.snap?.guide?.locked?.[type];
  return typeof floorNo === 'number' ? floorNo : null;
}

/** Disable a control the floor has locked, and say when it unlocks. */
function lockable(type, node) {
  const floorNo = lockedOn(type);
  if (floorNo !== null) {
    node.disabled = true;
    node.title = `Unlocks on floor ${floorNo}`;
    node.classList.add('locked');
  }
  return node;
}

$('block-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const ip = $('block-ip').value.trim();
  if (ip) act({ type: 'block', src: ip }).then(() => ($('block-ip').value = ''));
});

function selectTab(name) {
  for (const t of document.querySelectorAll('.tabs button')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const body of document.querySelectorAll('.tab-body')) body.hidden = body.dataset.body !== name;
}

for (const tab of document.querySelectorAll('.tabs button')) {
  tab.addEventListener('click', () => {
    selectTab(tab.dataset.tab);
    look('tab', tab.dataset.tab);
  });
}

/** Tell a guided floor what the learner just looked at. */
function look(what, id) {
  if (!state.snap?.guide?.current || !state.id) return;
  void quiet({ type: 'look', what, id });
}

/** An action that should not land in the "Your actions" feed. */
async function quiet(action) {
  state.lastWin = windowFor(action);
  try {
    const result = await api.post(`/api/sessions/${state.id}/act`, action);
    if (!result.ok && result.message) toast(result.message, 'medium');
    queueRefresh();
    return result;
  } catch (err) {
    toast(err.message, 'high');
    return null;
  }
}

async function act(action) {
  state.lastWin = windowFor(action);
  try {
    const result = await api.post(`/api/sessions/${state.id}/act`, action);
    if (!result.ok) toast(result.message, 'medium');
    else if (action.type !== 'acknowledge') feed(result.message);
    queueRefresh();
    return result;
  } catch (err) {
    toast(err.message, 'high');
    return null;
  }
}

// ------------------------------------------------------------ map growth

/** The floor below this one in its tower, when it plays the same organisation. */
function floorBelow(snap) {
  const spot = towerSpot(snap.practical.id);
  if (!spot) return null;
  const index = spot.tower.floors.indexOf(spot.floor);
  const below = spot.tower.floors[index - 1];
  const prev = below?.practical ? state.practicals.find((p) => p.id === below.practical) : null;
  return prev && prev.org === snap.org.id && prev.role === 'prey' ? prev : null;
}

/** The rooms the learner already knows from the floor below, or null for none. */
function knownRooms(snap) {
  const prev = floorBelow(snap);
  if (!prev) return null;
  return prev.mapSeen ?? snap.org.departments.map((d) => d.id);
}

/** What lies outside a floor's walls: the internet, the firewall, the partners. */
function outsideOf(map) {
  const set = new Set(map?.outside ?? ['internet', 'partners']);
  if (map?.perimeter) set.add('firewall');
  return set;
}

const OUTSIDE_NAME = { internet: 'The internet', firewall: 'The firewall', partners: 'Partners' };
const OUTSIDE_TITLE = { internet: 'The internet, beyond our walls', firewall: 'A firewall on the front door', partners: 'Our partners appear' };

/** As a floor opens: raise its new rooms and say what's new. */
function introMap(snap) {
  if (state.introDone) return;
  state.introDone = true;
  const map = snap.practical.map;
  const spot = towerSpot(snap.practical.id);
  const prev = floorBelow(snap);
  const fresh = floor.newRooms(snap.org, snap.role);
  const depts = fresh.map((id) => snap.org.departments.find((d) => d.id === id)).filter(Boolean);
  floor.playIntro();
  if (!prev) {
    const first = spot && spot.floor.floor === 0 && spot.tower.tier === 'intro';
    // The first floor of a tower opens with the tour, which says all the caption would.
    if (spot?.floor.floor === 0 && snap.guide && !tourSeen()) {
      state.tourTimer = setTimeout(() => startTour(state.snap ?? snap), 1700);
      return;
    }
    showCaption({
      kicker: first ? 'Your first floor' : snap.org.sites ? 'A new place' : 'A new building',
      title: snap.org.name,
      text: map?.note ?? (first ? 'This is where you work. More of the building opens up as you climb the tower.' : 'Bigger than the last one. Take a moment to look round before you start.'),
      rooms: [],
    });
    return;
  }
  const before = outsideOf(prev.map);
  const extras = [...outsideOf(map)].filter((x) => !before.has(x));
  if (depts.length === 0 && extras.length === 0 && !map?.note) return;
  const title = depts.length > 0 ? (depts.length === 1 ? 'A new room opens up' : `${depts.length} new rooms open up`) : extras.length > 0 ? OUTSIDE_TITLE[extras[0]] : 'The same floor, a harder day';
  showCaption({
    kicker: 'New on this floor',
    title,
    text: map?.note ?? '',
    rooms: [...depts, ...extras.map((x) => ({ id: null, name: OUTSIDE_NAME[x] }))],
  });
}

/** Build a room into the map mid-round, and say so. */
function revealRoom(deptId, why) {
  if (!deptId || state.snap?.role !== 'prey') return;
  const name = floor.reveal(deptId);
  if (!name) return;
  const dept = state.snap.org.departments.find((d) => d.id === deptId);
  showCaption({ kicker: 'New room', title: name, text: why ?? '', rooms: dept ? [dept] : [], short: true });
}

function showCaption({ kicker, title, text, rooms, short = false }) {
  const box = $('map-caption');
  clearTimeout(state.captionTimer);
  const close = h('button', { class: 'cap-close', type: 'button', 'aria-label': 'Close', title: 'Close' }, '✕');
  close.addEventListener('click', () => hideCaption());
  const parts = [
    h('span', { class: 'cap-kicker' }, kicker),
    h('b', { class: 'cap-title' }, title),
    text ? h('p', {}, text) : null,
    rooms.length > 0 ? h('div', { class: 'cap-rooms' }, ...rooms.map((d) => h('span', { class: 'cap-room', style: `--tint:${d.id ? floor.tint(d.id) : 'var(--accent)'}` }, d.name))) : null,
    close,
  ];
  // replaceChildren() would print a null as the text "null".
  box.replaceChildren(...parts.filter(Boolean));
  box.classList.remove('leaving');
  box.hidden = false;
  const wait = () => {
    clearTimeout(state.captionTimer);
    state.captionTimer = setTimeout(() => (box.matches(':hover') ? wait() : hideCaption()), short ? 5000 : 9000);
  };
  wait();
}

function hideCaption(now = false) {
  const box = $('map-caption');
  clearTimeout(state.captionTimer);
  if (now || box.hidden) {
    box.hidden = true;
    return;
  }
  box.classList.add('leaving');
  setTimeout(() => {
    if (box.classList.contains('leaving')) box.hidden = true;
  }, 360);
}

// ------------------------------------------------------------ the tour

/** The stops on a tour of the round screen, for this floor. */
function tourStops(snap) {
  const mentor = snap.guide?.mentor?.name?.split(/\s+/)[0] ?? 'Your mentor';
  const growing = !!snap.practical.map?.rooms;
  return [
    {
      target: () => $('floor-view'),
      side: 'inside',
      title: `This is ${snap.org.name}`,
      text: `The office, seen from above. Drag to look round, scroll to zoom, and double-click a room to go straight to it.${growing ? ' Rooms with the lights off open up as you need them.' : ''}`,
    },
    {
      target: () => desk.win('guide'),
      title: `${mentor}'s card`,
      text: 'It tells you what to do next, one step at a time, and ticks each step off when you do it. Stuck? Press "Show me".',
    },
    {
      target: () => desk.win('soc'),
      title: 'The SOC console',
      text: 'Alerts land here the moment a sensor sees something. Controls and Blocks are the tools you will use to stop an attack.',
    },
    {
      target: () => document.querySelector('#round .meters'),
      side: 'bottom',
      title: 'The clock and the business',
      text: 'The clock runs in office time. The business bar shows how well the company is working, and an attack that lands pulls it down.',
    },
    {
      target: () => document.querySelector('.map-tools'),
      title: 'Lost on the map?',
      text: 'Zoom in and out here. The square button shows the whole floor again (or press 0), and the ? plays this tour again any time.',
    },
  ];
}

function startTour(snap) {
  clearTimeout(state.tourTimer);
  if (!snap || $('round').hidden) return;
  hideCaption(true);
  tour.start(tourStops(snap));
}

$('map-tour').addEventListener('click', () => state.snap && startTour(state.snap));
$('map-in').addEventListener('click', () => floor.zoomBy(1.4));
$('map-out').addEventListener('click', () => floor.zoomBy(1 / 1.4));
$('map-fit').addEventListener('click', () => floor.fit());
document.addEventListener('keydown', (event) => {
  if ($('round').hidden || event.ctrlKey || event.metaKey || event.altKey) return;
  const t = event.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t?.isContentEditable) return;
  if (event.key === '+' || event.key === '=') floor.zoomBy(1.4);
  else if (event.key === '-' || event.key === '_') floor.zoomBy(1 / 1.4);
  else if (event.key === '0') floor.fit();
  else if (event.key === '?') startTour(state.snap);
  else return;
  event.preventDefault();
});

// ------------------------------------------------------------ guided floor

function renderGuide(snap) {
  const card = $('guide');
  const g = snap.guide;
  if (!g || (snap.status === 'ended' && g.complete)) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const doneCount = g.steps.filter((s) => s.status === 'done').length;
  if (doneCount > state.guideDone) {
    stepSound();
    const win = desk.win('guide');
    win?.classList.remove('ticked');
    void win?.offsetWidth;
    win?.classList.add('ticked');
    // "Done" goes in a note beside what you just did, so the card only says what's next.
    // It waits a moment for the windows to settle around the new step's card.
    const last = g.last;
    if (last && !g.complete) setTimeout(() => state.snap?.guide && showNote(last), 120);
    if (desk.folded('guide')) desk.ping('guide');
  }
  state.guideDone = doneCount;
  // On a sorting step, each verdict gets the mentor's reply beside the SOC console.
  if (g.verdict && g.verdict.seq > state.verdictSeq) {
    const verdict = g.verdict;
    setTimeout(() => state.snap?.guide && showNote({ ...verdict, wrong: !verdict.correct, heading: `${verdict.correct ? 'Right' : 'Not quite'}: ${verdict.title}` }), 120);
  }
  state.verdictSeq = Math.max(state.verdictSeq, g.verdict?.seq ?? 0);
  const cur = g.current;
  if (cur && cur.id !== state.guideStep) {
    state.guideStep = cur.id;
    // A step done in a desk tool opens that tool's window, once, as it starts.
    if (cur.tool && toolDesk.has(cur.tool)) toolDesk.focus(cur.tool);
    state.guideStepAt = Date.now();
    state.hintShown = null;
    floor.highlight({}); // last step's glow would point at the wrong thing now
    // A step that points into a room the map doesn't have yet builds it in.
    const target = cur.show?.room ?? (cur.show?.host ? floor.roomOf(cur.show.host) : null);
    if (target) setTimeout(() => revealRoom(target, cur.title), floor.waiting ? 1800 : 0);
    clearTimeout(state.hintTimer);
    state.hintTimer = setTimeout(() => state.snap && renderGuide(state.snap), HINT_AFTER_MS + 50);
  }
  desk.setTitle('guide', cur ? `Guide · ${cur.index + 1} of ${g.steps.length} · ${cur.title}` : 'Guide');

  const initials = g.mentor.name.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase();
  const head = h(
    'header',
    { class: 'guide-head' },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials),
    h('div', { class: 'who' }, h('b', {}, g.mentor.name), h('small', {}, g.mentor.role)),
  );
  const dots = h('ol', { class: 'guide-dots', 'aria-label': `${doneCount} of ${g.steps.length} steps done` }, ...g.steps.map((step) => h('li', { class: step.status, title: step.title })));
  if (!cur) {
    state.guideKey = null;
    card.replaceChildren(head, dots);
    return;
  }

  const stuck = Date.now() - state.guideStepAt > HINT_AFTER_MS;
  // Only rebuild the card when something on it changed, so a click is never lost to a redraw.
  const key = JSON.stringify([g.current, g.feedback, doneCount, stuck, state.hintShown, snap.fast]);
  if (key === state.guideKey && card.childElementCount > 0) return;
  state.guideKey = key;
  const parts = [head, dots];
  parts.push(h('h3', { class: 'guide-title' }, cur.title), h('p', { class: 'guide-say' }, cur.say));
  parts.push(h('div', { class: 'guide-do' }, h('span', { class: 'guide-do-label' }, 'Your turn'), cur.do));
  if (cur.waiting) {
    parts.push(h('div', { class: 'guide-wait' }, 'Watch closely. It is about to happen.'));
  }
  if (cur.sort) {
    const { done, total } = cur.sort;
    parts.push(
      h(
        'div',
        { class: 'guide-sort', role: 'status' },
        h('span', {}, `Sorted ${done} of ${total}`),
        h('span', { class: 'guide-sort-bar', 'aria-hidden': 'true' }, ...Array.from({ length: total }, (_, i) => h('i', { class: i < done ? 'on' : '' }))),
      ),
    );
  }
  if (cur.targets) {
    const { done, total } = cur.targets;
    parts.push(
      h(
        'div',
        { class: 'guide-sort', role: 'status' },
        h('span', {}, `Done ${done} of ${total}`),
        h('span', { class: 'guide-sort-bar', 'aria-hidden': 'true' }, ...Array.from({ length: total }, (_, i) => h('i', { class: i < done ? 'on' : '' }))),
      ),
    );
  }
  if (cur.canSkip) {
    parts.push(
      h(
        'div',
        { class: 'guide-skip' },
        h('button', { class: 'small', disabled: snap.fast, onclick: () => void quiet({ type: 'fast' }) }, snap.fast ? 'Skipping ahead…' : 'Skip ahead ⏩'),
        h('span', { class: 'note' }, snap.fast ? 'The clock runs fast until something happens.' : 'Nothing to do until it happens. Skip the wait.'),
      ),
    );
  }
  if (cur.ask) {
    const answered = g.feedback;
    parts.push(
      h(
        'div',
        { class: 'guide-ask' },
        h('b', {}, cur.ask.question),
        ...cur.ask.options.map((text, i) => h('button', { class: 'option', onclick: () => void quiet({ type: 'answer', option: i }) }, text)),
        answered ? h('p', { class: `guide-feedback${answered.correct ? ' right' : ''}` }, answered.text) : null,
      ),
    );
  }
  if (state.hintShown === cur.id) {
    parts.push(h('p', { class: 'guide-hint' }, cur.hint));
  }
  parts.push(
    h(
      'div',
      { class: 'guide-foot' },
      h('button', { class: `small${stuck && state.hintShown !== cur.id ? ' nudge' : ''}`, onclick: () => showMe(cur) }, 'Show me'),
      stuck && state.hintShown !== cur.id ? h('span', { class: 'note' }, 'Stuck? Press Show me.') : null,
    ),
  );
  card.replaceChildren(...parts);
}

/** Make the thing the step is about glow, and show the hint. */
function showMe(cur) {
  state.hintShown = cur.id;
  const show = cur.show ?? {};
  if (show.room || show.host) {
    floor.highlight({ room: show.room, host: show.host });
    if (desk.onPhone) document.querySelector('.floor-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (show.tab === 'term') {
    desk.open('term');
    glow($('term').querySelector('.term-head'));
    $('term-input').focus();
  } else if (show.tab && toolDesk.has(show.tab)) {
    const win = toolDesk.open(show.tab);
    glow(win?.querySelector('.pane-bar'));
  } else if (show.tab) {
    desk.open('soc');
    selectTab(show.tab);
    glow(document.querySelector(`.tabs button[data-tab="${show.tab}"]`));
  }
  if (show.alert !== undefined) {
    desk.open('soc');
    if (!show.tab) selectTab('alerts');
    state.glowAlert = { id: show.alert, until: Date.now() + 6000 };
    renderAlerts();
  }
  renderGuide(state.snap);
}

function glow(node) {
  if (!node) return;
  node.classList.remove('guide-glow');
  void node.offsetWidth;
  node.classList.add('guide-glow');
  setTimeout(() => node.classList.remove('guide-glow'), 6000);
}

// ------------------------------------------------------------- the machine

function openHost(key) {
  revealRoom(floor.roomOf(key));
  state.host = key;
  floor.select(key);
  $('room').hidden = true;
  $('host').hidden = false;
  desk.open('host');
  renderHost();
  look('host', key);
  clearInterval(state.logsTimer);
  if (state.snap.role === 'prey') {
    void loadLogs();
    state.logsTimer = setInterval(loadLogs, 2000);
  }
}

function closeHost() {
  state.host = null;
  floor.select(null);
  $('host').hidden = true;
  clearInterval(state.logsTimer);
}

$('host-close').addEventListener('click', closeHost);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('manual').hidden) $('manual').hidden = true;
    else if (!$('room').hidden) $('room').hidden = true;
    else if ($('notes').firstElementChild) hideNote();
    else if (state.host) closeHost();
  }
});

function renderHost() {
  const found = hostByKey(state.host);
  if (!found) {
    closeHost();
    return;
  }
  const { host, dept } = found;
  const prey = state.snap.role === 'prey';
  $('host-name').textContent = host.name;
  $('host-sub').textContent = `${host.fqdn} · ${host.ip}`;
  const facts = prey
    ? [
        ['Department', dept.name],
        ['Kind', host.kind],
        ['System', host.os],
        ['Zone', state.snap.org.zones.find((z) => z.id === host.zone)?.name ?? host.zone],
        ['Status', host.status],
        ['Business critical', host.critical ? 'Yes' : 'No'],
        ['Information held', (host.data ?? []).length ? host.data.map((d) => `${d.name} (${d.sensitivity}${d.personal ? ', personal information' : ''}${d.records ? `, ${d.records.toLocaleString('en-ZA')} records` : ''})`).join('; ') : 'Nothing on record'],
        ['Log agent', host.logAgent ? 'Sends logs to the SOC' : 'None. Nothing on this machine reaches you.'],
        ['Regular jobs', (host.jobs ?? []).length ? h('ul', { class: 'jobs' }, ...host.jobs.map((j) => h('li', {}, j))) : 'None on record'],
      ]
    : [
        ['Status', host.owned ? 'You have a session here' : 'Found, not owned'],
        ['Open ports', String(host.ports.length)],
      ];
  $('host-facts').replaceChildren(...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '')]));

  const actions = $('host-actions');
  actions.replaceChildren();
  if (prey && state.snap.status !== 'ended') {
    const isolated = host.status === 'isolated';
    actions.append(
      isolated
        ? lockable('release', h('button', { class: 'small', onclick: () => act({ type: 'release', host: host.key }) }, 'Release from isolation'))
        : lockable('isolate', h('button', { class: 'small danger', onclick: () => act({ type: 'isolate', host: host.key }) }, 'Isolate')),
      lockable('rebuild', h('button', { class: 'small', onclick: () => act({ type: 'rebuild', host: host.key }) }, 'Rebuild from image')),
    );
    const user = lockable('lock', h('input', { placeholder: 'account, for example admin', 'aria-label': 'Account', autocomplete: 'off' }));
    const form = h('form', { class: 'inline-form' }, user, lockable('lock', h('button', { class: 'small', type: 'button', onclick: () => user.value && act({ type: 'lock', host: host.key, user: user.value.trim() }) }, 'Lock')), lockable('reset', h('button', { class: 'small', type: 'button', onclick: () => user.value && act({ type: 'reset', host: host.key, user: user.value.trim() }) }, 'Reset password')));
    form.addEventListener('submit', (e) => e.preventDefault());
    actions.append(form);
    const floors = ['isolate', 'rebuild', 'lock', 'reset'].map(lockedOn).filter((n) => n !== null);
    if (floors.length) actions.append(h('p', { class: 'note locked-note' }, `These buttons unlock from floor ${Math.min(...floors)}. Today you only look.`));
  }
  $('host-ports').replaceChildren(
    ...(host.ports.length === 0
      ? [h('li', {}, prey ? 'No listening services.' : 'Nothing found yet. Try nmap -sV.')]
      : host.ports.map((p) => h('li', {}, h('b', {}, `${p.port}/tcp`), `  ${p.name ?? ''}  ${p.product ?? ''} ${p.version ?? ''}`))),
  );
  $('logs-col').hidden = !prey;
  $('host').classList.toggle('no-logs', !prey);
}

async function loadLogs() {
  if (!state.host || !state.id) return;
  try {
    const { lines } = await api.get(`/api/sessions/${state.id}/hosts/${encodeURIComponent(state.host)}/logs`);
    const pre = $('host-logs');
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    const found = hostByKey(state.host);
    pre.textContent = lines.length ? lines.join('\n') : found?.host.logAgent ? 'No log lines yet.' : 'This machine sends no logs to the SOC, so you cannot see what happens on it.';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  } catch {
    /* try again on the next tick */
  }
}

function openRoom(deptId) {
  const dept = state.snap.org.departments.find((d) => d.id === deptId);
  if (!dept) return;
  look('room', deptId);
  const pop = $('room');
  pop.replaceChildren(
    h('h3', {}, dept.revealed ? dept.name : 'Not found yet'),
    dept.revealed
      ? h('div', { class: 'note' }, `${dept.hosts.length} machine${dept.hosts.length === 1 ? '' : 's'}${dept.staffed ? '' : ' · not staffed yet'}`)
      : h('div', { class: 'note' }, 'Scan the networks to find what is here.'),
    dept.people.length ? h('ul', {}, ...dept.people.map((p) => h('li', {}, `${p.name}, ${p.role}${p.kind === 'agent' ? ' (AI agent)' : ''}`))) : null,
  );
  pop.hidden = false;
  // In a corner of the floor, which the building never reaches, so the box never covers
  // the room you want to click next. The corner the fewest windows are over.
  const stage = $('stage').getBoundingClientRect();
  if (desk.onPhone) {
    const wrap = document.querySelector('.floor-wrap').getBoundingClientRect();
    pop.style.left = `${Math.round(wrap.left + 8)}px`;
    pop.style.top = `${Math.round(Math.max(8, wrap.top + 8))}px`;
    return;
  }
  const free = state.free ?? { left: 0, top: 0, right: stage.width, bottom: stage.height };
  const spot = cornerSpot(free, pop.offsetWidth, pop.offsetHeight, desk.visibleRects());
  pop.style.left = `${Math.round(stage.left + spot.x)}px`;
  pop.style.top = `${Math.round(stage.top + spot.y)}px`;
}

document.addEventListener('click', (e) => {
  if (!$('room').hidden && !$('room').contains(e.target) && !e.target.closest?.('.room')) $('room').hidden = true;
});

// ------------------------------------------------------------- the terminal

function termPrint(text, kind) {
  const out = $('term-out');
  out.appendChild(kind ? h('span', { class: kind }, text) : document.createTextNode(text));
  out.scrollTop = out.scrollHeight;
}

$('term-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('term-input');
  const line = input.value;
  input.value = '';
  if (line.trim() === 'clear') {
    $('term-out').replaceChildren();
    return;
  }
  termPrint(`${$('term-prompt').textContent}${line}\n`, 'cmd');
  if (line.trim()) {
    state.history.push(line);
    state.historyAt = state.history.length;
  }
  state.busy++;
  $('term-busy').hidden = false;
  try {
    await api.post(`/api/sessions/${state.id}/console`, { line });
  } catch (err) {
    state.busy = Math.max(0, state.busy - 1);
    $('term-busy').hidden = state.busy === 0;
    termPrint(`${err.message}\n`, 'sys');
  }
});

$('term-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' && state.historyAt > 0) {
    state.historyAt--;
    e.target.value = state.history[state.historyAt] ?? '';
    e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    state.historyAt = Math.min(state.history.length, state.historyAt + 1);
    e.target.value = state.history[state.historyAt] ?? '';
    e.preventDefault();
  }
});
$('term-out').addEventListener('click', () => $('term-input').focus());

// ----------------------------------------------------------- round controls

$('pause').addEventListener('click', async () => {
  const paused = state.snap?.status === 'paused';
  await api.post(`/api/sessions/${state.id}/${paused ? 'resume' : 'pause'}`);
  queueRefresh();
});

$('stop').addEventListener('click', async () => {
  if (state.snap?.status === 'ended') {
    if (guidedOnly(state.snap)) showComplete(state.snap);
    else $('debrief').hidden = false;
    return;
  }
  apply(await api.post(`/api/sessions/${state.id}/stop`));
});

$('mute').addEventListener('click', () => {
  setMuted(!isMuted());
  $('mute').textContent = isMuted() ? '🔇' : '🔊';
  $('mute').title = isMuted() ? 'Sound off' : 'Sound on';
});

function leaveRound() {
  tab.set(ROUND_KEY, null);
  state.es?.close();
  state.es = null;
  clearInterval(state.pollTimer);
  closeHost();
  state.id = null;
  state.snap = null;
  clearTimeout(state.hintTimer);
  clearTimeout(state.tourTimer);
  tour.end(false);
  hideCaption(true);
  hideNote();
  $('debrief').hidden = true;
  $('complete').hidden = true;
  $('guide').hidden = true;
  toolDesk.sync({ tools: {} });
  show('start');
}

// ------------------------------------------------------------------ debrief

let debriefShownFor = null;

/** A guided floor that is not scored ends on a completion card, not a debrief. */
function guidedOnly(snap) {
  return !!snap.guide && !snap.guide.scored;
}

function ended(snap) {
  $('stop').textContent = guidedOnly(snap) ? 'Summary' : 'Debrief';
  $('pause').hidden = true;
  clearInterval(state.pollTimer);
  clearTimeout(state.hintTimer);
  if (debriefShownFor !== snap.session) {
    debriefShownFor = snap.session;
    if (snap.end?.reason !== 'stopped') markDone(snap.practical.id);
    if (guidedOnly(snap)) {
      if (snap.guide.complete) floorSound();
      showComplete(snap);
    } else {
      alertSound(snap.debrief?.score?.outcome === 'Breached' ? 'critical' : 'medium');
      $('debrief').hidden = false;
    }
  }
  if (!guidedOnly(snap)) renderDebrief(snap);
}

function showComplete(snap) {
  const g = snap.guide;
  const spot = towerSpot(snap.practical.id);
  const nextPractical = spot?.next?.practical ? state.practicals.find((p) => p.id === spot.next.practical) : null;
  $('cp-floor').textContent = spot ? `${spot.tower.name} · floor ${spot.floor.floor}` : snap.practical.title;
  const doneCount = g.steps.filter((s) => s.status === 'done').length;
  const time = g.time;
  $('cp-time').hidden = !(g.complete && time?.targetMs);
  if (g.complete && time?.targetMs) {
    const under = time.tookMs <= time.targetMs;
    $('cp-time').textContent = `Done in ${mmss(time.tookMs)} of lab time. Target ${mmss(time.targetMs)}${under ? ': inside it.' : ': over it this time.'}`;
    $('cp-time').className = `cp-time ${under ? 'ok' : 'over'}`;
  }
  if (g.complete) {
    $('cp-title').textContent = g.outro.title;
    $('cp-last').textContent = g.last?.text ?? '';
    $('cp-learned').replaceChildren(...g.outro.learned.map((line) => h('li', {}, line)));
  } else {
    $('cp-title').textContent = 'You left before the end';
    $('cp-last').textContent = `You finished ${doneCount} of ${g.steps.length} steps. Come back and finish the floor any time.`;
    $('cp-learned').replaceChildren(...g.steps.map((step) => h('li', { class: step.status === 'done' ? 'ok' : 'todo' }, step.title)));
  }
  $('cp-learned').previousElementSibling.textContent = g.complete ? 'What you now know' : 'Steps';
  const go = $('cp-go');
  if (!g.complete) {
    go.disabled = false;
    go.textContent = 'Try again';
    go.onclick = () => restart(snap.practical.id);
    $('cp-next').textContent = '';
  } else if (nextPractical) {
    go.disabled = false;
    go.textContent = `Next: floor ${spot.next.floor}`;
    go.onclick = () => restart(nextPractical.id);
    $('cp-next').textContent = `Up next: floor ${spot.next.floor}, ${spot.next.title}. ${spot.next.teaches}`;
  } else {
    $('cp-next').textContent = spot?.next ? `Up next: floor ${spot.next.floor}, ${spot.next.title}. It's being designed now.` : (g.outro.next ?? '');
  }
  // With nowhere to climb to yet, the way back to the towers is the main button.
  const canGo = !g.complete || !!nextPractical;
  go.hidden = !canGo;
  $('cp-tower').className = canGo ? 'ghost' : 'primary';
  $('complete').hidden = false;
}

function restart(practicalId) {
  const practical = state.practicals.find((p) => p.id === practicalId);
  leaveRound();
  renderStart();
  if (practical) void prepare(practical);
}

$('cp-floor-btn').addEventListener('click', () => ($('complete').hidden = true));
$('cp-tower').addEventListener('click', () => {
  leaveRound();
  renderStart();
});

function renderDebrief(snap) {
  const d = snap.debrief;
  if (!d) return;
  const score = d.score;
  $('db-outcome').textContent = `${score?.outcome ?? 'Round over'} · ${snap.practical.title}`;
  $('db-total').textContent = String(score?.total ?? 0);
  $('db-grade').textContent = score?.grade ?? '';
  $('db-parts').replaceChildren(
    ...(score?.parts ?? []).map((p) =>
      h('li', {}, h('div', { class: 'row' }, h('b', {}, p.label), h('span', { class: 'mono' }, `${p.points}/${p.max}`)), h('div', { class: 'bar' }, h('span', { style: `width:${(100 * p.points) / p.max}%` })), h('small', {}, p.note)),
    ),
  );
  $('db-leaked').replaceChildren(
    ...(d.leaked.length
      ? [h('div', { class: 'leaked' }, h('b', {}, 'Data that left the building'), h('ul', {}, ...d.leaked.map((l) => h('li', {}, `${l.name}: ${rands(l.impact)} in harm${l.personal ? ', personal information (POPIA: notify the Information Regulator and the people affected)' : ''}`))))]
      : []),
  );
  $('db-blind').replaceChildren(
    ...(d.blindSpots.length
      ? d.blindSpots.map((b) => h('li', {}, h('b', {}, `${b.clock} · ${b.what}${b.count > 1 ? ` (${b.count} times)` : ''}`), h('small', {}, b.why), h('small', {}, `Fix: ${b.fix}`)))
      : [h('li', {}, 'None. Every attack step was seen by at least one sensor.')]),
  );
  const reportPart = score?.parts.find((p) => p.label === 'Status report');
  $('report-form').hidden = snap.role !== 'prey' || (reportPart && reportPart.points > 0);

  const lanes = ['attacker', 'detection', 'response', 'business'];
  $('db-lanes').replaceChildren(
    ...lanes.map((lane) => {
      const on = state.lanes.has(lane);
      return h('button', { class: `small lane-${lane}`, 'aria-pressed': String(on), onclick: () => { on ? state.lanes.delete(lane) : state.lanes.add(lane); renderDebrief(state.snap); } }, lane);
    }),
  );
  $('db-timeline').replaceChildren(
    ...d.items
      .filter((item) => state.lanes.has(item.lane))
      .map((item) =>
        h(
          'li',
          { class: `lane-${item.lane}` },
          h('time', {}, item.clock),
          h('span', { class: item.intent ? 'intent' : item.falsePositive ? 'fp' : '' }, item.intent ? `Decides: ${item.title}` : item.title),
          item.falsePositive ? h('span', { class: 'detail' }, '  (false positive)') : null,
          item.detail ? h('div', { class: 'detail' }, item.detail) : null,
        ),
      ),
  );
}

$('report-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  const result = await act({ type: 'report', ...data });
  if (result?.ok) {
    e.target.reset();
    apply(await api.get(`/api/sessions/${state.id}`));
  }
});

$('db-floor').addEventListener('click', () => ($('debrief').hidden = true));
$('db-again').addEventListener('click', () => {
  leaveRound();
  renderStart();
});

// ------------------------------------------------------------------ manuals

async function openManual() {
  $('manual').hidden = false;
  if ($('manual-org').options.length === 0) {
    const orgs = await api.get('/api/orgs');
    $('manual-org').replaceChildren(...orgs.map((o) => h('option', { value: o.id, 'data-level': o.level }, o.name)));
    $('manual-level').value = String(orgs[0]?.level ?? 1);
  }
  await loadManual();
}

async function loadManual() {
  const org = $('manual-org').value;
  const level = $('manual-level').value;
  try {
    const manual = await api.get(`/api/manual/${encodeURIComponent(org)}?level=${level}`);
    renderMarkdown(manual.markdown, $('manual-body'));
  } catch (err) {
    $('manual-body').textContent = err.message;
  }
}

$('open-manual').addEventListener('click', () => void openManual());
$('manual-close').addEventListener('click', () => ($('manual').hidden = true));
$('manual-org').addEventListener('change', () => {
  const option = $('manual-org').selectedOptions[0];
  $('manual-level').value = option?.dataset.level ?? '1';
  void loadManual();
});
$('manual-level').addEventListener('change', () => void loadManual());

async function boot() {
  await loadPracticals();
  const inRound = state.practicals.length > 0 && (await rejoin());
  reloadedNote(inRound);
  void watchVersion();
}

void boot();
