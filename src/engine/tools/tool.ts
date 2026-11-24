// Desk tools: the windows a floor adds to the learner's desk, one new thing to
// work with per floor (a risk register, a vulnerability scanner, a honeypot,
// an open server case...). Each tool keeps its own state, answers the
// learner's operations, and shows a view. Every operation the learner does is
// a `tool.use` event, so a guided step can wait for it like any other action.

import type { EventBus, EventInput, LabEvent, Rng, SimClock } from '../core.ts';
import type { Detector } from '../detect.ts';
import type { Responder } from '../response.ts';
import type { Business, StaffBots } from '../staff.ts';
import type { World } from '../world.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';
import type { PracticalDef } from '../../world/types.ts';

export interface ToolParts {
  world: World;
  bus: EventBus;
  clock: SimClock;
  rng: Rng;
  detector: Detector;
  bots: StaffBots;
  business: Business;
  responder: Responder;
  /** The organisation the floor plays in. */
  org: string;
}

/** What a tool says back about one operation. */
export interface ToolOutcome {
  ok: boolean;
  /** Shown to the learner: a toast when it failed, the "Your actions" feed when it worked. */
  message: string;
  /** What the operation was done to, in the terms a guided step's `done` uses. */
  target?: string;
  /** False when the learner did it, but not well: the step shows `reply` and waits. */
  correct?: boolean;
  /** What the mentor says about it, right or wrong. */
  reply?: string;
}

export type ToolArgs = Record<string, unknown>;

export abstract class Tool<C = unknown> {
  abstract readonly id: string;
  readonly config: C;
  readonly parts: ToolParts;

  constructor(config: C, parts: ToolParts) {
    this.config = config;
    this.parts = parts;
  }

  /** The round has begun. */
  start(): void {}

  abstract act(op: string, args: ToolArgs): ToolOutcome;

  /** What the learner's window shows. Plain data: it goes to the browser as JSON. */
  abstract view(): unknown;

  /** A learner event happened elsewhere on the desk (a block, an alert closed). */
  observe(_event: LabEvent): void {}

  protected emit(event: Omit<EventInput, 'actor'> & { actor?: string }): LabEvent {
    return this.parts.bus.emit({ actor: 'system', org: this.parts.org, ...event });
  }

  /**
   * An operation the learner started that ends later (a scan that takes a
   * while): it counts as the learner's, so a guided step can wait for it.
   */
  protected finishedOp(op: string, outcome: Omit<ToolOutcome, 'ok'>): LabEvent {
    return this.parts.bus.emit(toolUse(this.parts.org, this.id, op, outcome));
  }

  /** A text arg the browser sent, trimmed, or empty. */
  protected text(args: ToolArgs, key: string): string {
    const v = args[key];
    return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  }

  protected int(args: ToolArgs, key: string): number | null {
    const v = Number(args[key]);
    return Number.isInteger(v) ? v : null;
  }
}

/** What a tool module checks in a practical's file before any round runs. */
export interface ToolCheck {
  bundleOrg: ResolvedOrg;
  practical: PracticalDef;
  /** Detection rule ids in the catalogue. */
  rules: Set<string>;
  internet: string;
  add: (message: string) => void;
}

export interface ToolModule<C = unknown> {
  create(config: C, parts: ToolParts): Tool<C>;
  /** Problems with the tool's part of a practical file, before anything runs. */
  validate(config: C, check: ToolCheck): void;
  /** The operations a guided step can wait for, and the targets each accepts (null: any). */
  ops(config: C, org: ResolvedOrg): Record<string, Set<string> | null>;
}

/** The event for one of the learner's tool operations. */
export function toolUse(org: string, tool: string, op: string, outcome: Omit<ToolOutcome, 'ok'>): EventInput {
  return {
    kind: 'tool.use',
    actor: 'learner',
    org,
    summary: outcome.message,
    data: {
      tool,
      op,
      ...(outcome.target !== undefined ? { target: outcome.target } : {}),
      ...(outcome.correct !== undefined ? { correct: outcome.correct } : {}),
      ...(outcome.reply !== undefined ? { reply: outcome.reply } : {}),
    },
  };
}

/** "a, b and c". */
export function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
