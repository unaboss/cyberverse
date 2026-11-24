// The honeypot's window: where the decoy stands and what it pretends to be,
// and the log of everything that touched it. Nothing should, so every line in
// the log is worth a look.

import { h } from '../dom.js';

export function title(view) {
  if (!view.placed) return 'Honeypot · not up';
  return `Honeypot · ${view.total} touch${view.total === 1 ? '' : 'es'}`;
}

export function render(root, view, ctx, local) {
  local.spot ??= view.placed?.spot ?? '';
  local.persona ??= view.placed?.persona ?? '';
  const choose = (name, label, items, text) => {
    const select = h('select', { name, 'aria-label': label }, h('option', { value: '' }, 'Choose'), ...items.map((item) => {
      const opt = h('option', { value: item.id }, text(item));
      if (local[name] === item.id) opt.selected = true;
      return opt;
    }));
    select.addEventListener('change', () => {
      local[name] = select.value;
    });
    return h('label', { class: 'risk-pick' }, label, select);
  };
  const form = h(
    'form',
    { class: 'pot-form' },
    choose('spot', 'Where', view.spots, (s) => `${s.name} · ${s.ip}`),
    choose('persona', 'Pretends to be', view.personas, (p) => `${p.name} (${p.ports.join(', ')})`),
    h('div', { class: 'pot-actions' }, h('button', { class: 'small primary' }, view.placed ? 'Move it' : 'Put it up')),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const spot = form.spot.value;
    const persona = form.persona.value;
    if (!spot || !persona) {
      ctx.toast('Choose where it stands and what it pretends to be.', 'low');
      return;
    }
    form.querySelector('button').disabled = true;
    void ctx.act('deploy', { spot, persona }).finally(() => {
      form.querySelector('button').disabled = false;
    });
  });

  const placed = view.placed
    ? h(
        'div',
        { class: `pot-status${view.total ? ' hit' : ''}` },
        h('span', { class: 'pot-dot', 'aria-hidden': 'true' }),
        h('div', { class: 'grow' }, h('b', {}, `${view.placed.name} · ${view.placed.ip}`), h('small', {}, `${view.placed.hostname}, up since ${view.placed.since}. Nobody has a reason to touch it.`)),
        h('button', { class: 'small', onclick: () => ctx.openHost(view.placed.key) }, 'Show'),
      )
    : h('p', { class: 'note' }, 'No honeypot yet. A decoy only catches what passes by, so put it where the attacker is looking, dressed as what they want.');

  const log = view.placed
    ? h(
        'div',
        { class: 'pot-log' },
        h('h3', {}, view.total ? `Touched ${view.total} time${view.total === 1 ? '' : 's'}, from ${view.sources} address${view.sources === 1 ? '' : 'es'}` : 'Nothing has touched it yet'),
        view.touches.length
          ? h(
              'ol',
              { class: 'pot-lines mono' },
              ...view.touches.map((t) => h('li', {}, h('span', { class: 'note' }, t.at), ` ${t.src} → ${view.placed.ip}:${t.port}`, t.from ? h('span', { class: 'pot-from' }, ` ${t.from}`) : null)),
            )
          : h('p', { class: 'note' }, 'Quiet is normal. Every line that lands here is somebody who went looking.'),
      )
    : null;

  root.replaceChildren(form, placed, log);
}
