// The workbench's window: the server's screen and the safety steps while the
// case is shut, a drawing of the open case to test and replace parts, then the
// BIOS settings and the power button.

import { h, s } from '../dom.js';

const SAFETY = { unplug: 'Switch off and unplug', strap: 'Put on the wrist strap', open: 'Open the case' };

export function title(view) {
  if (view.booted) return 'Workbench · running again';
  return `Workbench · ${view.machine?.name ?? ''}`;
}

export function render(root, view, ctx, local) {
  local.part ??= null;
  const head = h(
    'div',
    { class: 'bench-head' },
    h('b', {}, view.machine ? `${view.machine.name} · ${view.machine.ip}` : 'Workbench'),
    h('span', { class: `bench-state ${view.booted ? 'up' : 'down'}` }, view.booted ? 'Running' : view.open ? 'Case open' : 'Won\'t boot'),
  );
  const parts = [head];
  if (view.booted) {
    parts.push(h('p', { class: 'bench-ok' }, 'It boots from the RAID volume, the clock is right and the backup jobs log in again.'));
  } else if (view.open) {
    parts.push(board(view, ctx, local));
    if (view.fixed) parts.push(biosForm(ctx));
  } else if (view.bios) {
    parts.push(screen(['BIOS settings saved.', `Clock: ${view.bios.clock ? 'set' : '01/01/2000 00:00'}`, `Boot: ${view.bios.boot}`]));
    parts.push(biosForm(ctx, view.bios), h('div', { class: 'bench-actions' }, h('button', { class: 'small primary', onclick: () => void ctx.act('boot') }, 'Switch it on')));
  } else {
    parts.push(screen(view.symptoms));
    parts.push(
      h(
        'ol',
        { class: 'bench-safety' },
        ...view.safety.map((step) =>
          h(
            'li',
            { class: step.done ? 'done' : '' },
            h('button', { class: 'small', disabled: step.done, onclick: () => void ctx.act('prepare', { step: step.id }) }, step.done ? `✓ ${SAFETY[step.id]}` : SAFETY[step.id]),
          ),
        ),
      ),
    );
  }
  root.replaceChildren(...parts);
}

function screen(lines) {
  return h('pre', { class: 'bench-screen mono', 'aria-label': 'What the screen shows' }, lines.join('\n'));
}

/** Where each part sits in a top-down drawing of the open case: front on the left. */
const LAYOUT = {
  disks: { shape: 'rect', x: 12, y: 18, w: 46, h: 74, label: 'Disks' },
  fans: { shape: 'fans', x: 70, y: 18, w: 16, h: 164, label: 'Fans' },
  board: { shape: 'rect', x: 98, y: 12, w: 150, h: 176, label: 'Motherboard' },
  cpu: { shape: 'rect', x: 140, y: 62, w: 46, h: 46, label: 'CPU' },
  ram: { shape: 'ram', x: 198, y: 40, w: 34, h: 92, label: 'RAM' },
  'cmos-battery': { shape: 'coin', x: 122, y: 150, w: 18, h: 18, label: 'CMOS' },
  psu: { shape: 'rect', x: 258, y: 18, w: 50, h: 82, label: 'PSU' },
  nic: { shape: 'rect', x: 258, y: 132, w: 50, h: 16, label: 'NIC' },
};

function board(view, ctx, local) {
  const svg = s('svg', { class: 'bench-board', viewBox: '0 0 320 200', role: 'group', 'aria-label': 'The open case, front on the left' });
  svg.append(s('rect', { x: 4, y: 4, width: 312, height: 192, rx: 8, class: 'bench-chassis' }));
  const order = ['board', 'disks', 'fans', 'cpu', 'ram', 'cmos-battery', 'psu', 'nic'];
  for (const id of order) {
    const part = view.parts.find((p) => p.id === id);
    const at = LAYOUT[id];
    if (!part || !at) continue;
    const cls = ['bench-part', `p-${id}`, part.bad ? 'bad' : '', part.reading && !part.bad ? 'tested' : '', part.replaced ? 'replaced' : '', local.part === id ? 'picked' : ''].filter(Boolean).join(' ');
    const g = s('g', { class: cls, tabindex: 0, role: 'button', 'aria-label': part.name });
    if (at.shape === 'coin') {
      g.append(s('circle', { cx: at.x + at.w / 2, cy: at.y + at.h / 2, r: at.w / 2, class: 'shape' }));
    } else if (at.shape === 'fans') {
      g.append(s('rect', { x: at.x, y: at.y, width: at.w, height: at.h, rx: 3, class: 'shape' }));
      for (let i = 0; i < 4; i++) g.append(s('circle', { cx: at.x + at.w / 2, cy: at.y + 22 + i * 40, r: 6, class: 'fan' }));
    } else if (at.shape === 'ram') {
      g.append(s('rect', { x: at.x - 2, y: at.y - 2, width: at.w + 4, height: at.h + 4, rx: 2, class: 'hit' }));
      for (let i = 0; i < 4; i++) g.append(s('rect', { x: at.x + i * 9, y: at.y, width: 6, height: at.h, rx: 1, class: 'shape' }));
    } else {
      g.append(s('rect', { x: at.x, y: at.y, width: at.w, height: at.h, rx: id === 'board' ? 4 : 3, class: 'shape' }));
      if (id === 'cpu') for (let i = 1; i < 6; i++) g.append(s('line', { x1: at.x + 4, y1: at.y + i * 7.7, x2: at.x + at.w - 4, y2: at.y + i * 7.7, class: 'fin' }));
    }
    const labelY = id === 'board' ? at.y + at.h - 6 : at.shape === 'coin' ? at.y + at.h + 10 : at.y + at.h + 10;
    g.append(s('text', { x: at.x + at.w / 2, y: id === 'board' ? labelY : Math.min(labelY, 194), class: 'bench-label', 'text-anchor': 'middle' }, at.label));
    const pick = () => {
      local.part = id;
      ctx.redraw();
    };
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      pick();
    });
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    });
    svg.append(g);
  }
  const part = view.parts.find((p) => p.id === local.part);
  const detail = part
    ? h(
        'div',
        { class: 'bench-part-card' },
        h('b', {}, part.name),
        h('p', {}, part.about),
        part.reading ? h('p', { class: `bench-reading ${part.bad ? 'bad' : 'ok'}` }, h('b', {}, 'Meter: '), part.reading) : null,
        part.replaced ? h('p', { class: 'bench-reading ok' }, 'Replaced with a new one.') : null,
        h(
          'div',
          { class: 'bench-actions' },
          h('button', { class: 'small', onclick: () => void ctx.act('test', { part: part.id }) }, 'Test it'),
          h('button', { class: 'small', onclick: () => void ctx.act('replace', { part: part.id }) }, 'Replace it'),
        ),
      )
    : h('p', { class: 'note' }, 'Click a part to read what it does, test it with the meter, or replace it.');
  return h('div', { class: 'bench-open' }, svg, detail);
}

function biosForm(ctx, saved) {
  const clock = h('input', { type: 'checkbox', name: 'clock' });
  clock.checked = saved ? saved.clock : false;
  const boot = h(
    'select',
    { name: 'boot', 'aria-label': 'Boot from' },
    ...[
      ['network', 'Network (PXE)'],
      ['usb', 'USB'],
      ['raid', 'RAID volume'],
    ].map(([value, text]) => {
      const opt = h('option', { value }, text);
      if ((saved?.boot ?? 'network') === value) opt.selected = true;
      return opt;
    }),
  );
  const form = h(
    'form',
    { class: 'bench-bios' },
    h('b', {}, 'BIOS setup'),
    h('label', { class: 'bench-check' }, clock, 'Set the date and time to now'),
    h('label', { class: 'risk-pick' }, 'Boot from', boot),
    h('div', { class: 'bench-actions' }, h('button', { class: 'small primary' }, saved ? 'Save again' : 'Close up and save')),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void ctx.act('bios', { clock: clock.checked, boot: boot.value });
  });
  return form;
}
