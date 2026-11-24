// The evidence locker: what proves what happened, kept so that it still
// proves it later. Each item the learner bags gets a SHA-256 fingerprint and
// a line in the chain of custody (who took it, when, from where), so anyone
// can check later that nothing changed. Things that aren't evidence get the
// reason. An item that lives on a machine is gone once the machine is wiped,
// which is why evidence comes before cleanup. Sealing the locker closes it.

import { createHash } from 'node:crypto';
import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome } from './tool.ts';
import type { LabEvent } from '../core.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export interface EvidenceItemDef {
  id: string;
  name: string;
  /** The system it comes from. */
  from: string;
  /** What it shows. */
  detail: string;
  /** Evidence of what happened, how, or what was taken. */
  relevant: boolean;
  /** Said when it is bagged and isn't evidence, or once it is lost. */
  reply?: string;
  /** Gone if its system is rebuilt before it is bagged. */
  volatile?: boolean;
}

export interface EvidenceConfig {
  items: EvidenceItemDef[];
  /** Who signs for it. */
  custodian: string;
}

interface Bagged {
  at: number;
  hash: string;
}

class EvidenceLocker extends Tool<EvidenceConfig> {
  readonly id = 'evidence';
  private readonly bagged = new Map<string, Bagged>();
  private readonly lost = new Set<string>();
  private sealed: { at: number; hash: string } | null = null;

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op === 'bag') return this.bag(args);
    if (op === 'seal') return this.seal();
    return { ok: false, message: 'The evidence locker cannot do that.' };
  }

  private bag(args: ToolArgs): ToolOutcome {
    if (this.sealed) return { ok: false, message: 'The locker is sealed.' };
    const item = this.config.items.find((i) => i.id === this.text(args, 'item'));
    if (!item) return { ok: false, message: 'Choose something to bag.' };
    if (this.bagged.has(item.id)) return { ok: false, message: 'That is in the locker already.' };
    if (this.lost.has(item.id)) return { ok: false, message: `${item.name}: gone. ${item.from} was wiped before anyone kept it.` };
    if (!item.relevant) return { ok: true, message: `Looked at ${item.name}`, target: item.id, correct: false, reply: item.reply ?? 'That proves nothing about what happened.' };
    const hash = createHash('sha256').update(`${this.parts.org}/${item.id}/${item.detail}`).digest('hex');
    this.bagged.set(item.id, { at: this.parts.clock.now, hash });
    this.emit({ kind: 'tool.update', summary: `Bagged ${item.name}`, data: { tool: this.id } });
    return { ok: true, message: `Bagged ${item.name} (SHA-256 ${hash.slice(0, 12)}…)`, target: item.id, correct: true };
  }

  private seal(): ToolOutcome {
    if (this.sealed) return { ok: false, message: 'The locker is sealed already.' };
    if (this.bagged.size === 0) return { ok: false, message: 'The locker is empty.' };
    const missing = this.config.items.filter((i) => i.relevant && !this.bagged.has(i.id) && !this.lost.has(i.id));
    if (missing.length > 0) {
      return {
        ok: true,
        message: 'Tried to seal the evidence locker',
        target: 'locker',
        correct: false,
        reply: `Not yet: ${missing.length === 1 ? 'one more thing proves' : `${missing.length} more things prove`} what happened, how, or what was taken. Once it's sealed, it's sealed.`,
      };
    }
    const all = [...this.bagged.values()].map((b) => b.hash).join('');
    const hash = createHash('sha256').update(all).digest('hex');
    this.sealed = { at: this.parts.clock.now, hash };
    this.emit({ kind: 'tool.update', summary: 'Evidence locker sealed', data: { tool: this.id } });
    const lost = this.config.items.filter((i) => this.lost.has(i.id));
    const reply = lost.length
      ? `Sealed, without ${lost.map((i) => i.name.toLowerCase()).join(' and ')}: wiped before anyone kept it. Evidence comes before cleanup.`
      : `Sealed: ${this.bagged.size} items, each with its fingerprint and who took it when. Anyone can check later that nothing changed.`;
    return { ok: true, message: `Sealed the evidence locker (SHA-256 ${hash.slice(0, 12)}…)`, target: 'locker', correct: true, reply };
  }

  override observe(event: LabEvent): void {
    if (event.kind !== 'host.rebuild' || !event.host) return;
    const system = event.host.split('/')[1];
    for (const item of this.config.items) {
      if (item.volatile && item.from === system && !this.bagged.has(item.id)) this.lost.add(item.id);
    }
  }

  view(): unknown {
    const clock = this.parts.clock;
    return {
      custodian: this.config.custodian,
      items: this.config.items.map((i) => {
        const b = this.bagged.get(i.id);
        return {
          id: i.id,
          name: i.name,
          from: i.from,
          detail: i.detail,
          volatile: i.volatile === true,
          bagged: b ? { at: clock.clockText(b.at), hash: b.hash } : null,
          lost: this.lost.has(i.id),
        };
      }),
      sealed: this.sealed ? { at: clock.clockText(this.sealed.at), hash: this.sealed.hash } : null,
    };
  }
}

function validate(config: EvidenceConfig, check: ToolCheck): void {
  const { add, bundleOrg } = check;
  if (!Array.isArray(config?.items) || !config.items.some((i) => i.relevant)) {
    add('evidence: needs items, at least one of them evidence');
    return;
  }
  if (!config.custodian) add('evidence: needs a custodian');
  const systems = new Set(bundleOrg.systems.map((s) => s.id));
  for (const i of config.items) {
    if (!systems.has(i.from)) add(`evidence ${i.id}: no system ${i.from}`);
    if (!i.relevant && !i.reply) add(`evidence ${i.id}: needs a reply saying why it isn't evidence`);
  }
}

function ops(config: EvidenceConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  return { bag: new Set(config.items.map((i) => i.id)), seal: new Set(['locker']) };
}

export const evidenceTool: ToolModule<EvidenceConfig> = {
  create: (config, parts) => new EvidenceLocker(config, parts),
  validate,
  ops,
};
