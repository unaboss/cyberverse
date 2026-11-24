// Payments and approvals: today's supplier payment run before it goes, the
// call-back a finance team makes before trusting new bank details, and the
// rights each finance role holds in the ERP, with the pairs no one person
// should ever hold together (segregation of duties).
//
// Holding the one payment that's wrong stops the loss without stopping 340
// honest suppliers' money. Calling back on the number in the change letter
// only reaches whoever wrote the letter. A matrix that leaves one person able
// to change and approve where money goes is the hole the insider used.

import { Tool, list, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome, type ToolParts } from './tool.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export interface PaymentDef {
  id: string;
  supplier: string;
  invoice: string;
  amount: number;
  account: string;
  /** When the bank details last changed, as shown: "16 Nov, 21:47". */
  changed: string;
  /** Paying the wrong account: holding it is the fix. */
  fraud?: boolean;
  /** Said when someone holds an honest payment. */
  reply?: string;
  /** The two numbers to call, for a payment whose bank details just changed. */
  callback?: { contract: { number: string; says: string }; letter: { number: string; says: string } };
}

export interface ApprovalsConfig {
  run: { name: string; when: string; count: number; total: number };
  payments: PaymentDef[];
  /** Said when someone holds the whole run. */
  holdAll: string;
  rights: { id: string; name: string }[];
  roles: { id: string; name: string; person: string; rights: string[] }[];
  /** Rights no one role may hold together, and why. */
  conflicts: { a: string; b: string; why: string }[];
  /** Switched on when the roles are fixed. */
  control?: string;
}

const rand = (n: number): string => `R${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;

class Approvals extends Tool<ApprovalsConfig> {
  readonly id = 'approvals';
  private readonly held = new Map<string, number>();
  private readonly calls: { at: number; supplier: string; number: string; says: string }[] = [];
  private grants: Set<string>;
  private appliedAt: number | null = null;

  constructor(config: ApprovalsConfig, parts: ToolParts) {
    super(config, parts);
    this.grants = new Set(config.roles.flatMap((r) => r.rights.map((x) => `${r.id}>${x}`)));
  }

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op === 'hold') return this.hold(this.text(args, 'payment'));
    if (op === 'call') return this.call(this.text(args, 'payment'), this.text(args, 'number'));
    if (op === 'roles') return this.roles(args);
    return { ok: false, message: 'Payments and approvals cannot do that.' };
  }

  private hold(id: string): ToolOutcome {
    if (id === 'all') {
      return { ok: true, message: `Looked at holding the whole ${this.config.run.name.toLowerCase()}`, target: 'all', correct: false, reply: this.config.holdAll };
    }
    const p = this.config.payments.find((x) => x.id === id);
    if (!p) return { ok: false, message: 'Choose a payment.' };
    if (this.held.has(id)) return { ok: false, message: 'Held already.' };
    if (!p.fraud) {
      return { ok: true, message: `Looked at holding ${p.supplier}`, target: p.id, correct: false, reply: p.reply ?? `${p.supplier} has been paid into the same account since ${p.changed}. Holding it makes an honest supplier wait for nothing.` };
    }
    this.held.set(id, this.parts.clock.now);
    this.emit({ kind: 'tool.update', summary: `Held ${rand(p.amount)} to ${p.supplier} from the payment run`, data: { tool: this.id } });
    return {
      ok: true,
      message: `Held ${rand(p.amount)} to ${p.supplier} from the ${this.config.run.when} run`,
      target: p.id,
      correct: true,
      reply: `Held. The other ${this.config.run.count - 1} payments go at ${this.config.run.when} as normal, and ${p.supplier} is paid once its real account is confirmed.`,
    };
  }

  private call(id: string, number: string): ToolOutcome {
    const p = this.config.payments.find((x) => x.id === id);
    if (!p) return { ok: false, message: 'Choose a payment.' };
    if (!p.callback) return { ok: true, message: `Looked at calling ${p.supplier}`, target: p.id, correct: false, reply: `Nothing changed on ${p.supplier}: same account since ${p.changed}. Call back when bank details change.` };
    const side = number === 'letter' ? p.callback.letter : number === 'contract' ? p.callback.contract : null;
    if (!side) return { ok: false, message: 'Choose which number to call.' };
    this.calls.push({ at: this.parts.clock.now, supplier: p.supplier, number: side.number, says: side.says });
    this.emit({ kind: 'tool.update', summary: `Called ${p.supplier} on ${side.number}`, data: { tool: this.id } });
    const message = `Called ${p.supplier} on ${side.number}`;
    if (number === 'letter') return { ok: true, message, target: p.id, correct: false, reply: `${side.says} The number on the letter reaches whoever wrote the letter. Call the number you already had.` };
    return { ok: true, message, target: p.id, correct: true, reply: side.says };
  }

  private roles(args: ToolArgs): ToolOutcome {
    const raw = Array.isArray(args.grants) ? args.grants.filter((a): a is string => typeof a === 'string') : [];
    const valid = new Set(this.config.roles.flatMap((r) => this.config.rights.map((x) => `${r.id}>${x.id}`)));
    const grants = new Set(raw.filter((g) => valid.has(g)));
    const right = (id: string): string => this.config.rights.find((x) => x.id === id)?.name.toLowerCase() ?? id;
    const message = `Checked the finance roles: ${grants.size} rights given`;
    const orphan = this.config.rights.find((x) => !this.config.roles.some((r) => grants.has(`${r.id}>${x.id}`)));
    if (orphan) return { ok: true, message, target: 'roles', correct: false, reply: `Nobody can ${right(orphan.id)} now, so finance stops. Give it to a role that holds nothing it conflicts with.` };
    for (const role of this.config.roles) {
      for (const c of this.config.conflicts) {
        if (grants.has(`${role.id}>${c.a}`) && grants.has(`${role.id}>${c.b}`)) {
          return { ok: true, message, target: 'roles', correct: false, reply: `The ${role.name.toLowerCase()} can still ${right(c.a)} and ${right(c.b)}. ${c.why}` };
        }
      }
    }
    const moved = [...grants].filter((g) => !this.grants.has(g));
    this.grants = grants;
    this.appliedAt = this.parts.clock.now;
    this.emit({ kind: 'tool.update', summary: 'Finance roles changed: no one person holds two rights that conflict', data: { tool: this.id } });
    if (this.config.control && !this.parts.world.isControlOn(this.parts.org, this.config.control)) {
      this.parts.responder.setControl(this.parts.org, this.config.control, true, 'system');
    }
    const named = moved.map((g) => {
      const [r, x] = g.split('>') as [string, string];
      return `${right(x)} to the ${this.config.roles.find((o) => o.id === r)!.name.toLowerCase()}`;
    });
    return {
      ok: true,
      message: 'Changed the finance roles in the ERP',
      target: 'roles',
      correct: true,
      reply: `No one person can both make and approve a change to where money goes, or both capture and release a payment.${named.length ? ` Moved ${list(named)}.` : ''}`,
    };
  }

  view(): unknown {
    const clock = this.parts.clock;
    return {
      run: this.config.run,
      payments: this.config.payments.map((p) => ({
        id: p.id,
        supplier: p.supplier,
        invoice: p.invoice,
        amount: p.amount,
        account: p.account,
        changed: p.changed,
        callback: p.callback ? { contract: p.callback.contract.number, letter: p.callback.letter.number } : null,
        held: this.held.has(p.id) ? clock.clockText(this.held.get(p.id)) : null,
      })),
      calls: this.calls.map((c) => ({ ...c, at: clock.clockText(c.at) })),
      rights: this.config.rights,
      roles: this.config.roles.map((r) => ({ id: r.id, name: r.name, person: this.parts.world.person(this.parts.org, r.person)?.name ?? r.person })),
      grants: [...this.grants],
      conflicts: this.config.conflicts.map((c) => ({ a: c.a, b: c.b })),
      appliedAt: this.appliedAt !== null ? clock.clockText(this.appliedAt) : null,
    };
  }
}

function validate(config: ApprovalsConfig, check: ToolCheck): void {
  const { add, bundleOrg, practical } = check;
  if (!config?.payments?.some((p) => p.fraud)) add('approvals: needs one payment to the wrong account');
  const rights = new Set((config?.rights ?? []).map((r) => r.id));
  const people = new Set(bundleOrg.people.map((p) => p.id));
  for (const r of config?.roles ?? []) {
    if (!people.has(r.person)) add(`approvals role ${r.id}: ${r.person} does not work here`);
    for (const x of r.rights) if (!rights.has(x)) add(`approvals role ${r.id}: no right ${x}`);
  }
  for (const c of config?.conflicts ?? []) if (!rights.has(c.a) || !rights.has(c.b)) add(`approvals conflict ${c.a}/${c.b}: unknown right`);
  if (config?.control && !bundleOrg.controls.some((c) => c.id === config.control) && practical.controls?.[config.control] === undefined) add(`approvals: no control ${config.control}`);
}

function ops(config: ApprovalsConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  const ids = (config.payments ?? []).map((p) => p.id);
  return { hold: new Set(['all', ...ids]), call: new Set(ids), roles: new Set(['roles']) };
}

export const approvalsTool: ToolModule<ApprovalsConfig> = {
  create: (config, parts) => new Approvals(config, parts),
  validate,
  ops,
};
