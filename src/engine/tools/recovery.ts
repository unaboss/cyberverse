// The recovery console: the disaster recovery plan, the backup sets and a
// restore. The plan's steps tick themselves off as the learner does them, in
// whatever order they do them, so the plan is a thing to follow, not a page
// to read. Ransomware is still encrypting when the round starts, until the
// server is cut off. A restore needs the right copy (the one the attackers
// couldn't reach) onto the right place (never the infected server), and takes
// as long as the sum says: size over speed.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome } from './tool.ts';
import type { LabEvent } from '../core.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export interface PlanStepDef {
  id: string;
  text: string;
  /** What ticks it off: a built-in action on a system, or a desk tool's op. */
  when: { action: string; target?: string };
}

export interface BackupSetDef {
  id: string;
  name: string;
  /** Where it lives. */
  where: string;
  /** Whether it can be restored from. */
  clean: boolean;
  /** Why not, or what it holds. */
  reply: string;
}

export interface RestoreTargetDef {
  id: string;
  name: string;
  ok: boolean;
  reply?: string;
}

export interface RecoveryConfig {
  /** The system being encrypted, and how far it has got. */
  spread: { system: string; files: number; done: number; perMinute: number };
  plan: PlanStepDef[];
  /** How long the plan allows, in words. */
  rto: string;
  sets: BackupSetDef[];
  targets: RestoreTargetDef[];
  /** What a restore copies first. */
  restore: { what: string; gb: number; mbps: number };
  /** Said when the restore is done. */
  done: string;
}

class RecoveryConsole extends Tool<RecoveryConfig> {
  readonly id = 'recovery';
  private encrypted = this.config.spread.done;
  private stopped: number | null = null;
  private readonly ticked = new Map<string, number>();
  private running: { set: string; to: string; started: number; ends: number } | null = null;
  private restored: { to: string; at: number } | null = null;

  private get spreadKey(): string {
    return `${this.parts.org}/${this.config.spread.system}`;
  }

  override start(): void {
    const tick = (): void => {
      if (this.stopped !== null || this.encrypted >= this.config.spread.files) return;
      if (this.parts.world.hosts.get(this.spreadKey)?.status !== 'up') {
        this.stopped = this.parts.clock.now;
        return;
      }
      this.encrypted = Math.min(this.config.spread.files, this.encrypted + Math.max(1, Math.round(this.config.spread.perMinute / 6)));
      this.emit({ kind: 'tool.update', host: this.spreadKey, summary: `${this.encrypted} files encrypted`, data: { tool: this.id } });
      this.parts.clock.at(10_000, tick);
    };
    this.parts.clock.at(10_000, tick);
  }

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op !== 'restore') return { ok: false, message: 'The recovery console cannot do that.' };
    if (this.running) return { ok: false, message: 'A restore is running already.' };
    if (this.restored) return { ok: false, message: 'The files are back already.' };
    const set = this.config.sets.find((s) => s.id === this.text(args, 'set'));
    const to = this.config.targets.find((t) => t.id === this.text(args, 'to'));
    if (!set || !to) return { ok: false, message: 'Choose a backup set and where to restore it to.' };
    const message = `Restore "${set.name}" to ${to.name}`;
    if (!set.clean) return { ok: true, message, target: to.id, correct: false, reply: set.reply };
    if (!to.ok) return { ok: true, message, target: to.id, correct: false, reply: to.reply ?? 'Not there.' };
    const seconds = Math.round((this.config.restore.gb * 1000) / this.config.restore.mbps);
    const now = this.parts.clock.now;
    this.running = { set: set.id, to: to.id, started: now, ends: now + seconds * 1000 };
    this.parts.clock.at(seconds * 1000, () => this.finish());
    this.emit({ kind: 'tool.update', summary: `Restore started: ${set.name}`, data: { tool: this.id } });
    return { ok: true, message, target: to.id, correct: true, reply: `Restoring ${this.config.restore.what}: ${this.config.restore.gb} GB at ${this.config.restore.mbps} MB/s.` };
  }

  private finish(): void {
    const run = this.running;
    if (!run) return;
    this.running = null;
    this.restored = { to: run.to, at: this.parts.clock.now };
    this.emit({ kind: 'tool.update', summary: 'Restore finished', data: { tool: this.id } });
    this.finishedOp('restored', { message: `Restore finished: ${this.config.restore.what}`, target: run.to, correct: true, reply: this.config.done });
  }

  override observe(event: LabEvent): void {
    if (event.kind === 'host.isolate' && event.host === this.spreadKey && this.stopped === null) this.stopped = event.t;
    for (const step of this.config.plan) {
      if (this.ticked.has(step.id) || !this.matches(step.when, event)) continue;
      this.ticked.set(step.id, event.t);
      this.emit({ kind: 'tool.update', summary: `DR plan: ${step.text}`, data: { tool: this.id } });
    }
  }

  private matches(when: PlanStepDef['when'], event: LabEvent): boolean {
    if (event.actor !== 'learner') return false;
    if (when.action.includes('.')) {
      const [tool, op] = when.action.split('.');
      return event.kind === 'tool.use' && event.data?.tool === tool && event.data?.op === op && event.data?.correct !== false && (!when.target || event.data?.target === when.target);
    }
    const kinds: Record<string, string> = { isolate: 'host.isolate', rebuild: 'host.rebuild', block: 'fw.block', reset: 'account.reset', control: 'control.change' };
    if (event.kind !== kinds[when.action]) return false;
    if (!when.target) return true;
    if (when.action === 'block') return event.src === when.target;
    if (when.action === 'control') return event.data?.control === when.target;
    return event.host === `${this.parts.org}/${when.target}`;
  }

  view(): unknown {
    const clock = this.parts.clock;
    const now = clock.now;
    const run = this.running;
    return {
      spread: {
        system: this.parts.world.hosts.get(this.spreadKey)?.name ?? this.config.spread.system,
        files: this.config.spread.files,
        encrypted: this.encrypted,
        stopped: this.stopped !== null ? clock.clockText(this.stopped) : null,
      },
      plan: this.config.plan.map((s) => ({ id: s.id, text: s.text, done: this.ticked.has(s.id) ? clock.clockText(this.ticked.get(s.id)) : null })),
      rto: this.config.rto,
      sets: this.config.sets.map((s) => ({ id: s.id, name: s.name, where: s.where })),
      targets: this.config.targets.map((t) => ({ id: t.id, name: t.name })),
      restore: { what: this.config.restore.what, gb: this.config.restore.gb, mbps: this.config.restore.mbps },
      running: run ? { percent: Math.min(100, Math.round(((now - run.started) / (run.ends - run.started)) * 100)), ends: clock.clockText(run.ends) } : null,
      restored: this.restored ? { to: this.config.targets.find((t) => t.id === this.restored!.to)?.name ?? this.restored.to, at: clock.clockText(this.restored.at) } : null,
    };
  }
}

function validate(config: RecoveryConfig, check: ToolCheck): void {
  const { add, bundleOrg } = check;
  if (!bundleOrg.systems.some((s) => s.id === config?.spread?.system)) add(`recovery: no system ${config?.spread?.system}`);
  if (!Array.isArray(config?.plan) || config.plan.length === 0) add('recovery: needs a plan');
  if (!Array.isArray(config?.sets) || !config.sets.some((s) => s.clean)) add('recovery: needs at least one clean backup set');
  if (!Array.isArray(config?.targets) || !config.targets.some((t) => t.ok)) add('recovery: needs somewhere good to restore to');
  if (!(config?.restore?.gb > 0) || !(config?.restore?.mbps > 0)) add('recovery: restore needs gb and mbps');
  for (const t of config?.targets ?? []) if (!t.ok && !t.reply) add(`recovery target ${t.id}: needs a reply saying why not`);
}

function ops(config: RecoveryConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  const targets = new Set(config.targets.map((t) => t.id));
  return { restore: targets, restored: targets };
}

export const recoveryTool: ToolModule<RecoveryConfig> = {
  create: (config, parts) => new RecoveryConsole(config, parts),
  validate,
  ops,
};
