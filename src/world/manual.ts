// The operating manual: the "real company" output of the world files.
//
// The same department files feed the lab, so this generator is strict about
// what it copies. It only ever reads the fields the manual is meant to show
// (roles, processes, systems by name, data classes, connections, controls,
// policies and the maturity path). Everything marked LAB ONLY in types.ts —
// people's lab names and awareness, staff-bot activity, accounts, passwords,
// weaknesses, threats, live-mode images, lab addresses, hostnames, lab record
// counts and rand impacts, the lab on/off state — never reaches the page.

import type { WorldBundle } from './load.ts';
import { resolveOrg, type ResolvedDepartment, type ResolvedOrg } from './resolve.ts';
import { LEVELS, type ControlDef, type Level } from './types.ts';

export interface ManualSection {
  /** Department id, or "overview". */
  id: string;
  heading: string;
  markdown: string;
}

export interface Manual {
  org: string;
  level: Level;
  title: string;
  sections: ManualSection[];
}

const SENSITIVITY_TEXT: Record<string, string> = {
  public: 'Public',
  internal: 'Internal',
  confidential: 'Confidential',
  restricted: 'Restricted',
};

const HOURS_TEXT = { work: 'working hours (08:00 to 17:00)', always: 'around the clock' } as const;

function every(text: string): string {
  const m = /^(\d+)\s*(m|h|d)$/.exec(text.trim());
  if (!m) {
    return text;
  }
  const n = Number(m[1]);
  const unit = m[2] === 'm' ? 'minute' : m[2] === 'h' ? 'hour' : 'day';
  return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
}

function roleOf(dept: ResolvedDepartment, personId: string, org: ResolvedOrg): string {
  const person = dept.people.find((p) => p.id === personId) ?? org.people.find((p) => p.id === personId);
  return person ? person.role : personId;
}

function systemName(org: ResolvedOrg, ref: string): string {
  const id = ref.includes('/') ? ref.split('/')[1]! : ref;
  return org.systems.find((s) => s.id === id)?.name ?? id;
}

function connectionTarget(bundle: WorldBundle, org: ResolvedOrg, to: string): string {
  if (to.startsWith('org:')) {
    return bundle.orgs.get(to.slice(4))?.def.name ?? to.slice(4);
  }
  if (to.startsWith('external:')) {
    return to.slice('external:'.length);
  }
  return org.departments.find((d) => d.id === to)?.name ?? to;
}

function controlLine(c: ControlDef): string {
  const status = c.proposed ? 'Proposed' : c.status === 'in-place' ? 'In place' : 'Planned';
  const policy = c.policy ? `\n  - Policy: ${c.policy.trim()}` : '';
  return `- **${c.name}** (${c.kind}, ${status}). ${c.description.trim()}${policy}`;
}

function departmentSection(bundle: WorldBundle, org: ResolvedOrg, dept: ResolvedDepartment): ManualSection {
  const lines: string[] = [];
  lines.push(dept.purpose.trim(), '');

  lines.push('### People');
  if (dept.people.length === 0) {
    lines.push(`Not staffed yet at level ${org.level}.`);
  } else {
    for (const p of dept.people) {
      const kind = p.kind === 'agent' ? ' (AI agent)' : '';
      const allowed = p.kind === 'agent' && p.permissions?.length ? ` Allowed to: ${p.permissions.join(', ')}.` : '';
      lines.push(`- ${p.role}${kind}.${allowed}`);
    }
  }
  lines.push('');

  if (dept.processes.length > 0) {
    lines.push('### How the work runs');
    for (const proc of dept.processes) {
      lines.push(`**${proc.name}**${proc.proposed ? ' (proposed)' : ''}. Owner: ${roleOf(dept, proc.owner, org)}. Runs ${proc.cadence ?? every(proc.every)}${proc.cadence ? '' : `, ${HOURS_TEXT[proc.hours]}`}.`, '');
      proc.steps.forEach((step, i) => lines.push(`${i + 1}. ${step.trim()}`));
      lines.push('');
    }
  }

  if (dept.systems.length > 0) {
    lines.push('### Systems');
    for (const s of dept.systems) {
      const zone = org.zones.find((z) => z.id === s.zone)?.name ?? s.zone;
      const critical = s.critical ? ' Business critical.' : '';
      const about = s.description ? ` ${s.description.trim()}` : '';
      lines.push(`- **${s.name}** (${s.kind}, ${zone}).${critical}${about}`);
    }
    lines.push('');
  }

  if (dept.data.length > 0) {
    lines.push('### Information held');
    for (const d of dept.data) {
      const pi = d.personalInformation ? ' Personal information under POPIA.' : '';
      const about = d.description ? ` ${d.description.trim()}` : '';
      lines.push(`- **${d.name}**: ${SENSITIVITY_TEXT[d.sensitivity] ?? d.sensitivity}, kept in ${systemName(org, d.system)}.${pi}${about}`);
    }
    lines.push('');
  }

  if (dept.connections.length > 0) {
    lines.push('### Works with');
    for (const c of dept.connections) {
      lines.push(`- ${connectionTarget(bundle, org, c.to)}: ${c.kind} (${c.trust}).`);
    }
    lines.push('');
  }

  if (dept.controls.length > 0) {
    lines.push('### Controls and policies');
    for (const c of dept.controls) {
      lines.push(controlLine(c));
    }
    lines.push('');
  }

  lines.push('### Maturity path');
  for (const level of LEVELS) {
    const text = dept.maturity[level];
    if (!text) {
      continue;
    }
    const marker = level === org.level ? ' (current)' : level === org.level + 1 ? ' (next)' : '';
    lines.push(`- Level ${level}${marker}: ${text.trim()}`);
  }

  return { id: dept.id, heading: dept.name, markdown: lines.join('\n').trimEnd() };
}

function overview(org: ResolvedOrg): ManualSection {
  const d = org.def;
  const lines = [
    d.tagline.trim(),
    '',
    `This manual describes ${d.name} at maturity level ${org.level} of 4. Each department below says who does the work, how it runs, what it relies on, which controls protect it, and what the next level looks like.`,
    '',
    '### Network zones',
    ...org.zones.map((z) => `- ${z.name}`),
    '',
    '### Departments',
    ...org.departments.map((dept) => `- ${dept.name}${dept.staffed ? '' : ' (not staffed yet)'}`),
  ];
  return { id: 'overview', heading: 'Overview', markdown: lines.join('\n') };
}

export function buildManual(bundle: WorldBundle, orgId: string, level?: Level): Manual {
  const org = resolveOrg(bundle, orgId, level);
  return {
    org: orgId,
    level: org.level,
    title: `${org.def.name} operating manual`,
    sections: [overview(org), ...org.departments.map((dept) => departmentSection(bundle, org, dept))],
  };
}

export function manualToMarkdown(manual: Manual): string {
  const parts = [`# ${manual.title}`, '', `Maturity level ${manual.level}. Generated from the company's world files.`, ''];
  for (const section of manual.sections) {
    parts.push(`## ${section.heading}`, '', section.markdown, '');
  }
  return parts.join('\n');
}
