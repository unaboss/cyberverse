// The spreadsheet's window: four tabs, in the order an analyst works.
// Data: import from the SIEM database, a CSV file, a spreadsheet and a
// report. Model: relate the tables. Pivot: rows, columns and a value, with a
// chart. Dashboard: choose the tiles the executives see, and publish.

import { h, s } from '../dom.js';

export const tall = true;

export function title(view) {
  return `Spreadsheet · ${view.file}`;
}

const TABS = [
  ['data', 'Data'],
  ['model', 'Model'],
  ['pivot', 'Pivot'],
  ['dashboard', 'Dashboard'],
];
const KIND = { database: 'Database', csv: 'CSV file', file: 'Spreadsheet file', report: 'Report' };
const fmt = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : v);

function select(label, options, value, onChange) {
  const el = h('select', { 'aria-label': label }, ...options.map(([v, text]) => h('option', { value: v, selected: v === value ? true : null }, text)));
  el.addEventListener('change', () => onChange(el.value));
  return h('label', { class: 'sh-field' }, h('small', {}, label), el);
}

/** A small chart of labelled values: line, bar or pie. */
function chart(type, series, { width = 460, height = 170, target = null } = {}) {
  const max = Math.max(1, ...series.map((p) => p.value), target ?? 0) * 1.1;
  const pad = { l: 34, r: 10, t: 10, b: 26 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const y = (v) => pad.t + ih - (v / max) * ih;
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'sh-chart', role: 'img', 'aria-label': `${type} chart` });
  if (type === 'pie') {
    const total = series.reduce((a, p) => a + p.value, 0) || 1;
    let a0 = -Math.PI / 2;
    const cx = height / 2 + 10;
    const cy = height / 2;
    const r = height / 2 - 12;
    series.forEach((p, i) => {
      const a1 = a0 + (p.value / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      svg.appendChild(s('path', { d: `M ${cx} ${cy} L ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)} Z`, class: `sh-slice s${i % 6}` }));
      svg.appendChild(s('text', { x: cx + r + 24, y: 18 + i * 16, class: 'sh-axis' }, `${p.label}: ${fmt(p.value)}`));
      svg.appendChild(s('rect', { x: cx + r + 12, y: 9 + i * 16, width: 8, height: 8, class: `sh-slice s${i % 6}` }));
      a0 = a1;
    });
    return svg;
  }
  for (const f of [0, 0.5, 1]) {
    const v = Math.round((max / 1.1) * f);
    svg.appendChild(s('line', { x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v), class: 'sh-gridline' }));
    svg.appendChild(s('text', { x: pad.l - 6, y: y(v) + 3, 'text-anchor': 'end', class: 'sh-axis' }, fmt(v)));
  }
  const step = iw / Math.max(1, series.length);
  const cx = (i) => pad.l + step * i + step / 2;
  series.forEach((p, i) => svg.appendChild(s('text', { x: cx(i), y: height - 8, 'text-anchor': 'middle', class: 'sh-axis' }, p.label.length > 14 ? `${p.label.slice(0, 13)}…` : p.label)));
  if (target !== null) {
    svg.appendChild(s('line', { x1: pad.l, x2: width - pad.r, y1: y(target), y2: y(target), class: 'sh-target' }));
    svg.appendChild(s('text', { x: width - pad.r, y: y(target) - 4, 'text-anchor': 'end', class: 'sh-axis sh-target-label' }, `target ${target}`));
  }
  if (type === 'bar') {
    const bw = Math.min(46, step * 0.6);
    series.forEach((p, i) => svg.appendChild(s('rect', { x: cx(i) - bw / 2, y: y(p.value), width: bw, height: pad.t + ih - y(p.value), rx: 3, class: 'sh-bar' })));
  } else {
    svg.appendChild(s('polyline', { points: series.map((p, i) => `${cx(i)},${y(p.value)}`).join(' '), class: 'sh-line' }));
    series.forEach((p, i) => {
      svg.appendChild(s('circle', { cx: cx(i), cy: y(p.value), r: 3.5, class: 'sh-dot' }));
      svg.appendChild(s('text', { x: cx(i), y: y(p.value) - 8, 'text-anchor': 'middle', class: 'sh-axis sh-value' }, fmt(p.value)));
    });
  }
  return svg;
}

function tilePreview(t, big) {
  const show = t.show;
  if (show.series) return chart('line', show.series, { width: big ? 300 : 220, height: big ? 120 : 90, target: show.target ?? null });
  if (show.bars) {
    const max = Math.max(...show.bars.map((b) => b.value));
    return h('div', { class: 'sh-hbars' }, ...show.bars.map((b) => h('div', { class: 'sh-hbar' }, h('span', {}, b.label), h('i', { style: `width:${(b.value / max) * 100}%` }), h('b', {}, String(b.value)))));
  }
  return h('div', { class: 'sh-figure' }, show.figure, show.note ? h('small', {}, show.note) : null);
}

export function render(root, view, ctx, local) {
  local.tab ??= 'data';
  local.sep ??= {};
  local.rows ??= 'month';
  local.columns ??= '';
  local.value ??= 'count';
  local.relFrom ??= 'incidents.store';
  local.relTo ??= 'stores.store';
  local.tiles ??= new Set();

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

  const tabs = h(
    'div',
    { class: 'dz-stages', role: 'tablist' },
    ...TABS.map(([id, label]) => {
      const t = h('button', { class: `dz-stage${local.tab === id ? ' on' : ''}`, role: 'tab', 'aria-selected': local.tab === id ? 'true' : 'false' }, label);
      t.addEventListener('click', () => {
        local.tab = id;
        ctx.redraw();
      });
      return t;
    }),
  );

  let panel;
  if (local.tab === 'data') {
    const preview = view.tables.find((t) => t.name === local.preview) ?? view.tables.at(-1);
    panel = h(
      'div',
      { class: 'sh-panel' },
      h(
        'ul',
        { class: 'sh-sources' },
        ...view.sources.map((src) => {
          const controls = [];
          if (src.kind === 'csv') {
            controls.push(
              select('Separator', [[',', 'Comma ,'], [';', 'Semicolon ;'], ['\t', 'Tab']], local.sep[src.id] ?? ',', (v) => {
                local.sep[src.id] = v;
              }),
            );
          }
          controls.push(src.imported ? h('small', { class: 'sh-done' }, `imported ${src.imported}`) : act('Import', 'import', () => ({ source: src.id, delimiter: local.sep[src.id] ?? ',' })));
          return h(
            'li',
            {},
            h('div', {}, h('small', { class: 'sh-kind' }, KIND[src.kind]), h('b', {}, src.name), h('small', {}, src.about), src.head ? h('code', { class: 'sh-head' }, src.head) : null),
            h('div', { class: 'sh-controls' }, ...controls),
          );
        }),
      ),
      view.tables.length
        ? h(
            'div',
            { class: 'sh-tables' },
            h(
              'div',
              { class: 'sh-chips' },
              ...view.tables.map((t) => {
                const chip = h('button', { class: `sh-chip${preview?.name === t.name ? ' on' : ''}${t.garbled ? ' bad' : ''}` }, `${t.name} · ${fmt(t.count)} rows`);
                chip.addEventListener('click', () => {
                  local.preview = t.name;
                  ctx.redraw();
                });
                return chip;
              }),
            ),
            preview
              ? h('div', { class: 'sh-grid' }, h('table', {}, h('thead', {}, h('tr', {}, ...preview.columns.map((c) => h('th', {}, c)))), h('tbody', {}, ...preview.preview.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, fmt(c))))))))
              : null,
          )
        : null,
    );
  } else if (local.tab === 'model') {
    const tables = view.tables.filter((t) => !t.garbled);
    const inc = tables.find((t) => t.name === 'incidents');
    const others = tables.filter((t) => t.name !== 'incidents');
    panel = h(
      'div',
      { class: 'sh-panel' },
      h('p', { class: 'dz-say' }, 'A relationship joins two tables on the thing they share, so a pivot can use columns from both.'),
      h('div', { class: 'sh-model' }, ...tables.map((t) => h('div', { class: 'sh-entity' }, h('b', {}, t.name), ...t.columns.map((c) => h('small', { class: view.related?.includes(`${t.name}.${c}`) ? 'linked' : null }, c))))),
      view.related ? h('p', { class: 'sh-related' }, `Relationship: ${view.related} (many to one)`) : null,
      inc && others.length && !view.related
        ? h(
            'div',
            { class: 'sh-builder' },
            select('From', inc.columns.map((c) => [`incidents.${c}`, `incidents.${c}`]), local.relFrom, (v) => {
              local.relFrom = v;
            }),
            h('span', { class: 'sh-arrow' }, '→'),
            select('To', others.flatMap((t) => t.columns.map((c) => [`${t.name}.${c}`, `${t.name}.${c}`])), local.relTo, (v) => {
              local.relTo = v;
            }),
            act('Relate', 'relate', () => ({ from: local.relFrom, to: local.relTo }), 'small primary'),
          )
        : !view.related
          ? h('p', { class: 'dz-say' }, 'Import the incidents and the store list first.')
          : null,
    );
  } else if (local.tab === 'pivot') {
    const fieldOptions = view.fields.map((f) => [f.id, f.label]);
    const p = view.pivot;
    let result = null;
    if (p) {
      const valueFmt = (v) => (v === null ? '' : fmt(v));
      const head = [p.rowsLabel, ...p.colLabels, p.columns ? 'Total' : p.valueLabel];
      const body = p.rowLabels.map((rl, i) => h('tr', {}, h('th', {}, rl), ...p.cells[i].map((c) => h('td', {}, valueFmt(c))), h('td', { class: 'tot' }, valueFmt(p.rowTotals[i]))));
      const total = h('tr', { class: 'grand' }, h('th', {}, 'Grand total'), ...p.colTotals.map((c) => h('td', {}, valueFmt(c))), h('td', { class: 'tot' }, valueFmt(p.grand)));
      const chartBar = h(
        'div',
        { class: 'sh-chartbar', role: 'radiogroup', 'aria-label': 'Show as' },
        ...['table', 'bar', 'line', 'pie'].map((type) => {
          const b = h('button', { class: `sh-chip${view.chart === type ? ' on' : ''}`, role: 'radio', 'aria-checked': view.chart === type ? 'true' : 'false' }, type === 'table' ? 'Table' : `${type[0].toUpperCase()}${type.slice(1)} chart`);
          b.addEventListener('click', () => void ctx.act('chart', { type }));
          return b;
        }),
      );
      result = h(
        'div',
        {},
        h('div', { class: 'sh-grid sh-pivot' }, h('table', {}, h('thead', {}, h('tr', {}, ...head.map((c) => h('th', {}, c)))), h('tbody', {}, ...body, total))),
        chartBar,
        view.chart !== 'table' ? h('div', { class: 'sh-chartwrap' }, chart(view.chart, p.rowLabels.map((label, i) => ({ label, value: p.rowTotals[i] })), { target: p.value === 'avg-minutes' ? view.target : null })) : null,
      );
    }
    panel = h(
      'div',
      { class: 'sh-panel' },
      h(
        'div',
        { class: 'sh-builder' },
        select('Rows', fieldOptions, local.rows, (v) => {
          local.rows = v;
        }),
        select('Columns', [['', '(none)'], ...fieldOptions], local.columns, (v) => {
          local.columns = v;
        }),
        select('Values', view.values.map((v) => [v.id, v.label]), local.value, (v) => {
          local.value = v;
        }),
        act('Build the pivot', 'pivot', () => ({ rows: local.rows, columns: local.columns, value: local.value }), 'small primary'),
      ),
      result ?? h('p', { class: 'dz-say' }, 'Pivot the incidents: choose what goes down the rows, across the columns, and what to count or average.'),
    );
  } else {
    const published = view.published;
    panel = h(
      'div',
      { class: 'sh-panel' },
      h('p', { class: 'dz-say' }, published ? `Published to the executives at ${published.at}.` : 'Choose the tiles the executives see on Monday. Each one should answer a question they can act on.'),
      h(
        'div',
        { class: 'sh-tiles' },
        ...(published ? view.tiles.filter((t) => published.tiles.includes(t.id)) : view.tiles).map((t) => {
          const on = published ? true : local.tiles.has(t.id);
          const card = h('button', { class: `sh-tile${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false', disabled: published ? true : null }, h('b', {}, t.name), tilePreview(t, Boolean(published)));
          if (!published) {
            card.addEventListener('click', () => {
              if (local.tiles.has(t.id)) local.tiles.delete(t.id);
              else local.tiles.add(t.id);
              ctx.redraw();
            });
          }
          return card;
        }),
      ),
      published ? null : h('div', { class: 'dz-bar-row' }, act(`Publish ${local.tiles.size} tiles to the executives`, 'publish', () => ({ tiles: [...local.tiles] }), 'small primary')),
    );
  }

  root.replaceChildren(tabs, panel);
}
