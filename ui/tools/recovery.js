// The recovery console's window: the disaster recovery plan, ticking itself
// off as you go, the files still being encrypted, and a restore: which copy,
// to where.

import { h } from '../dom.js';

export const tall = true;

export function title(view) {
  if (view.restored) return 'Recovery console · restored';
  if (view.running) return `Recovery console · restoring ${view.running.percent}%`;
  return 'Recovery console';
}

export function render(root, view, ctx, local) {
  const sp = view.spread;
  const spread = h(
    'div',
    { class: `rc-spread${sp.stopped ? ' stopped' : ''}` },
    h('b', {}, sp.stopped ? `${sp.system}: cut off at ${sp.stopped}` : `${sp.system}: still encrypting`),
    h('span', { class: 'rc-meter', style: `--k: ${sp.encrypted / sp.files}` }),
    h('small', { class: 'mono' }, `${sp.encrypted} of ${sp.files} files end in .siyalock`),
  );

  const plan = h(
    'ol',
    { class: 'rc-plan' },
    ...view.plan.map((s) => h('li', { class: s.done ? 'done' : '' }, h('span', { class: 'rc-tick', 'aria-hidden': 'true' }, s.done ? '✓' : ''), h('span', { class: 'grow' }, s.text), s.done ? h('small', { class: 'note' }, s.done) : null)),
  );

  local.set ??= '';
  local.to ??= '';
  const radios = (name, items, label) =>
    h(
      'fieldset',
      { class: 'rc-pick', disabled: view.running || view.restored ? true : null },
      h('legend', {}, label),
      ...items.map((it) => {
        const r = h('input', { type: 'radio', name: `rc-${name}`, value: it.id, 'aria-label': `${label}: ${it.name}` });
        if (local[name] === it.id) r.checked = true;
        r.addEventListener('change', () => {
          local[name] = it.id;
        });
        return h('label', { class: 'rc-option' }, r, h('span', {}, h('b', {}, it.name), it.where ? h('small', {}, it.where) : null));
      }),
    );
  const go = h('button', { class: 'small primary', disabled: view.running || view.restored ? true : null }, 'Restore');
  go.addEventListener('click', () => {
    if (!local.set || !local.to) {
      ctx.toast('Choose a backup set and where to restore it to.', 'low');
      return;
    }
    go.disabled = true;
    void ctx.act('restore', { set: local.set, to: local.to }).finally(() => {
      go.disabled = false;
    });
  });
  const status = view.restored
    ? h('p', { class: 'rc-done' }, `Restored to ${view.restored.to} at ${view.restored.at}.`)
    : view.running
      ? h('div', { class: 'rc-run' }, h('span', { class: 'rc-meter run', style: `--k: ${view.running.percent / 100}` }), h('small', { class: 'mono' }, `${view.running.percent}% · done at ${view.running.ends}`))
      : h('small', { class: 'note' }, `${view.restore.what}: ${view.restore.gb} GB at ${view.restore.mbps} MB/s.`);

  root.replaceChildren(
    spread,
    h('h3', {}, `Disaster recovery plan · back within ${view.rto}`),
    plan,
    h('h3', {}, 'Restore'),
    h('div', { class: 'rc-restore' }, radios('set', view.sets, 'From'), radios('to', view.targets, 'To')),
    h('div', { class: 'rc-actions' }, status, go),
  );
}
