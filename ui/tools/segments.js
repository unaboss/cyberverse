// The store network map's window: one store's devices on the left, what they
// can reach on the right, a line for every flow your plan allows, a grid to
// allow or block each one, and the router's port forwards from the internet.

import { h, s } from '../dom.js';

export const tall = true;

export function title(view) {
  return `Store network map · ${view.site}`;
}

const W = 520;

/** Make an SVG element and put it in its parent. */
function add(parent, tag, attrs) {
  const node = s(tag, attrs);
  parent.appendChild(node);
  return node;
}
const ROW = 40;

export function render(root, view, ctx, local) {
  local.allow ??= new Set(view.applied);
  const key = (a, b) => `${a}>${b}`;
  const toggle = (k) => {
    if (local.allow.has(k)) local.allow.delete(k);
    else local.allow.add(k);
    ctx.redraw();
  };

  // ---- the map
  const dstY = (i) => 44 + i * ROW + (i > 0 ? groupGaps(view.destinations, i) : 0);
  const top = dstY(0) + 24;
  const bottom = dstY(view.destinations.length - 1) - 16;
  const srcY = (i) => (view.sources.length < 2 ? (top + bottom) / 2 : top + (i * (bottom - top)) / (view.sources.length - 1));
  const height = dstY(view.destinations.length - 1) + 40;
  const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, class: 'sg-map', role: 'img', 'aria-label': 'Flows your plan allows, from the store to head office, the internet and other stores' });
  add(svg, 'rect', { x: 6, y: 16, width: 170, height: height - 26, rx: 10, class: 'sg-box' });
  add(svg, 'text', { x: 16, y: 34, class: 'sg-box-label' }).textContent = view.site;
  const groups = [...new Set(view.destinations.map((d) => d.group))];
  for (const g of groups) {
    const idx = view.destinations.map((d, i) => (d.group === g ? i : -1)).filter((i) => i >= 0);
    const y0 = dstY(idx[0]) - 26;
    const y1 = dstY(idx[idx.length - 1]) + 16;
    add(svg, 'rect', { x: 330, y: y0, width: 184, height: y1 - y0, rx: 10, class: `sg-box sg-${g.toLowerCase().replace(/[^a-z]+/g, '-')}` });
    add(svg, 'text', { x: 506, y: y0 + 13, 'text-anchor': 'end', class: 'sg-box-label' }).textContent = g;
  }
  view.sources.forEach((src, i) => {
    view.destinations.forEach((dst, j) => {
      if (!local.allow.has(key(src.id, dst.id))) return;
      const y1 = srcY(i);
      const y2 = dstY(j);
      add(svg, 'path', { d: `M 160 ${y1} C 250 ${y1}, 250 ${y2}, 340 ${y2}`, class: `sg-flow${dst.group === 'Other stores' ? ' lateral' : ''}` });
    });
  });
  view.sources.forEach((src, i) => {
    const g = add(svg, 'g', { class: 'sg-node' });
    add(g, 'circle', { cx: 160, cy: srcY(i), r: 5 });
    add(g, 'text', { x: 150, y: srcY(i) + 4, 'text-anchor': 'end' }).textContent = src.name;
  });
  view.destinations.forEach((dst, j) => {
    const g = add(svg, 'g', { class: 'sg-node' });
    add(g, 'circle', { cx: 340, cy: dstY(j), r: 5 });
    add(g, 'text', { x: 350, y: dstY(j) + 4 }).textContent = dst.name;
  });

  // ---- the grid
  const grid = h(
    'table',
    { class: 'sg-grid' },
    h('thead', {}, h('tr', {}, h('th', {}, 'From the store ↓  to →'), ...view.destinations.map((d) => h('th', { title: d.does }, d.name)))),
    h(
      'tbody',
      {},
      ...view.sources.map((src) =>
        h(
          'tr',
          {},
          h('th', { title: src.does }, src.name, h('small', {}, src.does)),
          ...view.destinations.map((dst) => {
            const k = key(src.id, dst.id);
            const on = local.allow.has(k);
            const cell = h('button', { class: `sg-cell${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false', 'aria-label': `${src.name} to ${dst.name}: ${on ? 'allowed' : 'blocked'}` }, on ? 'Allow' : 'Block');
            cell.addEventListener('click', () => toggle(k));
            return h('td', {}, cell);
          }),
        ),
      ),
    ),
  );

  const blockAll = h('button', { class: 'small' }, 'Block everything');
  blockAll.addEventListener('click', () => {
    local.allow = new Set();
    ctx.redraw();
  });
  const reset = h('button', { class: 'small' }, 'Back to what\'s live');
  reset.addEventListener('click', () => {
    local.allow = new Set(view.applied);
    ctx.redraw();
  });
  const apply = h('button', { class: 'small primary' }, `Apply to all ${view.stores} stores`);
  apply.addEventListener('click', () => {
    apply.disabled = true;
    void ctx.act('apply', { allow: [...local.allow] }).finally(() => {
      apply.disabled = false;
    });
  });
  const live = view.appliedAt ? `Live since ${view.appliedAt}: ${view.applied.length} flows.` : `Live now: one flat VPN, all ${view.applied.length} flows open in every store.`;

  const forwards = h(
    'ul',
    { class: 'sg-forwards' },
    ...view.forwards.map((f) => {
      const close = f.closed ? h('small', { class: 'sg-closed' }, `closed ${f.closed}`) : h('button', { class: 'small danger', 'aria-label': `Close ${f.name}` }, 'Close');
      if (!f.closed) {
        close.addEventListener('click', () => {
          close.disabled = true;
          void ctx.act('close', { forward: f.id }).finally(() => {
            close.disabled = false;
          });
        });
      }
      return h('li', { class: f.closed ? 'closed' : null }, h('div', {}, h('b', {}, f.name), h('small', {}, f.by)), close);
    }),
  );

  root.replaceChildren(
    h('div', { class: 'sg-map-wrap' }, svg),
    h('div', { class: 'sg-bar' }, blockAll, reset, apply, h('small', {}, live)),
    h('div', { class: 'sg-scroll' }, grid),
    h('h4', { class: 'cl-h' }, 'Port forwards on the store router, from the internet'),
    forwards,
  );
}

/** Extra space before each new group of destinations. */
function groupGaps(dests, i) {
  let gaps = 0;
  for (let k = 1; k <= i; k++) if (dests[k].group !== dests[k - 1].group) gaps += 22;
  return gaps;
}
