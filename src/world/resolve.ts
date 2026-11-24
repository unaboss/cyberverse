// Turns the level-gated world files into the world as it is at one maturity
// level: only the people, systems, data and controls that exist at that level.

import type { WorldBundle } from './load.ts';
import type {
  ControlDef,
  DataDef,
  DepartmentDef,
  FlowDef,
  Gated,
  Level,
  LinkDef,
  OrganisationDef,
  PersonDef,
  ProcessDef,
  SystemDef,
  ThreatDef,
  ZoneDef,
} from './types.ts';

export function activeAt(item: Gated, level: Level): boolean {
  return (item.from ?? 1) <= level && level <= (item.until ?? 4);
}

function only<T extends Gated>(items: T[], level: Level): T[] {
  return items.filter((item) => activeAt(item, level));
}

export interface ResolvedDepartment extends DepartmentDef {
  /** False when nobody works in the department yet at this level. */
  staffed: boolean;
}

export interface ResolvedSystem extends SystemDef {
  org: string;
  dept: string;
  /** "org/system" */
  key: string;
  fqdn: string;
}

export interface ResolvedOrg {
  def: OrganisationDef;
  level: Level;
  zones: ZoneDef[];
  policy: FlowDef[];
  departments: ResolvedDepartment[];
  systems: ResolvedSystem[];
  people: (PersonDef & { dept: string })[];
  processes: (ProcessDef & { dept: string })[];
  data: (DataDef & { dept: string; org: string; key: string })[];
  controls: (ControlDef & { dept: string })[];
  threats: (ThreatDef & { dept: string })[];
}

export function resolveDepartment(dept: DepartmentDef, level: Level): ResolvedDepartment {
  const people = only(dept.people, level);
  return {
    ...dept,
    people,
    processes: only(dept.processes, level),
    systems: only(dept.systems, level).map((s) => ({ ...s, weaknesses: only(s.weaknesses ?? [], level) })),
    data: only(dept.data, level),
    connections: only(dept.connections, level),
    threats: only(dept.threats, level),
    controls: only(dept.controls, level),
    staffed: people.length > 0,
  };
}

export function resolveOrg(bundle: WorldBundle, orgId: string, level?: Level): ResolvedOrg {
  const org = bundle.orgs.get(orgId);
  if (!org) {
    throw new Error(`Unknown organisation: ${orgId}`);
  }
  const at = level ?? org.def.level;
  const departments = org.departments.map((d) => resolveDepartment(d, at));
  const resolved: ResolvedOrg = {
    def: org.def,
    level: at,
    zones: only(org.def.zones, at),
    policy: only(org.def.policy, at),
    departments,
    systems: [],
    people: [],
    processes: [],
    data: [],
    controls: [],
    threats: [],
  };
  // An account exists only while the person it belongs to works there.
  const staff = new Set(departments.flatMap((d) => d.people.map((p) => p.id)));
  for (const dept of departments) {
    for (const s of dept.systems) {
      resolved.systems.push({
        ...s,
        accounts: (s.accounts ?? []).filter((a) => a.person === undefined || staff.has(a.person)),
        org: orgId,
        dept: dept.id,
        key: `${orgId}/${s.id}`,
        fqdn: `${s.hostname}.${org.def.domain}`,
      });
    }
    resolved.people.push(...dept.people.map((p) => ({ ...p, dept: dept.id })));
    resolved.processes.push(...dept.processes.map((p) => ({ ...p, dept: dept.id })));
    resolved.data.push(...dept.data.map((d) => ({ ...d, dept: dept.id, org: orgId, key: `${orgId}/${d.id}` })));
    resolved.controls.push(...dept.controls.map((c) => ({ ...c, dept: dept.id })));
    resolved.threats.push(...dept.threats.map((t) => ({ ...t, dept: dept.id })));
  }
  return resolved;
}

export interface ResolvedMiniverse {
  orgs: Map<string, ResolvedOrg>;
  links: LinkDef[];
}

/** Links exist only while both ends exist at their organisations' levels. */
export function resolveMiniverse(bundle: WorldBundle, levels: Record<string, Level> = {}): ResolvedMiniverse {
  const orgs = new Map<string, ResolvedOrg>();
  for (const id of bundle.miniverse.organisations) {
    orgs.set(id, resolveOrg(bundle, id, levels[id]));
  }
  const hasSystem = (key: string): boolean => {
    const [orgId, systemId] = key.split('/');
    return orgs.get(orgId ?? '')?.systems.some((s) => s.id === systemId) ?? false;
  };
  const links = bundle.miniverse.links.filter((link) => {
    const srcOrg = orgs.get(link.src.split('/')[0] ?? '');
    return srcOrg !== undefined && activeAt(link, srcOrg.level) && hasSystem(link.src) && hasSystem(link.dst);
  });
  return { orgs, links };
}
