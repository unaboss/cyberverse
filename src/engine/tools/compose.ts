// A write-up: a notice, a report or a message, put together a part at a time.
// Each part offers a few ways to say it: the plain, honest, useful one, and
// the usual traps (jargon, blame, guessing, promises nobody can keep). The
// learner picks a line for every part and sees the whole thing take shape;
// publishing checks every part and says what is wrong with the first that is.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome } from './tool.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export interface ComposeOptionDef {
  id: string;
  text: string;
  correct?: boolean;
  /** What the mentor says about choosing it. */
  reply: string;
}

export interface ComposePartDef {
  id: string;
  label: string;
  options: ComposeOptionDef[];
}

export interface ComposeConfig {
  /** What it is: the window's title. */
  heading: string;
  /** Who reads it, and where. */
  to: string;
  /** The button. */
  send: string;
  parts: ComposePartDef[];
  /** Said when every part is right. */
  done: string;
}

class Compose extends Tool<ComposeConfig> {
  readonly id = 'compose';
  private sent: { at: number; choices: Record<string, string> } | null = null;
  private tries = 0;

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op !== 'publish') return { ok: false, message: 'That cannot be done here.' };
    if (this.sent) return { ok: false, message: 'It has gone out already.' };
    // The browser sends "part:option" for each part it has a line for.
    const raw = Array.isArray(args.choices) ? args.choices : [];
    const choices: Record<string, string> = Object.fromEntries(raw.filter((c): c is string => typeof c === 'string').map((c) => [c.split(':')[0], c.split(':')[1] ?? '']));
    const picked = this.config.parts.map((p) => ({ part: p, option: p.options.find((o) => o.id === choices[p.id]) }));
    const missing = picked.find((p) => !p.option);
    if (missing) return { ok: false, message: `Choose a line for "${missing.part.label}".` };
    this.tries++;
    const wrong = picked.find((p) => !p.option!.correct);
    const message = `${this.config.send}: ${this.config.heading}`;
    if (wrong) {
      return { ok: true, message: `Checked the draft of ${this.config.heading.toLowerCase()}`, target: 'draft', correct: false, reply: `${wrong.part.label}: ${wrong.option!.reply}` };
    }
    this.sent = { at: this.parts.clock.now, choices: Object.fromEntries(picked.map((p) => [p.part.id, p.option!.id])) };
    this.emit({ kind: 'tool.update', summary: message, data: { tool: this.id } });
    return { ok: true, message, target: 'draft', correct: true, reply: this.config.done };
  }

  view(): unknown {
    return {
      heading: this.config.heading,
      to: this.config.to,
      send: this.config.send,
      parts: this.config.parts.map((p) => ({ id: p.id, label: p.label, options: p.options.map((o) => ({ id: o.id, text: o.text })) })),
      sent: this.sent ? { at: this.parts.clock.clockText(this.sent.at), choices: this.sent.choices } : null,
      tries: this.tries,
    };
  }
}

function validate(config: ComposeConfig, check: ToolCheck): void {
  const { add } = check;
  for (const key of ['heading', 'to', 'send', 'done'] as const) {
    if (typeof config?.[key] !== 'string' || config[key].trim() === '') add(`compose: needs ${key} text`);
  }
  if (!Array.isArray(config?.parts) || config.parts.length === 0) {
    add('compose: needs parts');
    return;
  }
  for (const p of config.parts) {
    if (!Array.isArray(p.options) || p.options.filter((o) => o.correct).length !== 1) add(`compose part ${p.id}: needs options with exactly one correct`);
    for (const o of p.options ?? []) {
      if (typeof o.text !== 'string' || typeof o.reply !== 'string') add(`compose part ${p.id} option ${o.id}: text and reply must be text`);
    }
  }
}

function ops(_config: ComposeConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  return { publish: new Set(['draft']) };
}

export const composeTool: ToolModule<ComposeConfig> = {
  create: (config, parts) => new Compose(config, parts),
  validate,
  ops,
};
