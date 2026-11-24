// The store network map: one store drawn as the pattern for all of them, its
// devices on the left, everything they could reach on the right (head office
// servers, the internet, the other stores), and the store router's port
// forwards from the internet. Today it's one flat VPN: every device reaches
// everything. The learner draws the segmentation (start from block all, then
// allow exactly what each device's job needs) and applies it to every store.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome, type ToolParts } from './tool.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export interface SegmentNodeDef {
  id: string;
  name: string;
  /** What it is, or what it does all day. */
  does: string;
}

export interface SegmentsConfig {
  site: string;
  stores: number;
  sources: SegmentNodeDef[];
  destinations: (SegmentNodeDef & { group: string })[];
  /** Flows the business needs, and what breaks without each. */
  needs: { from: string; to: string; missing: string }[];
  /** Why a flow nobody needs is dangerous, by "from>to"; `default` for the rest. */
  replies: Record<string, string>;
  forwards: { id: string; name: string; by: string; reply: string }[];
  /** Switched on when the map is applied right. */
  control?: string;
}

const key = (from: string, to: string): string => `${from}>${to}`;

class SegmentMap extends Tool<SegmentsConfig> {
  readonly id = 'segments';
  private applied: Set<string>;
  private appliedAt: number | null = null;
  private readonly closed = new Map<string, number>();

  constructor(config: SegmentsConfig, parts: ToolParts) {
    super(config, parts);
    this.applied = this.all();
  }

  private all(): Set<string> {
    return new Set(this.config.sources.flatMap((s) => this.config.destinations.map((d) => key(s.id, d.id))));
  }

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op === 'apply') return this.apply(args);
    if (op === 'close') return this.close(this.text(args, 'forward'));
    return { ok: false, message: 'The network map cannot do that.' };
  }

  private apply(args: ToolArgs): ToolOutcome {
    const raw = Array.isArray(args.allow) ? args.allow.filter((a): a is string => typeof a === 'string') : [];
    const valid = this.all();
    const allow = new Set(raw.filter((a) => valid.has(a)));
    const name = (id: string): string => [...this.config.sources, ...this.config.destinations].find((n) => n.id === id)?.name ?? id;
    const message = `Applied a store network plan to all ${this.config.stores} stores: ${allow.size} flows allowed`;
    const missing = this.config.needs.find((n) => !allow.has(key(n.from, n.to)));
    if (missing) {
      return { ok: true, message: `Checked a store network plan: ${allow.size} flows allowed`, target: 'stores', correct: false, reply: `${name(missing.from)} → ${name(missing.to)} is blocked. ${missing.missing}` };
    }
    const needed = new Set(this.config.needs.map((n) => key(n.from, n.to)));
    const extra = [...allow].filter((a) => !needed.has(a));
    if (extra.length > 0) {
      const named = Object.keys(this.config.replies).find((k) => extra.includes(k));
      const first = named ?? extra[0]!;
      const [from, to] = first.split('>') as [string, string];
      const why = this.config.replies[first] ?? this.config.replies.default ?? 'Nothing needs that.';
      return {
        ok: true,
        message: `Checked a store network plan: ${allow.size} flows allowed`,
        target: 'stores',
        correct: false,
        reply: `${name(from)} → ${name(to)} is still allowed. ${why}${extra.length > 1 ? ` (${extra.length} flows in all that nothing needs.)` : ''}`,
      };
    }
    this.applied = allow;
    this.appliedAt = this.parts.clock.now;
    this.emit({ kind: 'tool.update', summary: `Store networks segmented: ${allow.size} flows allowed`, data: { tool: this.id } });
    if (this.config.control && !this.parts.world.isControlOn(this.parts.org, this.config.control)) {
      this.parts.responder.setControl(this.parts.org, this.config.control, true, 'system');
    }
    return {
      ok: true,
      message,
      target: 'stores',
      correct: true,
      reply: `Every device reaches what its job needs and nothing else, in all ${this.config.stores} stores. A recorder that's taken over now reaches the video cloud, and nothing of ours.`,
    };
  }

  private close(id: string): ToolOutcome {
    const forward = this.config.forwards.find((f) => f.id === id);
    if (!forward) return { ok: false, message: 'Choose a port forward.' };
    if (this.closed.has(id)) return { ok: false, message: 'Closed already.' };
    this.closed.set(id, this.parts.clock.now);
    this.emit({ kind: 'tool.update', summary: `Closed port forward: ${forward.name}`, data: { tool: this.id } });
    return { ok: true, message: `Closed the port forward ${forward.name} on every store router`, target: forward.id, correct: true, reply: forward.reply };
  }

  view(): unknown {
    const clock = this.parts.clock;
    return {
      site: this.config.site,
      stores: this.config.stores,
      sources: this.config.sources,
      destinations: this.config.destinations,
      applied: [...this.applied],
      appliedAt: this.appliedAt !== null ? clock.clockText(this.appliedAt) : null,
      forwards: this.config.forwards.map((f) => ({ id: f.id, name: f.name, by: f.by, closed: this.closed.has(f.id) ? clock.clockText(this.closed.get(f.id)) : null })),
    };
  }
}

function validate(config: SegmentsConfig, check: ToolCheck): void {
  const { add, bundleOrg, practical } = check;
  const sources = new Set((config?.sources ?? []).map((s) => s.id));
  const dests = new Set((config?.destinations ?? []).map((d) => d.id));
  if (sources.size === 0 || dests.size === 0) {
    add('segments: needs sources and destinations');
    return;
  }
  for (const n of config.needs ?? []) {
    if (!sources.has(n.from) || !dests.has(n.to)) add(`segments need ${n.from}>${n.to}: unknown device or destination`);
  }
  for (const k of Object.keys(config.replies ?? {})) {
    if (k === 'default') continue;
    const [from, to] = k.split('>');
    if (!sources.has(from ?? '') || !dests.has(to ?? '')) add(`segments reply ${k}: unknown device or destination`);
  }
  if (config.control && !bundleOrg.controls.some((c) => c.id === config.control) && practical.controls?.[config.control] === undefined) add(`segments: no control ${config.control}`);
}

function ops(config: SegmentsConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  return { apply: new Set(['stores']), close: new Set((config.forwards ?? []).map((f) => f.id)) };
}

export const segmentsTool: ToolModule<SegmentsConfig> = {
  create: (config, parts) => new SegmentMap(config, parts),
  validate,
  ops,
};
