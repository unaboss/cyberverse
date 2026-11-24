// The vulnerability scanner: a scheduled scan the learner runs by hand from the
// SOC's scanner. It takes a little while, works through the machines in its
// scope one by one, and reports what it found, ranked by CVSS. A finding is the
// world's own weakness (fixed when a control that fixes it is on) or a plain
// finding that a named control closes. Run it again after fixing and the
// report says what turned green since the last scan: the rescan is the proof.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome } from './tool.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';
import type { HostState } from '../world.ts';

export interface FindingDef {
  id: string;
  /** The machine it is on, by system id. */
  system: string;
  port?: number;
  title: string;
  cve?: string;
  /** CVSS base score, 0 to 10. */
  cvss: number;
  /** The world weakness this finding is: fixed once a control that fixes it is on. */
  weakness?: string;
  /** Or the control that closes it, when the world has no weakness for it. */
  control?: string;
  detail: string;
  /** What fixes it, in words. */
  fix: string;
  /** What it tells an attacker, for the findings that are enumeration. */
  reveals?: string;
}

export interface ScanConfig {
  /** The scanner, by system id. */
  from: string;
  /** Lab seconds a scan takes. */
  takes?: number;
  /** Zone ids it scans. */
  zones?: string[];
  findings: FindingDef[];
}

type Status = 'open' | 'fixed';

interface ScanRun {
  started: number;
  ends: number;
  /** Null while it runs. */
  results: Map<string, Status> | null;
}

export type Severity = 'none' | 'low' | 'medium' | 'high' | 'critical';

/** The CVSS v3 rating for a base score. */
export function severity(cvss: number): Severity {
  if (cvss >= 9) return 'critical';
  if (cvss >= 7) return 'high';
  if (cvss >= 4) return 'medium';
  if (cvss > 0) return 'low';
  return 'none';
}

class VulnerabilityScanner extends Tool<ScanConfig> {
  readonly id = 'scan';
  private readonly runs: ScanRun[] = [];

  private get takesMs(): number {
    return (this.config.takes ?? 15) * 1000;
  }

  private get zones(): string[] {
    return this.config.zones ?? ['servers', 'dmz'];
  }

  /** The machines in scope, in address order. */
  private targets(): HostState[] {
    return [...this.parts.world.hosts.values()]
      .filter((h) => h.org === this.parts.org && this.zones.includes(h.zone) && h.id !== this.config.from)
      .sort((a, b) => ipNumber(a.ip) - ipNumber(b.ip));
  }

  private get running(): ScanRun | null {
    const last = this.runs.at(-1);
    return last && !last.results ? last : null;
  }

  private get finished(): ScanRun[] {
    return this.runs.filter((r) => r.results);
  }

  act(op: string, _args: ToolArgs): ToolOutcome {
    if (op !== 'run') return { ok: false, message: 'The scanner cannot do that.' };
    const running = this.running;
    if (running) {
      return { ok: false, message: `A scan is already running. It finishes at ${this.parts.clock.clockText(running.ends)}.` };
    }
    const now = this.parts.clock.now;
    const run: ScanRun = { started: now, ends: now + this.takesMs, results: null };
    this.runs.push(run);
    this.parts.clock.at(this.takesMs, () => this.finish(run));
    this.emit({ kind: 'tool.update', summary: 'Vulnerability scan started', data: { tool: this.id } });
    const again = this.runs.length > 1 ? 'Rescan' : 'Scan';
    return { ok: true, message: `${again} started from the SOC scanner: ${this.targets().length} machines` };
  }

  private status(finding: FindingDef): Status {
    const world = this.parts.world;
    if (finding.weakness) {
      const host = world.resolveSystem(this.parts.org, finding.system);
      return host && world.weaknessActive(host, finding.weakness) ? 'open' : 'fixed';
    }
    if (finding.control) return world.isControlOn(this.parts.org, finding.control) ? 'fixed' : 'open';
    return 'open';
  }

  private finish(run: ScanRun): void {
    const previous = this.finished.at(-1)?.results ?? null;
    run.results = new Map(this.config.findings.map((f) => [f.id, this.status(f)]));
    const open = this.config.findings.filter((f) => run.results!.get(f.id) === 'open');
    const critical = open.filter((f) => severity(f.cvss) === 'critical').length;
    this.emit({ kind: 'tool.update', summary: 'Vulnerability scan finished', data: { tool: this.id } });
    this.finishedOp('finished', {
      message: `Scan finished: ${open.length} open finding${open.length === 1 ? '' : 's'}, ${critical} critical`,
    });
    if (!previous) return;
    const turned = this.config.findings.filter((f) => previous.get(f.id) === 'open' && run.results!.get(f.id) === 'fixed');
    for (const f of turned) {
      this.finishedOp('fixed', { message: `Rescan: "${f.title}" on ${this.hostName(f.system)} is fixed`, target: f.id, correct: true });
    }
    if (turned.length === 0) {
      this.finishedOp('fixed', {
        message: 'Rescan: nothing new is fixed since the last scan',
        target: '',
        correct: false,
        reply: 'Nothing turned green since the last scan. A rescan only proves a fix that is already in: fix first, then scan again.',
      });
    }
  }

  private hostName(system: string): string {
    return this.parts.world.resolveSystem(this.parts.org, system)?.name ?? system;
  }

  view(): unknown {
    const world = this.parts.world;
    const clock = this.parts.clock;
    const scanner = world.resolveSystem(this.parts.org, this.config.from);
    const org = world.orgs.get(this.parts.org);
    const zones = (org?.resolved.zones ?? []).filter((z) => this.zones.includes(z.id)).map((z) => `${z.name} ${z.cidr}`);
    const targets = this.targets();
    const running = this.running;
    let progress = null;
    if (running) {
      const share = Math.min(1, Math.max(0, (clock.now - running.started) / this.takesMs));
      const done = Math.floor(share * targets.length);
      progress = {
        percent: Math.round(share * 100),
        ends: clock.clockText(running.ends),
        hosts: targets.slice(0, done).map((h) => ({
          name: h.name,
          ip: h.ip,
          findings: this.config.findings.filter((f) => f.system === h.id).length,
        })),
        total: targets.length,
      };
    }
    const done = this.finished;
    const last = done.at(-1);
    const before = done.at(-2);
    const findings = last
      ? [...this.config.findings]
          .sort((a, b) => b.cvss - a.cvss || a.id.localeCompare(b.id))
          .map((f) => {
            const host = world.resolveSystem(this.parts.org, f.system);
            const status = last.results!.get(f.id) ?? 'open';
            const was = before?.results?.get(f.id);
            return {
              id: f.id,
              host: host ? { key: host.key, name: host.name, ip: host.ip, critical: host.critical } : null,
              port: f.port ?? null,
              title: f.title,
              cve: f.cve ?? null,
              cvss: f.cvss,
              severity: severity(f.cvss),
              detail: f.detail,
              fix: f.fix,
              reveals: f.reveals ?? null,
              status,
              change: was && was !== status ? status : null,
            };
          })
      : [];
    const open = findings.filter((f) => f.status === 'open');
    return {
      scanner: scanner ? { name: scanner.name, ip: scanner.ip } : null,
      scope: zones,
      machines: targets.length,
      running: progress,
      scans: done.length,
      last: last ? { at: clock.clockText(last.ends), open: open.length, fixed: findings.length - open.length } : null,
      counts: {
        critical: open.filter((f) => f.severity === 'critical').length,
        high: open.filter((f) => f.severity === 'high').length,
        medium: open.filter((f) => f.severity === 'medium').length,
        low: open.filter((f) => f.severity === 'low').length,
      },
      findings,
    };
  }
}

function ipNumber(ip: string): number {
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

function validate(config: ScanConfig, check: ToolCheck): void {
  const { add, bundleOrg } = check;
  const systems = new Map(bundleOrg.systems.map((s) => [s.id, s] as const));
  const controls = new Set(bundleOrg.controls.map((c) => c.id));
  const zones = new Set(bundleOrg.zones.map((z) => z.id));
  if (!config?.from || !systems.has(config.from)) add(`scan: the scanner ${config?.from} is not a machine here`);
  if (config?.takes !== undefined && (!Number.isFinite(config.takes) || config.takes <= 0)) add('scan: takes is lab seconds, more than 0');
  for (const zone of config?.zones ?? []) {
    if (!zones.has(zone)) add(`scan: no zone ${zone}`);
  }
  if (!Array.isArray(config?.findings) || config.findings.length === 0) {
    add('scan: needs at least one finding');
    return;
  }
  const ids = new Set<string>();
  for (const f of config.findings) {
    const at = `scan finding ${f.id}`;
    if (ids.has(f.id)) add(`scan: duplicate finding ${f.id}`);
    ids.add(f.id);
    const system = systems.get(f.system);
    if (!system) {
      add(`${at}: no machine ${f.system}`);
      continue;
    }
    if (!f.title || !f.detail || !f.fix) add(`${at}: needs a title, detail and fix`);
    if (typeof f.cvss !== 'number' || f.cvss < 0 || f.cvss > 10) add(`${at}: cvss goes from 0 to 10`);
    if (f.weakness && !(system.weaknesses ?? []).some((w) => w.id === f.weakness)) add(`${at}: ${f.system} has no weakness ${f.weakness}`);
    if (f.control && !controls.has(f.control)) add(`${at}: no control ${f.control}`);
    if (f.port !== undefined && !(system.services ?? []).some((s) => s.port === f.port)) add(`${at}: ${f.system} has nothing on port ${f.port}`);
  }
}

function ops(config: ScanConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  return {
    run: null,
    finished: null,
    fixed: new Set(config.findings.map((f) => f.id)),
  };
}

export const scanTool: ToolModule<ScanConfig> = {
  create: (config, parts) => new VulnerabilityScanner(config, parts),
  validate,
  ops,
};
