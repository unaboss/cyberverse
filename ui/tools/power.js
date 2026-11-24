// The UPS panel's window: which machines stay on the battery during load
// shedding, the watts they draw, and a chart of the battery running down
// against the slot. The sums happen here as you tick; saving tells the mentor.

import { h, s } from '../dom.js';

function hm(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours} h ${rest} min` : `${rest} min`;
}

export function title(view) {
  return `UPS panel · ${view.watts} W · ${view.runtime}`;
}

export function render(root, view, ctx, local) {
  if (!local.keep || local.savedAt !== view.saved) {
    local.keep = new Set(view.loads.filter((l) => l.on).map((l) => l.system));
    local.savedAt = view.saved;
  }
  const usable = view.ups.battery * view.ups.efficiency;
  const watts = view.fixed.watts + view.loads.filter((l) => local.keep.has(l.system)).reduce((sum, l) => sum + l.watts, 0);
  const minutes = Math.floor((usable / watts) * 60);
  const lasts = minutes >= view.slot.minutes;

  const rows = view.loads.map((l) => {
    const box = h('input', { type: 'checkbox', 'aria-label': `Keep ${l.name} on the UPS` });
    box.checked = local.keep.has(l.system);
    box.addEventListener('change', () => {
      if (box.checked) local.keep.add(l.system);
      else local.keep.delete(l.system);
      ctx.redraw();
    });
    return h(
      'tr',
      { class: box.checked ? '' : 'shed' },
      h('td', {}, h('label', { class: 'ups-load' }, box, h('span', {}, l.name), l.critical ? h('span', { class: 'jewel', title: 'Business critical' }, '◆') : null)),
      h('td', { class: 'num mono' }, `${l.watts} W`),
      h('td', { class: 'note' }, box.checked ? 'on the UPS' : 'shut down first'),
    );
  });

  const sum = h(
    'div',
    { class: `ups-sum ${lasts ? 'ok' : 'short'}` },
    h('div', {}, h('small', {}, 'Load'), h('b', { class: 'mono' }, `${watts} W`)),
    h('div', { title: `${view.ups.battery} Wh x ${view.ups.efficiency} through the inverter` }, h('small', {}, 'Usable battery'), h('b', { class: 'mono' }, `${usable} Wh`)),
    h('div', {}, h('small', {}, 'Lasts'), h('b', { class: 'mono' }, hm(minutes))),
    h('div', {}, h('small', {}, 'Slot'), h('b', { class: 'mono' }, `${view.slot.from}–${view.slot.to}`)),
  );

  const save = h('button', { class: 'small primary' }, 'Save the plan');
  save.addEventListener('click', () => {
    save.disabled = true;
    void ctx.act('plan', { keep: [...local.keep] }).finally(() => {
      save.disabled = false;
    });
  });

  root.replaceChildren(
    h('p', { class: 'note ups-lede' }, `${view.ups.name}. ${view.fixed.name} always draw ${view.fixed.watts} W. Untick what can be shut down cleanly before the slot.`),
    h('div', { class: 'ups-top' }, sum, chart(view, minutes, lasts)),
    h('table', { class: 'ups-table' }, h('tbody', {}, ...rows)),
    h('div', { class: 'ups-actions' }, h('small', { class: 'note' }, `Runtime = ${usable} Wh / ${watts} W = ${(usable / watts).toFixed(2)} hours`), save),
  );
}

/** The battery running down from 100% against the slot. */
function chart(view, minutes, lasts) {
  const W = 460;
  const H = 84;
  const span = Math.max(view.slot.minutes + 30, Math.min(minutes, view.slot.minutes * 1.6));
  const x = (m) => 8 + (m / span) * (W - 16);
  const y = (pct) => 8 + (1 - pct) * (H - 24);
  const end = Math.min(minutes, span);
  const svg = s('svg', { class: 'ups-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `The battery lasts ${hm(minutes)}; the slot is ${view.slot.text}` });
  svg.append(
    s('rect', { x: x(0), y: y(1), width: x(view.slot.minutes) - x(0), height: y(0) - y(1), class: 'ups-slot' }),
    s('line', { x1: x(0), y1: y(0), x2: x(span), y2: y(0), class: 'ups-axis' }),
    s('line', { x1: x(view.slot.minutes), y1: y(1) - 4, x2: x(view.slot.minutes), y2: y(0), class: 'ups-end' }),
    s('polyline', { points: `${x(0)},${y(1)} ${x(end)},${y(Math.max(0, 1 - end / minutes))}`, class: `ups-line ${lasts ? 'ok' : 'short'}` }),
    s('text', { x: x(0), y: H - 3, class: 'ups-tick' }, view.slot.from),
    s('text', { x: x(view.slot.minutes), y: H - 3, class: 'ups-tick', 'text-anchor': 'middle' }, `${view.slot.to} power back`),
  );
  if (minutes <= span) {
    svg.append(s('circle', { cx: x(minutes), cy: y(0), r: 3.5, class: `ups-flat ${lasts ? 'ok' : 'short'}` }), s('text', { x: Math.min(x(minutes), W - 40), y: y(0) - 7, class: 'ups-tick', 'text-anchor': 'middle' }, 'flat'));
  }
  return svg;
}
