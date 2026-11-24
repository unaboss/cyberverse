// The traffic monitor's window: a live graph of the requests reaching the
// server, the internet line in front of it, who sends what, and the
// per-address rate limit.

import { h, s } from '../dom.js';

const n = (x) => Math.round(x).toLocaleString('en-ZA');

/** The graph and the limit need the room. */
export const tall = true;

export function title(view) {
  const state = { full: 'line full', over: 'overloaded', ok: 'answering' }[view.status];
  return `Traffic monitor · ${view.system} · ${state}`;
}

export function render(root, view, ctx, local) {
  const banner = {
    full: `Line full: ${view.line.junk} Gbit/s of junk packets from ${view.line.addresses} addresses, on a ${view.line.size} Gbit/s line. Hardly anything gets through, honest or not.`,
    over: `Overloaded: ${n(view.now.honest + view.now.flood)} requests a second arrive, and it can answer ${n(view.capacity)}. Everybody gets errors, residents too.`,
    ok: `Answering everyone: ${n(view.now.honest + view.now.flood)} requests a second, of the ${n(view.capacity)} it can answer.`,
  }[view.status];

  const senders = h(
    'table',
    { class: 'tr-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Who'), h('th', {}, 'From'), h('th', { class: 'num' }, 'Each /s'), h('th', { class: 'num' }, 'Total /s'), h('th', {}, 'Asks for'))),
    h(
      'tbody',
      {},
      ...view.senders.map((x) =>
        h(
          'tr',
          { class: x.blocked ? 'blocked' : '' },
          h('td', {}, x.name ?? h('span', { class: 'note' }, 'Unknown')),
          h('td', { class: 'mono' }, x.ip ?? `${x.addresses} addresses`, x.blocked ? h('small', {}, 'blocked') : null),
          h('td', { class: 'num mono' }, n(x.each)),
          h('td', { class: 'num mono' }, n(x.total)),
          h('td', { class: 'mono' }, x.path),
        ),
      ),
    ),
  );
  const paths = h(
    'table',
    { class: 'tr-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Page'), h('th', { class: 'num' }, 'Requests /s'), h('th', { class: 'num' }, 'Answer'))),
    h(
      'tbody',
      {},
      ...view.paths.map((p) =>
        h('tr', {}, h('td', { class: 'mono' }, p.path), h('td', { class: 'num mono' }, n(p.rate)), h('td', { class: `num mono tr-code c${String(p.status)[0]}` }, p.status ? String(p.status) : '–')),
      ),
    ),
  );

  local.rate ??= view.limit ?? '';
  const rate = h('input', { type: 'number', min: 1, step: 1, value: local.rate, 'aria-label': 'Requests a second, per address' });
  rate.addEventListener('input', () => {
    local.rate = rate.value;
  });
  const set = h('button', { class: 'small primary' }, 'Set the limit');
  const form = h(
    'form',
    { class: 'tr-limit' },
    h('label', {}, 'Rate limit per address', rate, h('span', { class: 'note' }, 'requests a second')),
    set,
    h('small', { class: 'note' }, view.limit ? `Now: ${view.limit} a second per address. Anything over it gets "slow down" (429).` : 'No limit yet: any address can send as fast as it likes.'),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    set.disabled = true;
    void ctx.act('limit', { rate: Number(rate.value) }).finally(() => {
      set.disabled = false;
    });
  });

  root.replaceChildren(
    h('div', { class: `tr-banner ${view.status}` }, h('b', {}, `${view.system} · ${view.ip}`), h('span', {}, banner)),
    h('div', { class: 'tr-line' }, h('small', {}, 'Internet line'), h('span', { class: `tr-gauge${view.line.junk ? '' : ' clear'}`, style: `--k: ${view.line.junk ? Math.min(1, view.line.junk / view.line.size) : 0.2}` }), h('b', { class: 'mono' }, view.line.junk ? `${view.line.junk} of ${view.line.size} Gbit/s` : 'clear'), h('small', { class: 'note' }, view.scrubbed ? 'DDoS protection on: the provider scrubs junk before it reaches us.' : 'No DDoS protection.')),
    chart(view),
    form,
    h('h3', {}, 'Who is sending'),
    h('div', { class: 'tr-scroll' }, senders),
    h('h3', {}, 'What they ask for'),
    h('div', { class: 'tr-scroll' }, paths),
  );
}

function chart(view) {
  const W = 470;
  const H = 130;
  const L = 34;
  const B = 16;
  const pts = view.series;
  const top = Math.max(view.capacity * 2, ...pts.map((p) => p.honest + p.flood)) * 1.05;
  const x = (i) => L + (i / Math.max(1, pts.length - 1)) * (W - L - 6);
  const y = (v) => 6 + (1 - v / top) * (H - B - 6);
  const area = (lo, hi) => `M${pts.map((p, i) => `${x(i)},${y(hi(p))}`).join('L')}L${pts.map((p, i) => `${x(i)},${y(lo(p))}`).reverse().join('L')}Z`;
  const svg = s('svg', { class: 'tr-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Requests a second over the last minutes: now ${n(view.now.honest)} honest and ${n(view.now.flood)} flood, capacity ${n(view.capacity)}` });
  if (pts.length < 2) return h('div', { class: 'tr-chart-wrap' }, svg);
  pts.forEach((p, i) => {
    if (p.full && i < pts.length - 1) svg.append(s('rect', { x: x(i), y: 6, width: x(i + 1) - x(i) + 0.5, height: H - B - 6, class: 'tr-full' }));
  });
  for (const v of [0, view.capacity, view.capacity * 2]) {
    svg.append(s('text', { x: L - 4, y: y(v) + 3, class: 'tr-tick', 'text-anchor': 'end' }, v >= 1000 ? `${v / 1000}k` : String(v)));
  }
  svg.append(
    s('path', { d: area(() => 0, (p) => p.honest), class: 'tr-honest' }),
    s('path', { d: area((p) => p.honest, (p) => p.honest + p.flood), class: 'tr-flood' }),
    s('line', { x1: L, y1: y(view.capacity), x2: W - 6, y2: y(view.capacity), class: 'tr-cap' }),
    s('text', { x: W - 8, y: y(view.capacity) - 4, class: 'tr-tick', 'text-anchor': 'end' }, `can answer ${n(view.capacity)}/s`),
    s('line', { x1: L, y1: y(0), x2: W - 6, y2: y(0), class: 'tr-axis' }),
  );
  if (pts.length) {
    svg.append(
      s('text', { x: L, y: H - 3, class: 'tr-tick' }, pts[0].at.slice(0, 5)),
      s('text', { x: W - 6, y: H - 3, class: 'tr-tick', 'text-anchor': 'end' }, pts.at(-1).at.slice(0, 5)),
    );
  }
  const key = h('div', { class: 'tr-key' }, h('span', { class: 'k-honest' }, 'Honest requests'), h('span', { class: 'k-flood' }, 'Flood'), h('span', { class: 'k-full' }, 'Line full'));
  return h('div', { class: 'tr-chart-wrap' }, svg, key);
}
