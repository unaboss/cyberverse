// The query console's window: the tables and their columns, a SQL editor,
// the result as a table, and the queries you ran before. Ctrl+Enter runs.

import { h } from '../dom.js';

export const tall = true;

export function title(view) {
  return `Query console · ${view.source}`;
}

const n = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export function render(root, view, ctx, local) {
  local.sql ??= view.start;
  const editor = h('textarea', { class: 'sql-editor', rows: 4, spellcheck: 'false', 'aria-label': 'SQL query', value: local.sql });
  editor.addEventListener('input', () => {
    local.sql = editor.value;
  });
  const run = h('button', { class: 'small primary' }, 'Run');
  const go = () => {
    local.sql = editor.value;
    if (!local.sql.trim()) return;
    run.disabled = true;
    local.refocus = document.activeElement === editor;
    // Leave the editor so the window can show the answer as soon as it arrives.
    editor.blur();
    void ctx.act('query', { sql: local.sql }).finally(() => {
      run.disabled = false;
    });
  };
  run.addEventListener('click', go);
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      go();
    }
  });
  const insert = (text) => {
    const at = editor.selectionStart ?? editor.value.length;
    editor.value = `${editor.value.slice(0, at)}${text}${editor.value.slice(editor.selectionEnd ?? at)}`;
    local.sql = editor.value;
    editor.focus();
    editor.selectionStart = editor.selectionEnd = at + text.length;
  };

  const tables = h(
    'div',
    { class: 'sql-tables' },
    ...view.tables.map((t) =>
      h(
        'div',
        { class: 'sql-table' },
        h('div', {}, h('b', {}, t.name), h('small', {}, ` · ${n(t.rows)} rows · ${t.about}`)),
        h(
          'div',
          { class: 'sql-cols' },
          ...t.columns.map((c) => {
            const chip = h('button', { class: 'sql-col', title: `Add ${c} to the query` }, c);
            chip.addEventListener('click', () => insert(c));
            return chip;
          }),
        ),
      ),
    ),
  );

  const last = view.last;
  let result = h('p', { class: 'note' }, 'Run a query and the answer appears here.');
  if (last?.error) {
    result = h('div', { class: 'sql-error', role: 'alert' }, h('b', {}, 'That query didn\'t run. '), last.error);
  } else if (last) {
    const head = h('tr', {}, ...last.columns.map((c) => h('th', {}, c)));
    const body = last.rows.map((r) =>
      h(
        'tr',
        {},
        ...r.map((c) => h('td', { class: typeof c === 'number' ? 'num' : null, title: c !== null && String(c).length > 40 ? String(c) : null }, c === null ? 'NULL' : typeof c === 'number' ? n(c) : String(c))),
      ),
    );
    const meta = `${n(last.count)} ${last.count === 1 ? 'row' : 'rows'}${last.count > last.rows.length ? `, showing the first ${last.rows.length}` : ''} · ${last.ms} ms`;
    result = h('div', { class: 'sql-result' }, h('small', { class: 'sql-meta' }, meta), h('div', { class: 'sql-grid' }, h('table', {}, h('thead', {}, head), h('tbody', {}, ...body))));
  }

  let action = null;
  if (view.action) {
    if (view.action.done) {
      action = h('p', { class: 'sql-done' }, `${view.action.label}: done for ${n(view.action.done.count)} at ${view.action.done.at}.`);
    } else if (last && !last.error && last.columns.some((c) => c.toLowerCase() === view.action.column.toLowerCase())) {
      const button = h('button', { class: 'small danger' }, `${view.action.label} for these ${n(last.count)}`);
      button.addEventListener('click', () => {
        button.disabled = true;
        void ctx.act('act').finally(() => {
          button.disabled = false;
        });
      });
      action = h('div', { class: 'sql-action' }, button, h('small', {}, `It acts on every ${view.action.column} in the result above, all ${n(last.count)} of them.`));
    }
  }

  const history = view.history.length
    ? h(
        'details',
        { class: 'sql-history' },
        h('summary', {}, `Recent queries (${view.history.length})`),
        ...view.history.map((q) => {
          const item = h('button', { class: `sql-past${q.failed ? ' failed' : ''}`, title: 'Put it back in the editor' }, h('small', {}, q.at), ' ', q.sql);
          item.addEventListener('click', () => {
            local.sql = q.sql;
            ctx.redraw();
          });
          return item;
        }),
      )
    : null;

  root.replaceChildren(
    ...[tables, h('div', { class: 'sql-edit' }, editor, h('div', { class: 'sql-run' }, run, h('small', {}, 'Ctrl+Enter runs it. Read-only: SELECT only.'))), result, action, history].filter(Boolean),
  );
  if (local.refocus) {
    local.refocus = false;
    editor.focus();
    editor.selectionStart = editor.selectionEnd = editor.value.length;
  }
}
