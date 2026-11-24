// The security budget's window: each project with the risk it reduces, as a
// single loss times how often a year, its expected yearly loss before and
// after, its cost and (once added) its return. Tick projects to fund them;
// the bar shows the plan against what the board approved.

import { h } from '../dom.js';

export const tall = true;

export function title(view) {
  return `Security budget · ${view.year}`;
}

const rands = (n) => {
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  return a >= 1_000_000 ? `${sign}R${(a / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}m` : `${sign}R${String(Math.round(a)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;
};

export function render(root, view, ctx, local) {
  local.fund ??= new Set();
  const funded = view.approved ? new Set(view.approved.ids) : local.fund;
  const chosen = view.projects.filter((p) => funded.has(p.id));
  const cost = chosen.reduce((a, p) => a + p.cost, 0);
  const reduced = chosen.reduce((a, p) => a + p.reduced, 0);
  const over = cost > view.envelope;

  const act = (text, op, args, cls = 'small') => {
    const b = h('button', { class: cls }, text);
    b.addEventListener('click', () => {
      b.disabled = true;
      void ctx.act(op, typeof args === 'function' ? args() : args).finally(() => {
        b.disabled = false;
      });
    });
    return b;
  };

  const head = ['', 'Project, and the risk it reduces', 'Expected loss a year', 'Risk reduced', 'Cost a year', ...(view.showRosi ? ['Return'] : [])];
  const rows = view.projects.map((p) => {
    const on = funded.has(p.id);
    const toggle = h('button', { class: `bg-tick${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false', 'aria-label': `Fund ${p.name}`, disabled: view.approved ? true : null }, on ? '✓' : '');
    if (!view.approved) {
      toggle.addEventListener('click', () => {
        if (local.fund.has(p.id)) local.fund.delete(p.id);
        else local.fund.add(p.id);
        ctx.redraw();
      });
    }
    return h(
      'tr',
      { class: on ? 'on' : null },
      h('td', {}, toggle),
      h('td', {}, h('b', {}, p.name), h('small', {}, p.risk)),
      h('td', { class: 'num' }, rands(p.before), h('small', {}, `${rands(p.sle)} × ${p.aro}`), h('small', {}, `→ × ${p.aroAfter} = ${rands(p.after)}`)),
      h('td', { class: 'num good' }, rands(p.reduced)),
      h('td', { class: 'num' }, rands(p.cost)),
      ...(view.showRosi ? [h('td', { class: `num ${p.rosi < 0 ? 'bad' : 'good'}` }, `${p.rosi > 0 ? '+' : p.rosi < 0 ? '−' : ''}${Math.abs(p.rosi)}%`)] : []),
    );
  });

  const pct = Math.min(100, (cost / view.envelope) * 100);
  const parts = [
    h(
      'div',
      { class: 'bg-env' },
      h('div', {}, h('b', {}, `${rands(view.envelope)} approved for ${view.year}`), h('small', {}, view.approved ? `In the board pack since ${view.approved.at}.` : 'Tick the projects to fund. Each one names the risk it reduces.')),
      h('div', { class: `bg-meter${over ? ' over' : ''}` }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'bg-sums' }, h('span', { class: over ? 'bad' : null }, `Spent ${rands(cost)}${over ? `, ${rands(cost - view.envelope)} over` : `, ${rands(view.envelope - cost)} left`}`), h('span', { class: 'good' }, `Risk reduced ${rands(reduced)} a year`)),
    ),
    h('div', { class: 'ap-scroll' }, h('table', { class: 'bg-table' }, h('thead', {}, h('tr', {}, ...head.map((c) => h('th', {}, c)))), h('tbody', {}, ...rows))),
    h('p', { class: 'ap-rules' }, h('b', {}, 'Expected loss a year (ALE) '), '= single loss (SLE) × times a year (ARO).', view.showRosi ? h('span', {}, ' ', h('b', {}, 'Return (ROSI) '), '= (risk reduced − cost) ÷ cost.') : null),
    view.approved
      ? null
      : h('div', { class: 'sg-bar' }, view.showRosi ? null : act('Add a return column', 'rosi', {}), act('Put the plan in the board pack', 'fund', () => ({ projects: [...local.fund] }), 'small primary')),
  ];
  root.replaceChildren(...parts.filter(Boolean));
}
