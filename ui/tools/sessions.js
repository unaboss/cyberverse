// The webmail sessions window: everyone signed in to webmail, and every place
// each session is used from. One session used from two places at once is a
// stolen ticket.

import { h } from '../dom.js';

export function title(view) {
  return `Webmail sessions · ${view.active} signed in`;
}

export function render(root, view, ctx) {
  const rows = view.sessions.map((s) => {
    const twice = new Set(s.uses.map((u) => u.ip)).size > 1;
    const end = s.ended ? null : h('button', { class: 'small danger', type: 'button', 'aria-label': `End ${s.name}'s session ${s.id.slice(0, 6)}` }, 'End session');
    end?.addEventListener('click', () => {
      end.disabled = true;
      void ctx.act('revoke', { session: s.id }).finally(() => {
        end.disabled = false;
      });
    });
    return h(
      'li',
      { class: `ses-item${s.ended ? ' ended' : ''}${twice && !s.ended ? ' twice' : ''}` },
      h(
        'div',
        { class: 'ses-head' },
        h('div', { class: 'grow' }, h('b', {}, s.name), h('small', { class: 'mono' }, ` ${s.user} · session ${s.id.slice(0, 6)}…`)),
        twice && !s.ended ? h('span', { class: 'ses-flag' }, `Used from ${s.uses.length} places`) : null,
        s.ended ? h('span', { class: 'note' }, `Ended ${s.ended}`) : end,
      ),
      h(
        'ul',
        { class: 'ses-uses' },
        ...s.uses.map((u) => h('li', {}, h('span', { class: 'mono' }, u.ip), ` · ${u.where} · ${u.device} · since ${u.since}`)),
      ),
      s.reset ? h('small', { class: 'ses-reset' }, `Password reset at ${s.reset}`) : null,
    );
  });
  root.replaceChildren(
    h('p', { class: 'note ses-lede' }, 'A session is the ticket webmail hands out once the password checks out. Whoever holds it is signed in, wherever they are.'),
    h('ol', { class: 'ses-list' }, ...rows),
    h('div', { class: 'ses-foot' }, h('small', { class: 'note' }, 'Passwords are reset on the mail server itself.'), h('button', { class: 'small', type: 'button', onclick: () => ctx.openHost(view.host) }, 'Open the mail server')),
  );
}
