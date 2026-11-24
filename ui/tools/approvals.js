// The payments and approvals window: today's payment run with a hold button
// on each payment and a call-back for new bank details, the calls made, and
// the finance roles as a grid of rights you switch on and off, with the pairs
// that must never sit with one person.

import { h } from '../dom.js';

export const tall = true;

export function title() {
  return 'Payments and approvals · ERP';
}

const rands = (x) => `R${String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;

export function render(root, view, ctx, local) {
  if (!local.grants || local.applied !== view.appliedAt) {
    local.grants = new Set(view.grants);
    local.applied = view.appliedAt;
  }
  const act = (text, label, op, args, cls = 'small') => {
    const b = h('button', { class: cls, 'aria-label': label }, text);
    b.addEventListener('click', () => {
      b.disabled = true;
      void ctx.act(op, typeof args === 'function' ? args() : args).finally(() => {
        b.disabled = false;
      });
    });
    return b;
  };

  const run = h(
    'div',
    { class: 'ap-run' },
    h('div', {}, h('b', {}, view.run.name), h('small', {}, `Releases ${view.run.when} · ${view.run.count} payments · ${rands(view.run.total)}`)),
    act('Hold the whole run', 'Hold the whole run', 'hold', { payment: 'all' }, 'small danger'),
  );

  const rows = [];
  for (const p of view.payments) {
    rows.push(
      h(
        'tr',
        { class: p.held ? 'held' : null },
        h('td', {}, h('b', {}, p.supplier), h('small', {}, p.invoice)),
        h('td', { class: 'num' }, rands(p.amount)),
        h('td', {}, h('span', { class: 'mono' }, p.account), h('small', {}, `bank details since ${p.changed}`)),
        h('td', {}, p.held ? h('small', { class: 'ap-held' }, `held ${p.held}`) : act('Hold', `Hold ${p.supplier}`, 'hold', { payment: p.id }, 'small')),
      ),
    );
    if (p.callback) {
      rows.push(
        h(
          'tr',
          { class: 'ap-call' },
          h(
            'td',
            { colspan: '4' },
            h(
              'div',
              { class: 'ap-call-row' },
              h('small', {}, 'Call back before paying:'),
              act(`The change letter: ${p.callback.letter}`, `Call ${p.supplier} on the number in the change letter`, 'call', { payment: p.id, number: 'letter' }),
              act(`Our 2019 contract: ${p.callback.contract}`, `Call ${p.supplier} on the number in our contract`, 'call', { payment: p.id, number: 'contract' }),
            ),
          ),
        ),
      );
    }
  }
  const payments = h(
    'div',
    { class: 'ap-scroll' },
    h('table', { class: 'ap-pay' }, h('thead', {}, h('tr', {}, h('th', {}, 'Supplier'), h('th', { class: 'num' }, 'Amount'), h('th', {}, 'Paying into'), h('th', {}, ''))), h('tbody', {}, ...rows)),
  );

  const calls = view.calls.length
    ? h('ul', { class: 'ap-calls' }, ...view.calls.map((c) => h('li', {}, h('small', {}, `${c.at} · ${c.supplier} · ${c.number}`), c.says)))
    : null;

  const key = (r, x) => `${r}>${x}`;
  const rightName = (id) => view.rights.find((x) => x.id === id)?.name ?? id;
  const grid = h(
    'table',
    { class: 'ap-roles' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Role ↓  may →'), ...view.rights.map((x) => h('th', {}, x.name)))),
    h(
      'tbody',
      {},
      ...view.roles.map((r) =>
        h(
          'tr',
          {},
          h('th', {}, r.name, h('small', {}, r.person)),
          ...view.rights.map((x) => {
            const on = local.grants.has(key(r.id, x.id));
            const b = h('button', { class: `sg-cell${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false', 'aria-label': `${r.name}: ${x.name}: ${on ? 'yes' : 'no'}` }, on ? 'Yes' : '–');
            b.addEventListener('click', () => {
              if (local.grants.has(key(r.id, x.id))) local.grants.delete(key(r.id, x.id));
              else local.grants.add(key(r.id, x.id));
              ctx.redraw();
            });
            return h('td', {}, b);
          }),
        ),
      ),
    ),
  );
  const reset = h('button', { class: 'small' }, "Back to what's live");
  reset.addEventListener('click', () => {
    local.grants = new Set(view.grants);
    ctx.redraw();
  });

  root.replaceChildren(
    ...[
      run,
      payments,
      calls,
      h('h4', { class: 'cl-h' }, 'Finance roles in the ERP'),
      h('div', { class: 'ap-scroll' }, grid),
      h('p', { class: 'ap-rules' }, h('b', {}, 'Never one person: '), view.conflicts.map((c) => `${rightName(c.a).toLowerCase()} and ${rightName(c.b).toLowerCase()}`).join('; '), '.'),
      h('div', { class: 'sg-bar' }, reset, act('Apply to the ERP', 'Apply the roles to the ERP', 'roles', () => ({ grants: [...local.grants] }), 'small primary'), h('small', {}, view.appliedAt ? `Changed at ${view.appliedAt}.` : 'Live now: as set up in 2019, plus one right added in a busy month.')),
    ].filter(Boolean),
  );
}
