// The traffic monitor: a live graph of the requests reaching one web server,
// the internet line in front of it, and who is sending what. It plays a
// distributed denial of service in two layers. Junk packets fill the line
// until the internet provider's DDoS protection scrubs them; then a flood of
// real-looking requests to the most expensive page still outruns the server,
// until a per-address rate limit cuts every sender down to size. The limit is
// a sum: high enough for the biggest honest sender, low enough that every
// flooding address together stays under what the server can answer.
//
// While the line is full or the server is over capacity, the server counts as
// down: sales stop and the business bar falls.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome } from './tool.ts';
import type { LabEvent } from '../core.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';
import { inCidr } from '../../world/net.ts';

export interface SenderDef {
  name: string;
  /** One address, or `addresses` of them from the internet. */
  ip?: string;
  addresses?: number;
  /** Requests a second from each address. */
  rate: number;
  path: string;
}

export interface TrafficConfig {
  /** The web server under the flood. */
  system: string;
  /** Requests a second it can answer. */
  capacity: number;
  /** The internet line in front of it, Gbit/s. */
  line: number;
  honest: SenderDef[];
  /** Junk packets that fill the line until `control` is on. */
  junk: { addresses: number; gbps: number; control: string };
  /** Real-looking requests that get past the scrubbing. */
  flood: SenderDef;
  /** Somebody using the noise as cover. */
  sneak?: SenderDef & { status: number };
  /** Minutes the flood has run when the round begins. */
  since: number;
}

interface Point {
  t: number;
  honest: number;
  flood: number;
  answered: number;
  full: boolean;
}

const TICK = 5_000;

/** 2 800, the way the rest of the lab writes numbers. */
const n = (x: number): string => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

class TrafficMonitor extends Tool<TrafficConfig> {
  readonly id = 'traffic';
  private limit: number | null = null;
  private series: Point[] = [];
  private started = 0;

  private get hostKey(): string {
    return `${this.parts.org}/${this.config.system}`;
  }

  private get scrubbed(): boolean {
    return this.parts.world.isControlOn(this.parts.org, this.config.junk.control);
  }

  /** What each sender gets through, after the limit and any block. */
  private through(sender: SenderDef): number {
    const per = this.limit === null ? sender.rate : Math.min(sender.rate, this.limit);
    if (sender.ip && this.parts.world.isBlocked(sender.ip, this.parts.org)) return 0;
    return per * (sender.addresses ?? 1);
  }

  private load(): { honest: number; flood: number; full: boolean; over: boolean } {
    const honest = this.config.honest.reduce((sum, s) => sum + this.through(s), 0);
    const flood = this.through(this.config.flood);
    const full = !this.scrubbed;
    return { honest, flood, full, over: full || honest + flood > this.config.capacity };
  }

  override start(): void {
    this.started = this.parts.clock.now;
    // The graph starts with the minutes before the round: quiet, then the flood.
    const before = Math.round((this.config.since + 1) * 60_000 / TICK);
    const quiet = Math.round(60_000 / TICK);
    const honest = this.config.honest.reduce((sum, s) => sum + s.rate * (s.addresses ?? 1), 0);
    const flood = this.config.flood.rate * (this.config.flood.addresses ?? 1);
    for (let i = before; i > 0; i--) {
      const calm = i > before - quiet;
      this.series.push({ t: this.started - i * TICK, honest, flood: calm ? 0 : flood, answered: calm ? honest : 0, full: !calm });
    }
    this.tick();
  }

  private tick(): void {
    const { honest, flood, full, over } = this.load();
    const answered = full ? 0 : Math.min(this.config.capacity, honest + flood);
    this.series.push({ t: this.parts.clock.now, honest, flood, answered, full });
    if (this.series.length > 72) this.series.shift();
    this.setHost(over);
    this.parts.clock.at(TICK, () => this.tick());
  }

  private setHost(over: boolean): void {
    const host = this.parts.world.hosts.get(this.hostKey);
    if (!host || host.status === 'isolated') return;
    const was = host.status;
    host.status = over ? 'down' : 'up';
    if (was === host.status) return;
    this.emit({
      kind: over ? 'host.down' : 'host.restored',
      host: this.hostKey,
      summary: over ? `${host.name} overloaded: it stops answering` : `${host.name} answers again`,
      data: { tool: this.id },
    });
  }

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op !== 'limit') return { ok: false, message: 'The traffic monitor cannot do that.' };
    const rate = this.int(args, 'rate');
    if (rate === null || rate < 1 || rate > 10_000) return { ok: false, message: 'Give the limit in whole requests a second, 1 or more.' };
    this.limit = rate;
    const { honest, flood, full, over } = this.load();
    this.setHost(over);
    this.emit({ kind: 'tool.update', host: this.hostKey, summary: `Rate limit ${rate} a second per address`, data: { tool: this.id } });
    const message = `Set a limit of ${rate} requests a second per address on the ${this.config.system} gateway`;
    const biggest = [...this.config.honest].sort((a, b) => b.rate - a.rate)[0]!;
    const count = this.config.flood.addresses ?? 1;
    const honestFull = this.config.honest.reduce((sum, s) => sum + s.rate * (s.addresses ?? 1), 0);
    if (rate < biggest.rate) {
      return { ok: true, message, target: 'limit', correct: false, reply: `${biggest.name} sends ${biggest.rate} a second from one address, honestly, and that limit cuts it off. Keep the limit at ${biggest.rate} or more.` };
    }
    if (full) {
      return { ok: true, message, target: 'limit', correct: false, reply: 'The line itself is still full of junk, so nothing reaches the limit. Get the junk scrubbed first.' };
    }
    if (over) {
      return {
        ok: true,
        message,
        target: 'limit',
        correct: false,
        reply: `Still over: ${count} × ${Math.min(rate, this.config.flood.rate)} + ${n(honestFull)} = ${n(flood + honest)} a second, and it answers ${n(this.config.capacity)}. Lower it.`,
      };
    }
    return {
      ok: true,
      message,
      target: 'limit',
      correct: true,
      reply: `${count} × ${Math.min(rate, this.config.flood.rate)} + ${n(honestFull)} = ${n(flood + honest)} a second, under the ${n(this.config.capacity)} it can answer. Every honest sender fits under ${rate}.`,
    };
  }

  view(): unknown {
    const clock = this.parts.clock;
    const { honest, flood, full, over } = this.load();
    const host = this.parts.world.hosts.get(this.hostKey);
    const sneak = this.config.sneak;
    const sneaking = sneak && !this.parts.world.isBlocked(sneak.ip ?? '', this.parts.org);
    const senders = [
      ...this.config.honest.map((s) => ({ ...s, kind: 'honest' as const })),
      { ...this.config.flood, kind: 'flood' as const },
      ...(sneak ? [{ ...sneak, kind: 'sneak' as const }] : []),
    ];
    return {
      system: host?.name ?? this.config.system,
      ip: host?.ip ?? '',
      capacity: this.config.capacity,
      line: { size: this.config.line, junk: full ? this.config.junk.gbps : 0, addresses: this.config.junk.addresses },
      scrubbed: !full,
      limit: this.limit,
      status: full ? 'full' : over ? 'over' : 'ok',
      now: { honest, flood, answered: full ? 0 : Math.min(this.config.capacity, honest + flood) },
      since: clock.clockText(this.started - this.config.since * 60_000),
      series: this.series.map((p) => ({ at: clock.clockText(p.t), honest: p.honest, flood: p.flood, answered: p.answered, full: p.full })),
      // Who sends what, busiest first: what the server's access log adds up to.
      senders: senders
        .map((s) => {
          const blocked = !!s.ip && this.parts.world.isBlocked(s.ip, this.parts.org);
          const each = blocked ? 0 : this.limit === null ? s.rate : Math.min(s.rate, this.limit);
          return { name: s.kind === 'honest' ? s.name : null, ip: s.ip ?? null, addresses: s.addresses ?? 1, each, total: each * (s.addresses ?? 1), path: s.path, blocked };
        })
        .sort((a, b) => b.total - a.total),
      paths: [
        ...new Map(
          senders.map((s) => {
            const status = s.kind === 'sneak' ? (sneaking ? (sneak!.status) : 0) : full || over ? 503 : 200;
            return [s.path, { path: s.path, status }];
          }),
        ).values(),
      ].map((p) => ({ ...p, rate: senders.filter((s) => s.path === p.path).reduce((sum, s) => sum + (s.kind === 'sneak' && !sneaking ? 0 : this.through(s)), 0) })),
    };
  }

  override observe(event: LabEvent): void {
    if (event.kind === 'control.change' && event.data?.control === this.config.junk.control) {
      const { over } = this.load();
      this.setHost(over);
    }
  }
}

function validate(config: TrafficConfig, check: ToolCheck): void {
  const { add, bundleOrg, internet } = check;
  if (!bundleOrg.systems.some((s) => s.id === config?.system)) add(`traffic: no system ${config?.system}`);
  if (!(config?.capacity > 0) || !(config?.line > 0)) add('traffic: needs a capacity and a line size');
  if (!Array.isArray(config?.honest) || config.honest.length === 0) add('traffic: needs honest senders');
  // The control may come from a later level, brought in by the practical's controls.
  const control = config?.junk?.control;
  if (!bundleOrg.controls.some((c) => c.id === control) && check.practical.controls?.[control] === undefined) add(`traffic: no control ${control}`);
  for (const s of [...(config?.honest ?? []), config?.flood, config?.sneak].filter((x): x is SenderDef => !!x)) {
    if (!s.path || !(s.rate > 0)) add(`traffic sender ${s.name}: needs a path and a rate`);
    if (s.ip && !inCidr(s.ip, internet)) add(`traffic sender ${s.name}: ${s.ip} is not on the internet (${internet})`);
  }
}

function ops(_config: TrafficConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  return { limit: new Set(['limit']) };
}

export const trafficTool: ToolModule<TrafficConfig> = {
  create: (config, parts) => new TrafficMonitor(config, parts),
  validate,
  ops,
};
