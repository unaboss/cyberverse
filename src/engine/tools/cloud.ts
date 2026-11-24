// The cloud console: the company's account at a public cloud provider, the
// part of it a SOC analyst touches in an incident. API keys (who has one, how
// much they use it, revoke it) and storage buckets (public or private, what's
// in them, who downloaded it).
//
// Revoking a scraper's key while the API still hands any order to any
// signed-in customer only buys a minute: it signs up again. Making a bucket
// private when the shop's photos load straight from it breaks the shop. The
// console lets the learner find both out the safe way.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome, type ToolParts } from './tool.ts';
import type { LabEvent } from '../core.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export interface CloudKeyDef {
  id: string;
  account: string;
  created: string;
  requests: number;
  /** The scraper's key. */
  scraper?: boolean;
}

export interface CloudObjectDef {
  id: string;
  name: string;
  size: string;
  /** It shouldn't be here: removing it is the fix. */
  sensitive?: boolean;
  /** Said when someone tries to remove what the business needs. */
  reply?: string;
  downloads?: { at: string; ip: string; who: string }[];
}

export interface CloudBucketDef {
  id: string;
  name: string;
  public: boolean;
  purpose: string;
  objects: CloudObjectDef[];
  /** Why making it private isn't the fix, when it isn't. */
  privateReply?: string;
}

export interface CloudConfig {
  account: string;
  provider: string;
  keys: CloudKeyDef[];
  /** The control that fixes the API, so a revoked scraper can't just sign up again. */
  control: string;
  /** The scraper's next account, a minute after its key is revoked while the hole is open. */
  respawn: { id: string; account: string; after: number };
  buckets: CloudBucketDef[];
}

interface KeyState extends CloudKeyDef {
  revoked: number | null;
  refused: boolean;
}

class CloudConsole extends Tool<CloudConfig> {
  readonly id = 'cloud';
  private readonly keys: KeyState[];
  private readonly removed = new Map<string, number>();
  private respawned = false;

  constructor(config: CloudConfig, parts: ToolParts) {
    super(config, parts);
    this.keys = config.keys.map((k) => ({ ...k, revoked: null, refused: false }));
  }

  private get fixed(): boolean {
    return this.parts.world.isControlOn(this.parts.org, this.config.control);
  }

  override start(): void {
    // A live scraper key keeps counting while the hole is open.
    const tick = (): void => {
      for (const k of this.keys) {
        if (k.scraper && k.revoked === null && !this.fixed && k.id === this.config.respawn.id) k.requests += 11;
        if (k.scraper && this.fixed) k.refused = true;
      }
      this.parts.clock.at(5_000, tick);
    };
    this.parts.clock.at(5_000, tick);
  }

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op === 'revoke') return this.revoke(this.text(args, 'key'));
    if (op === 'remove') return this.remove(this.text(args, 'object'));
    if (op === 'private') return this.makePrivate(this.text(args, 'bucket'));
    return { ok: false, message: 'The cloud console cannot do that.' };
  }

  private revoke(id: string): ToolOutcome {
    const key = this.keys.find((k) => k.id === id);
    if (!key) return { ok: false, message: 'Choose a key.' };
    if (key.revoked !== null) return { ok: false, message: 'That key is revoked already.' };
    const message = `Revoked API key ${key.id} (${key.account})`;
    if (!key.scraper) {
      return { ok: true, message: `Looked at revoking ${key.id}`, target: key.id, correct: false, reply: `${key.account} is a customer who used the app ${key.requests} times today. Revoking it locks them out of their own orders.` };
    }
    key.revoked = this.parts.clock.now;
    this.emit({ kind: 'tool.update', summary: message, data: { tool: this.id } });
    if (!this.fixed) {
      if (!this.respawned) {
        this.respawned = true;
        this.parts.clock.at(this.config.respawn.after * 1000, () => this.comeBack());
      }
      return {
        ok: true,
        message,
        target: 'scraper',
        correct: false,
        reply: 'Revoked. But the hole is still open: any signed-in customer can ask for any order, and signing up is free. Watch the key list.',
      };
    }
    const left = this.keys.filter((k) => k.scraper && k.revoked === null);
    if (left.length > 0) return { ok: true, message, target: 'scraper', correct: false, reply: `Revoked. ${left.map((k) => k.id).join(' and ')} is still live.` };
    return { ok: true, message, target: 'scraper', correct: true, reply: 'Revoked, with the hole closed behind it. A new account now gets its own orders and nothing else.' };
  }

  private comeBack(): void {
    const { id, account } = this.config.respawn;
    this.keys.unshift({ id, account, created: this.parts.clock.clockText(this.parts.clock.now), requests: 0, scraper: true, revoked: null, refused: this.fixed });
    this.emit({ kind: 'tool.update', summary: `New API key ${id} for ${account}: asking for order after order`, data: { tool: this.id } });
  }

  private objects(): { bucket: CloudBucketDef; object: CloudObjectDef }[] {
    return this.config.buckets.flatMap((bucket) => bucket.objects.map((object) => ({ bucket, object })));
  }

  private remove(id: string): ToolOutcome {
    const found = this.objects().find((o) => o.object.id === id);
    if (!found) return { ok: false, message: 'Choose something in a bucket.' };
    if (this.removed.has(id)) return { ok: false, message: 'Removed already.' };
    const { bucket, object } = found;
    if (!object.sensitive) {
      return { ok: true, message: `Looked at removing ${object.name}`, target: object.id, correct: false, reply: object.reply ?? 'The business needs that.' };
    }
    this.removed.set(id, this.parts.clock.now);
    this.emit({ kind: 'tool.update', summary: `Removed ${object.name} from ${bucket.name}`, data: { tool: this.id } });
    return {
      ok: true,
      message: `Moved ${object.name} out of ${bucket.name} into the restricted evidence store`,
      target: object.id,
      correct: true,
      reply: `Gone from the public bucket, and kept, with its download log, as evidence. It was only ever meant for the agency, through a link that expires.`,
    };
  }

  private makePrivate(id: string): ToolOutcome {
    const bucket = this.config.buckets.find((b) => b.id === id);
    if (!bucket) return { ok: false, message: 'Choose a bucket.' };
    if (!bucket.public) return { ok: false, message: `${bucket.name} is private already.` };
    return { ok: true, message: `Looked at making ${bucket.name} private`, target: bucket.id, correct: false, reply: bucket.privateReply ?? 'Not yet.' };
  }

  override observe(event: LabEvent): void {
    if (event.kind === 'control.change' && event.data?.control === this.config.control && this.fixed) {
      for (const k of this.keys) if (k.scraper) k.refused = true;
    }
  }

  view(): unknown {
    const clock = this.parts.clock;
    return {
      account: this.config.account,
      provider: this.config.provider,
      fixed: this.fixed,
      keys: [...this.keys]
        .sort((a, b) => b.requests - a.requests)
        .map((k) => ({ id: k.id, account: k.account, created: k.created, requests: k.requests, revoked: k.revoked !== null ? clock.clockText(k.revoked) : null, refused: k.scraper ? k.refused : false })),
      buckets: this.config.buckets.map((b) => ({
        id: b.id,
        name: b.name,
        public: b.public,
        purpose: b.purpose,
        objects: b.objects.map((o) => ({ id: o.id, name: o.name, size: o.size, downloads: o.downloads ?? [], removed: this.removed.has(o.id) ? clock.clockText(this.removed.get(o.id)) : null })),
      })),
    };
  }
}

function validate(config: CloudConfig, check: ToolCheck): void {
  const { add, bundleOrg, practical } = check;
  if (!Array.isArray(config?.keys) || !config.keys.some((k) => k.scraper)) add('cloud: needs keys, one of them the scraper');
  if (!bundleOrg.controls.some((c) => c.id === config?.control) && practical.controls?.[config?.control] === undefined) add(`cloud: no control ${config?.control}`);
  if (!config?.respawn?.id || !(config.respawn.after > 0)) add('cloud: needs a respawn key and a delay');
  for (const b of config?.buckets ?? []) {
    for (const o of b.objects) if (!o.sensitive && !o.reply) add(`cloud object ${o.id}: needs a reply saying why it stays`);
  }
}

function ops(config: CloudConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  return {
    revoke: new Set(['scraper', ...config.keys.map((k) => k.id)]),
    remove: new Set(config.buckets.flatMap((b) => b.objects.map((o) => o.id))),
    private: new Set(config.buckets.map((b) => b.id)),
  };
}

export const cloudTool: ToolModule<CloudConfig> = {
  create: (config, parts) => new CloudConsole(config, parts),
  validate,
  ops,
};
