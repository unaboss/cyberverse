// The live attacker for prey rounds. It is not a recording: it scans, learns
// what is there, picks the most promising next step for its objective, and
// adapts when the defender blocks it (new address, quieter methods). If every
// path is closed it gives up, and the defender has contained it.

import {
  bruteForce,
  dirBust,
  dumpCredentials,
  exfiltrate,
  fetchUrl,
  modbusWrite,
  pingSweep,
  portFor,
  portScan,
  runExploit,
  sendPhish,
  sqlInjection,
  topPorts,
  tryLogin,
  type Ctx,
  type Found,
  type PortResult,
} from './attack.ts';
import type { Endpoint, HostState } from './world.ts';
import type { AttackerProfileDef } from '../world/types.ts';
import { hostsIn } from '../world/net.ts';

type Outcome = 'ok' | 'fail' | 'blocked';

interface Action {
  id: string;
  label: string;
  score: number;
  noise: number;
  org: string;
  run: () => Promise<Outcome>;
}

const WEB_MODULES = new Set(['sqli', 'directory-listing', 'idor', 'minio-anonymous-list', 'prompt-injection', 'upload-webshell']);
const LOGIN_PORTS = new Set([22, 445, 3389, 5432, 3306, 1433, 5900]);
const SPRAY_PASSWORDS = ['Welcome1', 'Summer2026!', 'Password1', 'Siyakhula2026', 'Siyakhula@123', 'Welcome@123', 'P@ssw0rd', 'Spring2026'];
const LURES = ['Invoice_INV-8841.docm', 'Tender_Briefing_Nov2026.docm', 'Payslip_November_2026.xlsm', 'Council_Agenda_Revised.docm'];

export type AttackerResult = 'objective' | 'gave-up' | 'stopped';

export class LiveAttacker {
  ip: string;
  private readonly pool: string[];
  readonly burned: string[] = [];
  stealth: number;
  readonly known = new Map<string, PortResult[]>();
  readonly footholds = new Map<string, 'user' | 'root'>();
  readonly creds: (Found & { host: string; source: string })[] = [];
  readonly dbAccess = new Set<string>();
  private readonly exposedVia = new Map<string, string>();
  private readonly webPaths = new Map<string, string[]>();
  private readonly tried = new Set<string>();
  private readonly blockedActions = new Set<string>();
  private pendingPhish = 0;
  private steps = 0;
  done = false;
  result: AttackerResult | null = null;

  private readonly ctx: Ctx;
  private readonly profile: AttackerProfileDef & { supplyChain?: boolean };
  private readonly targetOrg: string;
  private readonly onEnd: (result: AttackerResult) => void;

  constructor(
    ctx: Ctx,
    profile: AttackerProfileDef & { supplyChain?: boolean },
    targetOrg: string,
    onEnd: (result: AttackerResult) => void,
  ) {
    this.ctx = ctx;
    this.profile = profile;
    this.targetOrg = targetOrg;
    this.onEnd = onEnd;
    const pool = ctx.rng.shuffle(ctx.world.attackerPool);
    this.pool = pool.slice(0, Math.max(1, Math.min(profile.sources, pool.length)));
    this.ip = this.pool[0]!;
    this.stealth = profile.stealth;
  }

  private get objective(): (ReturnType<Ctx['world']['dataByKey']> & object) | undefined {
    return this.ctx.world.dataByKey(this.profile.objective);
  }

  private note(label: string): void {
    this.ctx.bus.emit({ kind: 'attacker.step', actor: 'attacker', malicious: true, org: this.targetOrg, src: this.ip, summary: label });
  }

  async run(): Promise<void> {
    await this.ctx.clock.sleep(Math.round(this.ctx.rng.jitter(25_000, 0.4)));
    this.note(`Attacker starts from ${this.ip}, after ${this.ctx.world.dataByKey(this.profile.objective)?.name ?? this.profile.objective}`);
    while (!this.done && !this.ctx.clock.isStopped) {
      this.prune();
      const objective = await this.tryObjective();
      if (objective === 'ok') {
        this.finish('objective');
        return;
      }
      if (objective === 'blocked' && !this.rotate()) {
        this.finish('gave-up');
        return;
      }
      const action = objective === 'none' ? this.choose() : null;
      if (objective === 'none' && !action) {
        if (this.pendingPhish > 0) {
          await this.ctx.clock.sleep(30_000);
          continue;
        }
        this.finish('gave-up');
        return;
      }
      if (action) {
        this.tried.add(action.id);
        this.note(action.label);
        const outcome = await action.run();
        if (outcome === 'blocked') {
          this.blockedActions.add(action.id);
          if (!this.rotate()) {
            this.finish('gave-up');
            return;
          }
        }
      }
      if (++this.steps > 120) {
        this.finish('gave-up');
        return;
      }
      await this.ctx.clock.sleep(Math.round(this.ctx.rng.jitter(this.profile.pace * 1000, 0.5)));
    }
    if (!this.done) {
      this.done = true;
      this.result = 'stopped';
    }
  }

  private finish(result: AttackerResult): void {
    this.done = true;
    this.result = result;
    this.ctx.bus.emit({
      kind: result === 'objective' ? 'attacker.objective' : 'attacker.gave-up',
      actor: 'attacker',
      malicious: true,
      org: this.targetOrg,
      summary: result === 'objective' ? `The attacker got ${this.objective?.name ?? 'what it came for'}` : 'The attacker ran out of options and left',
    });
    this.onEnd(result);
  }

  /** Burn the current address and move to the next one, more carefully. */
  private rotate(): boolean {
    const next = this.pool[this.burned.length + 1];
    if (!next) {
      return false;
    }
    this.burned.push(this.ip);
    this.ip = next;
    this.stealth = Math.min(1, this.stealth + 0.15);
    for (const id of this.blockedActions) {
      this.tried.delete(id);
    }
    this.blockedActions.clear();
    this.note(`Blocked. The attacker switches to ${next} and slows down`);
    return true;
  }

  /** Forget footholds the defender has taken away. */
  private prune(): void {
    for (const key of [...this.footholds.keys()]) {
      const host = this.ctx.world.hosts.get(key);
      if (!host || host.status !== 'up' || !host.compromise) {
        this.footholds.delete(key);
      }
    }
  }

  private internet(): Endpoint {
    return { ip: this.ip, org: null, zone: 'internet' };
  }

  /** The best place to attack a host from: a foothold if one reaches it, else the internet. */
  private endpointTo(host: HostState, port: number): Endpoint | null {
    for (const key of this.footholds.keys()) {
      const foothold = this.ctx.world.hosts.get(key)!;
      const from = this.ctx.world.endpointFor(foothold.ip);
      if (this.ctx.world.reach(from, host, port) === 'ok') {
        return from;
      }
    }
    const from = this.internet();
    return this.ctx.world.reach(from, host, port) === 'ok' ? from : null;
  }

  private blockedFrom(org: string): boolean {
    return this.ctx.world.isBlocked(this.ip, org) && this.footholds.size === 0;
  }

  private outcome(org: string, ok: boolean): Outcome {
    if (this.ctx.world.isBlocked(this.ip, org)) {
      return 'blocked';
    }
    return ok ? 'ok' : 'fail';
  }

  // -------------------------------------------------------------- objective

  private async tryObjective(): Promise<Outcome | 'none'> {
    const data = this.objective;
    if (!data) {
      return 'none';
    }
    const host = data.host;
    if (host.kind === 'ot') {
      const from = this.endpointTo(host, 502);
      if (!from) {
        return 'none';
      }
      this.note(`Writes a new dosing setpoint to ${host.hostname}`);
      const result = modbusWrite(this.ctx, from, host, 40001, 9999);
      return result.ok ? 'ok' : 'none';
    }
    const web = this.exposedVia.get(data.key);
    if (web) {
      const webHost = this.ctx.world.hosts.get(web)!;
      const port = webHost.services.find((s) => [443, 80, 8080, 9000].includes(s.port))?.port ?? 443;
      if (!this.endpointTo(webHost, port)) {
        return this.ctx.world.isBlocked(this.ip, webHost.org) ? 'blocked' : 'none';
      }
      this.note(`Dumps ${data.name} through ${webHost.hostname}`);
      const result = await exfiltrate(this.ctx, webHost, data.key, this.ip, 'web');
      if (result.ok) {
        return 'ok';
      }
      return this.ctx.world.isBlocked(this.ip, webHost.org) ? 'blocked' : 'none';
    }
    if (this.footholds.has(host.key) || this.dbAccess.has(host.key)) {
      this.note(`Copies ${data.name} out of ${host.hostname}`);
      const result = await exfiltrate(this.ctx, host, data.key, this.ip, this.footholds.has(host.key) ? 'shell' : 'database');
      if (result.ok) {
        return 'ok';
      }
      return this.ctx.world.isBlocked(this.ip, host.org) ? 'blocked' : 'none';
    }
    return 'none';
  }

  // ---------------------------------------------------------------- choices

  private choose(): Action | null {
    const options = this.enumerate().filter((a) => !this.tried.has(a.id));
    if (options.length === 0) {
      return null;
    }
    const objectiveHost = this.objective?.host;
    let best: Action | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const option of options) {
      let score = option.score - option.noise * this.stealth * 40 + this.ctx.rng.int(-8, 8);
      if (objectiveHost && option.id.includes(objectiveHost.key)) {
        score += 30;
      }
      // Follow the business: systems in the same department as the target data.
      const optionHost = option.id.split(':').find((part) => part.includes('/'));
      if (objectiveHost && optionHost && optionHost !== objectiveHost.key && this.ctx.world.hosts.get(optionHost)?.dept === objectiveHost.dept) {
        score += 20;
      }
      if (score > bestScore) {
        bestScore = score;
        best = option;
      }
    }
    return best;
  }

  private scopeOrgs(): string[] {
    const orgs = [this.targetOrg];
    if (this.profile.supplyChain) {
      for (const link of this.ctx.world.links) {
        const [srcOrg] = link.src.split('/');
        const [dstOrg] = link.dst.split('/');
        if (dstOrg === this.targetOrg && srcOrg && !orgs.includes(srcOrg)) {
          orgs.push(srcOrg);
        }
      }
    }
    return orgs;
  }

  private enumerate(): Action[] {
    const actions: Action[] = [];
    const world = this.ctx.world;

    for (const org of this.scopeOrgs()) {
      const knownInOrg = [...this.known.keys()].some((k) => k.startsWith(`${org}/`));
      if (!knownInOrg) {
        actions.push({ id: `recon:public:${org}`, label: `Maps ${world.orgs.get(org)!.name} from the internet`, score: 90, noise: 0.6, org, run: () => this.reconPublic(org) });
      }
    }

    for (const key of this.footholds.keys()) {
      const host = world.hosts.get(key)!;
      actions.push({ id: `recon:internal:${key}`, label: `Scans the inside network from ${host.hostname}`, score: 45, noise: 0.8, org: host.org, run: () => this.reconInternal(host) });
      if (this.footholds.get(key) === 'root') {
        actions.push({ id: `dump:${key}`, label: `Dumps saved passwords on ${host.hostname}`, score: 45, noise: 0.5, org: host.org, run: async () => this.dump(host) });
      }
    }

    for (const [key, ports] of this.known) {
      const host = world.hosts.get(key);
      if (!host || host.status !== 'up') {
        continue;
      }
      const open = ports.filter((p) => p.state === 'open');
      if (this.footholds.has(key)) {
        continue;
      }
      if (open.some((p) => [80, 443, 3000, 8080, 8888, 9000].includes(p.port)) && host.kind !== 'mail') {
        actions.push({ id: `web:${key}`, label: `Guesses web paths on ${host.fqdn}`, score: 35, noise: 0.7, org: host.org, run: () => this.webProbe(host) });
      }
      if (open.some((p) => p.product === 'MinIO S3 API')) {
        actions.push({ id: `fetch:${key}:/client-datasets/`, label: `Lists storage on ${host.fqdn}`, score: 50, noise: 0.2, org: host.org, run: () => this.fetch(host, '/client-datasets/', 9000) });
      }
      for (const path of this.webPaths.get(key) ?? []) {
        if (path.includes('.php')) {
          actions.push({ id: `sqli:${key}`, label: `Runs sqlmap against ${host.fqdn}${path}`, score: 55, noise: 0.6, org: host.org, run: () => this.sqli(host, `${path}?id=1`) });
        } else if (path.includes('upload')) {
          actions.push({ id: `upload:${key}`, label: `Uploads a web shell to ${host.fqdn}`, score: 50, noise: 0.5, org: host.org, run: () => this.exploit(host, 'upload-webshell', 443) });
        } else if (path !== '/manager/html') {
          actions.push({ id: `fetch:${key}:${path}`, label: `Fetches ${host.fqdn}${path}`, score: 50, noise: 0.2, org: host.org, run: () => this.fetch(host, path) });
        }
      }
      for (const entry of this.exploitDb()) {
        if (open.some((p) => p.port === entry.port && p.product === entry.product && p.version === entry.version)) {
          actions.push({ id: `exploit:${key}:${entry.module}`, label: `Fires ${entry.module} at ${host.ip}`, score: 60, noise: 0.5, org: host.org, run: () => this.exploit(host, entry.module, entry.port) });
        }
      }
      if (open.some((p) => p.product === 'Roundcube Webmail')) {
        actions.push({ id: `spray:${key}`, label: `Password-sprays webmail on ${host.fqdn}`, score: 40, noise: 0.6, org: host.org, run: () => this.spray(host) });
      }
      for (const [service, port, users] of [
        ['ssh', 22, ['root', 'admin', 'deploy', 'ubuntu', 'backup']],
        ['smb', 445, ['administrator', 'svc_backup', 'backup', 'admin', 'helpdesk']],
        ['rdp', 3389, ['administrator', 'engineer', 'admin']],
      ] as const) {
        if (open.some((p) => p.port === port)) {
          actions.push({ id: `brute:${service}:${key}`, label: `Brute-forces ${service.toUpperCase()} on ${host.ip}`, score: service === 'smb' && host.kind === 'directory' ? 42 : 28, noise: 0.9, org: host.org, run: () => this.brute(host, service, [...users]) });
        }
      }
    }

    for (const cred of this.creds) {
      for (const host of this.credTargets(cred)) {
        // The password's own system is a near-sure thing; reuse elsewhere is a gamble.
        const own = host.key === cred.host;
        actions.push({
          id: `${own ? 'login' : 'reuse'}:${host.key}:${cred.user}`,
          label: `${own ? 'Logs in to' : 'Tries the same password on'} ${host.hostname} as ${cred.user}`,
          score: own ? 65 : 30,
          noise: own ? 0.1 : 0.3,
          org: host.org,
          run: () => this.useCred(host, cred),
        });
      }
    }

    const people = world.orgs.get(this.targetOrg)?.resolved.people.filter((p) => p.kind === 'human') ?? [];
    for (const person of people.slice(0, 6)) {
      if (this.known.size > 0) {
        actions.push({ id: `phish:${person.id}`, label: `Sends a lure to ${person.name} (${person.role})`, score: 33, noise: 0.3, org: this.targetOrg, run: async () => this.phish(person.id) });
      }
    }
    return actions;
  }

  private exploitDb(): { product: string; version: string; module: string; port: number }[] {
    const out: { product: string; version: string; module: string; port: number }[] = [];
    for (const host of this.ctx.world.hosts.values()) {
      for (const w of host.weaknesses) {
        if (!w.module || WEB_MODULES.has(w.module) || w.port === undefined || w.module === 'modbus-write') {
          continue;
        }
        const svc = host.services.find((s) => s.port === w.port);
        if (svc && !out.some((e) => e.module === w.module && e.product === svc.product && e.version === svc.version)) {
          out.push({ product: svc.product, version: svc.version, module: w.module, port: w.port });
        }
      }
    }
    return out;
  }

  private credTargets(cred: Found & { host: string }): HostState[] {
    const world = this.ctx.world;
    const own = world.hosts.get(cred.host);
    const out: HostState[] = [];
    if (own && !this.footholds.has(own.key) && !this.dbAccess.has(own.key) && !this.usedOn(own.key, cred.user)) {
      out.push(own);
    }
    // People reuse passwords: try a stolen login on other systems that take one
    // (SSH, SMB, RDP, a database or webmail), not on every web page.
    for (const [key, ports] of this.known) {
      const host = world.hosts.get(key);
      if (!host || host.key === own?.key || host.org !== own?.org || this.footholds.has(key) || this.dbAccess.has(key)) {
        continue;
      }
      if (this.tried.has(`reuse:${key}:${cred.user}`)) {
        continue;
      }
      const takesLogin = ports.some((p) => p.state === 'open' && (LOGIN_PORTS.has(p.port) || p.product === 'Roundcube Webmail'));
      if (takesLogin) {
        out.push(host);
      }
    }
    if (own?.kind === 'directory') {
      for (const host of world.hosts.values()) {
        if (host.org === own.org && host.os.toLowerCase().includes('windows') && this.known.has(host.key) && !this.footholds.has(host.key)) {
          out.push(host);
        }
      }
    }
    return out;
  }

  private usedOn(hostKey: string, user: string): boolean {
    return this.tried.has(`login:${hostKey}:${user}`);
  }

  // ----------------------------------------------------------------- moves

  private remember(host: HostState | undefined, ports: PortResult[]): void {
    if (!host) {
      return;
    }
    const merged = new Map((this.known.get(host.key) ?? []).map((p) => [p.port, p] as const));
    for (const p of ports) {
      if (p.state === 'open') {
        merged.set(p.port, p);
      }
    }
    this.known.set(host.key, [...merged.values()]);
  }

  private async reconPublic(orgId: string): Promise<Outcome> {
    const world = this.ctx.world;
    const org = world.orgs.get(orgId)!;
    const publicZones = org.resolved.zones.filter((z) => org.resolved.policy.some((f) => f.src === 'internet' && f.dst === z.id));
    const from = this.internet();
    for (const zone of publicZones) {
      const named = world.zoneHosts(orgId, zone.id).map((h) => h.ip);
      const targets = this.stealth < 0.5 ? await pingSweep(this.ctx, from, hostsIn(zone.cidr), 4) : named;
      for (const ip of targets) {
        const result = await portScan(this.ctx, from, ip, this.stealth < 0.5 ? topPorts(1000) : topPorts(40), { timing: this.stealth < 0.5 ? 4 : 3, skipPing: this.stealth >= 0.5 });
        this.remember(result.host, result.ports);
        if (this.blockedFrom(orgId)) {
          return 'blocked';
        }
      }
    }
    return this.outcome(orgId, true);
  }

  private async reconInternal(foothold: HostState): Promise<Outcome> {
    const world = this.ctx.world;
    const from = world.endpointFor(foothold.ip);
    const org = world.orgs.get(foothold.org)!;
    for (const zone of org.resolved.zones) {
      const live = await pingSweep(this.ctx, from, hostsIn(zone.cidr), this.stealth < 0.6 ? 4 : 3);
      for (const ip of live) {
        if (ip === foothold.ip) {
          continue;
        }
        const result = await portScan(this.ctx, from, ip, topPorts(40), { timing: 4, skipPing: true });
        this.remember(result.host, result.ports);
        if (foothold.status !== 'up') {
          return 'fail';
        }
      }
    }
    // Follow the supplier link if this foothold has one.
    for (const link of world.links.filter((l) => l.src === foothold.key)) {
      const dst = world.hosts.get(link.dst);
      if (dst) {
        const result = await portScan(this.ctx, from, dst.ip, link.ports, { timing: 3, skipPing: true });
        this.remember(dst, result.ports);
      }
    }
    return 'ok';
  }

  private async webProbe(host: HostState): Promise<Outcome> {
    const from = this.endpointTo(host, host.services[0]?.port ?? 443);
    if (!from) {
      return this.outcome(host.org, false);
    }
    const paths = await dirBust(this.ctx, from, host);
    this.webPaths.set(host.key, paths);
    return this.outcome(host.org, paths.length > 0);
  }

  private async fetch(host: HostState, path: string, port?: number): Promise<Outcome> {
    const from = this.endpointTo(host, port ?? 443) ?? this.endpointTo(host, host.services[0]?.port ?? 443);
    if (!from) {
      return this.outcome(host.org, false);
    }
    const result = fetchUrl(this.ctx, from, host, path, port);
    if (result?.reveals) {
      this.creds.push({ ...result.reveals, source: `${host.fqdn}${path}` });
    }
    for (const key of result?.exposes ?? []) {
      this.exposedVia.set(key, host.key);
    }
    return this.outcome(host.org, !!result && (result.exposes.length > 0 || !!result.reveals));
  }

  private async sqli(host: HostState, path: string): Promise<Outcome> {
    const from = this.endpointTo(host, 443);
    if (!from) {
      return this.outcome(host.org, false);
    }
    const result = await sqlInjection(this.ctx, from, host, path);
    for (const key of result.exposes) {
      this.exposedVia.set(key, host.key);
    }
    return this.outcome(host.org, result.vulnerable);
  }

  private async exploit(host: HostState, module: string, port: number): Promise<Outcome> {
    const from = this.endpointTo(host, port);
    if (!from) {
      return this.outcome(host.org, false);
    }
    const result = await runExploit(this.ctx, from, host, module, { port });
    if (result.ok && result.level) {
      this.footholds.set(host.key, result.level);
    }
    return this.outcome(host.org, result.ok);
  }

  private async brute(host: HostState, service: 'ssh' | 'smb' | 'rdp', users: string[]): Promise<Outcome> {
    const port = portFor(host, service);
    if (port === undefined) {
      return 'fail';
    }
    const from = this.endpointTo(host, port);
    if (!from) {
      return this.outcome(host.org, false);
    }
    const result = await bruteForce(this.ctx, from, host, service, users, this.ctx.world.wordlist.slice(0, 70), { tasks: this.stealth > 0.6 ? 2 : 8, maxAttempts: 260 });
    for (const found of result.found) {
      this.creds.push({ ...found, host: host.key, source: `${service} brute force` });
    }
    return this.outcome(host.org, result.found.length > 0);
  }

  private async spray(host: HostState): Promise<Outcome> {
    const from = this.endpointTo(host, 443);
    if (!from) {
      return this.outcome(host.org, false);
    }
    const users = (this.ctx.world.orgs.get(host.org)?.resolved.people ?? [])
      .filter((p) => p.kind === 'human')
      .map((p) => p.name.split(' ')[0]!.toLowerCase());
    let hits = 0;
    for (const password of SPRAY_PASSWORDS) {
      for (const user of users) {
        const result = tryLogin(this.ctx, from, host, 'https', user, password, { tags: ['spray'] });
        if (result === 'ok') {
          this.creds.push({ user, password, host: host.key, source: 'webmail spray' });
          hits++;
        }
        if (result === 'unreachable') {
          return this.outcome(host.org, hits > 0);
        }
      }
      await this.ctx.clock.sleep(Math.round(this.ctx.rng.jitter(this.stealth > 0.5 ? 40_000 : 8_000)));
    }
    return this.outcome(host.org, hits > 0);
  }

  private async useCred(host: HostState, cred: Found): Promise<Outcome> {
    const service = host.services.some((s) => s.port === 5432)
      ? 'postgresql'
      : host.services.some((s) => s.port === 22)
        ? 'ssh'
        : host.services.some((s) => s.port === 445)
          ? 'smb'
          : host.services.some((s) => s.port === 3389)
            ? 'rdp'
            : 'https';
    const port = portFor(host, service);
    if (port === undefined) {
      return 'fail';
    }
    const from = this.endpointTo(host, port);
    if (!from) {
      return this.outcome(host.org, false);
    }
    const result = tryLogin(this.ctx, from, host, service, cred.user, cred.password);
    if (result !== 'ok') {
      return this.outcome(host.org, false);
    }
    if (service === 'postgresql' || service === 'https') {
      this.dbAccess.add(host.key);
    } else {
      const account = host.accounts.find((a) => a.user === cred.user);
      const level = account?.role === 'admin' || account?.role === 'service' || cred.user === 'administrator' ? 'root' : 'user';
      host.compromise = host.compromise ?? { level, by: 'attacker', at: this.ctx.clock.now };
      this.footholds.set(host.key, level);
    }
    return 'ok';
  }

  private dump(host: HostState): Outcome {
    for (const found of dumpCredentials(this.ctx, host)) {
      if (!this.creds.some((c) => c.host === host.key && c.user === found.user)) {
        this.creds.push({ ...found, host: host.key, source: `dumped on ${host.hostname}` });
      }
    }
    return 'ok';
  }

  private phish(personId: string): Outcome {
    const mail = this.ctx.world.mailServer(this.targetOrg);
    if (!mail) {
      return 'fail';
    }
    const lure = this.ctx.rng.pick(LURES);
    const sent = sendPhish(this.ctx, this.ip, this.targetOrg, personId, lure, this.ip, (device) => {
      this.pendingPhish = Math.max(0, this.pendingPhish - 1);
      this.footholds.set(device.key, device.compromise?.level ?? 'user');
      this.note(`${device.hostname} calls home: the lure worked`);
    });
    if (sent.delivered) {
      this.pendingPhish++;
      this.ctx.clock.at(420_000, () => {
        this.pendingPhish = Math.max(0, this.pendingPhish - 1);
      });
    }
    return this.outcome(this.targetOrg, sent.delivered);
  }
}
