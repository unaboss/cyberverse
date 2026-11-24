// The helpdesk queue: tickets from staff, each an everyday request with a
// security catch in it (a password reset for somebody else, a found USB
// stick, a driver from a strange site). The learner picks a response; the
// right one closes the ticket and the caller says how they feel about it, the
// wrong one gets the mentor's reason and the ticket stays open.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome } from './tool.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export interface TicketOptionDef {
  id: string;
  text: string;
  correct?: boolean;
  /** What the mentor says about it. */
  reply: string;
}

export interface TicketDef {
  id: string;
  /** Person id of the caller. */
  from: string;
  channel: 'phone' | 'email' | 'walk-in';
  priority: 'low' | 'medium' | 'high';
  subject: string;
  body: string;
  options: TicketOptionDef[];
  /** What the caller says once it is handled right. */
  thanks: string;
}

export interface TicketsConfig {
  tickets: TicketDef[];
}

interface TicketState {
  status: 'open' | 'resolved';
  tries: number;
  resolvedAt: number | null;
}

class HelpdeskQueue extends Tool<TicketsConfig> {
  readonly id = 'tickets';
  private readonly state = new Map<string, TicketState>(this.config.tickets.map((t) => [t.id, { status: 'open', tries: 0, resolvedAt: null }]));

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op !== 'resolve') return { ok: false, message: 'The helpdesk queue cannot do that.' };
    const ticket = this.config.tickets.find((t) => t.id === this.text(args, 'ticket'));
    if (!ticket) return { ok: false, message: 'Choose a ticket.' };
    const option = ticket.options.find((o) => o.id === this.text(args, 'option'));
    if (!option) return { ok: false, message: 'Choose how you will handle it.' };
    const state = this.state.get(ticket.id)!;
    if (state.status === 'resolved') return { ok: false, message: 'That ticket is closed already.' };
    state.tries++;
    if (!option.correct) {
      this.emit({ kind: 'tool.update', summary: `Ticket ${ticket.id}: not yet`, data: { tool: this.id } });
      return { ok: true, message: `Ticket "${ticket.subject}": ${option.text}`, target: ticket.id, correct: false, reply: option.reply };
    }
    state.status = 'resolved';
    state.resolvedAt = this.parts.clock.now;
    this.emit({ kind: 'tool.update', summary: `Ticket ${ticket.id} resolved`, data: { tool: this.id } });
    return { ok: true, message: `Resolved "${ticket.subject}"`, target: ticket.id, correct: true, reply: option.reply };
  }

  view(): unknown {
    const people = this.parts.world.orgs.get(this.parts.org)?.resolved.people ?? [];
    return {
      open: [...this.state.values()].filter((s) => s.status === 'open').length,
      tickets: this.config.tickets.map((t) => {
        const s = this.state.get(t.id)!;
        const who = people.find((p) => p.id === t.from);
        return {
          id: t.id,
          from: who ? { name: who.name, role: who.role } : { name: t.from, role: '' },
          channel: t.channel,
          priority: t.priority,
          subject: t.subject,
          body: t.body,
          options: t.options.map((o) => ({ id: o.id, text: o.text })),
          status: s.status,
          tries: s.tries,
          thanks: s.status === 'resolved' ? t.thanks : null,
          resolved: s.resolvedAt !== null ? this.parts.clock.clockText(s.resolvedAt) : null,
        };
      }),
    };
  }
}

function validate(config: TicketsConfig, check: ToolCheck): void {
  const { add, bundleOrg } = check;
  const people = new Set(bundleOrg.people.map((p) => p.id));
  if (!Array.isArray(config?.tickets) || config.tickets.length === 0) {
    add('tickets: needs at least one ticket');
    return;
  }
  const ids = new Set<string>();
  for (const t of config.tickets) {
    const at = `tickets ${t.id}`;
    if (ids.has(t.id)) add(`tickets: duplicate ticket ${t.id}`);
    ids.add(t.id);
    if (!people.has(t.from)) add(`${at}: ${t.from} does not work here`);
    if (!['phone', 'email', 'walk-in'].includes(t.channel)) add(`${at}: channel is phone, email or walk-in`);
    if (!['low', 'medium', 'high'].includes(t.priority)) add(`${at}: priority is low, medium or high`);
    for (const key of ['subject', 'body', 'thanks'] as const) {
      if (typeof t[key] !== 'string' || t[key].trim() === '') add(`${at}: needs ${key} text`);
    }
    if (!Array.isArray(t.options) || t.options.filter((o) => o.correct).length !== 1) add(`${at}: needs options with exactly one correct`);
    for (const o of t.options ?? []) {
      if (typeof o.text !== 'string' || typeof o.reply !== 'string') add(`${at} option ${o.id}: text and reply must be text`);
    }
  }
}

function ops(config: TicketsConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  return { resolve: new Set(config.tickets.map((t) => t.id)) };
}

export const ticketsTool: ToolModule<TicketsConfig> = {
  create: (config, parts) => new HelpdeskQueue(config, parts),
  validate,
  ops,
};
