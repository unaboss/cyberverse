// The evidence locker's window: what there is to keep, what is in the locker
// with its fingerprint and who took it when, and the seal.

import { h } from '../dom.js';

export const tall = true;

export function title(view) {
  const n = view.items.filter((i) => i.bagged).length;
  return view.sealed ? `Evidence locker · sealed, ${n} items` : `Evidence locker · ${n} bagged`;
}

export function render(root, view, ctx) {
  const rows = view.items.map((i) => {
    const bag = i.bagged || i.lost || view.sealed ? null : h('button', { class: 'small', type: 'button', 'aria-label': `Bag ${i.name}` }, 'Bag it');
    bag?.addEventListener('click', () => {
      bag.disabled = true;
      void ctx.act('bag', { item: i.id }).finally(() => {
        bag.disabled = false;
      });
    });
    return h(
      'li',
      { class: `ev-item${i.bagged ? ' bagged' : ''}${i.lost ? ' lost' : ''}` },
      h(
        'div',
        { class: 'ev-head' },
        h('b', { class: 'grow' }, i.name, h('small', { class: 'mono' }, ` · ${i.from}`), i.volatile && !i.bagged && !i.lost ? h('span', { class: 'ev-flag' }, 'gone if the machine is wiped') : null),
        bag,
        i.lost ? h('span', { class: 'ev-flag' }, 'lost') : null,
      ),
      h('p', { class: 'ev-detail mono' }, i.detail),
      i.bagged ? h('small', { class: 'ev-custody mono' }, `SHA-256 ${i.bagged.hash.slice(0, 32)}… · taken ${i.bagged.at} by ${view.custodian}`) : null,
    );
  });
  const seal = view.sealed ? null : h('button', { class: 'small primary', type: 'button' }, 'Seal the locker');
  seal?.addEventListener('click', () => {
    seal.disabled = true;
    void ctx.act('seal').finally(() => {
      seal.disabled = false;
    });
  });
  root.replaceChildren(
    h('p', { class: 'note ev-lede' }, 'Keep what proves what happened, how they got in, and what was taken. Every item gets a fingerprint, so anyone can check later that it never changed.'),
    h('ol', { class: 'ev-list' }, ...rows),
    h('div', { class: 'ev-foot' }, view.sealed ? h('small', { class: 'mono ev-sealed' }, `Sealed ${view.sealed.at} · SHA-256 ${view.sealed.hash.slice(0, 32)}…`) : h('small', { class: 'note' }, 'Sealing closes the locker for good.'), seal),
  );
}
