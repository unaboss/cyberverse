// The design board's window: the "How might we…" question, the team, the
// phishing campaign's results by group, and the five stages of design
// thinking as tabs. Each stage is a wall of sticky notes or a short list to
// choose from, and unlocks the next when it's done.

import { h } from '../dom.js';

export const tall = true;

export function title() {
  return 'Design board · Why do they click?';
}

const STAGES = [
  ['empathise', 'Empathise'],
  ['define', 'Define'],
  ['ideate', 'Ideate'],
  ['prototype', 'Prototype'],
  ['test', 'Test'],
];

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const n = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function initials(name) {
  return name
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('');
}

/** One campaign's results: a row per group, with bars for clicked and reported. */
function results(name, rows, note) {
  const bar = (v, cls) => h('span', { class: `dz-bar ${cls}` }, h('i', { style: `width:${v}%` }), h('b', {}, `${v}%`));
  return h(
    'div',
    { class: 'dz-results' },
    h('div', { class: 'dz-results-name' }, name),
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Group'), h('th', { class: 'num' }, 'Sent'), h('th', {}, 'Clicked'), h('th', { class: 'num' }, 'Typed a password'), h('th', {}, 'Reported it'))),
      h(
        'tbody',
        {},
        ...rows.map((r) =>
          h(
            'tr',
            {},
            h('th', {}, r.group),
            h('td', { class: 'num' }, n(r.sent)),
            h('td', {}, bar(pct(r.clicked, r.sent), 'click')),
            h('td', { class: 'num' }, `${pct(r.entered, r.sent)}%`),
            h('td', {}, bar(pct(r.reported, r.sent), 'report')),
          ),
        ),
      ),
    ),
    note ? h('small', { class: 'dz-note' }, note) : null,
  );
}

export function render(root, view, ctx, local) {
  local.keep ??= new Set(view.empathise.map((c) => c.id));
  local.ideas ??= new Set();
  const authors = [...new Set([...view.team.map((t) => t.name), ...view.empathise.map((c) => c.by), ...view.ideate.ideas.map((i) => i.by)])];
  const colour = (by) => `dz-c${authors.indexOf(by) % 5}`;
  if (!local.stage || (local.followed !== view.current && view.current)) {
    local.stage = view.current ?? 'test';
    local.followed = view.current;
  }
  const stage = local.stage;
  const done = view.stages[stage];

  const submit = (label, op, args, cls = 'small primary') => {
    const b = h('button', { class: cls }, label);
    b.addEventListener('click', () => {
      b.disabled = true;
      void ctx.act(op, args()).finally(() => {
        b.disabled = false;
      });
    });
    return b;
  };

  const tabs = h(
    'div',
    { class: 'dz-stages', role: 'tablist' },
    ...STAGES.map(([id, label], i) => {
      const finished = Boolean(view.stages[id]);
      const open = finished || id === view.current;
      const tab = h(
        'button',
        { class: `dz-stage${id === stage ? ' on' : ''}${finished ? ' done' : ''}`, role: 'tab', 'aria-selected': id === stage ? 'true' : 'false', disabled: open ? null : '' },
        h('span', { class: 'dz-step' }, finished ? '✓' : String(i + 1)),
        label,
      );
      tab.addEventListener('click', () => {
        local.stage = id;
        ctx.redraw();
      });
      return tab;
    }),
  );

  const sticky = (note, on, onClick) => {
    const b = h('button', { class: `dz-sticky ${colour(note.by)}${on ? ' on' : ' off'}`, 'aria-pressed': on ? 'true' : 'false' }, h('span', {}, note.text), h('small', {}, note.by));
    if (onClick) b.addEventListener('click', onClick);
    else b.disabled = true;
    return b;
  };

  const choices = (options, picked, onPick) =>
    h(
      'div',
      { class: 'dz-choices', role: 'radiogroup' },
      ...options.map((o) => {
        const on = picked === o.id;
        const b = h('button', { class: `dz-choice${on ? ' on' : ''}`, role: 'radio', 'aria-checked': on ? 'true' : 'false' }, o.text);
        if (onPick) {
          b.addEventListener('click', () => onPick(o.id));
        } else b.disabled = true;
        return b;
      }),
    );

  let panel;
  if (stage === 'empathise') {
    const kept = done ? new Set(done.chosen) : local.keep;
    const notes = done ? view.empathise.filter((c) => kept.has(c.id)) : view.empathise;
    panel = h(
      'div',
      {},
      h('p', { class: 'dz-say' }, done ? `What the team saw and heard, kept at ${done.at}.` : 'What the team brought back from the stores. Click a note to take it off the wall: keep only what somebody actually saw or heard.'),
      h(
        'div',
        { class: 'dz-wall' },
        ...notes.map((c) =>
          sticky(
            c,
            kept.has(c.id),
            done
              ? null
              : () => {
                  if (local.keep.has(c.id)) local.keep.delete(c.id);
                  else local.keep.add(c.id);
                  ctx.redraw();
                },
          ),
        ),
      ),
      done ? null : h('div', { class: 'dz-bar-row' }, submit(`Keep these ${local.keep.size}`, 'empathise', () => ({ keep: [...local.keep] }))),
    );
  } else if (stage === 'define') {
    const picked = done ? done.chosen[0] : local.define;
    panel = h(
      'div',
      {},
      h('p', { class: 'dz-say' }, done ? `Our problem, written at ${done.at}.` : 'Write the problem from the staff side: who they are, what they need, and why, in their words.'),
      choices(
        done ? view.define.filter((o) => o.id === picked) : view.define,
        picked,
        done
          ? null
          : (id) => {
              local.define = id;
              ctx.redraw();
            },
      ),
      done ? null : h('div', { class: 'dz-bar-row' }, local.define ? submit('This is our problem', 'define', () => ({ option: local.define })) : h('small', {}, 'Choose one.')),
    );
  } else if (stage === 'ideate') {
    const picked = done ? new Set(done.chosen) : local.ideas;
    const ideas = done ? view.ideate.ideas.filter((i) => picked.has(i.id)) : view.ideate.ideas;
    panel = h(
      'div',
      {},
      h('p', { class: 'dz-say' }, done ? `Taken to prototype at ${done.at}.` : `Every idea the team had, none judged yet. Now choose the ${view.ideate.pick} that answer the problem you wrote.`),
      h(
        'div',
        { class: 'dz-wall pick' },
        ...ideas.map((i) =>
          sticky(
            i,
            done || local.ideas.has(i.id),
            done
              ? null
              : () => {
                  if (local.ideas.has(i.id)) local.ideas.delete(i.id);
                  else local.ideas.add(i.id);
                  ctx.redraw();
                },
          ),
        ),
      ),
      done ? null : h('div', { class: 'dz-bar-row' }, submit(`Prototype these ${local.ideas.size}`, 'ideate', () => ({ ideas: [...local.ideas] })), h('small', {}, `${local.ideas.size} of ${view.ideate.pick} chosen`)),
    );
  } else if (stage === 'prototype') {
    const picked = done ? done.chosen[0] : local.prototype;
    panel = h(
      'div',
      {},
      h('p', { class: 'dz-say' }, done ? `Started at ${done.at}.` : 'How do you try the three ideas?'),
      choices(
        done ? view.prototype.filter((o) => o.id === picked) : view.prototype,
        picked,
        done
          ? null
          : (id) => {
              local.prototype = id;
              ctx.redraw();
            },
      ),
      done ? null : h('div', { class: 'dz-bar-row' }, local.prototype ? submit('Start the prototype', 'prototype', () => ({ option: local.prototype })) : h('small', {}, 'Choose one.')),
    );
  } else {
    panel = done
      ? h('div', {}, results(view.test.name, view.test.rows), h('p', { class: 'dz-finding' }, view.test.finding))
      : h('div', {}, h('p', { class: 'dz-say' }, 'Two weeks later. The same lure, the same day, to every store.'), h('div', { class: 'dz-bar-row' }, submit(`Run ${view.test.name}`, 'test', () => ({}))));
  }

  root.replaceChildren(
    h('div', { class: 'dz-challenge' }, h('small', {}, 'How might we'), view.challenge.replace(/^How might we\s*/i, '')),
    h(
      'ul',
      { class: 'dz-team', 'aria-label': 'The team' },
      ...view.team.map((t) => h('li', { class: colour(t.name) }, h('span', { class: 'dz-face' }, initials(t.name)), h('span', {}, h('b', {}, t.name), h('small', {}, t.does)))),
    ),
    results(view.campaign.name, view.campaign.rows, view.campaign.note),
    tabs,
    h('div', { class: 'dz-panel' }, panel),
  );
}
