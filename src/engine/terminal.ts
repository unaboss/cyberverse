// The learner's attack terminal on predator rounds. In simulated mode it
// understands the commands a junior pentester uses first (nmap, hydra,
// msfconsole, sqlmap, curl, gobuster, ssh, psql, swaks) and answers the way the
// real tools do. Every command runs through the same toolkit as the live
// attacker, so the target's sensors and defender react to it for real.
// In live mode this is replaced by a real Kali shell.

import {
  bruteForce,
  dirBust,
  dumpCredentials,
  exfiltrate,
  fetchUrl,
  modbusWrite,
  pingSweep,
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
import { hostsIn, inCidr } from '../world/net.ts';

type Mode =
  | { kind: 'kali' }
  | { kind: 'msf'; module: string | null; options: Record<string, string> }
  | { kind: 'shell'; host: string; user: string }
  | { kind: 'db'; host: string; user: string }
  | { kind: 'password'; next: (password: string) => Promise<string> };

interface MsfSession {
  id: number;
  host: string;
  level: 'user' | 'root';
  via: string;
}

const MODULE_INFO: Record<string, { name: string; rank: string; date: string }> = {
  'exploit/multi/samba/usermap_script': { name: 'Samba "username map script" Command Execution', rank: 'excellent', date: '2007-05-14' },
  'exploit/multi/http/tomcat_mgr_upload': { name: 'Apache Tomcat Manager Authenticated Upload Code Execution', rank: 'excellent', date: '2009-11-09' },
  'exploit/multi/http/geoserver_unauth_rce_cve_2024_36401': { name: 'GeoServer Unauthenticated Remote Code Execution', rank: 'excellent', date: '2024-07-01' },
  'exploit/multi/http/jupyter_notebook_rce': { name: 'Jupyter Notebook Unauthenticated Code Execution', rank: 'great', date: '2019-03-27' },
  'exploit/unix/ftp/vsftpd_234_backdoor': { name: 'VSFTPD v2.3.4 Backdoor Command Execution', rank: 'excellent', date: '2011-07-03' },
  'exploit/windows/smb/ms17_010_eternalblue': { name: 'MS17-010 EternalBlue SMB Remote Windows Kernel Pool Corruption', rank: 'average', date: '2017-03-14' },
  'exploit/multi/http/apache_normalize_path_rce': { name: 'Apache 2.4.49/2.4.50 Traversal RCE', rank: 'excellent', date: '2021-05-10' },
  'upload-webshell': { name: 'Unrestricted File Upload to Web Shell', rank: 'excellent', date: '2019-02-11' },
  'exploit/linux/http/nvr_web_rce': { name: 'NVR Web Admin Default Credentials Command Execution', rank: 'excellent', date: '2021-09-02' },
};

// Weaknesses that yield a shell but are not named with an exploit/ path (web
// flaws the learner's msf can still use, like a file upload that runs code).
const SHELL_MODULES = new Set(['upload-webshell']);

const DEFAULT_USERS = ['admin', 'root', 'administrator', 'user', 'test', 'backup', 'svc_backup', 'deploy', 'engineer', 'guest'];

export class Terminal {
  mode: Mode = { kind: 'kali' };
  readonly discovered = new Map<string, PortResult[]>();
  readonly loot: (Found & { host: string; source: string })[] = [];
  readonly stolen: string[] = [];
  /** Data sets only partly copied before a transfer was cut off. */
  readonly partial: string[] = [];
  readonly sessions: MsfSession[] = [];
  readonly scopeViolations: string[] = [];
  readonly history: string[] = [];
  private nextSession = 1;

  private readonly ctx: Ctx;
  ip: string;
  private readonly scopeOrg: string;
  /** Exit addresses the tester may switch between (a VPN with a few exits). */
  private readonly exits: string[];

  constructor(
    ctx: Ctx,
    exits: string[],
    scopeOrg: string,
  ) {
    this.ctx = ctx;
    this.exits = exits.slice(0, 3);
    this.ip = this.exits[0] ?? '10.88.0.143';
    this.scopeOrg = scopeOrg;
    ctx.notify = (message) => this.print(message);
  }

  /**
   * Begin the round already holding a shell on a host, for an internal floor
   * that picks up where a foothold was won. The host is marked compromised and
   * a session is opened on it, as if an earlier exploit had landed.
   */
  seedFoothold(systemId: string): void {
    const host = this.ctx.world.resolveSystem(this.scopeOrg, systemId);
    if (!host) {
      return;
    }
    host.compromise = host.compromise ?? { level: 'root', by: 'learner', at: this.ctx.clock.now };
    const id = this.nextSession++;
    this.sessions.push({ id, host: host.key, level: host.compromise.level, via: this.ip });
    this.remember(host, []);
  }

  get prompt(): string {
    switch (this.mode.kind) {
      case 'kali':
        return '┌──(kali㉿kali)-[~]\n└─$ ';
      case 'msf':
        return this.mode.module ? `msf6 ${this.mode.module.split('/')[0]}(${this.mode.module.split('/').slice(1).join('/')}) > ` : 'msf6 > ';
      case 'shell': {
        const host = this.ctx.world.hosts.get(this.mode.host);
        return `${this.mode.user}@${host?.hostname ?? 'target'}:~$ `;
      }
      case 'db':
        return 'dwh=> ';
      case 'password':
        return 'password: ';
    }
  }

  /** Output that arrives later, such as a phishing session calling back. */
  private print(text: string): void {
    this.ctx.bus.emit({ kind: 'terminal.output', actor: 'system', summary: 'terminal output', data: { text } });
  }

  async run(raw: string): Promise<string> {
    const line = raw.trim();
    if (this.mode.kind === 'password') {
      const next = this.mode.next;
      this.mode = { kind: 'kali' };
      return next(line);
    }
    if (line === '') {
      return '';
    }
    this.history.push(line);
    this.ctx.bus.emit({ kind: 'terminal.command', actor: 'learner', malicious: true, org: this.scopeOrg, summary: line });
    switch (this.mode.kind) {
      case 'msf':
        return this.msf(line);
      case 'shell':
        return this.shell(line);
      case 'db':
        return this.db(line);
      default:
        return this.kali(line, this.home());
    }
  }

  private home(): Endpoint {
    return { ip: this.ip, org: null, zone: 'internet' };
  }

  private target(name: string): HostState | undefined {
    return this.ctx.world.lookup(name.replace(/^https?:\/\//, '').split(/[/:]/)[0] ?? name);
  }

  private checkScope(host: HostState | undefined, ip: string): void {
    const outOfScope = host ? host.org !== this.scopeOrg : !this.ctx.world.isLabAddress(ip) || this.ctx.world.zoneOfIp(ip).org !== this.scopeOrg;
    if (outOfScope && !this.scopeViolations.includes(ip)) {
      this.scopeViolations.push(ip);
      this.ctx.bus.emit({ kind: 'scope.violation', actor: 'learner', malicious: true, org: this.scopeOrg, dst: ip, summary: `Touched ${host?.fqdn ?? ip}, which is outside the signed scope` });
    }
  }

  private remember(host: HostState | undefined, ports: PortResult[]): void {
    if (!host) {
      return;
    }
    const merged = new Map((this.discovered.get(host.key) ?? []).map((p) => [p.port, p] as const));
    for (const port of ports.filter((p) => p.state === 'open')) {
      merged.set(port.port, port);
    }
    this.discovered.set(host.key, [...merged.values()].sort((a, b) => a.port - b.port));
    this.ctx.bus.emit({ kind: 'terminal.discovered', actor: 'system', summary: host.key, data: { host: host.key } });
  }

  // ------------------------------------------------------------ kali shell

  private async kali(line: string, from: Endpoint): Promise<string> {
    const [cmd, ...args] = splitArgs(line);
    switch (cmd) {
      case 'help':
        return HELP;
      case 'whoami':
        return this.mode.kind === 'shell' ? this.mode.user : 'kali';
      case 'hostname':
        return 'kali';
      case 'id':
        return 'uid=1000(kali) gid=1000(kali) groups=1000(kali),27(sudo)';
      case 'ip':
      case 'ifconfig':
        return `eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet ${from.ip}  netmask 255.255.255.0  broadcast 10.88.0.255`;
      case 'ls':
        return 'Desktop  Documents  users.txt  scope-letter.pdf\n(/usr/share/wordlists: rockyou.txt  common.txt)';
      case 'cat':
        return this.catLocal(args[0] ?? '');
      case 'nmap':
        return this.nmap(args, from);
      case 'hydra':
        return this.hydra(args, from);
      case 'searchsploit':
        return this.searchsploit(args.join(' '));
      case 'msfconsole':
        this.mode = { kind: 'msf', module: null, options: {} };
        return `${MSF_BANNER}\n       =[ metasploit v6.4.38-dev ]\n+ -- --=[ 2461 exploits - 1268 auxiliary - 431 post ]`;
      case 'sqlmap':
        return this.sqlmap(args, from);
      case 'curl':
        return this.curl(args, from);
      case 'gobuster':
        return this.gobuster(args, from);
      case 'ssh':
        return this.ssh(args, from);
      case 'psql':
        return this.psql(args, from);
      case 'swaks':
        return this.swaks(args, from);
      case 'modbus':
        return this.modbus(args, from);
      case 'sessions':
        return this.sessionsCmd(args);
      case 'loot':
        return this.lootText();
      case 'vpn':
        return this.vpn(args);
      default:
        return `${cmd}: command not found. Type help for the tools in this lab.`;
    }
  }

  private catLocal(file: string): string {
    if (file === 'users.txt') {
      return DEFAULT_USERS.join('\n');
    }
    if (file === 'scope-letter.pdf') {
      return `AUTHORISATION TO TEST\nClient: ${this.ctx.world.orgs.get(this.scopeOrg)?.name}\nIn scope: every system of ${this.ctx.world.orgs.get(this.scopeOrg)?.domain}\nOut of scope: everything else, including DataQuant's own systems.\nWindow: tonight only. Stop if anything safety-critical misbehaves.`;
    }
    return `cat: ${file}: No such file or directory`;
  }

  // ------------------------------------------------------------------ nmap

  private async nmap(args: string[], from: Endpoint): Promise<string> {
    let timing = 3;
    let ports: number[] | null = null;
    let pingOnly = false;
    let versions = false;
    let skipPing = false;
    const targets: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (/^-T[0-5]$/.test(a)) timing = Number(a[2]);
      else if (a === '-sn') pingOnly = true;
      else if (a === '-sV' || a === '-A') versions = true;
      else if (a === '-Pn') skipPing = true;
      else if (a === '-F') ports = topPorts(100);
      else if (a === '-p-') ports = Array.from({ length: 65535 }, (_, k) => k + 1);
      else if (a === '-p') ports = parsePorts(args[++i] ?? '');
      else if (a.startsWith('-p')) ports = parsePorts(a.slice(2));
      else if (a === '--top-ports') ports = topPorts(Number(args[++i] ?? 1000));
      else if (a.startsWith('-')) continue;
      else targets.push(a);
    }
    if (targets.length === 0) {
      return 'Nmap 7.94SVN ( https://nmap.org )\nUsage: nmap [Scan Type(s)] [Options] {target specification}';
    }
    const addresses: string[] = [];
    for (const t of targets) {
      if (t.includes('/')) {
        if (!inCidr(t.split('/')[0]!, this.ctx.world.labRange)) {
          return `Refusing to scan ${t}: outside the lab range ${this.ctx.world.labRange}.`;
        }
        addresses.push(...hostsIn(t));
      } else {
        const host = this.target(t);
        if (!host && !this.ctx.world.isLabAddress(t)) {
          return `Failed to resolve "${t}".\nWARNING: No targets were specified, so 0 hosts scanned.`;
        }
        addresses.push(host?.ip ?? t);
      }
    }
    const started = Date.parse('2026-11-21T00:00:00Z') + this.ctx.clock.timeOfDayMs();
    const t0 = this.ctx.clock.now;
    const out: string[] = [`Starting Nmap 7.94SVN ( https://nmap.org ) at 2026-11-21 ${this.ctx.clock.clockText().slice(0, 5)} SAST`];
    void started;
    for (const ip of addresses) {
      this.checkScope(this.ctx.world.byIp.get(ip), ip);
    }
    if (pingOnly) {
      const up = await pingSweep(this.ctx, from, addresses, timing);
      for (const ip of up) {
        const host = this.ctx.world.byIp.get(ip);
        this.remember(host, []);
        out.push(`Nmap scan report for ${host ? `${host.fqdn} (${ip})` : ip}`, 'Host is up (0.0021s latency).');
      }
      out.push(`Nmap done: ${addresses.length} IP address${addresses.length === 1 ? '' : 'es'} (${up.length} host${up.length === 1 ? '' : 's'} up) scanned in ${((this.ctx.clock.now - t0) / 1000).toFixed(2)} seconds`);
      return out.join('\n');
    }
    let upCount = 0;
    const scanPorts = ports ?? topPorts(1000);
    for (const ip of addresses) {
      const result = await portScan(this.ctx, from, ip, scanPorts, { timing, skipPing });
      if (!result.up) {
        if (addresses.length === 1) {
          out.push('Note: Host seems down. If it is really up, but blocking our ping probes, try -Pn');
        }
        continue;
      }
      upCount++;
      this.remember(result.host, result.ports);
      out.push(...formatScan(result.host, ip, result.ports, versions, scanPorts.length));
    }
    out.push(`Nmap done: ${addresses.length} IP address${addresses.length === 1 ? '' : 'es'} (${upCount} host${upCount === 1 ? '' : 's'} up) scanned in ${((this.ctx.clock.now - t0) / 1000).toFixed(2)} seconds`);
    return out.join('\n');
  }

  // ----------------------------------------------------------------- hydra

  private async hydra(args: string[], from: Endpoint): Promise<string> {
    let users: string[] = [];
    let passwords: string[] = [];
    let tasks = 16;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === '-l') users = [args[++i] ?? ''];
      else if (a === '-L') users = this.listFile(args[++i] ?? '');
      else if (a === '-p') passwords = [args[++i] ?? ''];
      else if (a === '-P') passwords = this.listFile(args[++i] ?? '');
      else if (a === '-t') tasks = Number(args[++i] ?? 16);
      else if (!a.startsWith('-')) rest.push(a);
    }
    let service = '';
    let targetName = '';
    if (rest[0]?.includes('://')) {
      [service, targetName] = rest[0].split('://') as [string, string];
    } else {
      targetName = rest[0] ?? '';
      service = rest[1] ?? '';
    }
    const host = this.target(targetName);
    if (!host || users.length === 0 || passwords.length === 0 || !service) {
      return 'Syntax: hydra [-l LOGIN|-L FILE] [-p PASS|-P FILE] [-t TASKS] service://server\nExample: hydra -l admin -P /usr/share/wordlists/rockyou.txt ssh://10.88.20.20';
    }
    this.checkScope(host, host.ip);
    const header = `Hydra v9.5 (c) 2023 by van Hauser/THC & David Maciejak\n[DATA] max ${tasks} tasks per 1 server, overall ${tasks} tasks, ${users.length * passwords.length} login tries (l:${users.length}/p:${passwords.length})\n[DATA] attacking ${service}://${host.ip}:${''}`;
    const result = await bruteForce(this.ctx, from, host, service.replace('https-post-form', 'https'), users, passwords, { tasks });
    if (result.stoppedBy === 'unreachable') {
      return `${header}\n[ERROR] could not connect to ${service}://${host.ip}`;
    }
    if (result.stoppedBy === 'no-service') {
      return `${header}\n[ERROR] target does not support ${service}`;
    }
    const lines = [header.replace(/:$/, '')];
    for (const f of result.found) {
      lines.push(`[${portLabel(service)}][${service}] host: ${host.ip}   login: ${f.user}   password: ${f.password}`);
      this.addLoot({ ...f, host: host.key, source: `hydra ${service}` });
    }
    lines.push(`1 of 1 target ${result.found.length > 0 ? 'successfully completed' : 'completed'}, ${result.found.length} valid password${result.found.length === 1 ? '' : 's'} found`);
    return lines.join('\n');
  }

  private listFile(name: string): string[] {
    if (name.includes('rockyou') || name.includes('wordlist') || name.includes('passwords')) {
      return this.ctx.world.wordlist;
    }
    if (name.includes('users')) {
      return DEFAULT_USERS;
    }
    return [];
  }

  private addLoot(item: Found & { host: string; source: string }): void {
    if (!this.loot.some((l) => l.host === item.host && l.user === item.user)) {
      this.loot.push(item);
    }
  }

  // ------------------------------------------------------- exploits, msf

  private exploitCatalogue(): { module: string; product: string; version: string }[] {
    const out: { module: string; product: string; version: string }[] = [];
    for (const host of this.ctx.world.hosts.values()) {
      for (const w of host.weaknesses) {
        const svc = host.services.find((s) => s.port === w.port);
        if ((w.module?.startsWith('exploit/') || SHELL_MODULES.has(w.module ?? '')) && svc && !out.some((e) => e.module === w.module)) {
          out.push({ module: w.module!, product: svc.product, version: svc.version });
        }
      }
    }
    for (const module of Object.keys(MODULE_INFO)) {
      if (!out.some((e) => e.module === module)) {
        out.push({ module, product: module.split('/')[2] ?? '', version: '' });
      }
    }
    return out;
  }

  private searchsploit(terms: string): string {
    const words = terms.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = this.exploitCatalogue().filter((e) => words.every((w) => `${e.module} ${e.product} ${e.version} ${MODULE_INFO[e.module]?.name ?? ''}`.toLowerCase().includes(w)));
    if (hits.length === 0) {
      return 'Exploits: No Results\nShellcodes: No Results';
    }
    const rows = hits.map((h) => ` ${(MODULE_INFO[h.module]?.name ?? h.module).padEnd(62)} | ${h.module}`);
    return [' Exploit Title'.padEnd(64) + '|  Path', '-'.repeat(100), ...rows].join('\n');
  }

  private async msf(line: string): Promise<string> {
    const mode = this.mode as Extract<Mode, { kind: 'msf' }>;
    const [cmd, ...args] = splitArgs(line);
    switch (cmd) {
      case 'search': {
        const words = args.join(' ').toLowerCase();
        const hits = this.exploitCatalogue().filter((e) => `${e.module} ${e.product} ${MODULE_INFO[e.module]?.name ?? ''}`.toLowerCase().includes(words));
        if (hits.length === 0) {
          return '[-] No results from search';
        }
        return ['Matching Modules', '================', '', '   #  Name                                                          Disclosure Date  Rank       Description', ...hits.map((h, i) => `   ${i}  ${h.module.padEnd(62)}${(MODULE_INFO[h.module]?.date ?? '').padEnd(17)}${(MODULE_INFO[h.module]?.rank ?? 'normal').padEnd(11)}${MODULE_INFO[h.module]?.name ?? ''}`)].join('\n');
      }
      case 'use': {
        const module = args[0] ?? '';
        if (!this.exploitCatalogue().some((e) => e.module === module)) {
          return `[-] Failed to load module: ${module}`;
        }
        mode.module = module;
        return `[*] No payload configured, defaulting to cmd/unix/reverse_netcat`;
      }
      case 'set': {
        const key = (args[0] ?? '').toUpperCase();
        mode.options[key] = args[1] ?? '';
        return `${key} => ${args[1] ?? ''}`;
      }
      case 'show':
      case 'options':
        return `Module options (${mode.module ?? 'none'}):\n\n   Name      Current Setting\n   ----      ---------------\n   RHOSTS    ${mode.options['RHOSTS'] ?? ''}\n   RPORT     ${mode.options['RPORT'] ?? ''}\n   USERNAME  ${mode.options['USERNAME'] ?? ''}\n   PASSWORD  ${mode.options['PASSWORD'] ?? ''}\n   LHOST     ${this.ip}`;
      case 'run':
      case 'exploit':
        return this.msfRun(mode);
      case 'sessions':
        return this.sessionsCmd(args);
      case 'back':
        mode.module = null;
        return '';
      case 'exit':
      case 'quit':
        this.mode = { kind: 'kali' };
        return '';
      default:
        return `[-] Unknown command: ${cmd}`;
    }
  }

  private async msfRun(mode: Extract<Mode, { kind: 'msf' }>): Promise<string> {
    if (!mode.module) {
      return '[-] No module selected.';
    }
    const host = this.target(mode.options['RHOSTS'] ?? '');
    if (!host) {
      return '[-] Msf::OptionValidateError One or more options failed to validate: RHOSTS.';
    }
    this.checkScope(host, host.ip);
    const from = this.bestEndpoint(host);
    const port = mode.options['RPORT'] ? Number(mode.options['RPORT']) : undefined;
    const lines = [`[*] Started reverse TCP handler on ${this.ip}:4444`, `[*] ${host.ip}:${port ?? ''} - Running exploit...`];
    const result = await runExploit(this.ctx, from, host, mode.module, {
      ...(mode.options['USERNAME'] ? { username: mode.options['USERNAME'] } : {}),
      ...(mode.options['PASSWORD'] ? { password: mode.options['PASSWORD'] } : {}),
      ...(port ? { port } : {}),
    });
    if (!result.ok) {
      lines.push(`[-] ${result.reason}`);
      return lines.join('\n');
    }
    const id = this.nextSession++;
    this.sessions.push({ id, host: host.key, level: result.level ?? 'user', via: from.ip });
    this.remember(host, []);
    lines.push(`[*] Command shell session ${id} opened (${this.ip}:4444 -> ${host.ip}:${40000 + id}) at 2026-11-21 ${this.ctx.clock.clockText()} +0200`);
    lines.push(`Type: sessions -i ${id}`);
    return lines.join('\n');
  }

  private sessionsCmd(args: string[]): string {
    if (args[0] === '-i') {
      const session = this.sessions.find((s) => s.id === Number(args[1]));
      const host = session ? this.ctx.world.hosts.get(session.host) : undefined;
      if (!session || !host) {
        return '[-] Invalid session identifier';
      }
      if (host.status !== 'up' || !host.compromise) {
        return `[-] Session ${session.id} is no longer active (the target dropped off the network)`;
      }
      this.mode = { kind: 'shell', host: host.key, user: session.level === 'root' ? 'root' : 'www-data' };
      return `[*] Starting interaction with ${session.id}...`;
    }
    if (this.sessions.length === 0) {
      return 'Active sessions\n===============\n\nNo active sessions.';
    }
    return ['Active sessions', '===============', '', '  Id  Type   Connection', ...this.sessions.map((s) => {
      const host = this.ctx.world.hosts.get(s.host)!;
      const alive = host.status === 'up' && host.compromise ? '' : '  (dead)';
      return `  ${s.id}   shell  ${s.via} -> ${host.ip} (${host.hostname})${alive}`;
    })].join('\n');
  }

  /** Attack from inside if a session reaches the target, else from Kali. */
  private bestEndpoint(host: HostState): Endpoint {
    for (const s of this.sessions) {
      const foothold = this.ctx.world.hosts.get(s.host);
      if (foothold && foothold.status === 'up' && foothold.compromise && foothold.key !== host.key) {
        const from = this.ctx.world.endpointFor(foothold.ip);
        const port = host.services[0]?.port ?? 0;
        if (this.ctx.world.reach(from, host, port) === 'ok') {
          return from;
        }
      }
    }
    return this.home();
  }

  // ------------------------------------------------------------------- web

  private url(args: string[]): { host: HostState | undefined; path: string; port?: number; raw: string } {
    const raw = args.find((a) => a.includes('://') || a.includes('.internal') || /^\d+\.\d+\.\d+\.\d+/.test(a)) ?? '';
    const match = /^(?:https?:\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(raw.replace(/^["']|["']$/g, ''));
    const host = match ? this.ctx.world.lookup(match[1]!) : undefined;
    return { host, path: match?.[3] ?? '/', ...(match?.[2] ? { port: Number(match[2]) } : {}), raw };
  }

  private async sqlmap(args: string[], from: Endpoint): Promise<string> {
    const flagU = args.indexOf('-u');
    const { host, path } = this.url(flagU >= 0 ? [args[flagU + 1] ?? ''] : args);
    if (!host) {
      return 'sqlmap/1.8.2: no target URL given. Usage: sqlmap -u "https://host/page.php?id=1" --batch --dump';
    }
    this.checkScope(host, host.ip);
    const via = this.bestEndpoint(host);
    const result = await sqlInjection(this.ctx, via.ip === this.ip ? from : via, host, path);
    const lines = ['        ___\n       __H__\n ___ ___[.]_____ ___ ___  {1.8.2#stable}', `[*] starting @ ${this.ctx.clock.clockText()}`, `[INFO] testing connection to the target URL`];
    if (!result.vulnerable) {
      lines.push(`[WARNING] GET parameter 'id' does not seem to be injectable`, `[CRITICAL] all tested parameters do not appear to be injectable.`);
      return lines.join('\n');
    }
    lines.push(`[INFO] GET parameter 'id' is 'MySQL >= 5.0 AND error-based' injectable`, `sqlmap identified the following injection point(s) with a total of ${result.requests} HTTP(s) requests:`, `---\nParameter: id (GET)\n    Type: boolean-based blind\n    Payload: id=1 AND 4521=4521\n---`, '[INFO] the back-end DBMS is MySQL');
    if (args.includes('--dump') || args.includes('--dbs') || args.includes('-T')) {
      for (const key of result.exposes) {
        const data = this.ctx.world.dataByKey(key)!;
        lines.push(`[INFO] fetching entries for table '${data.path}'`, `Database: billing\nTable: customers\n[${(data.records ?? 0).toLocaleString('en-ZA')} entries]`);
        lines.push(...sampleRows(data.name));
        const sent = await exfiltrate(this.ctx, host, key, this.ip, 'web');
        this.track(key, sent);
        if (sent.ok) {
          lines.push(`[INFO] table dumped to /home/kali/.local/share/sqlmap/output/${host.fqdn}/dump/billing/customers.csv`);
        } else {
          lines.push(`[CRITICAL] connection timed out to the target URL. sqlmap is going to retry the request(s)`, `[ERROR] dump interrupted: ${sent.reason}`);
        }
      }
    }
    return lines.join('\n');
  }

  private async curl(args: string[], from: Endpoint): Promise<string> {
    const { host, path, port } = this.url(args);
    if (!host) {
      return 'curl: (6) Could not resolve host';
    }
    this.checkScope(host, host.ip);
    const via = this.bestEndpoint(host);
    const result = fetchUrl(this.ctx, via.ip === this.ip ? from : via, host, path, port);
    if (!result) {
      return `curl: (28) Failed to connect to ${host.fqdn} port ${port ?? 443} after 21003 ms: Timeout was reached`;
    }
    if (result.reveals) {
      this.addLoot({ ...result.reveals, source: `${host.fqdn}${path}` });
    }
    for (const key of result.exposes) {
      if (!this.stolen.includes(key) && (args.includes('-O') || args.includes('-o'))) {
        const sent = await exfiltrate(this.ctx, host, key, this.ip, 'web');
        this.track(key, sent);
      }
    }
    return result.body + (result.exposes.length > 0 ? '\n(add -O to download it)' : '');
  }

  private async gobuster(args: string[], from: Endpoint): Promise<string> {
    const flagU = args.indexOf('-u');
    const { host, port } = this.url(flagU >= 0 ? [args[flagU + 1] ?? ''] : args);
    if (!host) {
      return 'Usage: gobuster dir -u https://host -w /usr/share/wordlists/common.txt';
    }
    this.checkScope(host, host.ip);
    const via = this.bestEndpoint(host);
    const found = await dirBust(this.ctx, via.ip === this.ip ? from : via, host, port);
    return ['===============================================================', 'Gobuster v3.6', '===============================================================', `[+] Url: ${host.fqdn}`, ...found.map((p) => `${p.padEnd(24)} (Status: 200)`), '===============================================================', 'Finished'].join('\n');
  }

  // ------------------------------------------------------ ssh, psql, mail

  private ssh(args: string[], from: Endpoint): Promise<string> | string {
    const spec = args.find((a) => a.includes('@')) ?? '';
    const [user, name] = spec.split('@');
    const host = this.target(name ?? '');
    if (!host || !user) {
      return 'usage: ssh user@host';
    }
    this.checkScope(host, host.ip);
    this.mode = {
      kind: 'password',
      next: async (password) => {
        const via = this.bestEndpoint(host);
        const result = tryLogin(this.ctx, via.ip === this.ip ? from : via, host, 'ssh', user, password);
        if (result === 'unreachable' || result === 'no-service') {
          return `ssh: connect to host ${host.fqdn} port 22: Connection timed out`;
        }
        if (result !== 'ok') {
          return `Permission denied, please try again.${result === 'locked' ? ' (account locked)' : ''}`;
        }
        const account = host.accounts.find((a) => a.user === user);
        const level = account?.role === 'admin' ? 'root' : 'user';
        host.compromise = host.compromise ?? { level, by: 'learner', at: this.ctx.clock.now };
        const id = this.nextSession++;
        this.sessions.push({ id, host: host.key, level, via: from.ip });
        this.remember(host, []);
        this.mode = { kind: 'shell', host: host.key, user };
        return `Welcome to ${host.os}\nLast login: Fri Nov 20 17:02:11 2026 from 10.88.21.20`;
      },
    };
    return `${user}@${host.fqdn}'s password: `;
  }

  private psql(args: string[], from: Endpoint): string {
    const h = args[args.indexOf('-h') + 1] ?? '';
    const user = args[args.indexOf('-U') + 1] ?? '';
    const host = args.includes('-h') ? this.target(h) : undefined;
    if (!host || !args.includes('-U')) {
      return 'usage: psql -h host -U user';
    }
    this.checkScope(host, host.ip);
    this.mode = {
      kind: 'password',
      next: async (password) => {
        const via = this.bestEndpoint(host);
        const result = tryLogin(this.ctx, via.ip === this.ip ? from : via, host, 'postgresql', user, password);
        if (result === 'unreachable' || result === 'no-service') {
          return `psql: error: connection to server at "${host.fqdn}" (${host.ip}), port 5432 failed: Connection timed out`;
        }
        if (result !== 'ok') {
          return `psql: error: FATAL:  password authentication failed for user "${user}"`;
        }
        this.mode = { kind: 'db', host: host.key, user };
        return `psql (16.4, server 14.10)\nSSL connection (protocol: TLSv1.3)\nType "help" for help.`;
      },
    };
    return `Password for user ${user}: `;
  }

  private swaks(args: string[], from: Endpoint): string {
    const to = args[args.indexOf('--to') + 1] ?? '';
    const attach = args.includes('--attach') ? (args[args.indexOf('--attach') + 1] ?? 'invoice.docm') : '';
    const [local, domain] = to.split('@');
    const org = [...this.ctx.world.orgs.values()].find((o) => o.domain === domain);
    if (!org || !local) {
      return '*** No recipient. Usage: swaks --to person@siyakhula.internal --attach Invoice.docm';
    }
    const person = org.resolved.people.find((p) => p.name.split(' ')[0]!.toLowerCase() === local.toLowerCase());
    if (!person) {
      return `<** 550 5.1.1 <${to}>: Recipient address rejected: User unknown`;
    }
    const mail = this.ctx.world.mailServer(org.id);
    this.checkScope(mail, mail?.ip ?? '');
    if (!attach) {
      return '=== Connected. Message sent, but with no attachment nothing will run.';
    }
    const sent = sendPhish(this.ctx, from.ip, org.id, person.id, attach, this.ip, (device) => {
      const id = this.nextSession++;
      this.sessions.push({ id, host: device.key, level: device.compromise?.level ?? 'user', via: device.ip });
      this.remember(device, []);
      this.print(`\n[*] Command shell session ${id} opened (${this.ip}:443 -> ${device.ip}) : ${person.name} opened ${attach}\nType: sessions -i ${id}`);
    });
    return sent.delivered ? `=== Trying ${mail?.fqdn}:25...\n<-  250 2.0.0 Ok: queued\n=== Connection closed with remote host.` : `*** ${sent.reason}`;
  }

  private modbus(args: string[], from: Endpoint): string {
    const [verb, target, register, value] = args;
    const host = this.target(target ?? '');
    if (!host || (verb !== 'read' && verb !== 'write')) {
      return 'usage: modbus read <host> | modbus write <host> <register> <value>';
    }
    this.checkScope(host, host.ip);
    const via = this.bestEndpoint(host);
    const endpoint = via.ip === this.ip ? from : via;
    if (verb === 'read') {
      if (this.ctx.world.reach(endpoint, host, 502) !== 'ok') {
        return `Connection to ${host.ip}:502 timed out.`;
      }
      return '[40001]: 12  (chlorine dose, 0.1 mg/l)\n[40002]: 450 (flow setpoint, l/s)\n[40003]: 1   (auto mode)';
    }
    const result = modbusWrite(this.ctx, endpoint, host, Number(register ?? 40001), Number(value ?? 0));
    return result.reason;
  }

  // ------------------------------------------------------- inside a host

  private async shell(line: string): Promise<string> {
    const mode = this.mode as Extract<Mode, { kind: 'shell' }>;
    const host = this.ctx.world.hosts.get(mode.host)!;
    if (host.status !== 'up' || !host.compromise) {
      this.mode = { kind: 'kali' };
      return `[*] ${host.ip} - Command shell session closed. Reason: Died`;
    }
    const [cmd, ...args] = splitArgs(line);
    const here = this.ctx.world.endpointFor(host.ip);
    switch (cmd) {
      case 'exit':
      case 'background':
        this.mode = { kind: 'kali' };
        return '';
      case 'whoami':
        return mode.user;
      case 'hostname':
        return host.hostname;
      case 'id':
        return mode.user === 'root' ? 'uid=0(root) gid=0(root) groups=0(root)' : `uid=33(${mode.user}) gid=33(${mode.user})`;
      case 'ip':
      case 'ifconfig':
        return `eth0: inet ${host.ip}  netmask 255.255.255.0`;
      case 'ls':
        return this.ls(host, args[0] ?? '~');
      case 'cat':
        if (args[0] === '/etc/shadow' || args[0] === 'SAM') {
          return this.dump(host, mode.user);
        }
        return `cat: ${args[0] ?? ''}: Permission denied`;
      case 'mimikatz':
      case 'hashdump':
        return this.dump(host, mode.user);
      case 'download':
        return this.download(host, args[0] ?? '');
      case 'ps':
        return '  PID TTY          TIME CMD\n    1 ?        00:00:03 init\n  812 ?        00:00:00 sshd\n 1440 ?        00:00:00 sh';
      case 'nmap':
      case 'hydra':
      case 'curl':
      case 'ssh':
      case 'psql':
      case 'modbus':
      case 'sqlmap':
      case 'gobuster':
        return this.kali(line, here);
      default:
        return `sh: 1: ${cmd}: not found`;
    }
  }

  private ls(host: HostState, path: string): string {
    const data = host.data.filter((d) => path === '~' || path === '/' || d.path.startsWith(path) || path.startsWith(d.path));
    const base = path === '/' ? 'bin  etc  home  opt  srv  tmp  usr  var' : '';
    const files = data.map((d) => `${d.path}  (${d.name}, ${d.records ?? '?'} records)`);
    return [base, ...files].filter(Boolean).join('\n') || 'total 0';
  }

  private dump(host: HostState, user: string): string {
    if (user !== 'root' && host.compromise?.level !== 'root') {
      return 'Permission denied (you need root)';
    }
    const found = dumpCredentials(this.ctx, host);
    for (const f of found) {
      this.addLoot({ ...f, host: host.key, source: `dumped on ${host.hostname}` });
    }
    if (found.length === 0) {
      return 'Hashes dumped; none cracked with the lab wordlist.';
    }
    return found.map((f) => `${f.user}:${'$6$' + f.user.length + 'x'.repeat(8)}...  -> cracked: ${f.password}`).join('\n');
  }

  private async download(host: HostState, path: string): Promise<string> {
    const data = host.data.find((d) => path && (d.path.startsWith(path) || path.startsWith(d.path)));
    if (!data) {
      return `download: ${path}: No such file`;
    }
    const result = await exfiltrate(this.ctx, host, data.key, this.ip, 'shell');
    this.track(data.key, result);
    if (!result.ok) {
      return `[-] Download failed: ${result.reason}`;
    }
    return `[*] Downloaded ${(result.bytes / 1_000_000).toFixed(1)} MB: ${data.name} -> /home/kali/loot/${host.hostname}/`;
  }

  private async db(line: string): Promise<string> {
    const mode = this.mode as Extract<Mode, { kind: 'db' }>;
    const host = this.ctx.world.hosts.get(mode.host)!;
    if (line === '\\q') {
      this.mode = { kind: 'kali' };
      return '';
    }
    if (line === '\\dt') {
      return ['          List of relations', ' Schema |       Name        | Type  ', '--------+-------------------+-------', ...host.data.map((d) => ` ${d.path.split('.')[0]?.padEnd(6)} | ${(d.path.split('.')[1] ?? d.id).padEnd(17)} | table`)].join('\n');
    }
    const copy = /^\\copy\s+(\S+)/i.exec(line) ?? /^select\s+\*\s+from\s+(\S+)/i.exec(line);
    if (copy) {
      const data = host.data.find((d) => d.path.endsWith(copy[1]!.replace(/;$/, '')) || d.path === copy[1]);
      if (!data) {
        return `ERROR:  relation "${copy[1]}" does not exist`;
      }
      const result = await exfiltrate(this.ctx, host, data.key, this.ip, 'database');
      this.track(data.key, result);
      if (!result.ok) {
        return `ERROR:  could not send data to client: ${result.reason}`;
      }
      return [...sampleRows(data.name), `(${(data.records ?? 0).toLocaleString('en-ZA')} rows)`].join('\n');
    }
    return 'ERROR:  syntax error. Try \\dt, SELECT * FROM <table>; or \\q';
  }

  private track(key: string, sent: { ok: boolean; bytes: number }): void {
    if (sent.ok) {
      if (!this.stolen.includes(key)) {
        this.stolen.push(key);
      }
      const i = this.partial.indexOf(key);
      if (i >= 0) {
        this.partial.splice(i, 1);
      }
    } else if (sent.bytes > 0 && !this.stolen.includes(key) && !this.partial.includes(key)) {
      this.partial.push(key);
    }
  }

  private vpn(args: string[]): string {
    if (args[0] !== 'next') {
      const list = this.exits.map((ip) => `  ${ip === this.ip ? '*' : ' '} ${ip}${this.ctx.world.isBlocked(ip, this.scopeOrg) ? '  (blocked by the target)' : ''}`);
      return `VPN exits:\n${list.join('\n')}\nUse "vpn next" to switch exit.`;
    }
    const at = this.exits.indexOf(this.ip);
    const next = this.exits.slice(at + 1).find((ip) => !this.ctx.world.isBlocked(ip, this.scopeOrg));
    if (!next) {
      return 'No unused VPN exits left. Every exit you had is burned.';
    }
    this.ip = next;
    return `Connected. Your traffic now leaves from ${next}.`;
  }

  private lootText(): string {
    const creds = this.loot.map((l) => `  ${l.user}:${l.password}  (${l.host}, from ${l.source})`);
    const data = [
      ...this.stolen.map((k) => `  ${this.ctx.world.dataByKey(k)?.name ?? k}`),
      ...this.partial.map((k) => `  ${this.ctx.world.dataByKey(k)?.name ?? k} (partial: the transfer was cut off)`),
    ];
    return ['Credentials:', ...(creds.length ? creds : ['  none yet']), 'Data taken:', ...(data.length ? data : ['  none yet'])].join('\n');
  }
}

// ---------------------------------------------------------------- helpers

export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]!);
  }
  return out;
}

function parsePorts(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map(Number);
    if (a !== undefined && !Number.isNaN(a)) {
      if (b !== undefined && !Number.isNaN(b)) {
        for (let p = a; p <= b && p < 65536; p++) out.push(p);
      } else {
        out.push(a);
      }
    }
  }
  return out;
}

function portLabel(service: string): string {
  return String({ ssh: 22, smb: 445, rdp: 3389, https: 443, http: 80, postgresql: 5432, ftp: 21, vnc: 5900 }[service] ?? '');
}

function formatScan(host: HostState | undefined, ip: string, ports: PortResult[], versions: boolean, total: number): string[] {
  const open = ports.filter((p) => p.state === 'open');
  const filtered = ports.filter((p) => p.state === 'filtered').length;
  const closed = ports.filter((p) => p.state === 'closed').length;
  const lines = [`Nmap scan report for ${host ? `${host.fqdn} (${ip})` : ip}`, 'Host is up (0.0019s latency).'];
  const notShown = filtered > closed ? `${filtered} filtered tcp ports (no-response)` : `${closed} closed tcp ports (reset)`;
  if (total - open.length > 0) {
    lines.push(`Not shown: ${notShown}`);
  }
  if (open.length === 0) {
    lines.push(`All ${total} scanned ports are ${filtered > closed ? 'filtered' : 'closed'}`);
    return lines;
  }
  lines.push(versions ? 'PORT      STATE SERVICE        VERSION' : 'PORT      STATE SERVICE');
  for (const p of open) {
    const left = `${p.port}/tcp`.padEnd(10) + 'open  ' + (p.name ?? '').padEnd(15);
    lines.push(versions ? `${left}${p.product ?? ''} ${p.version ?? ''}` : left.trimEnd());
  }
  if (versions && host) {
    lines.push(`Service Info: OS: ${host.os}`);
  }
  return lines;
}

function sampleRows(name: string): string[] {
  return [
    `+---------+--------------------+---------------+----------------------+`,
    `| acc_no  | name               | id_number     | address              |`,
    `+---------+--------------------+---------------+----------------------+`,
    `| 1004421 | T. M***            | 8803*******87 | 14 Protea St         |`,
    `| 1004422 | S. N***            | 9101*******83 | 3 Ubuntu Ave         |`,
    `| 1004423 | J. v*** d*** M**** | 7612*******81 | 22 Kerk St           |`,
    `+---------+--------------------+---------------+----------------------+`,
    `(sample of ${name}; lab data is made up)`,
  ];
}

const MSF_BANNER = `
      .:okOOOkdc'           'cdkOOOko:.
    .xOOOOOOOOOOOOc       cOOOOOOOOOOOOx.
   :OOOOOOOOOOOOOOOk,   ,kOOOOOOOOOOOOOOO:
  'OOOOOOOOOkkkkOOOOO: :OOOOOOOOOOOOOOOOOO'
  oOOOOOOOO.    .oOOOOoOOOOl.    ,OOOOOOOOo
  dOOOOOOOO.      .cOOOOOc.      ,OOOOOOOOx
  lOOOOOOOO.         ;d;         ,OOOOOOOOl
  .OOOOOOOO.   .;           ;    ,OOOOOOOO.
   cOOOOOOO.   .OOc.     'oOO.   ,OOOOOOOc
    oOOOOOO.   .OOOO.   :OOOO.   ,OOOOOOo
     lOOOOO.   .OOOO.   :OOOO.   ,OOOOOl
      ;OOOO'   .OOOO.   :OOOO.   ;OOOO;
       .dOOo   .OOOOocccxOOOO.   xOOd.
         ,kOl  .OOOOOOOOOOOOO. .dOk,
           :kk;.OOOOOOOOOOOOO.cOk:
             ;kOOOOOOOOOOOOOOOk:
               ,xOOOOOOOOOOOx,
                 .lOOOOOOOl.
                    ,dOd,
                      .`;

const HELP = `Tools in this lab (simulated mode answers like the real ones):
  nmap [-sn] [-sV] [-Pn] [-p 22,80 | -F | -p-] [-T0..5] <host|range>
  hydra -l <user>|-L users.txt -p <pass>|-P rockyou.txt [-t 4] <service>://<host>
  searchsploit <product version>
  msfconsole            then: search, use, set RHOSTS, run, sessions -i <n>
  sqlmap -u "https://host/page.php?id=1" --batch --dump
  gobuster dir -u https://host -w common.txt
  curl [-O] https://host/path
  ssh user@host         psql -h host -U user
  swaks --to name@domain --attach Invoice.docm
  modbus read|write <host> [register] [value]
  loot, sessions, vpn [next], cat scope-letter.pdf
Stay inside the scope letter. Every command is seen, or missed, by the target's sensors.`;
