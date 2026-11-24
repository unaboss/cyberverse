// The script editor's window: the script in bash, Python or PowerShell, with
// the blocks still to write shown as gaps you click to fill, and a terminal
// underneath that shows what it printed when you ran it.

import { h } from '../dom.js';

export const tall = true;

const LANG_NAMES = { bash: 'bash', python: 'Python', powershell: 'PowerShell' };

export function title(view) {
  const lang = view.languages.find((l) => l.id === (view.last?.lang ?? 'bash'));
  return `Script editor · ${view.host}:~/scripts/${lang?.file ?? ''}`;
}

export function render(root, view, ctx, local) {
  local.lang ??= 'bash';
  local.choices ??= { ...view.draft };
  const lang = view.languages.find((l) => l.id === local.lang) ?? view.languages[0];

  const tabs = h(
    'div',
    { class: 'sc-tabs', role: 'tablist' },
    ...view.languages.map((l) => {
      const tab = h('button', { class: `sc-tab${l.id === lang.id ? ' on' : ''}`, role: 'tab', 'aria-selected': l.id === lang.id ? 'true' : 'false', title: l.file }, LANG_NAMES[l.id]);
      tab.addEventListener('click', () => {
        local.lang = l.id;
        ctx.redraw();
      });
      return tab;
    }),
  );

  const lines = [];
  for (const raw of lang.template.split('\n')) {
    const m = raw.match(/^(\s*)(.*?)\{\{(\/?)([a-z]+)\}\}\s*$/);
    if (!m) {
      lines.push(h('div', { class: `sc-line${/^\s*(#|\/\/|"""|<#)/.test(raw) ? ' comment' : ''}` }, raw || ' '));
      continue;
    }
    const [, indent, before, closing, id] = m;
    const slot = view.slots.find((s) => s.id === id);
    if (!slot) continue;
    const chosen = slot.options.find((o) => o.id === local.choices[id]);
    if (closing) {
      const end = chosen ? chosen.end?.[lang.id] : '…';
      if (end) lines.push(h('div', { class: `sc-line${chosen ? '' : ' gap-end'}` }, `${indent}${end}`));
      continue;
    }
    const code = chosen ? chosen.code[lang.id].split('\n').map((l, i) => `${i === 0 ? `${indent}${before}` : indent}${l}`) : [`${indent}${before}`];
    const active = local.active === id;
    const block = h(
      'button',
      { class: `sc-slot${chosen ? '' : ' empty'}${active ? ' active' : ''}`, 'aria-label': `${slot.label}: ${chosen ? 'change' : 'choose'}`, 'aria-expanded': active ? 'true' : 'false' },
      h('span', { class: 'sc-slot-label' }, slot.label),
      ...code.map((l, i) => h('div', { class: 'sc-line' }, l, !chosen && i === 0 ? h('span', { class: 'sc-gap' }, `▸ ${slot.label}: click to write it`) : null)),
    );
    block.addEventListener('click', () => {
      local.active = active ? null : id;
      ctx.redraw();
    });
    lines.push(block);
    if (active) {
      lines.push(
        h(
          'div',
          { class: 'sc-picker', role: 'radiogroup', 'aria-label': slot.label },
          ...slot.options.map((o) => {
            const card = h(
              'button',
              { class: `sc-option${local.choices[id] === o.id ? ' on' : ''}`, role: 'radio', 'aria-checked': local.choices[id] === o.id ? 'true' : 'false' },
              h('pre', {}, [o.code[lang.id], o.end?.[lang.id] ? `  …\n${o.end[lang.id]}` : ''].filter(Boolean).join('\n')),
            );
            card.addEventListener('click', () => {
              local.choices[id] = o.id;
              local.active = null;
              ctx.redraw();
            });
            return card;
          }),
        ),
      );
    }
  }

  const choices = () => Object.entries(local.choices).map(([slot, option]) => `${slot}:${option}`);
  const runButton = (label, scope, cls) => {
    const b = h('button', { class: `small ${cls}` }, label);
    b.addEventListener('click', () => {
      b.disabled = true;
      void ctx.act('run', { lang: lang.id, scope, choices: choices() }).finally(() => {
        b.disabled = false;
      });
    });
    return b;
  };
  const bar = h('div', { class: 'sc-bar' }, runButton('Test on one store', 'one', ''), runButton(`Run on all ${view.list.count}`, 'all', 'primary'), h('small', {}, `${view.list.file}: ${view.list.about}`));

  const last = view.last;
  const term = h(
    'div',
    { class: 'sc-term', 'aria-label': 'Terminal output' },
    h('div', { class: 'sc-prompt' }, `${view.host}:~/scripts$ `, last ? last.command : view.languages.find((l) => l.id === lang.id).run),
    ...(last ? last.lines.map((l) => h('div', { class: /DEFAULT PASSWORD/.test(l) ? 'bad' : /no answer|Traceback|Error|stops|timed out|canceled/i.test(l) ? 'warn' : null }, l)) : [h('div', { class: 'faint' }, 'Nothing run yet.')]),
    last ? h('div', { class: 'sc-summary' }, `${last.at} · ${LANG_NAMES[last.lang]} · ${last.summary}`) : null,
  );

  let fix = null;
  if (view.fixed) {
    fix = h('p', { class: 'sc-fixed' }, `${view.fix}: done at ${view.fixed}.`);
  } else if (view.found?.length) {
    const b = h('button', { class: 'small danger' }, `${view.fix} (${view.found.length})`);
    b.addEventListener('click', () => {
      b.disabled = true;
      void ctx.act('fix').finally(() => {
        b.disabled = false;
      });
    });
    fix = h('div', { class: 'sc-fix' }, b, h('small', {}, `Stores ${view.found.join(', ')}`));
  }

  root.replaceChildren(...[h('small', { class: 'sc-env' }, view.editor), tabs, h('div', { class: 'sc-code' }, ...lines), bar, term, fix].filter(Boolean));
  // A new run: bring its output into view.
  const runKey = last ? `${last.at}|${last.command}|${last.summary}|${last.lines.length}` : null;
  if (runKey && runKey !== local.seenRun) {
    local.seenRun = runKey;
    term.scrollIntoView({ block: 'nearest' });
  }
}
