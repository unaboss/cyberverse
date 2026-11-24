// The cloud console's window: the account's API keys, busiest first, and its
// storage buckets with what's in them and who downloaded it.

import { h } from '../dom.js';

export const tall = true;

export function title(view) {
  return `Cloud console · ${view.account}`;
}

const n = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function render(root, view, ctx) {
  const action = (text, label, op, args, cls = 'small') => {
    const b = h('button', { class: cls, 'aria-label': label }, text);
    b.addEventListener('click', () => {
      b.disabled = true;
      void ctx.act(op, args).finally(() => {
        b.disabled = false;
      });
    });
    return b;
  };

  const keys = h(
    'table',
    { class: 'cl-keys' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Key'), h('th', {}, 'Account'), h('th', { class: 'num' }, 'Today'), h('th', {}, ''))),
    h(
      'tbody',
      {},
      ...view.keys.map((k) =>
        h(
          'tr',
          { class: k.revoked ? 'revoked' : null },
          h('td', { class: 'mono' }, k.id),
          h('td', {}, k.account, h('small', { class: 'cl-created' }, `since ${k.created}`), k.refused && !k.revoked ? h('small', { class: 'cl-refused' }, 'Now gets 403 Forbidden for other people\'s orders') : null),
          h('td', { class: 'num' }, n(k.requests)),
          h('td', {}, k.revoked ? h('small', {}, `revoked ${k.revoked}`) : action('Revoke', `Revoke ${k.id}`, 'revoke', { key: k.id }, 'small danger')),
        ),
      ),
    ),
  );

  const buckets = view.buckets.map((b) =>
    h(
      'div',
      { class: `cl-bucket${b.public ? ' public' : ''}` },
      h(
        'div',
        { class: 'cl-bucket-head' },
        h('b', { class: 'mono' }, b.name),
        h('span', { class: `cl-badge${b.public ? ' public' : ''}` }, b.public ? 'Public: anyone can list and read' : 'Private'),
        b.public ? action('Make private', `Make ${b.name} private`, 'private', { bucket: b.id }) : null,
      ),
      h('small', { class: 'cl-purpose' }, b.purpose),
      h(
        'ul',
        { class: 'cl-objects' },
        ...b.objects.map((o) =>
          h(
            'li',
            { class: o.removed ? 'removed' : null },
            h('div', { class: 'cl-object' }, h('span', { class: 'mono' }, o.name), h('small', {}, o.size), o.removed ? h('small', { class: 'cl-ok' }, `moved to evidence at ${o.removed}`) : action('Remove', `Remove ${o.name}`, 'remove', { object: o.id })),
            o.downloads.length
              ? h('details', { class: 'cl-downloads' }, h('summary', {}, `Downloads (${o.downloads.length})`), ...o.downloads.map((d) => h('div', { class: 'mono' }, `${d.at}  ${d.ip.padEnd(13)} ${d.who}`)))
              : null,
          ),
        ),
      ),
    ),
  );

  root.replaceChildren(
    h('small', { class: 'cl-account' }, `${view.provider} · account ${view.account}`),
    h('div', { class: `cl-fix${view.fixed ? ' on' : ''}` }, view.fixed ? 'Order ownership check in the API: on. Each customer gets only their own orders.' : 'Order ownership check in the API: off. Any signed-in customer can ask for any order number.'),
    h('h4', { class: 'cl-h' }, 'API keys, busiest first'),
    h('div', { class: 'cl-scroll' }, keys),
    h('h4', { class: 'cl-h' }, 'Storage buckets'),
    ...buckets,
  );
}
