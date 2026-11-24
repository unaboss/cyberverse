// Builds the world from its files: the miniverse, each organisation and its
// department files, the detection rule catalogue and the practicals.
//
// It reads through a WorldSource, so the same code builds the world from disk
// (load.ts, for the local server and the tests) or from files bundled into a
// Cloudflare Worker (cloudflare/worker.ts). Nothing here touches node:fs.

import { parse } from 'yaml';
import type {
  DepartmentDef,
  MiniverseDef,
  OrganisationDef,
  PracticalDef,
  RuleDef,
  TowerDef,
} from './types.ts';

export interface OrgBundle {
  def: OrganisationDef;
  departments: DepartmentDef[];
  /** Department id -> file it came from, for error messages. */
  files: Map<string, string>;
}

export interface WorldBundle {
  root: string;
  miniverse: MiniverseDef;
  orgs: Map<string, OrgBundle>;
  rules: RuleDef[];
  practicals: PracticalDef[];
  /** Storylines that order the practicals floor by floor (practicals/towers.yaml). */
  towers: TowerDef[];
  wordlist: string[];
  /** QCTO ids we can map to, if the blueprints are present. */
  qctoIds: Set<string> | null;
}

/**
 * Where the world files come from. Paths are relative to the project folder,
 * with forward slashes; the QCTO blueprints are under `docs/qcto`.
 */
export interface WorldSource {
  read(path: string): string;
  exists(path: string): boolean;
  /** The file names in a folder (not recursive). */
  list(dir: string): string[];
  /** How to name a file in an error message. */
  where(path: string): string;
}

const TOWERS_FILE = 'towers.yaml';

/** The QCTO blueprints the practicals map to, relative to the project folder. */
export const QCTO_FILES = [
  'docs/qcto/qcto-cybersecurity-analyst-modules.json',
  'docs/qcto/qcto-cybersecurity-analyst-eas.json',
];

function withDepartmentDefaults(raw: Partial<DepartmentDef>): DepartmentDef {
  return {
    id: raw.id ?? '',
    name: raw.name ?? '',
    purpose: raw.purpose ?? '',
    room: raw.room ?? { x: 0, y: 0, w: 1, h: 1 },
    people: raw.people ?? [],
    processes: (raw.processes ?? []).map((p) => ({ ...p, activity: p.activity ?? [], steps: p.steps ?? [] })),
    systems: (raw.systems ?? []).map((s) => ({ ...s, services: s.services ?? [] })),
    data: raw.data ?? [],
    connections: raw.connections ?? [],
    threats: raw.threats ?? [],
    controls: raw.controls ?? [],
    maturity: raw.maturity ?? ({} as DepartmentDef['maturity']),
    qcto: raw.qcto ?? [],
  };
}

function loadQctoIds(source: WorldSource): Set<string> | null {
  if (!QCTO_FILES.every((f) => source.exists(f))) {
    return null;
  }
  const ids = new Set<string>();
  for (const file of QCTO_FILES) {
    const blueprint = JSON.parse(source.read(file)) as {
      domains: { code: string; objectives: { id: string }[] }[];
    };
    for (const domain of blueprint.domains) {
      ids.add(domain.code);
      for (const objective of domain.objectives) {
        ids.add(objective.id);
      }
    }
  }
  return ids;
}

export function buildWorld(source: WorldSource, root = ''): WorldBundle {
  const yaml = <T>(path: string): T => parse(source.read(path)) as T;
  const miniverse = yaml<MiniverseDef>('worlds/miniverse.yaml');
  miniverse.links = miniverse.links ?? [];

  const orgs = new Map<string, OrgBundle>();
  for (const orgId of miniverse.organisations) {
    const def = yaml<OrganisationDef>(`worlds/${orgId}/organisation.yaml`);
    def.policy = def.policy ?? [];
    const departments: DepartmentDef[] = [];
    const files = new Map<string, string>();
    for (const deptId of def.departments) {
      const file = `worlds/${orgId}/departments/${deptId}.yaml`;
      const dept = withDepartmentDefaults(yaml<Partial<DepartmentDef>>(file));
      departments.push(dept);
      files.set(dept.id, source.where(file));
    }
    orgs.set(orgId, { def, departments, files });
  }

  const rules = yaml<RuleDef[]>('worlds/detections.yaml');

  const practicals = source.exists('practicals')
    ? source
        .list('practicals')
        .filter((f) => f.endsWith('.yaml') && f !== TOWERS_FILE)
        .sort()
        .map((f) => yaml<PracticalDef>(`practicals/${f}`))
    : [];
  const towersPath = `practicals/${TOWERS_FILE}`;
  const towers = source.exists(towersPath) ? (yaml<TowerDef[] | null>(towersPath) ?? []) : [];

  const wordlist = source
    .read('worlds/wordlists/common-passwords.txt')
    .split(/\r?\n/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && !w.startsWith('#'));

  return {
    root,
    miniverse,
    orgs,
    rules,
    practicals,
    towers,
    wordlist,
    qctoIds: loadQctoIds(source),
  };
}

/** A source over files already in memory, keyed by their relative path (a Worker's bundle). */
export function memorySource(files: Record<string, string>): WorldSource {
  const has = (path: string): boolean => Object.hasOwn(files, path);
  return {
    read(path) {
      if (!has(path)) {
        throw new Error(`The world bundle has no ${path}.`);
      }
      return files[path]!;
    },
    exists(path) {
      return has(path) || Object.keys(files).some((name) => name.startsWith(`${path}/`));
    },
    list(dir) {
      const prefix = `${dir}/`;
      return Object.keys(files)
        .filter((name) => name.startsWith(prefix) && !name.slice(prefix.length).includes('/'))
        .map((name) => name.slice(prefix.length));
    },
    where(path) {
      return path;
    },
  };
}
