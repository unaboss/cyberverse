// The risk register's window: the list of risks with their scores, a 5 x 5
// heat map, a form to score the risk you picked, and the incidents to link.

import { h, s } from '../dom.js';

const BAND_NAME = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };

function bandOf(score) {
  if (score <= 4) return 'low';
  if (score <= 9) return 'medium';
  if (score <= 16) return 'high';
  return 'critical';
}

export function title(view) {
  const scored = view.risks.filter((r) => r.score).length;
  return `Risk register · ${scored} of ${view.risks.length} scored`;
}

export function render(root, view, ctx, local) {
  local.pick ??= view.risks.find((r) => !r.score)?.id ?? view.risks[0]?.id;
  const picked = view.risks.find((r) => r.id === local.pick) ?? view.risks[0];

  const rows = h(
    'table',
    { class: 'risk-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Risk'), h('th', {}, 'Owner'), h('th', { class: 'num' }, 'L'), h('th', { class: 'num' }, 'I'), h('th', { class: 'num' }, 'Score'))),
    h(
      'tbody',
      {},
      ...view.risks.map((r) =>
        h(
          'tr',
          {
            class: `${r.id === picked?.id ? 'picked' : ''}`,
            tabindex: 0,
            onclick: () => {
              local.pick = r.id;
              ctx.redraw();
            },
            onkeydown: (e) => {
              if (e.key === 'Enter') {
                local.pick = r.id;
                ctx.redraw();
              }
            },
          },
          h('td', {}, h('b', {}, r.name), r.asset ? h('small', {}, r.asset.name) : null, r.incidents.length ? h('small', { class: 'risk-incident' }, `Happened: ${r.incidents.join('; ')}`) : null),
          h('td', {}, h('small', {}, r.owner ?? 'Nobody yet')),
          h('td', { class: 'num' }, r.likelihood ?? '–'),
          h('td', { class: 'num' }, r.impact ?? '–'),
          h('td', { class: 'num' }, r.score ? h('span', { class: `band band-${r.band}` }, `${r.score}`) : h('span', { class: 'note' }, 'not scored')),
        ),
      ),
    ),
  );

  const form = picked ? scoreForm(picked, view, ctx) : null;
  const incidents = view.incidents.length ? incidentList(view, ctx) : null;
  root.replaceChildren(h('div', { class: 'risk-top' }, heatMap(view, picked, ctx, local), form), rows, incidents);
}

function heatMap(view, picked, ctx, local) {
  const cell = 30;
  const pad = 26;
  const size = pad + cell * 5;
  const svg = s('svg', { class: 'heat', viewBox: `0 0 ${size + 4} ${size + 18}`, role: 'img', 'aria-label': 'Heat map: likelihood across, impact up' });
  for (let l = 1; l <= 5; l++) {
    for (let i = 1; i <= 5; i++) {
      const x = pad + (l - 1) * cell;
      const y = (5 - i) * cell;
      svg.append(s('rect', { x, y, width: cell - 2, height: cell - 2, rx: 3, class: `heat-cell band-${bandOf(l * i)}` }));
    }
  }
  for (let n = 1; n <= 5; n++) {
    svg.append(s('text', { x: pad + (n - 1) * cell + cell / 2 - 1, y: size + 12, class: 'heat-axis' }, String(n)));
    svg.append(s('text', { x: pad - 8, y: (5 - n) * cell + cell / 2 + 3, class: 'heat-axis' }, String(n)));
  }
  svg.append(s('text', { x: pad + cell * 2.5, y: size + 4 + 14 + 0, class: 'heat-label' }));
  const placed = new Map();
  for (const r of view.risks) {
    if (!r.score) continue;
    const at = `${r.likelihood},${r.impact}`;
    const n = placed.get(at) ?? 0;
    placed.set(at, n + 1);
    const cx = pad + (r.likelihood - 1) * cell + cell / 2 - 1 + (n % 2 ? 7 : n ? -7 : 0);
    const cy = (5 - r.impact) * cell + cell / 2 - 1 + (n > 1 ? 7 : 0);
    const dot = s('circle', { cx, cy, r: r.id === picked?.id ? 7 : 5.5, class: `heat-dot${r.id === picked?.id ? ' picked' : ''}`, tabindex: 0 }, s('title', {}, `${r.name}: ${r.likelihood} x ${r.impact} = ${r.score}`));
    dot.addEventListener('click', () => {
      local.pick = r.id;
      ctx.redraw();
    });
    svg.append(dot);
  }
  return h('figure', { class: 'heat-wrap' }, svg, h('figcaption', { class: 'note' }, 'Likelihood across, impact up'));
}

function scoreForm(risk, view, ctx) {
  const pick = (name, label, names, value) =>
    h(
      'label',
      { class: 'risk-pick' },
      label,
      h('select', { name, 'aria-label': label }, h('option', { value: '' }, 'Choose'), ...names.map((n, i) => {
        const opt = h('option', { value: String(i + 1) }, `${i + 1} · ${n}`);
        if (value === i + 1) opt.selected = true;
        return opt;
      })),
    );
  const form = h(
    'form',
    { class: 'risk-form' },
    h('b', {}, risk.name),
    risk.description ? h('p', { class: 'note' }, risk.description) : null,
    h('p', { class: 'risk-meta' }, risk.asset ? `On: ${risk.asset.name}. ` : '', `Owner: ${risk.owner ?? 'nobody yet'}.`),
    pick('likelihood', 'Likelihood', view.scales.likelihood, risk.likelihood),
    pick('impact', 'Impact', view.scales.impact, risk.impact),
    h('div', { class: 'risk-score-line' }, h('span', { class: 'note', 'data-score': '' }, risk.score ? `Score ${risk.likelihood} x ${risk.impact} = ${risk.score}, ${BAND_NAME[risk.band]}` : 'Score = likelihood x impact'), h('button', { class: 'small primary' }, 'Save score')),
  );
  const live = () => {
    const l = Number(form.likelihood.value);
    const i = Number(form.impact.value);
    const out = form.querySelector('[data-score]');
    if (l && i) out.textContent = `Score ${l} x ${i} = ${l * i}, ${BAND_NAME[bandOf(l * i)]}`;
  };
  form.addEventListener('change', live);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const l = Number(form.likelihood.value);
    const i = Number(form.impact.value);
    if (!l || !i) return;
    form.querySelector('button').disabled = true;
    void ctx.act('score', { risk: risk.id, likelihood: l, impact: i }).finally(() => {
      form.querySelector('button').disabled = false;
      form.querySelector('select')?.blur();
    });
  });
  return form;
}

function incidentList(view, ctx) {
  return h(
    'div',
    { class: 'risk-incidents' },
    h('h3', {}, 'Incident reports'),
    ...view.incidents.map((inc) => {
      const select = h('select', { 'aria-label': `Risk for ${inc.name}` }, h('option', { value: '' }, 'Which risk did this prove?'), ...view.risks.map((r) => {
        const opt = h('option', { value: r.id }, r.name);
        if (inc.linked === r.id) opt.selected = true;
        return opt;
      }));
      return h(
        'div',
        { class: 'risk-inc' },
        h('p', {}, h('b', {}, inc.name), inc.report ? ` ${inc.report}` : ''),
        h('div', { class: 'inline-form' }, select, h('button', { class: 'small', onclick: () => select.value && void ctx.act('link', { incident: inc.id, risk: select.value }) }, inc.linked ? 'Link again' : 'Link')),
      );
    }),
  );
}
