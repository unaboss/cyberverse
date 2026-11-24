// The security budget: next year's money against the risks it could buy
// down. Each project names the risk it reduces as a single loss (SLE) times
// how often a year it happens (ARO), so its annual loss expectancy (ALE)
// before and after, the risk it reduces, its cost, and its return on
// security investment (ROSI) are all arithmetic the learner can check. The
// plan must fit the envelope and buy the most risk reduction it can.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome, type ToolParts } from './tool.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export interface BudgetProjectDef {
  id: string;
  name: string;
  /** The risk it reduces, in words. */
  risk: string;
  /** What one occurrence costs, in rands. */
  sle: number;
  /** How often a year it happens, today and with the project. */
  aro: number;
  aroAfter: number;
  /** A year's cost, in rands. */
  cost: number;
  /** Said when it's chosen and shouldn't be. */
  reply?: string;
}

export interface BudgetConfig {
  year: string;
  /** What the board has approved, in rands. */
  envelope: number;
  projects: BudgetProjectDef[];
}

const rands = (n: number): string => {
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  return a >= 1_000_000 ? `${sign}R${(a / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}m` : `${sign}R${String(Math.round(a)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;
};

export function ale(p: BudgetProjectDef): { before: number; after: number; reduced: number; rosi: number } {
  const before = Math.round(p.sle * p.aro);
  const after = Math.round(p.sle * p.aroAfter);
  const reduced = before - after;
  return { before, after, reduced, rosi: Math.round(((reduced - p.cost) / p.cost) * 100) };
}

/** The plan that fits the envelope and reduces the most risk. */
export function bestPlan(config: BudgetConfig): string[] {
  const ps = config.projects;
  let best: { ids: string[]; reduced: number; cost: number } = { ids: [], reduced: 0, cost: 0 };
  for (let mask = 0; mask < 1 << ps.length; mask++) {
    const chosen = ps.filter((_, i) => mask & (1 << i));
    const cost = chosen.reduce((a, p) => a + p.cost, 0);
    if (cost > config.envelope) continue;
    const reduced = chosen.reduce((a, p) => a + ale(p).reduced, 0);
    if (reduced > best.reduced || (reduced === best.reduced && cost < best.cost)) best = { ids: chosen.map((p) => p.id), reduced, cost };
  }
  return best.ids;
}

class Budget extends Tool<BudgetConfig> {
  readonly id = 'budget';
  private showRosi = false;
  private approved: { at: number; ids: string[] } | null = null;

  constructor(config: BudgetConfig, parts: ToolParts) {
    super(config, parts);
  }

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op === 'rosi') return this.rosi();
    if (op === 'fund') return this.fund(args);
    return { ok: false, message: 'The budget cannot do that.' };
  }

  private rosi(): ToolOutcome {
    if (this.showRosi) return { ok: false, message: 'The return column is there already.' };
    this.showRosi = true;
    return { ok: true, message: 'Added a return on security investment column', target: 'rosi', correct: true, reply: 'ROSI = (risk reduced − cost) ÷ cost. Above zero, a project saves more than it costs; below zero, it costs more than it saves.' };
  }

  private fund(args: ToolArgs): ToolOutcome {
    if (this.approved) return { ok: false, message: 'The plan has gone to the board already.' };
    const ids = Array.isArray(args.projects) ? [...new Set(args.projects.filter((p): p is string => typeof p === 'string'))] : [];
    const chosen = this.config.projects.filter((p) => ids.includes(p.id));
    const cost = chosen.reduce((a, p) => a + p.cost, 0);
    const reduced = chosen.reduce((a, p) => a + ale(p).reduced, 0);
    const message = `Checked a ${this.config.year} plan: ${chosen.length} projects, ${rands(cost)}`;
    if (cost > this.config.envelope) return { ok: true, message, target: 'plan', correct: false, reply: `${rands(cost)} is ${rands(cost - this.config.envelope)} over the ${rands(this.config.envelope)} the board approved. Something has to give: look at risk reduced per rand.` };
    const losing = chosen.find((p) => ale(p).rosi < 0);
    if (losing) {
      const a = ale(losing);
      return { ok: true, message, target: 'plan', correct: false, reply: `${losing.name} costs ${rands(losing.cost)} a year to reduce ${rands(a.reduced)} of risk: a return of ${a.rosi}%. ${losing.reply ?? ''}`.trim() };
    }
    const best = bestPlan(this.config);
    const same = best.length === chosen.length && best.every((id) => ids.includes(id));
    if (!same) {
      const bestReduced = this.config.projects.filter((p) => best.includes(p.id)).reduce((a, p) => a + ale(p).reduced, 0);
      return { ok: true, message, target: 'plan', correct: false, reply: `That reduces ${rands(reduced)} a year of risk. Another mix within ${rands(this.config.envelope)} reduces ${rands(bestReduced)}. Rank the projects by return, and fund from the top while the money lasts.` };
    }
    this.approved = { at: this.parts.clock.now, ids };
    this.emit({ kind: 'tool.update', summary: `Security plan for ${this.config.year}: ${chosen.length} projects, ${rands(cost)}, reducing ${rands(reduced)} a year of risk`, data: { tool: this.id } });
    return { ok: true, message: `Put the ${this.config.year} security plan in the board pack: ${rands(cost)}`, target: 'plan', correct: true, reply: `${rands(cost)} of ${rands(this.config.envelope)}, reducing expected losses by ${rands(reduced)} a year. Every project earns more than it costs.` };
  }

  view(): unknown {
    return {
      year: this.config.year,
      envelope: this.config.envelope,
      showRosi: this.showRosi,
      projects: this.config.projects.map((p) => ({ id: p.id, name: p.name, risk: p.risk, sle: p.sle, aro: p.aro, aroAfter: p.aroAfter, cost: p.cost, ...ale(p) })),
      approved: this.approved ? { at: this.parts.clock.clockText(this.approved.at), ids: this.approved.ids } : null,
    };
  }
}

function validate(config: BudgetConfig, check: ToolCheck): void {
  const { add } = check;
  if (!(config?.envelope > 0)) add('budget: needs an envelope');
  if (!Array.isArray(config?.projects) || config.projects.length < 2 || config.projects.length > 12) {
    add('budget: needs 2 to 12 projects');
    return;
  }
  for (const p of config.projects) {
    if (!(p.cost > 0) || !(p.sle > 0) || !(p.aro >= p.aroAfter)) add(`budget project ${p.id}: needs a cost, a single loss and a lower rate after`);
    if (ale(p).rosi < 0 && !p.reply) add(`budget project ${p.id}: a project that loses money needs a reply`);
  }
}

function ops(_config: BudgetConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  return { rosi: new Set(['rosi']), fund: new Set(['plan']) };
}

export const budgetTool: ToolModule<BudgetConfig> = {
  create: (config, parts) => new Budget(config, parts),
  validate,
  ops,
};
