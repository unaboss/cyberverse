// The Wi-Fi survey's window: the floor in metres with x across and y up from
// the bottom-left corner, the access points ICT put up, and a dot for every
// reading you take. Pick a network in a reading to colour the dots by its
// signal, then follow it to where it is loudest.

import { h, s } from '../dom.js';

const SC = 11; // pixels per metre
const ML = 24;
const MT = 8;
const MB = 18;

/** The window asks for the desk's full height: the map and a reading don't fit in less. */
export const tall = true;

export function title(view) {
  if (view.seized) return 'Wi-Fi survey · twin unplugged';
  return `Wi-Fi survey · ${view.readings.length} reading${view.readings.length === 1 ? '' : 's'}`;
}

/** A room's name cut to the room's width (about 4.7 px a letter at the map's size). */
function fit(name, width) {
  const max = Math.floor(width / 4.7);
  return name.length <= max ? name : `${name.slice(0, max - 1).trimEnd()}…`;
}

/** 0 (faint) to 1 (beside it). */
function strength(signal) {
  return Math.max(0, Math.min(1, (signal + 80) / 40));
}

export function render(root, view, ctx, local) {
  local.spot ??= { x: 18, y: 10 };
  const last = view.readings.at(-1);
  if (!local.reading || !view.readings.some((r) => r.n === local.reading)) local.reading = last?.n ?? null;
  if (local.seen !== view.readings.length) {
    // A new reading: show it.
    local.seen = view.readings.length;
    local.reading = last?.n ?? null;
  }
  const reading = view.readings.find((r) => r.n === local.reading) ?? null;
  const networks = new Map(view.networks.map((n) => [n.bssid, n]));
  const staff = new Set(view.networks.filter((n) => n.known).map((n) => n.ssid));

  const map = floorMap(view, local, ctx);

  const x = h('input', { type: 'number', min: 0, max: view.width, step: 1, value: local.spot.x, 'aria-label': 'x, metres across' });
  const y = h('input', { type: 'number', min: 0, max: view.height, step: 1, value: local.spot.y, 'aria-label': 'y, metres up' });
  const sync = () => {
    local.spot = { x: Number(x.value), y: Number(y.value) };
    ctx.redraw();
  };
  x.addEventListener('change', sync);
  y.addEventListener('change', sync);
  const run = (op, button) => {
    button.disabled = true;
    void ctx.act(op, { x: Number(x.value), y: Number(y.value) }).finally(() => {
      button.disabled = false;
    });
  };
  const readBtn = h('button', { class: 'small primary', type: 'button' }, 'Take a reading here');
  readBtn.addEventListener('click', () => run('survey', readBtn));
  const markBtn = h('button', { class: 'small', type: 'button', disabled: view.located ? true : null }, 'Mark the twin here');
  markBtn.addEventListener('click', () => run('locate', markBtn));
  const seizeBtn = view.located && !view.seized ? h('button', { class: 'small danger', type: 'button' }, 'Go there and unplug it') : null;
  seizeBtn?.addEventListener('click', () => {
    seizeBtn.disabled = true;
    void ctx.act('seize').finally(() => {
      seizeBtn.disabled = false;
    });
  });
  const controls = h('div', { class: 'wifi-controls' }, h('label', { class: 'wifi-xy' }, 'x', x), h('label', { class: 'wifi-xy' }, 'y', y), readBtn, markBtn, seizeBtn);

  const table = reading
    ? readingTable(reading, networks, staff, local, ctx, view)
    : h('p', { class: 'note' }, `Click the map to choose a spot, then take a reading. You need ${view.need} or so, spread out, before the signals tell you anything.`);
  const box = view.seized
    ? h(
        'div',
        { class: 'wifi-seized' },
        h('h3', {}, 'What was in the box'),
        h('p', {}, view.seized.found),
        h('b', { class: 'wifi-sub' }, 'Joined to it this morning'),
        h('ul', { class: 'wifi-clients' }, ...view.seized.clients.map((c) => h('li', {}, h('b', {}, c.name), ` · ${c.device}`))),
        h('b', { class: 'wifi-sub' }, 'Its capture log'),
        h('pre', { class: 'wifi-capture mono' }, view.seized.capture.join('\n')),
      )
    : null;

  root.replaceChildren(
    ...[
      h('p', { class: 'note wifi-lede' }, `The floor is ${view.width} m across and ${view.height} m up. A spot is (x, y): metres across, then metres up, from the bottom-left corner.`),
      map,
      controls,
      box,
      table,
    ].filter(Boolean),
  );
}

function floorMap(view, local, ctx) {
  const W = ML + view.width * SC + 8;
  const H = MT + view.height * SC + MB;
  const px = (m) => ML + m * SC;
  const py = (m) => MT + (view.height - m) * SC;
  const svg = s('svg', { class: 'wifi-map', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Floor map, ${view.width} by ${view.height} metres, with ${view.readings.length} readings` });
  for (let m = 0; m <= view.width; m += 5) {
    svg.append(s('line', { x1: px(m), y1: py(0), x2: px(m), y2: py(view.height), class: m % 10 === 0 ? 'wifi-grid major' : 'wifi-grid' }));
    if (m % 10 === 0) svg.append(s('text', { x: px(m), y: H - 5, class: 'wifi-tick', 'text-anchor': 'middle' }, String(m)));
  }
  for (let m = 0; m <= view.height; m += 5) {
    svg.append(s('line', { x1: px(0), y1: py(m), x2: px(view.width), y2: py(m), class: m % 10 === 0 ? 'wifi-grid major' : 'wifi-grid' }));
    if (m % 10 === 0) svg.append(s('text', { x: ML - 5, y: py(m) + 3, class: 'wifi-tick', 'text-anchor': 'end' }, String(m)));
  }
  for (const r of view.rooms) {
    svg.append(
      s('rect', { x: px(r.x), y: py(r.y + r.h), width: r.w * SC, height: r.h * SC, class: 'wifi-room' }),
      s('text', { x: px(r.x) + 4, y: py(r.y + r.h) + 11, class: 'wifi-room-name' }, fit(r.name, r.w * SC - 8)),
    );
  }
  for (const ap of view.known) {
    svg.append(
      s('rect', { x: px(ap.x) - 4, y: py(ap.y) - 4, width: 8, height: 8, class: 'wifi-ap', transform: `rotate(45 ${px(ap.x)} ${py(ap.y)})` }),
      s('text', { x: px(ap.x) + 8, y: py(ap.y) + 3, class: 'wifi-ap-name' }, `${ap.name} (${ap.x}, ${ap.y})`),
    );
  }
  for (const r of view.readings) {
    const heard = local.colour ? r.heard.find((n) => n.bssid === local.colour) : null;
    const k = heard ? strength(heard.signal) : 0;
    const dot = s('circle', {
      cx: px(r.x),
      cy: py(r.y),
      r: 5,
      class: `wifi-dot${r.n === local.reading ? ' picked' : ''}`,
      style: heard ? `fill: color-mix(in srgb, var(--critical) ${Math.round(k * 100)}%, var(--low))` : null,
    });
    dot.append(s('title', {}, `Reading ${r.n} at (${r.x}, ${r.y})${heard ? `: ${heard.signal} dBm` : ''}`));
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      local.reading = r.n;
      local.spot = { x: r.x, y: r.y };
      ctx.redraw();
    });
    svg.append(dot);
    if (heard) svg.append(s('text', { x: px(r.x), y: py(r.y) - 8, class: 'wifi-dbm', 'text-anchor': 'middle' }, String(heard.signal)));
  }
  for (const m of view.marks) {
    svg.append(s('path', { d: `M${px(m.x) - 4},${py(m.y) - 4}l8,8m0,-8l-8,8`, class: 'wifi-mark' }));
  }
  if (view.located) {
    svg.append(
      s('circle', { cx: px(view.located.x), cy: py(view.located.y), r: 7, class: `wifi-twin${view.seized ? ' off' : ''}` }),
      s('text', { x: px(view.located.x) + 10, y: py(view.located.y) + 4, class: 'wifi-twin-name' }, view.seized ? 'twin (unplugged)' : `twin (${view.located.x}, ${view.located.y})`),
    );
  }
  svg.append(
    s('circle', { cx: px(local.spot.x), cy: py(local.spot.y), r: 9, class: 'wifi-spot' }),
    s('text', { x: px(local.spot.x), y: py(local.spot.y) + 21, class: 'wifi-spot-name', 'text-anchor': 'middle' }, `(${local.spot.x}, ${local.spot.y})`),
  );
  svg.addEventListener('click', (e) => {
    const box = svg.getBoundingClientRect();
    const vx = ((e.clientX - box.left) * W) / box.width;
    const vy = ((e.clientY - box.top) * H) / box.height;
    const x = Math.round((vx - ML) / SC);
    const y = Math.round(view.height - (vy - MT) / SC);
    if (x < 0 || y < 0 || x > view.width || y > view.height) return;
    local.spot = { x, y };
    ctx.redraw();
  });
  return svg;
}

function readingTable(reading, networks, staff, local, ctx, view) {
  const joins = reading.heard.find((n) => staff.has(networks.get(n.bssid)?.ssid));
  const rows = reading.heard.map((n) => {
    const net = networks.get(n.bssid);
    const row = h(
      'tr',
      { class: n.bssid === local.colour ? 'picked' : '', tabindex: 0, 'aria-label': `Colour the map by ${net.ssid} ${n.bssid}` },
      h('td', {}, net.ssid, h('small', {}, net.security)),
      h('td', { class: 'mono' }, n.bssid),
      h('td', {}, net.vendor),
      h('td', { class: 'num' }, String(net.channel)),
      h('td', { class: 'num mono' }, h('span', { class: 'wifi-bar', style: `--k: ${strength(n.signal)}` }), ` ${n.signal} dBm`),
    );
    const pick = () => {
      local.colour = local.colour === n.bssid ? null : n.bssid;
      ctx.redraw();
    };
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    });
    return row;
  });
  const vendor = joins ? networks.get(joins.bssid).vendor : '';
  return h(
    'div',
    { class: 'wifi-reading' },
    h(
      'div',
      { class: 'wifi-reading-head' },
      h('b', {}, `Reading ${reading.n} of ${view.readings.length} · (${reading.x}, ${reading.y}) · ${reading.room} · ${reading.at}`),
      joins ? h('small', {}, `A staff laptop here joins ${joins.bssid} (${vendor}), the loudest "${networks.get(joins.bssid).ssid}".`) : null,
    ),
    h(
      'div',
      { class: 'wifi-scroll' },
      h(
        'table',
        { class: 'wifi-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Network'), h('th', {}, 'BSSID'), h('th', {}, 'Maker'), h('th', { class: 'num' }, 'Ch'), h('th', { class: 'num' }, 'Signal'))),
        h('tbody', {}, ...rows),
      ),
    ),
    h('small', { class: 'note' }, local.colour ? `The dots show ${local.colour}'s signal: red is loud, blue is faint. Click its row again to stop.` : 'Click a network to colour the dots by its signal. Click a dot to see that reading.'),
  );
}
