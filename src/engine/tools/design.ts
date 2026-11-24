// The design board: a cross-department team works a people problem through
// design thinking. Empathise (keep what people saw, drop what we assumed),
// define the problem from their side, ideate (many ideas, then pick the ones
// that answer the problem), prototype small and cheap, and test it with the
// next phishing simulation. The campaign results sit on top, by group, so the
// learner starts from the numbers and ends by changing them.

import { Tool, list, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome, type ToolParts } from './tool.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export interface CampaignRow {
  group: string;
  sent: number;
  clicked: number;
  /** Typed a password into the fake page. */
  entered: number;
  reported: number;
}

interface Choice {
  id: string;
  text: string;
  correct?: boolean;
  reply?: string;
}

export interface DesignConfig {
  /** The "How might we…" question on top of the board. */
  challenge: string;
  team: { person: string; does: string }[];
  campaign: { name: string; rows: CampaignRow[]; note?: string };
  empathise: { cards: { id: string; by: string; text: string; kind: 'saw' | 'assumed'; reply?: string }[] };
  define: { options: Choice[] };
  /** A good idea names the reason from the problem statement it `answers`; a weak one has a `reply` saying why not. */
  ideate: { pick: number; ideas: { id: string; by: string; text: string; good?: boolean; answers?: string; reply?: string }[] };
  prototype: { options: Choice[] };
  test: { name: string; rows: CampaignRow[]; finding: string };
}

const STAGES = ['empathise', 'define', 'ideate', 'prototype', 'test'] as const;
type Stage = (typeof STAGES)[number];

class DesignBoard extends Tool<DesignConfig> {
  readonly id = 'design';
  private readonly done = new Map<Stage, { at: number; chosen: string[] }>();

  constructor(config: DesignConfig, parts: ToolParts) {
    super(config, parts);
  }

  private name(id: string): string {
    return this.parts.world.person(this.parts.org, id)?.name ?? id;
  }

  private first(name: string): string {
    return this.name(name).split(' ')[0] ?? name;
  }

  act(op: string, args: ToolArgs): ToolOutcome {
    const stage = STAGES.find((s) => s === op);
    if (!stage) return { ok: false, message: 'The design board cannot do that.' };
    const before = STAGES[STAGES.indexOf(stage) - 1];
    if (before && !this.done.has(before)) return { ok: false, message: `Finish ${before} first.` };
    if (this.done.has(stage)) return { ok: false, message: `${stage[0]!.toUpperCase()}${stage.slice(1)} is done.` };
    if (stage === 'empathise') return this.empathise(this.ids(args, 'keep'));
    if (stage === 'define') return this.pick('define', this.config.define.options, this.text(args, 'option'), 'problem');
    if (stage === 'ideate') return this.ideate(this.ids(args, 'ideas'));
    if (stage === 'prototype') return this.pick('prototype', this.config.prototype.options, this.text(args, 'option'), 'trial');
    return this.runTest();
  }

  private ids(args: ToolArgs, key: string): string[] {
    const raw = args[key];
    return Array.isArray(raw) ? [...new Set(raw.filter((a): a is string => typeof a === 'string'))] : [];
  }

  private finish(stage: Stage, chosen: string[], summary: string): void {
    this.done.set(stage, { at: this.parts.clock.now, chosen });
    this.emit({ kind: 'tool.update', summary, data: { tool: this.id } });
  }

  private empathise(keep: string[]): ToolOutcome {
    const cards = this.config.empathise.cards;
    const message = `Kept ${keep.length} notes of what the team saw`;
    const assumed = cards.find((c) => c.kind === 'assumed' && keep.includes(c.id));
    if (assumed) {
      return { ok: true, message, target: 'observations', correct: false, reply: `"${assumed.text}" ${assumed.reply ?? "That's what we assume, not what anybody saw."}` };
    }
    const dropped = cards.filter((c) => c.kind === 'saw' && !keep.includes(c.id));
    if (dropped.length > 0) {
      const d = dropped[0]!;
      return { ok: true, message, target: 'observations', correct: false, reply: `${this.first(d.by)} saw that: "${d.text}" Keep everything somebody actually saw.${dropped.length > 1 ? ` (${dropped.length} notes like that dropped.)` : ''}` };
    }
    this.finish('empathise', keep, `Empathise: ${keep.length} observations on the board`);
    return { ok: true, message, target: 'observations', correct: true, reply: 'Only what people saw and said. Every one of these is a reason, not a fault.' };
  }

  private pick(stage: 'define' | 'prototype', options: Choice[], id: string, target: string): ToolOutcome {
    const option = options.find((o) => o.id === id);
    if (!option) return { ok: false, message: 'Choose one.' };
    const message = stage === 'define' ? 'Wrote the problem statement' : `Chose a prototype: ${option.text}`;
    if (!option.correct) return { ok: true, message, target, correct: false, reply: option.reply ?? 'Not that one.' };
    this.finish(stage, [id], stage === 'define' ? 'Define: the problem, from the staff side' : `Prototype: ${option.text}`);
    return { ok: true, message, target, correct: true, reply: option.reply ?? 'Yes.' };
  }

  private ideate(chosen: string[]): ToolOutcome {
    const { pick, ideas } = this.config.ideate;
    const message = `Took ${chosen.length} ideas to prototype`;
    const known = chosen.filter((id) => ideas.some((i) => i.id === id));
    const weak = ideas.find((i) => !i.good && known.includes(i.id));
    if (weak) return { ok: true, message, target: 'ideas', correct: false, reply: `"${weak.text}" ${weak.reply ?? "It doesn't answer the problem we wrote."}` };
    if (known.length !== pick) {
      const missing = ideas.filter((i) => i.good && !known.includes(i.id));
      return {
        ok: true,
        message,
        target: 'ideas',
        correct: false,
        reply: `Take ${pick}: one for each reason in the problem statement.${missing[0]?.answers ? ` Which idea answers "${missing[0].answers}"?` : ''}`,
      };
    }
    this.finish('ideate', known, `Ideate: ${list(known.map((id) => ideas.find((i) => i.id === id)!.text.replace(/\.$/, '').toLowerCase()))}`);
    return { ok: true, message, target: 'ideas', correct: true, reply: 'Three ideas, each answering one reason staff gave us. Cheap to try, quick to throw away.' };
  }

  private runTest(): ToolOutcome {
    this.finish('test', ['results'], `Test: ${this.config.test.name}`);
    return { ok: true, message: `Ran ${this.config.test.name}`, target: 'results', correct: true, reply: this.config.test.finding };
  }

  view(): unknown {
    const clock = this.parts.clock;
    const stageView = (s: Stage) => {
      const d = this.done.get(s);
      return d ? { at: clock.clockText(d.at), chosen: d.chosen } : null;
    };
    const current = STAGES.find((s) => !this.done.has(s)) ?? null;
    return {
      challenge: this.config.challenge,
      team: this.config.team.map((t) => ({ name: this.name(t.person), does: t.does })),
      campaign: this.config.campaign,
      current,
      stages: Object.fromEntries(STAGES.map((s) => [s, stageView(s)])),
      empathise: this.config.empathise.cards.map((c) => ({ id: c.id, by: this.name(c.by), text: c.text })),
      define: this.config.define.options.map((o) => ({ id: o.id, text: o.text })),
      ideate: { pick: this.config.ideate.pick, ideas: this.config.ideate.ideas.map((i) => ({ id: i.id, by: this.name(i.by), text: i.text })) },
      prototype: this.config.prototype.options.map((o) => ({ id: o.id, text: o.text })),
      test: this.done.has('test') ? { name: this.config.test.name, rows: this.config.test.rows, finding: this.config.test.finding } : { name: this.config.test.name },
    };
  }
}

function validate(config: DesignConfig, check: ToolCheck): void {
  const { add, bundleOrg } = check;
  const people = new Set(bundleOrg.people.map((p) => p.id));
  const who = (id: string, at: string): void => {
    if (!people.has(id)) add(`design ${at}: ${id} does not work here`);
  };
  for (const t of config?.team ?? []) who(t.person, 'team');
  for (const c of config?.empathise?.cards ?? []) who(c.by, `card ${c.id}`);
  for (const i of config?.ideate?.ideas ?? []) who(i.by, `idea ${i.id}`);
  if (!config?.empathise?.cards?.some((c) => c.kind === 'assumed')) add('design: empathise needs at least one assumption to drop');
  for (const c of config?.empathise?.cards ?? []) if (c.kind === 'assumed' && !c.reply) add(`design card ${c.id}: an assumption needs a reply`);
  if ((config?.define?.options ?? []).filter((o) => o.correct).length !== 1) add('design: define needs exactly one correct option');
  if ((config?.prototype?.options ?? []).filter((o) => o.correct).length !== 1) add('design: prototype needs exactly one correct option');
  const good = (config?.ideate?.ideas ?? []).filter((i) => i.good).length;
  if (good !== config?.ideate?.pick) add(`design: ideate picks ${config?.ideate?.pick} but ${good} ideas are good`);
  for (const i of config?.ideate?.ideas ?? []) if (i.good ? !i.answers : !i.reply) add(`design idea ${i.id}: ${i.good ? 'needs the reason it answers' : 'needs a reply'}`);
  if (!config?.test?.rows?.length || !config.test.finding) add('design: test needs result rows and a finding');
}

function ops(_config: DesignConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  return { empathise: new Set(['observations']), define: new Set(['problem']), ideate: new Set(['ideas']), prototype: new Set(['trial']), test: new Set(['results']) };
}

export const designTool: ToolModule<DesignConfig> = {
  create: (config, parts) => new DesignBoard(config, parts),
  validate,
  ops,
};
