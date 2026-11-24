// The attacker's toolkit. Both the live attacker (when the learner defends)
// and the learner's terminal (when the learner attacks) use these same
// functions, so an attack behaves the same whoever runs it. Every probe,
// login and exploit becomes an event the sensors may or may not see.

import type { EventBus, Rng, SimClock } from './core.ts';
import type { AccountState, Endpoint, HostState, World } from './world.ts';
import type { WeaknessDef } from '../world/types.ts';

export interface Ctx {
  world: World;
  bus: EventBus;
  clock: SimClock;
  rng: Rng;
  /** "attacker" or "learner". */
  actor: string;
  /** Called when something happens later, such as a phishing victim clicking. */
  notify?: (message: string) => void;
  onLeak?: (dataKey: string, by: string, fraction?: number) => void;
}

/** Milliseconds between probes for nmap's -T0 to -T5. */
export const TIMING_MS = [300_000, 15_000, 400, 50, 20, 5];

const INTERESTING_PORTS = [
  21, 22, 23, 25, 53, 80, 88, 110, 111, 135, 139, 143, 389, 443, 445, 502, 514, 636, 873, 993, 995, 1433, 1514, 2049,
  3000, 3306, 3389, 5432, 5900, 5985, 6379, 8000, 8080, 8443, 8888, 9000, 9001, 9200, 27017, 55000,
];

/** nmap's default scan touches the 1000 most common ports. */
export function topPorts(n = 1000): number[] {
  const out = [...INTERESTING_PORTS];
  for (let p = 1; out.length < n && p < 65536; p++) {
    if (!out.includes(p)) {
      out.push(p);
    }
  }
  return out.slice(0, n);
}

export const SERVICE_PORTS: Record<string, number[]> = {
  ssh: [22],
  ftp: [21],
  smb: [445, 139],
  rdp: [3389],
  https: [443, 8443, 3000, 8080, 80, 8888, 9000],
  http: [80, 8080, 3000, 8888, 9000, 443],
  postgresql: [5432],
  postgres: [5432],
  mysql: [3306],
  mssql: [1433],
  vnc: [5900],
  smtp: [25],
};

/** The service a person most likely logs in to a machine through. */
export function defaultService(host: HostState): string {
  const has = (port: number): boolean => host.services.some((s) => s.port === port);
  if (host.kind === 'directory' && has(445)) {
    return 'smb';
  }
  if (has(443) || has(3000) || has(8080)) {
    return 'https';
  }
  if (has(3389)) {
    return 'rdp';
  }
  if (has(22)) {
    return 'ssh';
  }
  if (has(5900)) {
    return 'vnc';
  }
  if (has(5432)) {
    return 'postgresql';
  }
  return 'smb';
}

export function portFor(host: HostState, service: string): number | undefined {
  const candidates = SERVICE_PORTS[service] ?? [];
  return candidates.find((p) => host.services.some((s) => s.port === p));
}

function serviceMatches(account: AccountState, service: string): boolean {
  if (!account.service) {
    return true;
  }
  const alias = (s: string): string => (s === 'http' ? 'https' : s === 'postgres' ? 'postgresql' : s);
  return alias(account.service) === alias(service);
}

// ---------------------------------------------------------------- scanning

export interface PortResult {
  port: number;
  state: 'open' | 'closed' | 'filtered';
  name?: string;
  product?: string;
  version?: string;
}

export interface ScanResult {
  host: HostState | undefined;
  ip: string;
  up: boolean;
  ports: PortResult[];
  probed: number;
}

/** Ping sweep a range. Returns the addresses that answered. */
export async function pingSweep(ctx: Ctx, from: Endpoint, addresses: string[], timing = 3): Promise<string[]> {
  const delay = TIMING_MS[timing] ?? 50;
  const up: string[] = [];
  const batch = Math.max(1, Math.round(250 / delay));
  for (let i = 0; i < addresses.length; i++) {
    const ip = addresses[i]!;
    const host = ctx.world.byIp.get(ip);
    ctx.bus.emit({
      kind: 'net.probe',
      actor: ctx.actor,
      malicious: true,
      src: from.ip,
      dst: ip,
      dstPort: 0,
      ...(host ? { org: host.org } : {}),
      tags: ['icmp'],
      summary: `ICMP echo to ${ip}`,
    });
    if (host && ctx.world.reach(from, host, 0) === 'ok') {
      up.push(ip);
    }
    if ((i + 1) % batch === 0) {
      await ctx.clock.sleep(Math.max(delay, 250));
    }
  }
  return up;
}

/** TCP port scan of one address. */
export async function portScan(
  ctx: Ctx,
  from: Endpoint,
  ip: string,
  ports: number[],
  opts: { timing?: number; skipPing?: boolean; malicious?: boolean; actor?: string } = {},
): Promise<ScanResult> {
  const timing = opts.timing ?? 3;
  const delay = TIMING_MS[timing] ?? 50;
  const actor = opts.actor ?? ctx.actor;
  const malicious = opts.malicious ?? true;
  const host = ctx.world.byIp.get(ip);
  // A block at the perimeter drops the probes before any sensor behind it sees them.
  const dropped = !!host && from.org !== host.org && ctx.world.isBlocked(from.ip, host.org);
  const pingOk = host ? ctx.world.reach(from, host, 0) === 'ok' : false;
  if (!pingOk && !opts.skipPing) {
    if (dropped) {
      await ctx.clock.sleep(2000);
      return { host, ip, up: false, ports: [], probed: 0 };
    }
    ctx.bus.emit({
      kind: 'net.probe',
      actor,
      malicious,
      src: from.ip,
      dst: ip,
      dstPort: 0,
      tags: ['icmp'],
      summary: `ICMP echo to ${ip}`,
    });
    await ctx.clock.sleep(2000);
    return { host, ip, up: false, ports: [], probed: 0 };
  }
  const results: PortResult[] = [];
  const emitLimit = 2000;
  const perBatch = Math.max(1, Math.round(250 / delay));
  let emitted = 0;
  for (let i = 0; i < ports.length; i++) {
    const port = ports[i]!;
    const reach = host ? ctx.world.reach(from, host, port) : 'filtered';
    if (emitted < emitLimit && !dropped) {
      ctx.bus.emit({
        kind: 'net.probe',
        actor,
        malicious,
        src: from.ip,
        dst: ip,
        dstPort: port,
        ...(host ? { org: host.org } : {}),
        tags: ['tcp', 'syn'],
        summary: `SYN to ${ip}:${port}`,
      });
      emitted++;
    }
    if (reach === 'ok' && host) {
      const svc = host.services.find((s) => s.port === port)!;
      results.push({ port, state: 'open', name: svc.name, product: svc.product, version: svc.version });
    } else if (reach === 'filtered') {
      results.push({ port, state: 'filtered' });
    } else if (reach === 'down') {
      // An isolated host stops answering part-way through.
      results.push({ port, state: 'filtered' });
    } else {
      results.push({ port, state: 'closed' });
    }
    if ((i + 1) % perBatch === 0) {
      await ctx.clock.sleep(Math.max(delay, 250));
    }
  }
  const up = host !== undefined && results.some((r) => r.state !== 'filtered');
  return { host, ip, up: up || (pingOk && !!host), ports: results, probed: ports.length };
}

// ------------------------------------------------------------------ logins

export type LoginResult = 'ok' | 'fail' | 'locked' | 'mfa' | 'unreachable' | 'no-service';

function findAccount(world: World, host: HostState, user: string): AccountState | undefined {
  const local = host.accounts.find((a) => a.user === user);
  if (local) {
    return local;
  }
  // Domain accounts work on every Windows machine and the directory itself.
  if (host.os.toLowerCase().includes('windows') || host.kind === 'directory') {
    const directory = [...world.hosts.values()].find((h) => h.org === host.org && h.kind === 'directory');
    return directory?.accounts.find((a) => a.user === user);
  }
  return undefined;
}

export function loginTags(world: World, clock: SimClock, host: HostState, account: AccountState, src: string): string[] {
  const tags: string[] = [];
  if (account.role === 'service') {
    tags.push('service-account');
    const known = world.baseline.get(`${host.key}:${account.user}`);
    if (!known || !known.has(src)) {
      tags.push('new-source');
    }
  } else {
    tags.push('interactive');
    if (!clock.isWorkHours()) {
      tags.push('off-hours');
    }
  }
  const defaultCreds = host.weaknesses.some(
    (w) => w.kind === 'default-credentials' && w.account === account.user && world.weaknessActive(host, w.id),
  );
  if (defaultCreds) {
    tags.push('default-credentials');
  }
  return tags;
}

/** One login attempt, with lockout and MFA applied. */
export function tryLogin(
  ctx: Ctx,
  from: Endpoint,
  host: HostState,
  service: string,
  user: string,
  password: string,
  opts: { malicious?: boolean; actor?: string; tags?: string[] } = {},
): LoginResult {
  const { world, bus } = ctx;
  const port = portFor(host, service);
  if (port === undefined) {
    return 'no-service';
  }
  if (world.reach(from, host, port) !== 'ok') {
    return 'unreachable';
  }
  const malicious = opts.malicious ?? true;
  const actor = opts.actor ?? ctx.actor;
  const base = {
    actor,
    malicious,
    org: host.org,
    src: from.ip,
    dst: host.ip,
    dstPort: port,
    host: host.key,
    service: service === 'http' ? 'https' : service,
    user,
  } as const;
  const account = findAccount(world, host, user);
  if (!account || !serviceMatches(account, service)) {
    bus.emit({ ...base, kind: 'auth.fail', outcome: 'fail', tags: [...(opts.tags ?? []), 'invalid-user'], summary: `Failed login for invalid user ${user}` });
    return 'fail';
  }
  if (account.locked) {
    bus.emit({ ...base, kind: 'auth.fail', outcome: 'fail', tags: [...(opts.tags ?? []), 'locked'], summary: `Login refused for locked account ${user}` });
    return 'locked';
  }
  if (account.password !== password) {
    account.failures++;
    bus.emit({ ...base, kind: 'auth.fail', outcome: 'fail', tags: opts.tags ?? [], summary: `Failed password for ${user}` });
    const limit = world.lockoutAfter(host.org);
    if (limit !== null && account.failures >= limit && account.role !== 'service') {
      account.locked = true;
      bus.emit({
        kind: 'account.lock',
        actor: 'system',
        org: host.org,
        host: host.key,
        user,
        summary: `${user} locked after ${account.failures} failed logins`,
      });
    }
    return 'fail';
  }
  if (account.role !== 'service' && world.mfaRequired(host.org)) {
    bus.emit({ ...base, kind: 'auth.fail', outcome: 'fail', tags: [...(opts.tags ?? []), 'mfa'], summary: `Second factor not completed for ${user}` });
    return 'mfa';
  }
  account.failures = 0;
  bus.emit({
    ...base,
    kind: 'auth.success',
    outcome: 'ok',
    tags: [...(opts.tags ?? []), ...loginTags(world, ctx.clock, host, account, from.ip)],
    summary: `Accepted password for ${user}`,
  });
  return 'ok';
}

export interface Found {
  user: string;
  password: string;
}

/** Hydra-style guessing. Stops at the first hit per user. */
export async function bruteForce(
  ctx: Ctx,
  from: Endpoint,
  host: HostState,
  service: string,
  users: string[],
  passwords: string[],
  opts: { tasks?: number; maxAttempts?: number } = {},
): Promise<{ found: Found[]; attempts: number; stoppedBy?: LoginResult }> {
  const tasks = opts.tasks ?? 16;
  const delay = Math.max(50, Math.round(1000 / tasks));
  const found: Found[] = [];
  let attempts = 0;
  const max = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
  for (const user of users) {
    for (const password of passwords) {
      if (attempts >= max) {
        return { found, attempts };
      }
      const result = tryLogin(ctx, from, host, service, user, password, { tags: ['bruteforce'] });
      attempts++;
      if (result === 'unreachable' || result === 'no-service') {
        return { found, attempts, stoppedBy: result };
      }
      if (result === 'ok') {
        found.push({ user, password });
        break;
      }
      if (result === 'locked' || result === 'mfa') {
        break;
      }
      await ctx.clock.sleep(delay);
    }
  }
  return { found, attempts };
}

// ---------------------------------------------------------------- exploits

export interface ExploitResult {
  ok: boolean;
  level?: 'user' | 'root';
  reason: string;
}

export function weaknessByModule(host: HostState, module: string): WeaknessDef | undefined {
  return host.weaknesses.find((w) => w.module === module);
}

export function compromise(ctx: Ctx, host: HostState, level: 'user' | 'root'): void {
  if (!host.compromise || (host.compromise.level === 'user' && level === 'root')) {
    host.compromise = { level, by: ctx.actor, at: ctx.clock.now };
  }
}

export async function runExploit(
  ctx: Ctx,
  from: Endpoint,
  host: HostState,
  module: string,
  opts: { username?: string; password?: string; port?: number } = {},
): Promise<ExploitResult> {
  const weakness = weaknessByModule(host, module);
  const port = opts.port ?? weakness?.port ?? host.services[0]?.port;
  if (port === undefined) {
    return { ok: false, reason: 'The target exposes no service for this module.' };
  }
  const reach = ctx.world.reach(from, host, port);
  if (reach !== 'ok') {
    await ctx.clock.sleep(5000);
    return { ok: false, reason: reach === 'closed' ? `Connection refused on ${host.ip}:${port}` : `Exploit failed [unreachable]: Rex::ConnectionTimeout ${host.ip}:${port}` };
  }
  ctx.bus.emit({
    kind: 'exploit.attempt',
    actor: ctx.actor,
    malicious: true,
    org: host.org,
    src: from.ip,
    dst: host.ip,
    dstPort: port,
    host: host.key,
    tags: ['signature'],
    summary: `Exploit traffic (${module}) to ${host.ip}:${port}`,
    data: { module, ...(weakness?.cve ? { cve: weakness.cve } : {}) },
  });
  await ctx.clock.sleep(3000);
  if (!weakness || !ctx.world.weaknessActive(host, weakness.id)) {
    return { ok: false, reason: 'Exploit completed, but no session was created.' };
  }
  if (weakness.kind === 'default-credentials' && weakness.account) {
    const user = opts.username ?? weakness.account;
    const result = tryLogin(ctx, from, host, 'http', user, opts.password ?? weakness.account);
    if (result !== 'ok') {
      return { ok: false, reason: 'Exploit aborted due to failure: no-access: Unable to access the Tomcat Manager.' };
    }
  }
  const level = weakness.grants ?? 'user';
  compromise(ctx, host, level);
  ctx.bus.emit({
    kind: 'proc.exec',
    actor: ctx.actor,
    malicious: true,
    org: host.org,
    src: from.ip,
    host: host.key,
    user: level === 'root' ? 'root' : 'www-data',
    tags: ['suspicious', 'shell'],
    summary: `Shell spawned by a service on ${host.hostname}`,
  });
  return { ok: true, level, reason: 'session opened' };
}

// -------------------------------------------------------------------- web

export interface WebResult {
  status: number;
  body: string;
  exposes: string[];
  reveals?: Found & { host: string };
}

export function webRequest(
  ctx: Ctx,
  from: Endpoint,
  host: HostState,
  port: number,
  path: string,
  opts: { tags?: string[]; outcome?: 'ok' | 'fail'; malicious?: boolean; actor?: string; agent?: string } = {},
): boolean {
  if (ctx.world.reach(from, host, port) !== 'ok') {
    return false;
  }
  ctx.bus.emit({
    kind: 'http.request',
    actor: opts.actor ?? ctx.actor,
    malicious: opts.malicious ?? true,
    org: host.org,
    src: from.ip,
    dst: host.ip,
    dstPort: port,
    host: host.key,
    path,
    outcome: opts.outcome ?? 'ok',
    tags: opts.tags ?? [],
    summary: `GET ${path}`,
    data: { agent: opts.agent ?? 'Mozilla/5.0' },
  });
  return true;
}

function webPort(host: HostState, preferred?: number): number | undefined {
  if (preferred && host.services.some((s) => s.port === preferred)) {
    return preferred;
  }
  // Prefer HTTPS, then plain HTTP, then the app ports, whatever order the services are listed in.
  return [443, 80, 8080, 3000, 8888, 9000, 8443].find((port) => host.services.some((s) => s.port === port));
}

/** Fetch a URL. Reveals whatever a web weakness at that path leaks. */
export function fetchUrl(ctx: Ctx, from: Endpoint, host: HostState, path: string, port?: number, agent = 'curl/8.5.0'): WebResult | null {
  const p = webPort(host, port);
  if (p === undefined) {
    return null;
  }
  const active = ctx.world.activeWeaknesses(host);
  const match = active.find((w) => w.path && path.startsWith(w.path.replace(/\?.*$/, '')) && w.port === p);
  const anonymous = active.find((w) => w.module === 'minio-anonymous-list' && w.port === p);
  const tags: string[] = [];
  if (anonymous && path !== '/') {
    tags.push('anonymous-list');
  }
  if (!webRequest(ctx, from, host, p, path, { tags, agent })) {
    return null;
  }
  if (match?.kind === 'exposed-secret' && match.reveals) {
    const [sysKey, user] = match.reveals.split(':');
    const target = ctx.world.hosts.get(sysKey ?? '');
    const account = target?.accounts.find((a) => a.user === user);
    if (target && account) {
      const body = `# config\nDB_HOST=${target.fqdn}\nDB_USER=${account.user}\nDB_PASSWORD=${account.password}\n`;
      return { status: 200, body, exposes: [], reveals: { host: target.key, user: account.user, password: account.password } };
    }
  }
  if (match && (match.module === 'directory-listing' || match.module === 'idor') && match.exposes) {
    const files = match.exposes.map((d) => ctx.world.dataByKey(`${host.org}/${d}`)?.name ?? d);
    return { status: 200, body: `Index of ${path}\n${files.map((f) => `  ${f.toLowerCase().replace(/ /g, '_')}/`).join('\n')}`, exposes: match.exposes.map((d) => `${host.org}/${d}`) };
  }
  if (anonymous && path !== '/') {
    return {
      status: 200,
      body: '<ListBucketResult><Name>client-datasets</Name><Contents><Key>siyakhula/latest.parquet</Key></Contents></ListBucketResult>',
      exposes: (anonymous.exposes ?? []).map((d) => `${host.org}/${d}`),
    };
  }
  const svc = host.services.find((s) => s.port === p);
  return { status: 200, body: `<html><head><title>${host.name}</title></head><!-- ${svc?.product ?? ''} ${svc?.version ?? ''} --></html>`, exposes: [] };
}

/** Guess common paths, the way gobuster or dirb does. Noisy: many 404s. */
export async function dirBust(ctx: Ctx, from: Endpoint, host: HostState, port?: number): Promise<string[]> {
  const p = webPort(host, port);
  if (p === undefined) {
    return [];
  }
  const common = ['/admin', '/login', '/backup', '/config', '/.git', '/api', '/uploads', '/debug', '/old', '/test', '/phpmyadmin', '/server-status', '/wp-admin', '/.env', '/console', '/manager/html', '/robots.txt', '/sitemap.xml', '/static', '/images', '/js', '/css', '/files', '/docs', '/private', '/tmp', '/dev', '/staging', '/db', '/sql', '/data', '/export', '/reports', '/user', '/users', '/account.php', '/submit', '/api/learners', '/debug/config', '/dataquant'];
  const found = new Set<string>();
  for (const w of ctx.world.activeWeaknesses(host)) {
    if (w.path && w.port === p) {
      found.add(w.path.replace(/\?.*$/, ''));
    }
  }
  if (host.services.some((s) => s.product === 'Apache Tomcat')) {
    found.add('/manager/html');
  }
  for (let i = 0; i < common.length; i++) {
    const path = common[i]!;
    const hit = [...found].some((f) => f.startsWith(path) && path.length > 1);
    if (!webRequest(ctx, from, host, p, path, { outcome: hit ? 'ok' : 'fail', agent: 'gobuster/3.6' })) {
      return [];
    }
    if (i % 8 === 7) {
      await ctx.clock.sleep(250);
    }
  }
  return [...found].sort();
}

/** sqlmap against a URL. Returns the data sets the injection exposes. */
export async function sqlInjection(ctx: Ctx, from: Endpoint, host: HostState, path: string, port?: number): Promise<{ vulnerable: boolean; exposes: string[]; requests: number }> {
  const p = webPort(host, port);
  if (p === undefined) {
    return { vulnerable: false, exposes: [], requests: 0 };
  }
  const weakness = ctx.world
    .activeWeaknesses(host)
    .find((w) => w.module === 'sqli' && w.path && path.startsWith(w.path.split('?')[0]!));
  const requests = weakness ? 46 : 120;
  for (let i = 0; i < requests; i++) {
    const payload = i % 3 === 0 ? "1' AND 1=1-- -" : i % 3 === 1 ? "1 UNION ALL SELECT NULL,NULL-- -" : "1' AND SLEEP(5)-- -";
    if (!webRequest(ctx, from, host, p, `${path.split('=')[0]}=${encodeURIComponent(payload)}`, { tags: ['sqli'], agent: 'sqlmap/1.8.2#stable' })) {
      return { vulnerable: false, exposes: [], requests: i };
    }
    if (i % 10 === 9) {
      await ctx.clock.sleep(500);
    }
  }
  return { vulnerable: !!weakness, exposes: (weakness?.exposes ?? []).map((d) => `${host.org}/${d}`), requests };
}

/** Abuse a web flaw that runs code, such as an upload that accepts a web shell. */
export async function webExploit(ctx: Ctx, from: Endpoint, host: HostState, module: string): Promise<ExploitResult> {
  return runExploit(ctx, from, host, module);
}

// ---------------------------------------------------------------- phishing

/**
 * Send a lure. If the person opens it on a vulnerable device, the device calls
 * back to `callbackIp` some minutes later and `onSession` fires.
 */
export function sendPhish(
  ctx: Ctx,
  fromIp: string,
  orgId: string,
  personId: string,
  lure: string,
  callbackIp: string,
  onSession: (device: HostState) => void,
): { delivered: boolean; reason: string } {
  const mail = ctx.world.mailServer(orgId);
  const person = ctx.world.person(orgId, personId);
  if (!mail || !person) {
    return { delivered: false, reason: 'No such recipient.' };
  }
  const from = ctx.world.endpointFor(fromIp);
  if (ctx.world.reach(from, mail, 25) !== 'ok') {
    return { delivered: false, reason: `Could not connect to ${mail.fqdn}:25.` };
  }
  ctx.bus.emit({
    kind: 'mail.received',
    actor: ctx.actor,
    malicious: true,
    org: orgId,
    src: fromIp,
    dst: mail.ip,
    dstPort: 25,
    host: mail.key,
    user: personId,
    tags: ['malicious', 'attachment'],
    summary: `Mail to ${person.name} with attachment "${lure}"`,
  });
  const device = ctx.world.deviceOf(orgId, personId);
  // People read mail when they are at work. A night-time lure waits for the morning.
  const shiftWorker = ctx.world.orgs.get(orgId)?.resolved.processes.some((p) => p.owner === personId && p.hours === 'always') ?? false;
  let readAfter = ctx.rng.int(60, 360) * 1000;
  if (!shiftWorker && !ctx.clock.isWorkHours(ctx.clock.now + readAfter)) {
    const dayMs = 24 * 3_600_000;
    const untilEight = (8 * 3_600_000 - ctx.clock.timeOfDayMs() + dayMs) % dayMs;
    readAfter = untilEight + ctx.rng.int(5, 90) * 60_000;
  }
  ctx.clock.at(readAfter, () => {
    if (!device || device.status !== 'up') {
      return;
    }
    const weakness = device.weaknesses.find((w) => w.kind === 'phishable');
    const clicks = weakness && ctx.world.weaknessActive(device, weakness.id) && ctx.rng.chance(1 - person.awareness * 0.8);
    if (!clicks) {
      return;
    }
    ctx.bus.emit({
      kind: 'proc.exec',
      actor: ctx.actor,
      malicious: true,
      org: orgId,
      host: device.key,
      user: personId,
      tags: ['suspicious', 'macro'],
      summary: `${lure} started a script on ${device.hostname}`,
    });
    compromise(ctx, device, weakness?.grants ?? 'user');
    ctx.bus.emit({
      kind: 'net.connect',
      actor: ctx.actor,
      malicious: true,
      org: orgId,
      src: device.ip,
      dst: callbackIp,
      dstPort: 443,
      host: device.key,
      tags: ['beacon', 'outbound'],
      summary: `${device.hostname} connected out to ${callbackIp}:443`,
    });
    onSession(device);
  });
  return { delivered: true, reason: `Queued for ${person.name}.` };
}

// ------------------------------------------------------- collection, impact

/** Read and send a data set out. The caller checks the attacker has access. */
export async function exfiltrate(ctx: Ctx, source: HostState, dataKey: string, toIp: string, via: 'shell' | 'web' | 'database'): Promise<{ ok: boolean; bytes: number; reason: string }> {
  const data = ctx.world.dataByKey(dataKey);
  if (!data) {
    return { ok: false, bytes: 0, reason: 'No such data.' };
  }
  if (source.status !== 'up') {
    return { ok: false, bytes: 0, reason: 'Connection lost.' };
  }
  const reads = Math.min(60, Math.max(5, Math.ceil((data.records ?? 100) / 500)));
  if (via === 'shell') {
    for (let i = 0; i < reads; i++) {
      ctx.bus.emit({
        kind: 'file.read',
        actor: ctx.actor,
        malicious: true,
        org: data.host.org,
        host: data.host.key,
        user: data.host.compromise?.level === 'root' ? 'root' : 'www-data',
        path: `${data.path}/${String(i).padStart(4, '0')}`,
        tags: ['collection'],
        summary: `Read ${data.path}`,
      });
      if (i % 20 === 19) {
        await ctx.clock.sleep(1000);
      }
    }
  }
  // The data goes out in pages, so a defender who acts in time keeps most of it.
  // An injection pulls rows through web responses (slow); a database login or
  // a shell copies faster.
  const bytes = Math.max(2_000_000, (data.records ?? 1000) * 2_000);
  const pages = Math.min(12, Math.max(1, Math.ceil((data.records ?? 1000) / 9_000)));
  const pageMs = via === 'web' ? 35_000 : via === 'database' ? 12_000 : 8_000;
  const pageBytes = Math.round(bytes / pages);
  let sent = 0;
  for (let page = 0; page < pages; page++) {
    if (source.status !== 'up' || ctx.world.isBlocked(toIp, source.org)) {
      break;
    }
    ctx.bus.emit({
      kind: 'data.transfer',
      actor: ctx.actor,
      malicious: true,
      org: data.host.org,
      src: source.ip,
      dst: toIp,
      dstPort: 443,
      host: source.key,
      bytes: pageBytes,
      tags: ['outbound', via],
      summary: `${(pageBytes / 1_000_000).toFixed(0)} MB sent from ${source.hostname} to ${toIp} (part ${page + 1} of ${pages})`,
      data: { data: dataKey, page: page + 1, pages },
    });
    await ctx.clock.sleep(pageMs);
    if (source.status !== 'up' || ctx.world.isBlocked(toIp, source.org)) {
      break;
    }
    sent++;
  }
  if (sent === 0) {
    return { ok: false, bytes: 0, reason: 'Transfer cut off.' };
  }
  ctx.onLeak?.(dataKey, ctx.actor, sent / pages);
  if (sent < pages) {
    return { ok: false, bytes: sent * pageBytes, reason: `Transfer cut off after ${sent} of ${pages} parts.` };
  }
  return { ok: true, bytes, reason: 'done' };
}

/** Dump the account database on a host the attacker owns. Weak passwords crack. */
export function dumpCredentials(ctx: Ctx, host: HostState): Found[] {
  ctx.bus.emit({
    kind: 'proc.exec',
    actor: ctx.actor,
    malicious: true,
    org: host.org,
    host: host.key,
    user: 'root',
    tags: ['suspicious', 'credential-dump'],
    summary: `Credential dump on ${host.hostname}`,
  });
  return host.accounts
    .filter((a) => ctx.world.wordlist.includes(a.password) || host.kind === 'directory')
    .map((a) => ({ user: a.user, password: a.password }));
}

export function modbusWrite(ctx: Ctx, from: Endpoint, plc: HostState, register: number, value: number): { ok: boolean; reason: string } {
  if (ctx.world.reach(from, plc, 502) !== 'ok') {
    return { ok: false, reason: `Connection to ${plc.ip}:502 timed out.` };
  }
  ctx.bus.emit({
    kind: 'ot.write',
    actor: ctx.actor,
    malicious: true,
    org: plc.org,
    src: from.ip,
    dst: plc.ip,
    dstPort: 502,
    host: plc.key,
    tags: ['modbus', 'write'],
    summary: `Modbus write: register ${register} = ${value}`,
    data: { register, value },
  });
  const open = plc.weaknesses.find((w) => w.module === 'modbus-write');
  if (!open || !ctx.world.weaknessActive(plc, open.id)) {
    return { ok: false, reason: 'Illegal function (exception 1).' };
  }
  for (const d of plc.data) {
    ctx.onLeak?.(d.key, ctx.actor);
  }
  return { ok: true, reason: `Register ${register} set to ${value}.` };
}

export async function encryptHost(ctx: Ctx, host: HostState): Promise<void> {
  for (let i = 0; i < 30; i++) {
    ctx.bus.emit({
      kind: 'file.write',
      actor: ctx.actor,
      malicious: true,
      org: host.org,
      host: host.key,
      user: 'root',
      path: `/srv/files/doc_${i}.pdf.locked`,
      tags: ['encrypt'],
      summary: `File rewritten as .locked on ${host.hostname}`,
    });
    if (i % 10 === 9) {
      await ctx.clock.sleep(1000);
    }
  }
  if (host.status === 'up') {
    host.status = 'down';
    ctx.bus.emit({ kind: 'host.down', actor: 'system', org: host.org, host: host.key, summary: `${host.hostname} is encrypted and down` });
  }
}
