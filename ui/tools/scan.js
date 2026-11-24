// The vulnerability scan's window: a Run button, the machines it works through
// while it runs, and the report, ranked by CVSS. After a rescan, what turned
// green since the last scan says so.

import { h } from '../dom.js';

const SEVERITY = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', none: 'None' };

export function title(view) {
  if (view.running) return `Vulnerability scan · running ${view.running.percent}%`;
  if (!view.last) return 'Vulnerability scan';
  return `Vulnerability scan · ${view.last.open} open · ${view.last.at}`;
}

export function render(root, view, ctx, local) {
  local.open ??= null;
  const running = view.running;
  const head = h(
    'div',
    { class: 'scan-head' },
    h(
      'div',
      { class: 'grow' },
      h('b', {}, view.scanner ? `${view.scanner.name} · ${view.scanner.ip}` : 'Scanner'),
      h('small', {}, `Scope: ${view.scope.join(' and ')}. ${view.machines} machines.`),
    ),
    h(
      'button',
      { class: `small${view.scans === 0 ? ' primary' : ''}`, disabled: !!running, onclick: () => void ctx.act('run') },
      running ? 'Scanning…' : view.scans === 0 ? 'Run scan' : 'Rescan',
    ),
  );

  const parts = [head];
  if (running) parts.push(progress(running));
  if (view.last) parts.push(summary(view), report(view, ctx, local));
  else if (!running) parts.push(h('p', { class: 'note' }, 'No scan yet this month. Run one to see what the servers and the DMZ are missing.'));
  root.replaceChildren(...parts);
}

function progress(running) {
  return h(
    'div',
    { class: 'scan-progress' },
    h('div', { class: 'scan-bar', role: 'progressbar', 'aria-valuenow': running.percent, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { style: `width:${running.percent}%` })),
    h('small', { class: 'note' }, `${running.hosts.length} of ${running.total} machines checked. Done at ${running.ends}.`),
    h(
      'ol',
      { class: 'scan-hosts mono' },
      ...running.hosts.slice(-6).map((host) => h('li', {}, `${host.ip.padEnd(13)} ${host.name}`, host.findings ? h('span', { class: 'scan-hit' }, ` ${host.findings} finding${host.findings === 1 ? '' : 's'}`) : h('span', { class: 'note' }, ' clean'))),
    ),
  );
}

function summary(view) {
  const c = view.counts;
  const tile = (sev, n) => h('span', { class: `scan-count sev-${sev}${n === 0 ? ' zero' : ''}` }, h('b', {}, String(n)), SEVERITY[sev]);
  return h(
    'div',
    { class: 'scan-summary' },
    tile('critical', c.critical),
    tile('high', c.high),
    tile('medium', c.medium),
    tile('low', c.low),
    h('small', { class: 'note' }, `Scan ${view.scans} finished ${view.last.at}${view.last.fixed ? `. ${view.last.fixed} fixed.` : '.'}`),
  );
}

function report(view, ctx, local) {
  return h(
    'ol',
    { class: 'scan-findings' },
    ...view.findings.map((f) => {
      const open = local.open === f.id;
      const toggle = () => {
        local.open = open ? null : f.id;
        ctx.redraw();
      };
      return h(
        'li',
        { class: `finding ${f.status}${f.change ? ' changed' : ''}` },
        h(
          'button',
          { class: 'finding-row', 'aria-expanded': open ? 'true' : 'false', onclick: toggle },
          h('span', { class: `cvss sev-${f.severity}` }, f.cvss.toFixed(1)),
          h(
            'span',
            { class: 'grow finding-text' },
            h('b', {}, f.title),
            h('small', {}, `${f.host ? `${f.host.name} · ${f.host.ip}` : ''}${f.port ? `:${f.port}` : ''}${f.cve ? ` · ${f.cve}` : ''}`),
          ),
          f.host?.critical ? h('span', { class: 'jewel', title: 'Business critical' }, '◆') : null,
          h('span', { class: `finding-status ${f.status}` }, f.change === 'fixed' ? 'Fixed now' : f.status === 'fixed' ? 'Fixed' : 'Open'),
        ),
        open
          ? h(
              'div',
              { class: 'finding-body' },
              h('p', {}, f.detail),
              f.reveals ? h('p', { class: 'finding-reveals' }, h('b', {}, 'An attacker learns: '), f.reveals) : null,
              h('p', {}, h('b', {}, 'Fix: '), f.fix),
              f.host ? h('button', { class: 'small', onclick: () => ctx.openHost(f.host.key) }, `Open ${f.host.name}`) : null,
            )
          : null,
      );
    }),
  );
}
