// What the learner is allowed to see. The browser only ever gets this
// projection, never the raw world: on a prey round the map shows only what the
// sensors detected, and on a predator round it shows only what recon found.

import type { LabEvent } from './core.ts';
import { sightings, type Alert } from './detect.ts';
import type { Session } from './session.ts';
import type { HostState, World } from './world.ts';
import { buildDebrief, type Debrief } from './score.ts';
import { publicPenalty } from './staff.ts';
import type { GuideView } from './guide.ts';
import type { MapDef } from '../world/types.ts';

export interface HostView {
  key: string;
  name: string;
  hostname: string;
  fqdn: string;
  ip: string;
  kind: string;
  os?: string;
  zone?: string;
  critical?: boolean;
  status?: string;
  ports: { port: number; name?: string; product?: string; version?: string }[];
  logAgent?: boolean;
  /** What the asset register says the machine holds (prey only). */
  data?: { name: string; sensitivity: string; personal: boolean; records?: number }[];
  /** The organisation's regular jobs that run from or against this machine (prey only). */
  jobs?: string[];
  alerts?: number;
  owned?: boolean;
}

export interface DeptView {
  id: string;
  name: string;
  room: { x: number; y: number; w: number; h: number };
  /** False when nobody works there yet at this level. */
  staffed: boolean;
  /** False while hidden by fog of war. */
  revealed: boolean;
  people: { name: string; role: string; kind: string }[];
  hosts: HostView[];
}

export interface OrgView {
  id: string;
  name: string;
  domain: string;
  level: number;
  colour: string;
  floor: { width: number; height: number };
  zones: { id: string; name: string; cidr: string }[];
  /** The buildings and places the map groups the rooms into, or null for one building. */
  sites: { id: string; name: string; kind: string; rooms: string[]; shift: { x: number; y: number } }[] | null;
  /** The room the security team (and so the learner) sits in. */
  home: string | null;
  departments: DeptView[];
}

export interface AlertView {
  id: number;
  t: number;
  clock: string;
  rule: string;
  name: string;
  severity: string;
  attack: string;
  sensor: string;
  host?: string;
  room?: string;
  src?: string;
  /** The machine of ours the alert's traffic came from, when it came from one. */
  srcHost?: string;
  dst?: string;
  user?: string;
  summary: string;
  response: string;
  count: number;
  status: string;
  verdict?: string;
  /** A practice alert from a guided floor. */
  drill?: boolean;
}

export interface ClientState {
  session: string;
  role: 'prey' | 'predator';
  status: string;
  practical: { id: string; title: string; briefing: string; status: string; durationMin: number; qcto: string[]; map: MapDef | null };
  clock: { text: string; elapsedMs: number; remainingMs: number; speed: number; timed: boolean };
  org: OrgView;
  business: { health: number; lostRands: number; criticalDown: string[] } | null;
  alerts: AlertView[];
  controls: { id: string; name: string; kind: string; on: boolean; project: boolean; description: string }[];
  blocks: string[];
  /** For each block, the connection attempts it has stopped. */
  stopped: Record<string, number>;
  terminal: { prompt: string; ip: string; loot: { user: string; password: string; host: string; source: string }[]; sessions: { id: number; host: string; level: string }[] } | null;
  end: { reason: string } | null;
  debrief: Debrief | null;
  guide: GuideView | null;
  /** The floor's desk tools, by id, each with its window's title and what it shows. */
  tools: Record<string, unknown> | null;
  /** True while the clock is skipping ahead on a guided floor. */
  fast: boolean;
}

function hidsCovers(world: World, host: HostState): boolean {
  return world.sensors.some((s) => s.org === host.org && s.type === 'hids' && s.covers.has(host.id));
}

const VERBS: Record<string, string> = {
  login: 'logs in to',
  http: 'visits',
  file: 'opens files on',
  mail: 'sends mail through',
  scan: 'scans',
  query: 'polls',
  transfer: 'copies data to',
};

function rhythm(every: string): string {
  return /^\d+[smhd]$/.test(every) ? `every ${every}` : every;
}

/**
 * The regular jobs that touch a machine, the way the operations manual lists
 * them: what runs, who runs it, how often, and what it does here.
 */
function hostJobs(world: World, orgId: string, host: HostState): string[] {
  const org = world.orgs.get(orgId);
  if (!org) {
    return [];
  }
  // "the Public website" reads oddly mid-sentence; "the CRM" must stay as it is.
  const named = (name: string): string => (/^[A-Z][a-z]/.test(name) ? name[0]!.toLowerCase() + name.slice(1) : name);
  const jobs: string[] = [];
  for (const process of org.resolved.processes) {
    const owner = org.resolved.people.find((p) => p.id === process.owner)?.name ?? process.owner;
    const lead = `${process.name} (${owner}, ${rhythm(process.cadence ?? process.every)})`;
    for (const step of process.activity) {
      const target = world.resolveSystem(orgId, step.system);
      const via = step.via && step.via !== 'internet' ? world.resolveSystem(orgId, step.via) : undefined;
      const verb = VERBS[step.action] ?? step.action;
      if (via?.key === host.key && target) {
        jobs.push(`${lead}: from here, ${verb} the ${named(target.name)}.`);
      } else if (target?.key === host.key) {
        jobs.push(`${lead}: ${verb} this machine${via ? ` from the ${named(via.name)}` : ''}.`);
      }
    }
  }
  return [...new Set(jobs)];
}

function alertView(session: Session, alert: Alert): AlertView {
  const host = alert.host ? session.world.hosts.get(alert.host) : alert.dst ? session.world.byIp.get(alert.dst) : undefined;
  const srcHost = alert.src ? session.world.byIp.get(alert.src) : undefined;
  return {
    id: alert.id,
    t: alert.t,
    clock: session.clock.clockText(alert.t),
    rule: alert.rule,
    name: alert.name,
    severity: alert.severity,
    attack: alert.attack,
    sensor: alert.sensor,
    ...(host ? { host: host.key, room: host.dept } : {}),
    ...(alert.src ? { src: alert.src } : {}),
    ...(srcHost && srcHost.org === alert.org ? { srcHost: srcHost.key } : {}),
    ...(alert.dst ? { dst: alert.dst } : {}),
    ...(alert.user ? { user: alert.user } : {}),
    summary: alert.summary,
    response: alert.response,
    count: alert.count,
    status: alert.status,
    ...(alert.verdict ? { verdict: alert.verdict } : {}),
    ...(alert.drill ? { drill: true } : {}),
  };
}

function orgView(session: Session): OrgView {
  const { world, practical } = session;
  const org = world.orgs.get(practical.org)!;
  const predator = practical.role === 'predator';
  const discovered = session.terminal?.discovered ?? new Map();
  const owned = new Set((session.terminal?.sessions ?? []).map((s) => s.host));
  const alertsByHost = new Map<string, number>();
  for (const a of session.detector.alerts) {
    if (a.org === org.id && a.host && a.status !== 'closed') {
      alertsByHost.set(a.host, (alertsByHost.get(a.host) ?? 0) + 1);
    }
  }
  const departments: DeptView[] = org.resolved.departments.map((dept) => {
    const hosts = [...world.hosts.values()].filter((h) => h.org === org.id && h.dept === dept.id);
    const visibleHosts = predator ? hosts.filter((h) => discovered.has(h.key)) : hosts;
    return {
      id: dept.id,
      name: predator && visibleHosts.length === 0 ? 'Unknown' : dept.name,
      room: dept.room,
      staffed: dept.staffed,
      revealed: !predator || visibleHosts.length > 0,
      people: predator ? [] : dept.people.map((p) => ({ name: p.name, role: p.role, kind: p.kind })),
      hosts: visibleHosts.map((h) =>
        predator
          ? {
              key: h.key,
              name: owned.has(h.key) ? h.name : h.fqdn,
              hostname: h.hostname,
              fqdn: h.fqdn,
              ip: h.ip,
              kind: owned.has(h.key) ? h.kind : 'unknown',
              ports: (discovered.get(h.key) ?? []).map((p: { port: number; name?: string; product?: string; version?: string }) => ({ port: p.port, ...(p.name ? { name: p.name } : {}), ...(p.product ? { product: p.product } : {}), ...(p.version ? { version: p.version } : {}) })),
              owned: owned.has(h.key) && h.status === 'up' && !!h.compromise,
            }
          : {
              key: h.key,
              name: h.name,
              hostname: h.hostname,
              fqdn: h.fqdn,
              ip: h.ip,
              kind: h.kind,
              os: h.os,
              zone: h.zone,
              critical: h.critical,
              status: h.status,
              ports: h.services.map((s) => ({ port: s.port, name: s.name, product: s.product, version: s.version })),
              logAgent: hidsCovers(world, h),
              data: h.data.map((d) => ({ name: d.name, sensitivity: d.sensitivity, personal: d.personalInformation === true, ...(d.records ? { records: d.records } : {}) })),
              jobs: hostJobs(world, org.id, h),
              alerts: alertsByHost.get(h.key) ?? 0,
            },
      ),
    };
  });
  return {
    id: org.id,
    name: org.name,
    domain: org.domain,
    level: org.level,
    colour: org.colour,
    floor: org.resolved.def.floor,
    zones: org.resolved.zones.map((z) => ({ id: z.id, name: z.name, cidr: z.cidr })),
    home: org.resolved.def.home ?? null,
    sites: org.resolved.def.sites?.map((site) => ({ id: site.id, name: site.name, kind: site.kind ?? 'building', rooms: site.rooms, shift: site.shift ?? { x: 0, y: 0 } })) ?? null,
    departments,
  };
}

export function snapshot(session: Session): ClientState {
  const { practical, clock, world } = session;
  const prey = practical.role === 'prey';
  const business = session.business.state.get(practical.org)!;
  const org = world.orgs.get(practical.org)!;
  const ended = session.status === 'ended';
  // During a prey round a leak is not visible: nobody knows yet. Downtime is.
  const health = prey && !ended ? Math.max(0, Math.round(100 * (1 - (business.criticalDown.length / Math.max(1, [...world.hosts.values()].filter((h) => h.org === org.id && h.critical).length)) * 0.8)) - publicPenalty(world.publicBlocked(org.id))) : business.health;
  return {
    session: session.id,
    role: practical.role,
    status: session.status,
    practical: { id: practical.id, title: practical.title, briefing: practical.briefing, status: practical.status, durationMin: practical.durationMin, qcto: practical.qcto, map: practical.map ?? null },
    clock: { text: clock.clockText(), elapsedMs: clock.now, remainingMs: session.remainingMs, speed: session.speed, timed: session.timed },
    org: orgView(session),
    business: prey || ended ? { health, lostRands: Math.round(prey && !ended ? business.downtimeLost : business.lostRands), criticalDown: business.criticalDown } : null,
    alerts: prey ? session.detector.alerts.filter((a) => a.org === org.id).map((a) => alertView(session, a)) : [],
    controls: prey ? [...org.controls.values()].map((c) => ({ id: c.id, name: c.name, kind: c.kind, on: org.controlOn.get(c.id) ?? false, project: org.projects.has(c.id), description: c.description })) : [],
    blocks: prey ? world.blocks.filter((b) => b.org === org.id).map((b) => b.src) : [],
    stopped: prey ? Object.fromEntries(world.blocks.filter((b) => b.org === org.id).map((b) => [b.src, b.stopped])) : {},
    terminal: session.terminal
      ? {
          prompt: session.terminal.prompt,
          ip: session.terminal.ip,
          loot: session.terminal.loot,
          sessions: session.terminal.sessions.map((s) => ({ id: s.id, host: s.host, level: s.level })),
        }
      : null,
    end: session.end ? { reason: session.end.reason } : null,
    debrief: ended ? buildDebrief(session) : null,
    guide: session.guide?.view() ?? null,
    tools: prey ? (session.tools?.view() ?? null) : null,
    fast: session.fast,
  };
}

// --------------------------------------------------------------- the stream

export type ClientEvent =
  | { type: 'alert'; alert: AlertView; fresh: boolean }
  | { type: 'flow'; from: string; to: string; sensor: string; hostile: boolean }
  | { type: 'action'; text: string; actor: string; host?: string }
  | { type: 'terminal'; text: string }
  | { type: 'discovered'; host: string }
  | { type: 'round'; status: string; reason?: string }
  | { type: 'host'; host: string; status: string }
  | { type: 'guide' }
  | { type: 'tool' };

const FLOW_KINDS = new Set(['net.probe', 'net.connect', 'http.request', 'exploit.attempt', 'data.transfer', 'auth.fail', 'auth.success', 'mail.received']);

export class StreamFilter {
  private lastFlow = new Map<string, number>();
  private lastUpdate = new Map<number, number>();

  private readonly session: Session;

  constructor(session: Session) {
    this.session = session;
  }

  map(event: LabEvent): ClientEvent | null {
    const { session } = this;
    const prey = session.practical.role === 'prey';
    const org = session.practical.org;
    switch (event.kind) {
      case 'round.start':
        return { type: 'round', status: 'live' };
      case 'round.end':
        return { type: 'round', status: 'ended', reason: String(event.data?.reason ?? '') };
      case 'terminal.output':
        return prey ? null : { type: 'terminal', text: String(event.data?.text ?? '') };
      case 'terminal.discovered':
        return prey ? null : { type: 'discovered', host: event.summary };
      case 'guide.step':
      case 'guide.ready':
      case 'guide.done':
      case 'guide.sorted':
      case 'guide.complete':
        return { type: 'guide' };
      case 'guide.answer':
        return null;
      case 'tool.update':
        return prey ? { type: 'tool' } : null;
      case 'alert.raised':
      case 'alert.updated': {
        if (!prey || event.org !== org) {
          return null;
        }
        const alert = session.detector.get(Number(event.data?.alert));
        if (!alert) {
          return null;
        }
        // A noisy alert updates on every matching packet; the queue only needs a refresh now and then.
        if (event.kind === 'alert.updated') {
          const last = this.lastUpdate.get(alert.id) ?? -Infinity;
          if (event.t - last < 3000) {
            return null;
          }
          this.lastUpdate.set(alert.id, event.t);
        }
        return { type: 'alert', alert: alertView(session, alert), fresh: event.kind === 'alert.raised' };
      }
      case 'host.isolate':
      case 'host.release':
      case 'host.rebuild':
      case 'host.restored':
      case 'host.down':
        return prey && event.org === org && event.host ? { type: 'host', host: event.host, status: session.world.hosts.get(event.host)?.status ?? 'up' } : null;
      default:
        break;
    }
    if (prey && event.org === org && event.actor === 'learner' && !event.kind.startsWith('alert')) {
      return { type: 'action', text: event.summary, actor: 'learner', ...(event.host ? { host: event.host } : {}) };
    }
    if (prey && FLOW_KINDS.has(event.kind)) {
      return this.flow(event);
    }
    return null;
  }

  /** Traffic the sensors saw, as a room-to-room spark on the map. */
  private flow(event: LabEvent): ClientEvent | null {
    const { world, practical } = this.session;
    const seen = sightings(world, event).filter((s) => s.org === practical.org);
    if (seen.length === 0) {
      return null;
    }
    const roomOf = (ip: string | undefined): string => {
      if (!ip) return 'internet';
      const host = world.byIp.get(ip);
      if (host && host.org === practical.org) return host.dept;
      if (host) return 'partner';
      return 'internet';
    };
    const from = roomOf(event.src);
    const to = event.host && world.hosts.get(event.host)?.org === practical.org ? world.hosts.get(event.host)!.dept : roomOf(event.dst);
    if (from === to) {
      return null;
    }
    const key = `${from}>${to}`;
    const last = this.lastFlow.get(key) ?? -Infinity;
    if (event.t - last < 1500) {
      return null;
    }
    this.lastFlow.set(key, event.t);
    return { type: 'flow', from, to, sensor: seen[0]!.sensor, hostile: from === 'internet' && event.kind !== 'http.request' };
  }
}

// --------------------------------------------------------------- host logs

/** The log lines a host's sensors captured, formatted like the real thing. */
export function hostLogs(session: Session, hostKey: string, limit = 150): string[] {
  const { world, bus, clock } = session;
  const host = world.hosts.get(hostKey);
  if (!host || session.practical.role !== 'prey' || host.org !== session.practical.org) {
    return [];
  }
  const lines: string[] = [];
  for (const e of bus.events) {
    if (e.host !== hostKey && e.dst !== host.ip) {
      continue;
    }
    const seen = sightings(world, e).filter((s) => s.org === host.org);
    if (seen.length === 0) {
      continue;
    }
    const line = formatLog(session, host, e, seen.map((s) => s.sensor));
    if (line) {
      lines.push(line);
    }
  }
  void clock;
  return lines.slice(-limit);
}

function formatLog(session: Session, host: HostState, e: LabEvent, sensors: string[]): string | null {
  const c = session.clock;
  const pid = 1000 + (e.id % 8000);
  const port = 40000 + (e.id % 20000);
  if (sensors.includes('hids') || sensors.includes('mail')) {
    switch (e.kind) {
      case 'auth.fail':
        if (e.service === 'ssh') {
          return `${c.syslogStamp(e.t)} ${host.hostname} sshd[${pid}]: Failed password for ${e.tags.includes('invalid-user') ? 'invalid user ' : ''}${e.user} from ${e.src} port ${port} ssh2`;
        }
        if (e.service === 'smb') {
          return `${c.syslogStamp(e.t)} ${host.hostname} samba[${pid}]: Auth: [SMB2,(null)] user [${session.world.orgs.get(host.org)?.domain.split('.')[0]?.toUpperCase()}]\\[${e.user}] status [${e.tags.includes('locked') ? 'NT_STATUS_ACCOUNT_LOCKED_OUT' : 'NT_STATUS_WRONG_PASSWORD'}] remote host [ipv4:${e.src}:${port}]`;
        }
        return `${c.syslogStamp(e.t)} ${host.hostname} auth[${pid}]: login failed for ${e.user} from ${e.src} (${e.service})${e.tags.includes('mfa') ? ' second factor not completed' : ''}${e.tags.includes('locked') ? ' account locked' : ''}`;
      case 'auth.success':
        if (e.service === 'ssh') {
          return `${c.syslogStamp(e.t)} ${host.hostname} sshd[${pid}]: Accepted password for ${e.user} from ${e.src} port ${port} ssh2`;
        }
        return `${c.syslogStamp(e.t)} ${host.hostname} auth[${pid}]: login ok for ${e.user} from ${e.src} (${e.service})`;
      case 'proc.exec':
        return `${c.syslogStamp(e.t)} ${host.hostname} audit[${pid}]: type=EXECVE uid=${e.user === 'root' ? 0 : 33} argc=3 a0="/bin/sh" a1="-c" a2="${e.tags.includes('credential-dump') ? 'cat /etc/shadow' : e.tags.includes('macro') ? 'powershell -enc JABjAD0A...' : 'id;uname -a'}"`;
      case 'file.read':
        return `${c.syslogStamp(e.t)} ${host.hostname} audit[${pid}]: type=PATH uid=${e.user} name="${e.path}" op=read`;
      case 'file.write':
        return `${c.syslogStamp(e.t)} ${host.hostname} audit[${pid}]: type=PATH uid=${e.user} name="${e.path}" op=rename`;
      case 'mail.received':
        return `${c.syslogStamp(e.t)} ${host.hostname} postfix/smtpd[${pid}]: connect from unknown[${e.src}]${e.tags.includes('malicious') ? `; amavis: Blocked SPAM-PHISH attachment for <${e.user}>` : ''}`;
      default:
        break;
    }
  }
  if (sensors.includes('weblog') && e.kind === 'http.request') {
    const status = e.outcome === 'fail' ? 404 : 200;
    return `${e.src} - - [${c.webStamp(e.t)}] "GET ${e.path} HTTP/1.1" ${status} ${status === 200 ? 4000 + (e.id % 3000) : 196} "-" "${String(e.data?.agent ?? 'Mozilla/5.0')}"`;
  }
  if (sensors.includes('nids')) {
    switch (e.kind) {
      case 'exploit.attempt':
        return `${c.syslogStamp(e.t)} ids suricata[${pid}]: [1:${2_000_000 + (e.id % 99999)}:3] ET EXPLOIT ${String(e.data?.module ?? '').split('/').pop()} [Classification: Attempted Administrator Privilege Gain] [Priority: 1] {TCP} ${e.src}:${port} -> ${e.dst}:${e.dstPort}`;
      case 'data.transfer':
        return `${c.syslogStamp(e.t)} ids suricata[${pid}]: flow ${e.src} -> ${e.dst}:${e.dstPort} bytes_toclient=${e.bytes}`;
      default:
        return null;
    }
  }
  return null;
}
