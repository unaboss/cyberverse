// Checks the world files hang together at every maturity level, so a change
// to one department file cannot silently break the lab or the manual.

import type { WorldBundle } from './load.ts';
import { resolveOrg, type ResolvedOrg } from './resolve.ts';
import { cidrInside, inCidr } from './net.ts';
import { LEVELS, SEVERITIES, STAGES, TOWER_TIERS, type GuideDef, type Level, type OrganisationDef, type PracticalDef } from './types.ts';
import { TOOL_MODULES } from '../engine/tools/index.ts';
import type { ToolModule } from '../engine/tools/tool.ts';

export interface Issue {
  where: string;
  message: string;
}

const SENSITIVITIES = new Set(['public', 'internal', 'confidential', 'restricted']);
const SENSOR_TYPES = new Set(['nids', 'hids', 'weblog', 'mail', 'decoy']);
const EVERY = /^\d+(s|m|h)$/;

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      dups.add(id);
    }
    seen.add(id);
  }
  return [...dups];
}

function checkStatic(bundle: WorldBundle, issues: Issue[]): void {
  const { miniverse } = bundle;
  const add = (where: string, message: string): void => {
    issues.push({ where, message });
  };

  if (!cidrInside(miniverse.internet.cidr, miniverse.labRange)) {
    add('miniverse', `internet range ${miniverse.internet.cidr} is outside the lab range ${miniverse.labRange}`);
  }
  for (const ip of miniverse.internet.attackerPool) {
    if (!inCidr(ip, miniverse.internet.cidr)) {
      add('miniverse', `attacker address ${ip} is outside the internet range`);
    }
  }

  const allIps: string[] = [...miniverse.internet.attackerPool];
  const ruleIds = new Set(bundle.rules.map((r) => r.id));
  for (const dup of duplicates(bundle.rules.map((r) => r.id))) {
    add('detections', `duplicate rule id ${dup}`);
  }
  for (const rule of bundle.rules) {
    if (!SENSOR_TYPES.has(rule.sensor)) {
      add(`rule ${rule.id}`, `unknown sensor ${rule.sensor}`);
    }
    if (!SEVERITIES.includes(rule.severity)) {
      add(`rule ${rule.id}`, `unknown severity ${rule.severity}`);
    }
  }

  for (const [orgId, org] of bundle.orgs) {
    const where = `${orgId}/organisation`;
    if (org.def.id !== orgId) {
      add(where, `id is ${org.def.id} but the folder is ${orgId}`);
    }
    for (const zone of org.def.zones) {
      if (!cidrInside(zone.cidr, miniverse.labRange)) {
        add(where, `zone ${zone.id} (${zone.cidr}) is outside the lab range ${miniverse.labRange}`);
      }
    }
    const zoneIds = new Set(org.def.zones.map((z) => z.id));
    for (const flow of org.def.policy) {
      if (flow.src !== 'internet' && !zoneIds.has(flow.src)) {
        add(where, `policy flow from unknown zone ${flow.src}`);
      }
      if (!zoneIds.has(flow.dst)) {
        add(where, `policy flow to unknown zone ${flow.dst}`);
      }
    }

    const deptIds = new Set(org.departments.map((d) => d.id));
    const allSystems = org.departments.flatMap((d) => d.systems);
    const allPeople = org.departments.flatMap((d) => d.people);
    const allData = org.departments.flatMap((d) => d.data);
    const allControls = org.departments.flatMap((d) => d.controls);
    const allThreats = org.departments.flatMap((d) => d.threats);
    const allProcesses = org.departments.flatMap((d) => d.processes);
    const allWeaknesses = allSystems.flatMap((s) => s.weaknesses ?? []);
    for (const [label, ids] of [
      ['system', allSystems.map((s) => s.id)],
      ['hostname', allSystems.map((s) => s.hostname)],
      ['person', allPeople.map((p) => p.id)],
      ['data', allData.map((d) => d.id)],
      ['control', allControls.map((c) => c.id)],
      ['threat', allThreats.map((t) => t.id)],
      ['process', allProcesses.map((p) => p.id)],
      ['weakness', allWeaknesses.map((w) => w.id)],
    ] as const) {
      for (const dup of duplicates([...ids])) {
        add(orgId, `duplicate ${label} id ${dup}`);
      }
    }

    const rooms = org.departments.map((d) => ({ id: d.id, ...d.room }));
    for (const room of rooms) {
      if (room.x < 0 || room.y < 0 || room.x + room.w > org.def.floor.width || room.y + room.h > org.def.floor.height) {
        add(`${orgId}/${room.id}`, 'room does not fit on the floor');
      }
    }
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i]!;
        const b = rooms[j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        if (overlap) {
          add(orgId, `rooms ${a.id} and ${b.id} overlap`);
        }
      }
    }

    validateSites(org.def, org.departments, (msg) => add(orgId, msg));
    if (org.def.home && !org.departments.some((d) => d.id === org.def.home)) add(orgId, `home room ${org.def.home} is not a department`);

    for (const dept of org.departments) {
      const at = `${orgId}/${dept.id}`;
      if (!org.def.departments.includes(dept.id)) {
        add(at, 'department id does not match its file name');
      }
      for (const level of LEVELS) {
        if (typeof dept.maturity[level] !== 'string' || dept.maturity[level].length === 0) {
          add(at, `maturity level ${level} is not described`);
        }
      }
      for (const id of dept.qcto) {
        if (bundle.qctoIds && !bundle.qctoIds.has(id)) {
          add(at, `unknown QCTO id ${id}`);
        }
      }
      for (const system of dept.systems) {
        allIps.push(system.ip);
        const zone = org.def.zones.find((z) => z.id === system.zone);
        if (!zone) {
          add(at, `system ${system.id} is in unknown zone ${system.zone}`);
        } else if (!inCidr(system.ip, zone.cidr)) {
          add(at, `system ${system.id} address ${system.ip} is outside zone ${zone.id} (${zone.cidr})`);
        }
        for (const account of system.accounts ?? []) {
          if (account.person && !allPeople.some((p) => p.id === account.person)) {
            add(at, `account ${system.id}:${account.user} belongs to unknown person ${account.person}`);
          }
        }
        for (const weakness of system.weaknesses ?? []) {
          if (weakness.port !== undefined && !system.services.some((s) => s.port === weakness.port)) {
            add(at, `weakness ${weakness.id} uses port ${weakness.port}, which ${system.id} does not serve`);
          }
          if (weakness.kind === 'vulnerable-service' && !weakness.module) {
            add(at, `weakness ${weakness.id} is a vulnerable service with no exploit module`);
          }
          if (weakness.reveals) {
            const [sysKey, user] = weakness.reveals.split(':');
            const [revOrg, revSys] = (sysKey ?? '').split('/');
            const target = bundle.orgs
              .get(revOrg ?? '')
              ?.departments.flatMap((d) => d.systems)
              .find((s) => s.id === revSys);
            if (!target || !(target.accounts ?? []).some((a) => a.user === user)) {
              add(at, `weakness ${weakness.id} reveals unknown account ${weakness.reveals}`);
            }
          }
        }
      }
      for (const person of dept.people) {
        if (person.awareness !== undefined && (person.awareness < 0 || person.awareness > 1)) {
          add(at, `person ${person.id} awareness must be between 0 and 1`);
        }
      }
      for (const process of dept.processes) {
        if (!EVERY.test(process.every)) {
          add(at, `process ${process.id} has an unreadable schedule "${process.every}"`);
        }
      }
      for (const data of dept.data) {
        if (!SENSITIVITIES.has(data.sensitivity)) {
          add(at, `data ${data.id} has unknown sensitivity ${data.sensitivity}`);
        }
        if (!allSystems.some((s) => s.id === data.system)) {
          add(at, `data ${data.id} is stored on unknown system ${data.system}`);
        }
      }
      for (const connection of dept.connections) {
        const [kind, target] = connection.to.includes(':') ? connection.to.split(':') : ['dept', connection.to];
        if (kind === 'dept' && !deptIds.has(target ?? '')) {
          add(at, `connection to unknown department ${connection.to}`);
        }
        if (kind === 'org' && !bundle.orgs.has(target ?? '')) {
          add(at, `connection to unknown organisation ${connection.to}`);
        }
      }
      for (const threat of dept.threats) {
        if (!STAGES.includes(threat.stage)) {
          add(at, `threat ${threat.id} has unknown stage ${threat.stage}`);
        }
        for (const id of threat.qcto ?? []) {
          if (bundle.qctoIds && !bundle.qctoIds.has(id)) {
            add(at, `threat ${threat.id} has unknown QCTO id ${id}`);
          }
        }
      }
      for (const control of dept.controls) {
        for (const ruleId of control.rules ?? []) {
          if (!ruleIds.has(ruleId)) {
            add(at, `control ${control.id} switches on unknown rule ${ruleId}`);
          }
        }
        for (const weaknessId of control.fixes ?? []) {
          if (!allWeaknesses.some((w) => w.id === weaknessId)) {
            add(at, `control ${control.id} fixes unknown weakness ${weaknessId}`);
          }
        }
        if (control.sensor) {
          if (!SENSOR_TYPES.has(control.sensor.type)) {
            add(at, `control ${control.id} has unknown sensor type ${control.sensor.type}`);
          }
          for (const covered of control.sensor.covers) {
            const known =
              control.sensor.type === 'nids' ? zoneIds.has(covered) : allSystems.some((s) => s.id === covered);
            if (!known) {
              add(at, `control ${control.id} sensor covers unknown ${control.sensor.type === 'nids' ? 'zone' : 'system'} ${covered}`);
            }
          }
        }
      }
    }
  }

  for (const link of miniverse.links) {
    for (const end of [link.src, link.dst]) {
      const [orgId, sysId] = end.split('/');
      const found = bundle.orgs.get(orgId ?? '')?.departments.some((d) => d.systems.some((s) => s.id === sysId));
      if (!found) {
        add(`link ${link.id}`, `unknown system ${end}`);
      }
    }
  }

  for (const dup of duplicates(allIps)) {
    add('miniverse', `address ${dup} is used twice`);
  }

  for (const practical of bundle.practicals) {
    const at = `practical ${practical.id}`;
    const org = bundle.orgs.get(practical.org);
    if (!org) {
      add(at, `unknown organisation ${practical.org}`);
      continue;
    }
    const controlIds = new Set(org.departments.flatMap((d) => d.controls.map((c) => c.id)));
    for (const [id, state] of Object.entries(practical.controls ?? {})) {
      if (!controlIds.has(id)) {
        add(at, `overrides unknown control ${id}`);
      }
      if (!['on', 'off', 'project'].includes(state)) {
        add(at, `control ${id} is ${String(state)}: use on, off or project`);
      }
    }
    if (practical.attacker) {
      const [objOrg, objData] = practical.attacker.objective.split('/');
      const target = bundle.orgs.get(objOrg ?? '');
      if (!target?.departments.some((d) => d.data.some((x) => x.id === objData))) {
        add(at, `attacker objective ${practical.attacker.objective} is not a known data set`);
      }
    }
    if (practical.foothold !== undefined) {
      const systemIds = new Set(org.departments.flatMap((d) => d.systems.map((sy) => sy.id)));
      if (practical.role !== 'predator') add(at, 'foothold is for predator floors');
      for (const id of Array.isArray(practical.foothold) ? practical.foothold : [practical.foothold]) {
        if (!systemIds.has(id)) add(at, `foothold ${id} is not a system in ${practical.org}`);
      }
    }
    if (practical.map) {
      const deptIds = new Set(org.departments.map((d) => d.id));
      for (const id of practical.map.rooms ?? []) {
        if (!deptIds.has(id)) add(at, `map room ${id} is not a department in ${practical.org}`);
      }
      for (const side of practical.map.outside ?? []) {
        if (side !== 'internet' && side !== 'partners') add(at, `map outside ${String(side)}: use internet or partners`);
      }
    }
    for (const id of practical.qcto) {
      if (bundle.qctoIds && !bundle.qctoIds.has(id)) {
        add(at, `unknown QCTO id ${id}`);
      }
    }
  }
}

/** References must still resolve once level gating is applied. */
function checkLevel(bundle: WorldBundle, org: ResolvedOrg, level: Level, issues: Issue[]): void {
  const where = `${org.def.id} at level ${level}`;
  const systemIds = new Set(org.systems.map((s) => s.id));
  const peopleIds = new Set(org.people.map((p) => p.id));
  const zoneIds = new Set(org.zones.map((z) => z.id));
  const systemExists = (ref: string): boolean => {
    if (!ref.includes('/')) {
      return systemIds.has(ref);
    }
    const [otherOrg, sys] = ref.split('/');
    const other = bundle.orgs.get(otherOrg ?? '');
    return other?.departments.some((d) => d.systems.some((s) => s.id === sys)) ?? false;
  };
  for (const system of org.systems) {
    if (!zoneIds.has(system.zone)) {
      add(`system ${system.id} sits in zone ${system.zone}, which does not exist yet`);
    }
  }
  for (const process of org.processes) {
    if (!peopleIds.has(process.owner)) {
      add(`process ${process.id} is owned by ${process.owner}, who does not exist yet`);
    }
    for (const step of process.activity) {
      if (!systemExists(step.system)) {
        add(`process ${process.id} uses system ${step.system}, which does not exist yet`);
      }
      if (step.via && step.via !== 'internet' && !systemIds.has(step.via)) {
        add(`process ${process.id} runs from ${step.via}, which does not exist yet`);
      }
      if (step.as && !peopleIds.has(step.as)) {
        add(`process ${process.id} acts as ${step.as}, who does not exist yet`);
      }
    }
  }
  for (const data of org.data) {
    if (!systemIds.has(data.system)) {
      add(`data ${data.id} is stored on ${data.system}, which does not exist yet`);
    }
  }
  for (const threat of org.threats) {
    const target = org.systems.find((s) => s.id === threat.target);
    if (!target) {
      add(`threat ${threat.id} targets ${threat.target}, which does not exist yet`);
      continue;
    }
    if (threat.uses && !(target.weaknesses ?? []).some((w) => w.id === threat.uses)) {
      add(`threat ${threat.id} uses weakness ${threat.uses}, which ${threat.target} does not have yet`);
    }
  }
  for (const control of org.controls) {
    if (control.sensor?.type === 'nids') {
      for (const zone of control.sensor.covers) {
        if (!zoneIds.has(zone)) {
          add(`control ${control.id} watches zone ${zone}, which does not exist yet`);
        }
      }
    } else if (control.sensor) {
      for (const sys of control.sensor.covers) {
        if (!systemIds.has(sys)) {
          add(`control ${control.id} watches ${sys}, which does not exist yet`);
        }
      }
    }
  }

  function add(message: string): void {
    issues.push({ where, message });
  }
}

/** True when an address parses and sits inside the range. */
function insideRange(ip: unknown, cidr: string): boolean {
  try {
    return typeof ip === 'string' && inCidr(ip, cidr);
  } catch {
    return false;
  }
}

/** Whether a control is on when a round starts: the practical's say, else the lab's, else its status. */
/** Keys with no value anywhere in a tool's settings: usually a comma in unquoted YAML text. */
function emptyKeys(value: unknown, at: string): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => emptyKeys(v, `${at}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => (v === null ? [`${at}.${k}`] : emptyKeys(v, `${at}.${k}`)));
}

function controlStartsOn(control: { status: string; lab?: string }, override?: string): boolean {
  return (override ?? control.lab ?? (control.status === 'in-place' ? 'on' : 'off')) === 'on';
}

const LOCKABLE = new Set(['block', 'unblock', 'isolate', 'release', 'rebuild', 'lock', 'reset', 'control']);
const ACTIONS = new Set(['block', 'isolate', 'rebuild', 'lock', 'reset', 'control']);
const TABS = new Set(['alerts', 'controls', 'blocks', 'term']);
const COMMAND_DID = new Set(['read', 'scan', 'crack', 'login', 'shell', 'dump', 'exfil']);

/** A guided floor may only point at rooms, machines and people that exist at its level. */
function checkGuide(bundle: WorldBundle, practical: PracticalDef, guide: GuideDef, issues: Issue[]): void {
  const at = `practical ${practical.id}`;
  const add = (message: string): void => {
    issues.push({ where: at, message });
  };
  if (practical.role !== 'prey' && practical.role !== 'predator') {
    add('guided floors are prey or predator rounds');
  }
  const org = resolveOrg(bundle, practical.org, practical.level);
  const rooms = new Set(org.departments.map((d) => d.id));
  const systems = new Map(org.systems.map((s) => [s.id, s] as const));
  const processes = new Set(org.processes.map((p) => p.id));
  const people = new Set(org.people.map((p) => p.id));
  const locked = new Set(Object.keys(guide.locked ?? {}));
  // Which controls exist at this level, and whether each is on when the floor starts.
  const controls = new Map(
    org.departments
      .flatMap((d) => d.controls)
      .map((c) => [c.id, { on: controlStartsOn(c, practical.controls?.[c.id]), project: practical.controls?.[c.id] === 'project' }] as const),
  );
  for (const [id, state] of Object.entries(practical.controls ?? {})) {
    if (!controls.has(id)) {
      const def = bundle.orgs.get(practical.org)?.departments.flatMap((d) => d.controls).find((c) => c.id === id);
      if (def) controls.set(id, { on: state === 'on', project: state === 'project' });
    }
  }
  for (const process of guide.hold ?? []) {
    if (!processes.has(process)) add(`holds unknown process ${process}`);
  }
  const rules = new Set(bundle.rules.map((r) => r.id));
  const internet = bundle.miniverse.internet.cidr;
  // The floor's desk tools and what each one's operations accept.
  const toolOps = new Map<string, Record<string, Set<string> | null>>();
  for (const [id, config] of Object.entries(practical.tools ?? {})) {
    const module = TOOL_MODULES[id] as ToolModule<unknown> | undefined;
    if (!module) {
      add(`unknown desk tool ${id}: use one of ${Object.keys(TOOL_MODULES).join(', ')}`);
      continue;
    }
    module.validate(config ?? {}, { bundleOrg: org, practical, rules, internet, add: (message) => add(`tools.${message}`) });
    toolOps.set(id, module.ops(config ?? {}, org));
    for (const path of emptyKeys(config, id)) {
      add(`tools.${path} has no value: a comma inside unquoted text in { } splits it, so quote the text`);
    }
  }
  if (guide.target !== undefined && (typeof guide.target !== 'number' || guide.target <= 0)) add('target is the minutes the floor should take');
  // The mentor usually works in the floor's own organisation; on an attack floor
  // they are a colleague from another (DataQuant tests the client).
  const mentorAnywhere =
    org.people.some((p) => p.id === guide.mentor) ||
    [...bundle.orgs.keys()].some((id) => resolveOrg(bundle, id, practical.level).people.some((p) => p.id === guide.mentor));
  if (!mentorAnywhere) {
    add(`mentor ${guide.mentor} does not work at any organisation at level ${org.level}`);
  }
  for (const action of Object.keys(guide.locked ?? {})) {
    if (!LOCKABLE.has(action)) {
      add(`cannot lock unknown action ${action}`);
    }
  }
  if (guide.steps.length === 0) {
    add('a guide needs at least one step');
  }
  for (const dup of duplicates(guide.steps.map((s) => s.id))) {
    add(`duplicate step id ${dup}`);
  }
  for (const step of guide.steps) {
    const where = (message: string): void => add(`step ${step.id}: ${message}`);
    for (const field of ['title', 'say', 'do', 'hint'] as const) {
      if (typeof step[field] !== 'string' || step[field].trim() === '') {
        where(`needs ${field}`);
      }
    }
    const done = step.done;
    if ('look' in done) {
      if (done.look === 'room' && done.id && !rooms.has(done.id)) where(`no room ${done.id}`);
      if (done.look === 'host' && !systems.has(done.id)) where(`no machine ${done.id}`);
      if (done.look === 'tab' && !TABS.has(done.id) && !toolOps.has(done.id)) where(`no tab or desk tool ${done.id}`);
      if (done.look === 'alert' && done.rule && !rules.has(done.rule)) where(`no detection rule ${done.rule}`);
    } else if ('answer' in done) {
      if (step.ask && (typeof step.ask.question !== 'string' || !step.ask.options.every((o) => typeof o.text === 'string' && typeof o.reply === 'string'))) {
        where('the question, each option and each reply must be text (quote one with ": " in it)');
      }
      const correct = step.ask?.options.filter((o) => o.correct === true).length ?? 0;
      if (!step.ask) where('done by answer, but there is no question');
      else if (correct !== 1) where(`the question needs exactly one correct answer (has ${correct})`);
    } else if ('alert' in done) {
      if (done.drill && !(step.script ?? []).some((s) => s.event === 'drill')) where('waits for a drill alert, but its script sends none');
      if (done.rule && !rules.has(done.rule)) where(`no detection rule ${done.rule}`);
    } else if ('sorted' in done) {
      if (!step.sort?.length) where('done when the alerts are sorted, but there is no sort list');
    } else if ('command' in done) {
      const want = done.command;
      if (practical.role !== 'predator') where('a command step is for an attack (predator) floor');
      if (!COMMAND_DID.has(want.did)) where(`command did must be one of ${[...COMMAND_DID].join(', ')}`);
      if (want.of !== undefined && !systems.has(want.of)) where(`command target ${want.of} does not exist at level ${org.level}`);
      if (want.did === 'read' && !want.text) where('a read command step needs text to match in the command line');
    } else if ('action' in done && done.action.includes('.')) {
      // A desk tool's operation, "tool.op".
      const [toolId, op] = done.action.split('.') as [string, string];
      const accepts = toolOps.get(toolId)?.[op];
      if (!toolOps.has(toolId)) where(`waits for ${done.action}, but the floor has no ${toolId} tool`);
      else if (accepts === undefined) where(`the ${toolId} tool has no operation ${op}`);
      const targets = done.targets ?? (done.target !== undefined ? [done.target] : []);
      if (done.targets && done.target !== undefined) where('give target or targets, not both');
      for (const target of targets) {
        if (accepts && !accepts.has(target)) where(`${done.action} has no target ${target}`);
      }
      for (const target of Object.keys(step.replies ?? {})) {
        if (accepts && !accepts.has(target)) where(`reply for unknown ${done.action} target ${target}`);
      }
    } else if ('action' in done) {
      const perUser = done.action === 'lock' || done.action === 'reset';
      // A lock or reset names its account with user, or as "system:user" in targets.
      const split = (target: string): [string, string | undefined] => {
        const [system, user] = target.split(':');
        return perUser && user !== undefined ? [system!, user] : [target, done.user];
      };
      const known = (target: string): boolean => {
        if (done.action === 'block') return insideRange(target, bundle.miniverse.labRange);
        if (done.action === 'control') return controls.has(target);
        return systems.has(split(target)[0]);
      };
      const targets = done.targets ?? (done.target !== undefined ? [done.target] : []);
      if (!ACTIONS.has(done.action)) where(`done action must be one of ${[...ACTIONS].join(', ')}, or a desk tool's tool.op`);
      else if (targets.length === 0) where(`${done.action} needs a target`);
      for (const target of targets) {
        if (ACTIONS.has(done.action) && !known(target)) where(`${done.action} target ${target} does not exist at level ${org.level}`);
        const [system, user] = split(target);
        if (perUser && !(systems.get(system)?.accounts ?? []).some((a) => a.user === user)) {
          where(`${system} has no account ${user ?? '(no user given)'}`);
        }
        if (done.action === 'control' && controls.get(target)?.on) where(`control ${target} is already on at the start, so the step would be done at once`);
        if (done.action === 'control' && controls.get(target)?.project) where(`control ${target} is a project on this floor, so the learner can't switch it on`);
      }
      if (locked.has(done.action)) where(`waits for ${done.action}, but this floor locks it`);
      if (!step.wrong) where('an action step needs a wrong reply, for the same action on the wrong thing');
      for (const target of Object.keys(step.replies ?? {})) {
        if (done.action === 'control' ? !controls.has(target) : done.action !== 'block' && !systems.has(target.split(':')[0] ?? '')) where(`reply for unknown ${done.action} target ${target}`);
      }
    } else {
      where('done must be look, answer, alert, sorted or action');
    }
    if (step.replies && !('action' in done)) where('replies only go on an action step');
    if (step.sort?.length && !('sorted' in done)) where('has a sort list, so it needs done: { sorted: true }');
    if (step.show?.room && !rooms.has(step.show.room)) where(`shows unknown room ${step.show.room}`);
    if (step.show?.host && !systems.has(step.show.host)) where(`shows unknown machine ${step.show.host}`);
    if (step.show?.tab && !TABS.has(step.show.tab) && !toolOps.has(step.show.tab)) where(`shows unknown tab or desk tool ${step.show.tab}`);
    if (step.show?.alert && step.show.alert !== 'drill' && !rules.has(step.show.alert)) where(`shows alerts from unknown rule ${step.show.alert}`);
    if (step.wait !== undefined && !(typeof step.wait === 'number' && step.wait > 0)) where('wait is the seconds the step can take, more than 0');
    for (const item of step.script ?? []) {
      if (typeof item.after !== 'number' || item.after < 0) where('script times are seconds from the start of the step');
      if (item.event === 'job') {
        if (!processes.has(item.process)) where(`${practical.org} has no process ${item.process} at level ${org.level}`);
        continue;
      }
      if (item.event === 'sweep') {
        if (!systems.has(item.from)) where(`sweep comes from unknown machine ${item.from}`);
        if (!org.zones.some((z) => z.id === item.zone)) where(`sweep works through unknown zone ${item.zone}`);
        if (!Array.isArray(item.ports) || item.ports.length === 0 || !item.ports.every((p) => Number.isInteger(p) && p > 0 && p < 65536)) where('a sweep needs ports to probe');
        if (typeof item.every !== 'number' || item.every <= 0) where('a sweep needs seconds between probes');
        if (typeof item.for !== 'number' || item.for <= 0 || item.for > 7200) where('a sweep runs for 1 to 7200 seconds');
        continue;
      }
      if (item.event === 'phish') {
        if (!people.has(item.to)) where(`phish goes to unknown person ${item.to}`);
        if (!insideRange(item.src, internet)) where(`phishing must come from the internet range ${internet}, not ${item.src}`);
        if (typeof item.lure !== 'string' || item.lure.trim() === '') where('a phish needs a lure (the attachment name)');
        if (item.opens !== undefined && (typeof item.opens !== 'number' || item.opens < 0)) where('opens is seconds after delivery');
        if (item.opens !== undefined && !org.systems.some((s) => ['laptop', 'desktop', 'workstation'].includes(s.kind) && (s.accounts ?? []).some((a) => a.person === item.to))) {
          where(`${item.to} has no device of their own to open the lure on`);
        }
        continue;
      }
      const system = systems.get(item.system);
      if (!system) {
        where(`script uses unknown machine ${item.system}`);
        continue;
      }
      if (item.event === 'login') {
        if (!systems.has(item.from)) where(`login comes from unknown machine ${item.from}`);
        if (!(system.accounts ?? []).some((a) => a.user === item.user)) where(`${item.system} has no account ${item.user}`);
        if (item.fails !== undefined && (!Number.isInteger(item.fails) || item.fails < 1 || item.fails > 9)) where('a login has 1 to 9 wrong tries first, or none');
        if (item.every !== undefined && (typeof item.every !== 'number' || item.every <= 0)) where('a login needs seconds between tries');
      } else if (item.event === 'drill') {
        if (!SEVERITIES.includes(item.severity)) where(`unknown severity ${item.severity}`);
      } else if (item.event === 'guess') {
        if (!(system.accounts ?? []).some((a) => a.user === item.user)) where(`${item.system} has no account ${item.user}`);
        if (!insideRange(item.src, internet)) where(`guesses must come from the internet range ${internet}, not ${item.src}`);
        if (!Number.isInteger(item.tries) || item.tries < 1 || item.tries > 50) where('a guess needs 1 to 50 tries');
        if (typeof item.every !== 'number' || item.every <= 0) where('a guess needs seconds between tries');
      } else if (item.event === 'scan') {
        if (item.from !== undefined && item.src !== undefined) where('a scan comes from src or from, not both');
        if (item.from !== undefined && !systems.has(item.from)) where(`scan comes from unknown machine ${item.from}`);
        if (item.from === undefined && !insideRange(item.src, internet)) where(`scans must come from the internet range ${internet}, not ${item.src}`);
        if (item.ports !== undefined && (!Number.isInteger(item.ports) || item.ports < 25 || item.ports > 1000)) where('a scan checks 25 to 1000 ports');
      } else if (item.event === 'download') {
        if (!insideRange(item.src, internet)) where(`downloads must come from the internet range ${internet}, not ${item.src}`);
        if (typeof item.path !== 'string' || !item.path.startsWith('/')) where('a download needs a path starting with /');
        if (item.port !== undefined && !(system.services ?? []).some((svc) => svc.port === item.port)) where(`${item.system} has nothing on port ${item.port}`);
      } else {
        where(`unknown script event ${(item as { event?: string }).event}: use login, drill, guess, scan, sweep, job, phish or download`);
      }
    }
    for (const [i, entry] of (step.sort ?? []).entries()) {
      const which = `sort entry ${i + 1}`;
      if (!rules.has(entry.rule)) where(`${which}: no detection rule ${entry.rule}`);
      if (entry.from && !systems.has(entry.from)) where(`${which}: comes from unknown machine ${entry.from}`);
      if (entry.src && typeof entry.src !== 'string') where(`${which}: src is an address`);
      if (entry.verdict !== 'true-positive' && entry.verdict !== 'false-positive') where(`${which}: verdict is true-positive or false-positive`);
      if (typeof entry.right !== 'string' || entry.right.trim() === '') where(`${which}: needs what to say when it is sorted right`);
      if (typeof entry.wrong !== 'string' || entry.wrong.trim() === '') where(`${which}: needs what to say when it is sorted wrong`);
    }
  }
  if (!guide.outro?.title || !Array.isArray(guide.outro.learned)) {
    add('a guide needs an outro with a title and what was learned');
  } else if (!guide.outro.learned.every((line) => typeof line === 'string')) {
    add('every line of the outro\'s learned list must be text (quote a line with ": " in it)');
  }
}

function checkTowers(bundle: WorldBundle, issues: Issue[]): void {
  for (const dup of duplicates(bundle.towers.map((t) => t.id))) {
    issues.push({ where: 'towers', message: `duplicate tower id ${dup}` });
  }
  for (const dup of duplicates(bundle.towers.map((t) => `${t.role} ${t.tier}`))) {
    issues.push({ where: 'towers', message: `two ${dup} towers: the town has one building for each role and tier` });
  }
  for (const tower of bundle.towers) {
    const at = `tower ${tower.id}`;
    if (!TOWER_TIERS.includes(tower.tier)) {
      issues.push({ where: at, message: `tier must be one of ${TOWER_TIERS.join(', ')}` });
    }
    for (const dup of duplicates(tower.floors.map((f) => String(f.floor)))) {
      issues.push({ where: at, message: `floor ${dup} appears twice` });
    }
    for (const floor of tower.floors) {
      if (!floor.practical) {
        continue;
      }
      const practical = bundle.practicals.find((p) => p.id === floor.practical);
      if (!practical) {
        issues.push({ where: at, message: `floor ${floor.floor} plays unknown practical ${floor.practical}` });
      } else if (practical.role !== tower.role) {
        issues.push({ where: at, message: `floor ${floor.floor} is a ${practical.role} practical in a ${tower.role} tower` });
      }
    }
  }
}

export function validateWorld(bundle: WorldBundle): Issue[] {
  const issues: Issue[] = [];
  checkStatic(bundle, issues);
  checkTowers(bundle, issues);
  for (const practical of bundle.practicals) {
    if (practical.guide && bundle.orgs.has(practical.org)) {
      checkGuide(bundle, practical, practical.guide, issues);
    }
  }
  for (const orgId of bundle.orgs.keys()) {
    for (const level of LEVELS) {
      checkLevel(bundle, resolveOrg(bundle, orgId, level), level, issues);
    }
  }
  return issues;
}

const SITE_KINDS = new Set(['building', 'depot', 'cloud', 'stores']);

/** Every room in exactly one site, and no two sites on top of each other once moved. */
function validateSites(def: OrganisationDef, departments: Array<{ id: string; room: { x: number; y: number; w: number; h: number } }>, add: (msg: string) => void): void {
  const sites = def.sites;
  if (!sites) return;
  const owner = new Map<string, string>();
  for (const site of sites) {
    if (site.kind && !SITE_KINDS.has(site.kind)) add(`site ${site.id}: unknown kind ${site.kind}`);
    if (site.rooms.length === 0) add(`site ${site.id} has no rooms`);
    for (const room of site.rooms) {
      if (!departments.some((d) => d.id === room)) add(`site ${site.id}: no department ${room}`);
      const other = owner.get(room);
      if (other) add(`room ${room} is in sites ${other} and ${site.id}`);
      owner.set(room, site.id);
    }
  }
  for (const d of departments) if (!owner.has(d.id)) add(`room ${d.id} is in no site`);
  for (const dup of duplicates(sites.map((s) => s.id))) add(`duplicate site id ${dup}`);
  const boxes = sites.map((site) => {
    const rects = departments.filter((d) => site.rooms.includes(d.id)).map((d) => d.room);
    const dx = site.shift?.x ?? 0;
    const dy = site.shift?.y ?? 0;
    return {
      id: site.id,
      x0: Math.min(...rects.map((r) => r.x)) + dx,
      y0: Math.min(...rects.map((r) => r.y)) + dy,
      x1: Math.max(...rects.map((r) => r.x + r.w)) + dx,
      y1: Math.max(...rects.map((r) => r.y + r.h)) + dy,
    };
  });
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) add(`sites ${a.id} and ${b.id} overlap on the map`);
    }
  }
}
