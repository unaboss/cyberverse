// Staff bots and the business pulse. The people and agents in the department
// files go about their processes, so the network is always busy and the SOC
// sees normal work (and honest false alarms) alongside any attack.

import { parseEvery, type EventBus, type Rng, type SimClock } from './core.ts';
import { defaultService, portScan, topPorts, tryLogin, webRequest, type Ctx } from './attack.ts';
import type { Endpoint, HostState, World } from './world.ts';
import type { ActivityDef, ProcessDef } from '../world/types.ts';

export class StaffBots {
  private readonly world: World;
  private readonly bus: EventBus;
  private readonly clock: SimClock;
  private readonly rng: Rng;
  /** "org/process" ids a guided floor runs on cue, so they never also run on their schedule. */
  private readonly held = new Set<string>();

  constructor(
    world: World,
    bus: EventBus,
    clock: SimClock,
    rng: Rng,
  ) {
    this.world = world;
    this.bus = bus;
    this.clock = clock;
    this.rng = rng;
  }

  /** Leave a process to a guided floor's script instead of its schedule. Call before start(). */
  hold(orgId: string, processId: string): void {
    this.held.add(`${orgId}/${processId}`);
  }

  /** Run a process once, now, the way its staff bot would. */
  async runNow(orgId: string, processId: string): Promise<boolean> {
    const process = this.world.orgs.get(orgId)?.resolved.processes.find((p) => p.id === processId);
    if (!process) {
      return false;
    }
    const ctx: Ctx = { world: this.world, bus: this.bus, clock: this.clock, rng: this.rng, actor: `bot:${process.id}` };
    for (const step of process.activity) {
      await this.perform(ctx, orgId, process, step);
    }
    return true;
  }

  start(): void {
    for (const org of this.world.orgs.values()) {
      for (const process of org.resolved.processes) {
        if (this.held.has(`${org.id}/${process.id}`)) {
          continue;
        }
        const interval = parseEvery(process.every);
        this.clock.at(this.rng.int(5_000, Math.max(10_000, interval)), () => void this.run(org.id, process, interval));
      }
    }
  }

  private async run(orgId: string, process: ProcessDef, interval: number): Promise<void> {
    if (this.clock.isStopped) {
      return;
    }
    this.clock.at(Math.round(this.rng.jitter(interval, 0.2)), () => void this.run(orgId, process, interval));
    if (process.hours === 'work' && !this.clock.isWorkHours()) {
      return;
    }
    const ctx: Ctx = { world: this.world, bus: this.bus, clock: this.clock, rng: this.rng, actor: `bot:${process.id}` };
    for (const step of process.activity) {
      await this.perform(ctx, orgId, process, step);
      await this.clock.sleep(this.rng.int(1_000, 6_000));
    }
  }

  private source(orgId: string, process: ProcessDef, step: ActivityDef, target: HostState): Endpoint {
    if (step.via === 'internet') {
      return this.world.endpointFor(this.world.publicAddress());
    }
    if (step.via) {
      const via = this.world.resolveSystem(orgId, step.via);
      if (via) {
        return this.world.endpointFor(via.ip);
      }
    }
    const person = this.world.orgs.get(orgId)?.resolved.people.find((p) => p.id === process.owner);
    if (person?.kind === 'agent') {
      const gateway = [...this.world.hosts.values()].find((h) => h.org === orgId && h.kind === 'ai');
      if (gateway && gateway.key !== target.key) {
        return this.world.endpointFor(gateway.ip);
      }
    }
    return this.world.endpointFor(target.ip);
  }

  private async perform(ctx: Ctx, orgId: string, process: ProcessDef, step: ActivityDef): Promise<void> {
    const target = this.world.resolveSystem(orgId, step.system);
    if (!target || target.status !== 'up') {
      return;
    }
    const from = this.source(orgId, process, step, target);
    const personId = step.as ?? process.owner;
    const benign = { malicious: false, actor: ctx.actor };
    switch (step.action) {
      case 'login': {
        const account = step.account
          ? target.accounts.find((a) => a.user === step.account)
          : target.accounts.find((a) => a.person === personId);
        if (!account) {
          return;
        }
        const svc = account.service ?? defaultService(target);
        if (svc === 'login') {
          return;
        }
        if (step.typo && this.rng.chance(step.typo)) {
          tryLogin(ctx, from, target, svc, account.user, `${account.password}x`, { ...benign, tags: ['typo'] });
          await this.clock.sleep(this.rng.int(3_000, 9_000));
        }
        tryLogin(ctx, from, target, svc, account.user, account.password, benign);
        return;
      }
      case 'http': {
        const port = target.services.find((s) => [443, 80, 8080, 3000, 8888, 9000].includes(s.port))?.port;
        if (port !== undefined) {
          webRequest(ctx, from, target, port, step.path ?? '/', { ...benign, agent: process.owner.includes('agent') ? 'dq-agent/1.0' : 'Mozilla/5.0' });
        }
        return;
      }
      case 'file': {
        const account = target.accounts.find((a) => a.person === personId);
        this.bus.emit({
          kind: 'file.read',
          actor: ctx.actor,
          org: target.org,
          host: target.key,
          user: account?.user ?? personId,
          path: step.path ?? '/',
          summary: `${account?.user ?? personId} opened ${step.path ?? 'a file'}`,
        });
        return;
      }
      case 'mail': {
        const mail = this.world.mailServer(orgId);
        if (mail) {
          this.bus.emit({
            kind: 'mail.received',
            actor: ctx.actor,
            org: orgId,
            src: this.world.publicAddress(),
            dst: mail.ip,
            dstPort: 25,
            host: mail.key,
            user: personId,
            summary: `Mail delivered to ${personId}`,
          });
        }
        return;
      }
      case 'scan': {
        await portScan(ctx, from, target.ip, topPorts(100), { timing: 4, malicious: false, actor: ctx.actor });
        return;
      }
      case 'query': {
        const port = target.services[0]?.port;
        if (port !== undefined && this.world.reach(from, target, port) === 'ok') {
          this.bus.emit({
            kind: 'net.connect',
            actor: ctx.actor,
            org: target.org,
            src: from.ip,
            dst: target.ip,
            dstPort: port,
            tags: ['query'],
            summary: `${from.ip} polled ${target.hostname}:${port}`,
          });
        }
        return;
      }
      case 'transfer': {
        const port = target.services[0]?.port ?? 0;
        if (this.world.reach(from, target, port) === 'ok') {
          this.bus.emit({
            kind: 'data.transfer',
            actor: ctx.actor,
            org: target.org,
            src: from.ip,
            dst: target.ip,
            dstPort: port,
            host: target.key,
            bytes: step.bytes ?? 1_000_000,
            summary: `${((step.bytes ?? 1_000_000) / 1_000_000).toFixed(0)} MB from ${from.ip} to ${target.hostname}`,
          });
        }
        return;
      }
    }
  }
}

// ---------------------------------------------------------------- business

export interface OrgBusiness {
  org: string;
  /** 0 to 100. */
  health: number;
  lostRands: number;
  downtimeLost: number;
  leaked: { key: string; name: string; impact: number; personal: boolean; fraction: number; at: number }[];
  criticalDown: string[];
  /** Share (0 to 1) of clients and suppliers the perimeter blocks shut out. */
  publicBlocked: number;
}

/**
 * The business pulse: rands lost while critical systems are down or isolated,
 * plus the cost of every data set that leaks. Blocking everything stops the
 * business too, so the learner has to balance the two.
 */
/** Health points lost when the perimeter shuts out a share of the public. */
export function publicPenalty(share: number): number {
  return Math.round(60 * share);
}

export class Business {
  readonly state = new Map<string, OrgBusiness>();

  private readonly world: World;
  private readonly bus: EventBus;
  private readonly clock: SimClock;

  constructor(
    world: World,
    bus: EventBus,
    clock: SimClock,
  ) {
    this.world = world;
    this.bus = bus;
    this.clock = clock;
    for (const org of world.orgs.values()) {
      this.state.set(org.id, { org: org.id, health: 100, lostRands: 0, downtimeLost: 0, leaked: [], criticalDown: [], publicBlocked: 0 });
    }
  }

  start(): void {
    const tick = (): void => {
      this.tick(10);
      this.clock.at(10_000, tick);
    };
    this.clock.at(10_000, tick);
  }

  tick(seconds: number): void {
    for (const org of this.world.orgs.values()) {
      const s = this.state.get(org.id)!;
      const critical = [...this.world.hosts.values()].filter((h) => h.org === org.id && h.critical);
      const down = critical.filter((h) => h.status !== 'up');
      s.criticalDown = down.map((h) => h.key);
      const share = critical.length === 0 ? 0 : down.length / critical.length;
      // Blocking a whole range shuts out clients and suppliers too: work stops coming in.
      s.publicBlocked = this.world.publicBlocked(org.id);
      const lost = (org.revenuePerHour * (share + s.publicBlocked * 0.5) * seconds) / 3600;
      s.downtimeLost += lost;
      s.lostRands += lost;
      const leakPenalty = Math.min(60, s.leaked.reduce((sum, l) => sum + l.impact, 0) / 100_000);
      const compromised = [...this.world.hosts.values()].filter((h) => h.org === org.id && h.compromise).length;
      s.health = Math.max(0, Math.round(100 * (1 - share * 0.8) - leakPenalty - Math.min(20, compromised * 3) - publicPenalty(s.publicBlocked)));
    }
  }

  /** Record data leaving. A cut-off transfer leaks a fraction of the set. */
  leak(dataKey: string, by: string, fraction = 1): void {
    const data = this.world.dataByKey(dataKey);
    if (!data) {
      return;
    }
    const s = this.state.get(data.host.org)!;
    const share = Math.min(1, Math.max(0, fraction));
    const existing = s.leaked.find((l) => l.key === dataKey);
    if (existing && existing.fraction >= share) {
      return;
    }
    const impact = Math.round(data.impact * share);
    if (existing) {
      s.lostRands += impact - existing.impact;
      existing.impact = impact;
      existing.fraction = share;
    } else {
      s.leaked.push({ key: dataKey, name: data.name, impact, personal: data.personalInformation, fraction: share, at: this.clock.now });
      s.lostRands += impact;
    }
    this.tick(0);
    const part = share < 1 ? ` (about ${Math.round(share * 100)}% of it)` : '';
    this.bus.emit({
      kind: 'data.leaked',
      actor: 'system',
      malicious: true,
      org: data.host.org,
      host: data.host.key,
      summary: `${data.name} left the building${part} (${by})`,
      data: { data: dataKey, impact, fraction: share, personal: data.personalInformation },
    });
  }
}
