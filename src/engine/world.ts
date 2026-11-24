// The live state of the miniverse during a round: every machine, account,
// control and firewall block, and the rules that decide who can reach what.

import type { WorldBundle } from '../world/load.ts';
import { resolveMiniverse, type ResolvedOrg, type ResolvedSystem } from '../world/resolve.ts';
import { inCidr, hostsIn } from '../world/net.ts';
import type {
  ControlDef,
  DataDef,
  Level,
  LinkDef,
  PracticalDef,
  RuleDef,
  SensorType,
  ServiceDef,
  WeaknessDef,
} from '../world/types.ts';
import type { Rng } from './core.ts';

export interface AccountState {
  user: string;
  password: string;
  /** The password in the world file, before any control rotates it. */
  originalPassword: string;
  role: 'user' | 'admin' | 'service';
  person?: string;
  service?: string;
  locked: boolean;
  failures: number;
  /** Created by the engine for a person with no account in the files. */
  implicit: boolean;
}

export type HostStatus = 'up' | 'isolated' | 'down';

export interface Compromise {
  level: 'user' | 'root';
  by: string;
  at: number;
}

export interface HostState {
  key: string;
  org: string;
  dept: string;
  id: string;
  name: string;
  hostname: string;
  fqdn: string;
  kind: string;
  zone: string;
  ip: string;
  os: string;
  critical: boolean;
  services: ServiceDef[];
  accounts: AccountState[];
  weaknesses: WeaknessDef[];
  status: HostStatus;
  compromise: Compromise | null;
  /** Names of the files on this host that hold the organisation's data. */
  data: (DataDef & { key: string })[];
  /** A hardware fault: the machine stays down until it is repaired, and re-imaging won't help. */
  fault?: string;
}

export interface SensorState {
  org: string;
  control: string;
  type: SensorType;
  covers: Set<string>;
}

export interface Block {
  org: string;
  /** A single address or a CIDR range. */
  src: string;
  by: string;
  at: number;
  /** Connection attempts the block has stopped at the perimeter. */
  stopped: number;
}

export interface OrgState {
  id: string;
  name: string;
  domain: string;
  level: Level;
  colour: string;
  revenuePerHour: number;
  resolved: ResolvedOrg;
  controls: Map<string, ControlDef & { dept: string }>;
  controlOn: Map<string, boolean>;
  /** Controls that are projects on this floor: off, and not a switch the learner can flip. */
  projects: Set<string>;
}

export interface Endpoint {
  ip: string;
  /** Null for the internet. */
  org: string | null;
  zone: string;
  /** "org/system" when the endpoint is a lab machine. */
  hostKey?: string;
}

export type Reach = 'ok' | 'closed' | 'filtered' | 'down';

const STRONG_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%&*';

export class World {
  readonly orgs = new Map<string, OrgState>();
  readonly hosts = new Map<string, HostState>();
  readonly byIp = new Map<string, HostState>();
  readonly links: LinkDef[];
  readonly rules = new Map<string, RuleDef>();
  readonly blocks: Block[] = [];
  readonly internetCidr: string;
  readonly attackerPool: string[];
  readonly labRange: string;
  /** Addresses each service account normally logs in from. */
  readonly baseline = new Map<string, Set<string>>();
  readonly wordlist: string[];
  sensors: SensorState[] = [];

  readonly bundle: WorldBundle;
  readonly practical: PracticalDef | null;
  private readonly rng: Rng;

  constructor(
    bundle: WorldBundle,
    practical: PracticalDef | null,
    rng: Rng,
  ) {
    this.bundle = bundle;
    this.practical = practical;
    this.rng = rng;
    const levels: Record<string, Level> = {};
    if (practical?.level) {
      levels[practical.org] = practical.level;
    }
    const resolved = resolveMiniverse(bundle, levels);
    this.links = resolved.links;
    this.internetCidr = bundle.miniverse.internet.cidr;
    this.attackerPool = [...bundle.miniverse.internet.attackerPool];
    this.labRange = bundle.miniverse.labRange;
    this.wordlist = bundle.wordlist;
    for (const rule of bundle.rules) {
      this.rules.set(rule.id, rule);
    }

    for (const [id, org] of resolved.orgs) {
      const controls = new Map(org.controls.map((c) => [c.id, c] as const));
      const controlOn = new Map<string, boolean>();
      const projects = new Set<string>();
      for (const control of org.controls) {
        const lab = control.lab ?? (control.status === 'in-place' ? 'on' : 'off');
        controlOn.set(control.id, lab === 'on');
      }
      if (practical && practical.org === id) {
        for (const [controlId, state] of Object.entries(practical.controls ?? {})) {
          if (!controls.has(controlId)) {
            // A control the organisation only gets at a higher level, added in the lab for
            // this practical. The real company (and its manual) stays as it is.
            const dept = bundle.orgs.get(id)?.departments.find((d) => d.controls.some((c) => c.id === controlId));
            const def = dept?.controls.find((c) => c.id === controlId);
            if (dept && def) {
              const added = { ...def, dept: dept.id };
              controls.set(controlId, added);
              org.controls.push(added);
            }
          }
          if (controls.has(controlId)) {
            controlOn.set(controlId, state === 'on');
            if (state === 'project') projects.add(controlId);
          }
        }
      }
      this.orgs.set(id, {
        id,
        name: org.def.name,
        domain: org.def.domain,
        level: org.level,
        colour: org.def.colour,
        revenuePerHour: org.def.revenuePerHour,
        resolved: org,
        controls,
        controlOn,
        projects,
      });
      for (const system of org.systems) {
        this.addHost(org, system);
      }
    }
    this.addImplicitAccounts();
    this.buildBaseline();
    this.applyControls();
  }

  private addHost(org: ResolvedOrg, system: ResolvedSystem): void {
    const host: HostState = {
      key: system.key,
      org: system.org,
      dept: system.dept,
      id: system.id,
      name: system.name,
      hostname: system.hostname,
      fqdn: system.fqdn,
      kind: system.kind,
      zone: system.zone,
      ip: system.ip,
      os: system.os,
      critical: system.critical ?? false,
      services: system.services,
      accounts: (system.accounts ?? []).map((a) => ({
        user: a.user,
        password: a.password,
        originalPassword: a.password,
        role: a.role,
        ...(a.person ? { person: a.person } : {}),
        ...(a.service ? { service: a.service } : {}),
        locked: false,
        failures: 0,
        implicit: false,
      })),
      weaknesses: system.weaknesses ?? [],
      status: 'up',
      compromise: null,
      data: org.data.filter((d) => d.system === system.id),
    };
    this.hosts.set(host.key, host);
    this.byIp.set(host.ip, host);
  }

  /** People log in to systems the files give them no explicit account on. */
  private addImplicitAccounts(): void {
    for (const org of this.orgs.values()) {
      for (const process of org.resolved.processes) {
        for (const step of process.activity) {
          if (step.action !== 'login' || step.account) {
            continue;
          }
          const host = this.resolveSystem(org.id, step.system);
          const personId = step.as ?? process.owner;
          if (!host || host.accounts.some((a) => a.person === personId)) {
            continue;
          }
          const person = org.resolved.people.find((p) => p.id === personId);
          const user = (person?.name.split(' ')[0] ?? personId).toLowerCase();
          host.accounts.push({
            user,
            password: this.strongPassword(),
            originalPassword: '',
            role: 'user',
            person: personId,
            locked: false,
            failures: 0,
            implicit: true,
          });
        }
      }
    }
  }

  private buildBaseline(): void {
    for (const org of this.orgs.values()) {
      for (const process of org.resolved.processes) {
        for (const step of process.activity) {
          if (step.action !== 'login' || !step.account) {
            continue;
          }
          const host = this.resolveSystem(org.id, step.system);
          const via = step.via ? this.resolveSystem(org.id, step.via) : undefined;
          if (!host) {
            continue;
          }
          const key = `${host.key}:${step.account}`;
          const set = this.baseline.get(key) ?? new Set<string>();
          set.add(via?.ip ?? host.ip);
          this.baseline.set(key, set);
        }
      }
    }
  }

  strongPassword(): string {
    let out = '';
    for (let i = 0; i < 16; i++) {
      out += STRONG_CHARS[this.rng.int(0, STRONG_CHARS.length - 1)];
    }
    return out;
  }

  // --------------------------------------------------------------- controls

  isControlOn(orgId: string, controlId: string): boolean {
    return this.orgs.get(orgId)?.controlOn.get(controlId) ?? false;
  }

  setControl(orgId: string, controlId: string, on: boolean): boolean {
    const org = this.orgs.get(orgId);
    if (!org?.controls.has(controlId)) {
      return false;
    }
    org.controlOn.set(controlId, on);
    this.applyControls();
    return true;
  }

  /** Recompute sensors and rotated passwords after any control change. */
  applyControls(): void {
    this.sensors = [];
    for (const org of this.orgs.values()) {
      for (const control of org.controls.values()) {
        if (control.sensor && org.controlOn.get(control.id)) {
          this.sensors.push({
            org: org.id,
            control: control.id,
            type: control.sensor.type,
            covers: new Set(control.sensor.covers),
          });
        }
      }
    }
    for (const host of this.hosts.values()) {
      for (const weakness of host.weaknesses) {
        if (weakness.kind !== 'weak-password' && weakness.kind !== 'default-credentials') {
          continue;
        }
        const account = host.accounts.find((a) => a.user === weakness.account);
        if (!account) {
          continue;
        }
        const fixed = this.isFixed(host.org, weakness.id);
        if (fixed && account.password === account.originalPassword) {
          account.password = this.strongPassword();
        } else if (!fixed && account.password !== account.originalPassword && account.originalPassword) {
          account.password = account.originalPassword;
        }
      }
    }
  }

  private isFixed(orgId: string, weaknessId: string): boolean {
    const org = this.orgs.get(orgId);
    if (!org) {
      return false;
    }
    for (const control of org.controls.values()) {
      if (org.controlOn.get(control.id) && (control.fixes ?? []).includes(weaknessId)) {
        return true;
      }
    }
    return false;
  }

  weaknessActive(host: HostState, weaknessId: string): boolean {
    return host.weaknesses.some((w) => w.id === weaknessId) && !this.isFixed(host.org, weaknessId);
  }

  activeWeaknesses(host: HostState): WeaknessDef[] {
    return host.weaknesses.filter((w) => !this.isFixed(host.org, w.id));
  }

  /**
   * Put a decoy machine on the network: a honeypot nobody uses, so anything
   * that touches it is suspicious. A second decoy with the same key replaces
   * the first.
   */
  addDecoy(decoy: Pick<HostState, 'key' | 'org' | 'dept' | 'id' | 'name' | 'hostname' | 'zone' | 'ip' | 'os' | 'services'>): HostState {
    this.removeHost(decoy.key);
    const org = this.orgs.get(decoy.org);
    const host: HostState = {
      ...decoy,
      fqdn: `${decoy.hostname}.${org?.domain ?? 'lab'}`,
      kind: 'decoy',
      critical: false,
      accounts: [],
      weaknesses: [],
      status: 'up',
      compromise: null,
      data: [],
    };
    this.hosts.set(host.key, host);
    this.byIp.set(host.ip, host);
    return host;
  }

  removeHost(key: string): void {
    const host = this.hosts.get(key);
    if (!host) return;
    this.hosts.delete(key);
    if (this.byIp.get(host.ip) === host) this.byIp.delete(host.ip);
  }

  /** Rules switched on by any control that is on. A decoy's rule is on wherever a decoy stands. */
  ruleEnabled(orgId: string, ruleId: string): boolean {
    const org = this.orgs.get(orgId);
    if (!org) {
      return false;
    }
    if (this.rules.get(ruleId)?.sensor === 'decoy') {
      return true;
    }
    for (const control of org.controls.values()) {
      if (org.controlOn.get(control.id) && (control.rules ?? []).includes(ruleId)) {
        return true;
      }
    }
    return false;
  }

  lockoutAfter(orgId: string): number | null {
    const org = this.orgs.get(orgId);
    let limit: number | null = null;
    for (const control of org?.controls.values() ?? []) {
      if (control.lockoutAfter && org?.controlOn.get(control.id)) {
        limit = limit === null ? control.lockoutAfter : Math.min(limit, control.lockoutAfter);
      }
    }
    return limit;
  }

  mfaRequired(orgId: string): boolean {
    const org = this.orgs.get(orgId);
    for (const control of org?.controls.values() ?? []) {
      if (control.mfa && org?.controlOn.get(control.id)) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- network

  resolveSystem(orgId: string, ref: string): HostState | undefined {
    return this.hosts.get(ref.includes('/') ? ref : `${orgId}/${ref}`);
  }

  /** Resolve an address or a host name to a lab machine. */
  lookup(target: string): HostState | undefined {
    const byIp = this.byIp.get(target);
    if (byIp) {
      return byIp;
    }
    const name = target.toLowerCase();
    for (const host of this.hosts.values()) {
      if (host.fqdn === name || host.hostname === name) {
        return host;
      }
    }
    return undefined;
  }

  endpointFor(ip: string): Endpoint {
    const host = this.byIp.get(ip);
    if (host) {
      return { ip, org: host.org, zone: host.zone, hostKey: host.key };
    }
    return { ip, org: null, zone: 'internet' };
  }

  isLabAddress(ip: string): boolean {
    try {
      return inCidr(ip, this.labRange);
    } catch {
      return false;
    }
  }

  isBlocked(src: string, orgId: string): boolean {
    return this.blockFor(src, orgId) !== undefined;
  }

  /** The block that covers an address, if any: the address itself first, then a range. */
  blockFor(src: string, orgId: string): Block | undefined {
    const mine = this.blocks.filter((b) => b.org === orgId);
    return mine.find((b) => b.src === src) ?? mine.find((b) => b.src.includes('/') && inCidr(src, b.src));
  }

  /** Share (0 to 1) of the public, the organisation's clients and suppliers, that its blocks shut out. */
  publicBlocked(orgId: string): number {
    const pool = this.publicPool();
    if (!this.blocks.some((b) => b.org === orgId)) {
      return 0;
    }
    return pool.filter((ip) => this.isBlocked(ip, orgId)).length / pool.length;
  }

  /** Whether `from` can open a connection to `host` on `port` (0 for ICMP). */
  reach(from: Endpoint, host: HostState, port: number): Reach {
    if (host.status !== 'up') {
      return 'down';
    }
    if (from.hostKey === host.key) {
      return port === 0 || host.services.some((s) => s.port === port) ? 'ok' : 'closed';
    }
    if (!this.pathAllowed(from, host, port)) {
      return 'filtered';
    }
    if (port === 0) {
      return 'ok';
    }
    return host.services.some((s) => s.port === port) ? 'ok' : 'closed';
  }

  private pathAllowed(from: Endpoint, host: HostState, port: number): boolean {
    const block = from.org !== host.org ? this.blockFor(from.ip, host.org) : undefined;
    if (block) {
      block.stopped++;
      return false;
    }
    if (from.hostKey) {
      const source = this.hosts.get(from.hostKey);
      if (source && source.status !== 'up') {
        return false;
      }
    }
    if (from.org === host.org) {
      if (from.zone === host.zone) {
        return true;
      }
      return this.flowAllows(host.org, from.zone, host.zone, port);
    }
    if (from.hostKey) {
      const link = this.links.find((l) => l.src === from.hostKey && l.dst === host.key);
      if (link && (port === 0 || link.ports.includes(port))) {
        return true;
      }
    }
    return this.flowAllows(host.org, 'internet', host.zone, port);
  }

  private flowAllows(orgId: string, srcZone: string, dstZone: string, port: number): boolean {
    const org = this.orgs.get(orgId);
    if (!org) {
      return false;
    }
    return org.resolved.policy.some(
      (flow) =>
        flow.src === srcZone &&
        flow.dst === dstZone &&
        (flow.ports === 'any' || port === 0 || flow.ports.includes(port)),
    );
  }

  /** Every address in an organisation's zones that holds a machine. */
  zoneHosts(orgId: string, zoneId: string): HostState[] {
    return [...this.hosts.values()].filter((h) => h.org === orgId && h.zone === zoneId);
  }

  zoneOfIp(ip: string): { org: string | null; zone: string } {
    const host = this.byIp.get(ip);
    if (host) {
      return { org: host.org, zone: host.zone };
    }
    for (const org of this.orgs.values()) {
      for (const zone of org.resolved.zones) {
        if (inCidr(ip, zone.cidr)) {
          return { org: org.id, zone: zone.id };
        }
      }
    }
    return { org: null, zone: 'internet' };
  }

  addressesIn(cidr: string): string[] {
    return hostsIn(cidr);
  }

  /** A public address for a resident or supplier, never one an attacker uses. */
  publicAddress(): string {
    return this.rng.pick(this.publicPool());
  }

  private publicPool(): string[] {
    return hostsIn(this.internetCidr).filter((ip) => !this.attackerPool.includes(ip)).slice(20, 240);
  }

  /** The person who uses a device, from its accounts or the processes run on it. */
  deviceOwner(host: HostState): string | undefined {
    const fromAccount = host.accounts.find((a) => a.person && a.role !== 'service')?.person;
    if (fromAccount) {
      return fromAccount;
    }
    const org = this.orgs.get(host.org);
    return org?.resolved.processes.find((p) => p.activity.some((a) => a.via === host.id))?.owner;
  }

  /** The machine a person works on. */
  deviceOf(orgId: string, personId: string): HostState | undefined {
    for (const host of this.hosts.values()) {
      if (host.org === orgId && ['laptop', 'desktop', 'workstation'].includes(host.kind) && this.deviceOwner(host) === personId) {
        return host;
      }
    }
    return undefined;
  }

  mailServer(orgId: string): HostState | undefined {
    return [...this.hosts.values()].find((h) => h.org === orgId && h.kind === 'mail');
  }

  dataByKey(key: string): (DataDef & { key: string; host: HostState }) | undefined {
    for (const host of this.hosts.values()) {
      const data = host.data.find((d) => d.key === key);
      if (data) {
        return { ...data, host };
      }
    }
    return undefined;
  }

  person(orgId: string, personId: string): { name: string; role: string; awareness: number; kind: string } | undefined {
    const person = this.orgs.get(orgId)?.resolved.people.find((p) => p.id === personId);
    return person
      ? { name: person.name, role: person.role, awareness: person.awareness ?? 0.5, kind: person.kind }
      : undefined;
  }
}
