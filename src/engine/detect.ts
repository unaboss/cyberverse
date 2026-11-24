// Sensors and detection rules. An event only becomes an alert when a sensor
// can see it and a switched-on rule matches it. Anything else is a blind spot,
// which the debrief shows afterwards.

import type { EventBus, LabEvent } from './core.ts';
import type { World } from './world.ts';
import type { EventKey, RuleDef, SensorType, Severity } from '../world/types.ts';

export interface Alert {
  id: number;
  t: number;
  /** Last time evidence was added. */
  updated: number;
  org: string;
  rule: string;
  name: string;
  severity: Severity;
  attack: string;
  sensor: SensorType;
  host?: string;
  src?: string;
  dst?: string;
  user?: string;
  summary: string;
  response: string;
  count: number;
  evidence: number[];
  status: 'new' | 'acknowledged' | 'closed';
  verdict?: 'true-positive' | 'false-positive';
  /** Ground truth: did any evidence come from an attacker? Hidden during a round. */
  truth: boolean;
  groupKey: string;
  /** A practice alert a guided floor sent on purpose. */
  drill?: boolean;
}

const HOST_KINDS = new Set(['auth.fail', 'auth.success', 'proc.exec', 'file.read', 'file.write', 'account.change']);
const NET_KINDS = new Set(['net.probe', 'net.connect', 'exploit.attempt', 'data.transfer', 'ot.write', 'http.request']);

export interface Sighting {
  org: string;
  sensor: SensorType;
}

/** Which sensors in which organisations can see an event. */
export function sightings(world: World, event: LabEvent): Sighting[] {
  const out: Sighting[] = [];
  const seen = new Set<string>();
  const add = (org: string, sensor: SensorType): void => {
    const key = `${org}:${sensor}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ org, sensor });
    }
  };
  const host = event.host ? world.hosts.get(event.host) : undefined;

  // A decoy sees everything sent to it, and nothing legitimate is.
  const decoy = event.dst && NET_KINDS.has(event.kind) ? world.byIp.get(event.dst) : undefined;
  if (decoy?.kind === 'decoy') {
    add(decoy.org, 'decoy');
  }

  for (const sensor of world.sensors) {
    if (sensor.type === 'hids' && HOST_KINDS.has(event.kind) && host && host.org === sensor.org && sensor.covers.has(host.id)) {
      add(sensor.org, 'hids');
    }
    if (sensor.type === 'weblog' && event.kind === 'http.request' && host && host.org === sensor.org && sensor.covers.has(host.id)) {
      add(sensor.org, 'weblog');
    }
    if (sensor.type === 'mail' && event.kind.startsWith('mail.') && host && host.org === sensor.org && sensor.covers.has(host.id)) {
      add(sensor.org, 'mail');
    }
    if (sensor.type === 'nids' && NET_KINDS.has(event.kind)) {
      for (const ip of [event.src, event.dst]) {
        if (!ip) {
          continue;
        }
        const where = world.zoneOfIp(ip);
        if (where.org === sensor.org && sensor.covers.has(where.zone)) {
          add(sensor.org, 'nids');
        }
      }
    }
  }
  return out;
}

function keyOf(event: LabEvent, key: EventKey): string {
  const value = key === 'dstPort' ? event.dstPort : event[key];
  return value === undefined ? '-' : String(value);
}

export function ruleMatches(rule: RuleDef, event: LabEvent): boolean {
  const m = rule.match;
  if (m.kind !== event.kind) {
    return false;
  }
  if (m.service && m.service !== event.service) {
    return false;
  }
  if (m.outcome && m.outcome !== event.outcome) {
    return false;
  }
  if (m.tags && !m.tags.every((t) => event.tags.includes(t))) {
    return false;
  }
  if (m.minBytes && (event.bytes ?? 0) < m.minBytes) {
    return false;
  }
  return true;
}

interface Window {
  items: { t: number; id: number; distinct: string; malicious: boolean }[];
}

export class Detector {
  readonly alerts: Alert[] = [];
  private nextId = 1;
  private windows = new Map<string, Window>();
  private priors = new Map<string, { t: number }[]>();
  private lastRaised = new Map<string, Alert>();
  /** Event id -> alert ids it contributed to. */
  readonly explained = new Map<number, number[]>();

  private readonly world: World;
  private readonly bus: EventBus;

  constructor(
    world: World,
    bus: EventBus,
  ) {
    this.world = world;
    this.bus = bus;
    bus.on((event) => this.observe(event));
  }

  private observe(event: LabEvent): void {
    if (event.kind.startsWith('alert.') || event.actor === 'sensor') {
      return;
    }
    const seen = sightings(this.world, event);
    if (seen.length === 0) {
      return;
    }
    for (const sighting of seen) {
      for (const rule of this.world.rules.values()) {
        if (rule.sensor !== sighting.sensor || !this.world.ruleEnabled(sighting.org, rule.id)) {
          continue;
        }
        if (rule.after) {
          this.trackPrior(sighting.org, rule, event);
        }
        if (!ruleMatches(rule, event)) {
          continue;
        }
        this.evaluate(sighting.org, rule, event);
      }
    }
  }

  private trackPrior(org: string, rule: RuleDef, event: LabEvent): void {
    const after = rule.after!;
    if (event.kind !== after.kind) {
      return;
    }
    const key = `${org}:${rule.id}:${after.sameKeys.map((k) => keyOf(event, k)).join('|')}`;
    const list = this.priors.get(key) ?? [];
    list.push({ t: event.t });
    this.priors.set(key, list.filter((p) => event.t - p.t <= after.withinSec * 1000));
  }

  private evaluate(org: string, rule: RuleDef, event: LabEvent): void {
    if (rule.after) {
      const key = `${org}:${rule.id}:${rule.after.sameKeys.map((k) => keyOf(event, k)).join('|')}`;
      const prior = (this.priors.get(key) ?? []).filter((p) => event.t - p.t <= rule.after!.withinSec * 1000);
      if (prior.length < rule.after.count) {
        return;
      }
      // Those failures are explained now. One more typo later must not raise the
      // same alert again on the strength of failures somebody already looked at.
      this.priors.delete(key);
    }
    const groupKeys: EventKey[] = rule.threshold?.groupBy ?? ['src', 'host'];
    const group = groupKeys.map((k) => keyOf(event, k)).join('|');
    const windowKey = `${org}:${rule.id}:${group}`;

    if (rule.threshold) {
      const window = this.windows.get(windowKey) ?? { items: [] };
      const distinct = rule.threshold.distinct ? keyOf(event, rule.threshold.distinct) : String(event.id);
      window.items.push({ t: event.t, id: event.id, distinct, malicious: event.malicious });
      window.items = window.items.filter((i) => event.t - i.t <= rule.threshold!.withinSec * 1000);
      this.windows.set(windowKey, window);
      const count = new Set(window.items.map((i) => i.distinct)).size;
      if (count < rule.threshold.count) {
        return;
      }
      this.raise(org, rule, event, windowKey, window.items.map((i) => i.id), window.items.some((i) => i.malicious), count);
      return;
    }
    this.raise(org, rule, event, windowKey, [event.id], event.malicious, 1);
  }

  private raise(org: string, rule: RuleDef, event: LabEvent, groupKey: string, evidence: number[], malicious: boolean, count: number): void {
    const last = this.lastRaised.get(groupKey);
    const cooldown = (rule.cooldownSec ?? 60) * 1000;
    if (last && event.t - last.updated < cooldown) {
      const fresh = evidence.filter((id) => !last.evidence.includes(id));
      if (fresh.length === 0) {
        return;
      }
      last.evidence.push(...fresh);
      last.count += fresh.length;
      last.updated = event.t;
      last.truth = last.truth || malicious;
      for (const id of fresh) {
        this.explain(id, last.id);
      }
      this.bus.emit({
        kind: 'alert.updated',
        actor: 'sensor',
        org,
        summary: `${rule.name} (${last.count})`,
        data: { alert: last.id },
      });
      return;
    }
    const alert: Alert = {
      id: this.nextId++,
      t: event.t,
      updated: event.t,
      org,
      rule: rule.id,
      name: rule.name,
      severity: rule.severity,
      attack: rule.attack,
      sensor: rule.sensor,
      ...(event.host ? { host: event.host } : {}),
      ...(event.src ? { src: event.src } : {}),
      ...(event.dst ? { dst: event.dst } : {}),
      ...(event.user ? { user: event.user } : {}),
      summary: this.describe(rule, event, count),
      response: rule.response,
      count,
      evidence: [...evidence],
      status: 'new',
      truth: malicious,
      groupKey,
    };
    this.alerts.push(alert);
    this.lastRaised.set(groupKey, alert);
    for (const id of evidence) {
      this.explain(id, alert.id);
    }
    this.bus.emit({
      kind: 'alert.raised',
      actor: 'sensor',
      org,
      ...(event.host ? { host: event.host } : {}),
      summary: alert.summary,
      data: { alert: alert.id, severity: alert.severity },
    });
  }

  private explain(eventId: number, alertId: number): void {
    const list = this.explained.get(eventId) ?? [];
    list.push(alertId);
    this.explained.set(eventId, list);
  }

  private describe(rule: RuleDef, event: LabEvent, count: number): string {
    const host = event.host ? this.world.hosts.get(event.host) : undefined;
    if (host && event.src === host.ip && event.dst) {
      // Traffic leaving one of our machines: name the machine, then where it went.
      const dst = this.world.byIp.get(event.dst)?.fqdn ?? event.dst;
      return `${rule.name}: ${host.fqdn} -> ${dst}${count > 1 ? ` (${count} events)` : ''}`;
    }
    const sweep = rule.threshold?.distinct === 'dst' || rule.threshold?.distinct === 'user';
    const target = sweep
      ? rule.threshold?.distinct === 'user' ? `${count} accounts` : `${count} addresses`
      : host ? host.fqdn : event.dst ? (this.world.byIp.get(event.dst)?.fqdn ?? event.dst) : 'the network';
    const source = event.src ?? 'an unknown source';
    const times = count > 1 && !sweep ? ` (${count} events)` : '';
    return `${rule.name}: ${source} -> ${target}${event.user ? ` as ${event.user}` : ''}${times}`;
  }

  /** A practice alert, sent on purpose by a guided floor. It is never real. */
  drill(org: string, t: number, input: { host: string; name: string; severity: Severity; summary: string; response: string }): Alert {
    const host = this.world.hosts.get(input.host);
    const alert: Alert = {
      id: this.nextId++,
      t,
      updated: t,
      org,
      rule: 'drill',
      name: input.name,
      severity: input.severity,
      attack: '-',
      sensor: 'hids',
      host: input.host,
      ...(host ? { dst: host.ip } : {}),
      summary: input.summary,
      response: input.response,
      count: 1,
      evidence: [],
      status: 'new',
      truth: false,
      groupKey: `${org}:drill:${t}`,
      drill: true,
    };
    this.alerts.push(alert);
    this.bus.emit({ kind: 'alert.raised', actor: 'sensor', org, host: input.host, summary: alert.summary, data: { alert: alert.id, severity: alert.severity, drill: true } });
    return alert;
  }

  get(id: number): Alert | undefined {
    return this.alerts.find((a) => a.id === id);
  }
}
