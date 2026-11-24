// A write-up's window: a line to choose for every part, and the whole thing
// as the reader will see it, taking shape as you choose.

import { h } from '../dom.js';

/** The parts and the preview need the room. */
export const tall = true;

export function title(view) {
  return view.sent ? `${view.heading} · sent` : view.heading;
}

export function render(root, view, ctx, local) {
  local.choices ??= view.sent?.choices ? { ...view.sent.choices } : {};
  const parts = view.parts.map((p) => {
    const name = `cp-${p.id}`;
    return h(
      'fieldset',
      { class: 'cp-part', disabled: view.sent ? true : null },
      h('legend', {}, p.label),
      ...p.options.map((o) => {
        const radio = h('input', { type: 'radio', name, value: o.id, 'aria-label': `${p.label}: ${o.text}` });
        if (local.choices[p.id] === o.id) radio.checked = true;
        radio.addEventListener('change', () => {
          local.choices[p.id] = o.id;
          ctx.redraw();
        });
        return h('label', { class: 'cp-option' }, radio, h('span', {}, o.text));
      }),
    );
  });
  const lines = view.parts.map((p) => p.options.find((o) => o.id === local.choices[p.id])?.text).filter(Boolean);
  const preview = h(
    'div',
    { class: 'cp-preview' },
    h('small', {}, `To: ${view.to}`),
    lines.length ? h('div', { class: 'cp-text' }, ...lines.map((t, i) => (i === 0 ? h('b', {}, t) : h('p', {}, t)))) : h('p', { class: 'note' }, 'Choose a line for each part and it appears here, the way readers will see it.'),
  );
  const send = h('button', { class: 'small primary', disabled: view.sent ? true : null }, view.sent ? `Sent at ${view.sent.at}` : view.send);
  send.addEventListener('click', () => {
    send.disabled = true;
    void ctx.act('publish', { choices: Object.entries(local.choices).map(([part, option]) => `${part}:${option}`) }).finally(() => {
      send.disabled = !!view.sent;
    });
  });
  root.replaceChildren(h('div', { class: 'cp-wrap' }, h('div', { class: 'cp-parts' }, ...parts), h('div', { class: 'cp-side' }, preview, h('div', { class: 'cp-actions' }, send))));
}
