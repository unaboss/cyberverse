// The helpdesk queue's window: the tickets down the side, the one you picked
// with what the caller wrote, and the ways you could handle it.

import { h } from '../dom.js';

const CHANNEL = { phone: '☎ Phone call', email: '✉ Email', 'walk-in': '🚶 Walked in' };

export function title(view) {
  return view.open ? `Helpdesk queue · ${view.open} open` : 'Helpdesk queue · all done';
}

export function render(root, view, ctx, local) {
  if (!local.pick || !view.tickets.some((t) => t.id === local.pick)) local.pick = view.tickets.find((t) => t.status === 'open')?.id ?? view.tickets[0]?.id;
  const picked = view.tickets.find((t) => t.id === local.pick);
  const list = h(
    'ol',
    { class: 'tk-list' },
    ...view.tickets.map((t) =>
      h(
        'li',
        {},
        h(
          'button',
          {
            class: `tk-item ${t.status}${t.id === picked?.id ? ' picked' : ''}`,
            'aria-current': t.id === picked?.id ? 'true' : null,
            onclick: () => {
              local.pick = t.id;
              local.choice = null;
              ctx.redraw();
            },
          },
          h('span', { class: `tk-pri pri-${t.priority}`, title: `${t.priority} priority` }),
          h('span', { class: 'grow' }, h('b', {}, t.subject), h('small', {}, `${t.from.name}${t.status === 'resolved' ? ' · resolved' : ''}`)),
          t.status === 'resolved' ? h('span', { class: 'tk-done', 'aria-label': 'Resolved' }, '✓') : null,
        ),
      ),
    ),
  );
  root.replaceChildren(h('div', { class: 'tk-wrap' }, list, picked ? detail(picked, ctx, local) : null));
}

function detail(t, ctx, local) {
  const head = h(
    'div',
    { class: 'tk-head' },
    h('b', {}, t.subject),
    h('small', {}, `${CHANNEL[t.channel]} from ${t.from.name}, ${t.from.role}. ${t.priority[0].toUpperCase()}${t.priority.slice(1)} priority.`),
  );
  const body = h('blockquote', { class: 'tk-body' }, t.body);
  if (t.status === 'resolved') {
    return h('div', { class: 'tk-detail' }, head, body, h('p', { class: 'tk-thanks' }, h('b', {}, `${t.from.name.split(' ')[0]}: `), t.thanks), h('small', { class: 'note' }, `Resolved ${t.resolved}${t.tries > 1 ? `, on try ${t.tries}` : ''}.`));
  }
  const name = `tk-${t.id}`;
  const options = t.options.map((o) => {
    const radio = h('input', { type: 'radio', name, value: o.id });
    if (local.choice === o.id) radio.checked = true;
    radio.addEventListener('change', () => {
      local.choice = o.id;
    });
    return h('label', { class: 'tk-option' }, radio, h('span', {}, o.text));
  });
  const send = h('button', { class: 'small primary' }, 'Do it');
  const form = h('form', { class: 'tk-form' }, h('b', { class: 'tk-q' }, 'How do you handle it?'), ...options, h('div', { class: 'tk-actions' }, send));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const option = form.querySelector('input:checked')?.value;
    if (!option) {
      ctx.toast('Choose how you will handle it.', 'low');
      return;
    }
    send.disabled = true;
    void ctx.act('resolve', { ticket: t.id, option }).finally(() => {
      send.disabled = false;
    });
  });
  return h('div', { class: 'tk-detail' }, head, body, form);
}
