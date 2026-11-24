// The risk register: what could go wrong, how likely it is, how bad it would
// be, and who owns it. The learner scores each risk as likelihood x impact on
// the usual 1 to 5 scales, and the heat map places it. A sensible score sits
// in the band the floor expects; anything outside gets the reason it is off.
// Incidents that happened can be linked to the risk they prove, which takes
// that risk's likelihood to 5: it is no longer a maybe.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome, type ToolParts } from './tool.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export interface RiskDef {
  id: string;
  name: string;
  /** The system the risk lands on. */
  asset?: string;
  /** Person id of the risk owner: the manager who answers for it, not ICT. */
  owner?: string;
  description?: string;
  /** The scores a sensible analyst gives it, [lowest, highest] for each scale. */
  expect: { likelihood: [number, number]; impact: [number, number] };
  /** Why the likelihood and the impact are what they are, said when a score is off. */
  why: { likelihood: string; impact: string };
  /** Already scored when the round starts. */
  given?: { likelihood: number; impact: number };
}

export interface IncidentDef {
  id: string;
  /** A short name, shown on the risk it is linked to. */
  name: string;
  /** The incident report itself. */
  report?: string;
  /** The risk this incident proves. */
  risk: string;
  /** What the mentor says once it is linked. */
  why: string;
}

export interface RiskConfig {
  risks: RiskDef[];
  incidents?: IncidentDef[];
}

export type Band = 'low' | 'medium' | 'high' | 'critical';

export function band(score: number): Band {
  if (score <= 4) return 'low';
  if (score <= 9) return 'medium';
  if (score <= 16) return 'high';
  return 'critical';
}

interface RiskState {
  likelihood: number | null;
  impact: number | null;
  incidents: string[];
  /** Lab ms of the last change. */
  updated: number | null;
}

const LIKELIHOOD = ['', 'Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain'];
const IMPACT = ['', 'Insignificant', 'Minor', 'Moderate', 'Major', 'Severe'];

class RiskRegister extends Tool<RiskConfig> {
  readonly id = 'risk';
  private readonly state = new Map<string, RiskState>();

  constructor(config: RiskConfig, parts: ToolParts) {
    super(config, parts);
    for (const risk of config.risks) {
      this.state.set(risk.id, {
        likelihood: risk.given?.likelihood ?? null,
        impact: risk.given?.impact ?? null,
        incidents: [],
        updated: risk.given ? 0 : null,
      });
    }
  }

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op === 'score') return this.score(args);
    if (op === 'link') return this.link(args);
    return { ok: false, message: 'The risk register cannot do that.' };
  }

  private score(args: ToolArgs): ToolOutcome {
    const risk = this.config.risks.find((r) => r.id === this.text(args, 'risk'));
    const likelihood = this.int(args, 'likelihood');
    const impact = this.int(args, 'impact');
    if (!risk) return { ok: false, message: 'Choose a risk in the register.' };
    if (likelihood === null || impact === null || likelihood < 1 || likelihood > 5 || impact < 1 || impact > 5) {
      return { ok: false, message: 'Likelihood and impact each go from 1 to 5.' };
    }
    const state = this.state.get(risk.id)!;
    state.likelihood = likelihood;
    state.impact = impact;
    state.updated = this.parts.clock.now;
    const score = likelihood * impact;
    const off: string[] = [];
    const [lLo, lHi] = risk.expect.likelihood;
    const [iLo, iHi] = risk.expect.impact;
    if (likelihood < lLo) off.push(`Likelihood ${likelihood} (${LIKELIHOOD[likelihood]}) is too low. ${risk.why.likelihood}`);
    if (likelihood > lHi) off.push(`Likelihood ${likelihood} (${LIKELIHOOD[likelihood]}) is too high. ${risk.why.likelihood}`);
    if (impact < iLo) off.push(`Impact ${impact} (${IMPACT[impact]}) is too low. ${risk.why.impact}`);
    if (impact > iHi) off.push(`Impact ${impact} (${IMPACT[impact]}) is too high. ${risk.why.impact}`);
    const message = `Scored "${risk.name}": ${likelihood} x ${impact} = ${score}, ${band(score)}`;
    if (off.length > 0) {
      return { ok: true, message, target: risk.id, correct: false, reply: off.join(' ') };
    }
    const reply = `${likelihood} x ${impact} = ${score}: a ${band(score)} risk. ${risk.why.likelihood} ${risk.why.impact}`;
    return { ok: true, message, target: risk.id, correct: true, reply };
  }

  private link(args: ToolArgs): ToolOutcome {
    const incident = (this.config.incidents ?? []).find((i) => i.id === this.text(args, 'incident'));
    const risk = this.config.risks.find((r) => r.id === this.text(args, 'risk'));
    if (!incident || !risk) return { ok: false, message: 'Choose an incident and the risk it belongs to.' };
    if (incident.risk !== risk.id) {
      return {
        ok: true,
        message: `Linked "${incident.name}" to "${risk.name}"`,
        target: incident.id,
        correct: false,
        reply: `That incident is not what "${risk.name}" describes. Read the incident again: what did the attacker actually do, and to which system?`,
      };
    }
    const state = this.state.get(risk.id)!;
    for (const other of this.state.values()) other.incidents = other.incidents.filter((id) => id !== incident.id);
    state.incidents.push(incident.id);
    state.likelihood = 5;
    state.updated = this.parts.clock.now;
    const impact = state.impact;
    const score = impact ? ` It now scores 5 x ${impact} = ${5 * impact}, ${band(5 * impact)}.` : ' Score its impact too.';
    return {
      ok: true,
      message: `Linked "${incident.name}" to "${risk.name}"; likelihood is now 5`,
      target: incident.id,
      correct: true,
      reply: `${incident.why} It happened, so it is not a maybe any more: likelihood 5.${score}`,
    };
  }

  view(): unknown {
    const org = this.parts.world.orgs.get(this.parts.org);
    const people = org?.resolved.people ?? [];
    return {
      scales: { likelihood: LIKELIHOOD.slice(1), impact: IMPACT.slice(1) },
      risks: this.config.risks.map((risk) => {
        const s = this.state.get(risk.id)!;
        const score = s.likelihood && s.impact ? s.likelihood * s.impact : null;
        const asset = risk.asset ? this.parts.world.resolveSystem(this.parts.org, risk.asset) : undefined;
        const owner = people.find((p) => p.id === risk.owner);
        return {
          id: risk.id,
          name: risk.name,
          description: risk.description ?? '',
          asset: asset ? { key: asset.key, name: asset.name } : null,
          owner: owner ? `${owner.name}, ${owner.role}` : null,
          likelihood: s.likelihood,
          impact: s.impact,
          score,
          band: score ? band(score) : null,
          incidents: s.incidents.map((id) => this.config.incidents?.find((i) => i.id === id)?.name ?? id),
          updated: s.updated !== null ? this.parts.clock.clockText(s.updated) : null,
        };
      }),
      incidents: (this.config.incidents ?? []).map((i) => ({
        id: i.id,
        name: i.name,
        report: i.report ?? '',
        linked: [...this.state.entries()].find(([, s]) => s.incidents.includes(i.id))?.[0] ?? null,
      })),
    };
  }
}

function validate(config: RiskConfig, check: ToolCheck): void {
  const { add, bundleOrg } = check;
  if (!Array.isArray(config?.risks) || config.risks.length === 0) {
    add('risk: the register needs at least one risk');
    return;
  }
  const systems = new Set(bundleOrg.systems.map((s) => s.id));
  const people = new Set(bundleOrg.people.map((p) => p.id));
  const ids = new Set<string>();
  const range = (v: unknown): boolean =>
    Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 1 && n <= 5) && v[0] <= v[1];
  for (const risk of config.risks) {
    const at = `risk ${risk.id}`;
    if (ids.has(risk.id)) add(`risk: duplicate risk ${risk.id}`);
    ids.add(risk.id);
    if (!risk.name) add(`${at}: needs a name`);
    if (risk.asset && !systems.has(risk.asset)) add(`${at}: no machine ${risk.asset}`);
    if (risk.owner && !people.has(risk.owner)) add(`${at}: owner ${risk.owner} does not work here`);
    if (!range(risk.expect?.likelihood) || !range(risk.expect?.impact)) add(`${at}: expect gives [low, high] from 1 to 5 for likelihood and impact`);
    if (!risk.why?.likelihood || !risk.why?.impact) add(`${at}: needs why for likelihood and impact`);
  }
  for (const incident of config.incidents ?? []) {
    if (!ids.has(incident.risk)) add(`risk: incident ${incident.id} proves unknown risk ${incident.risk}`);
    if (!incident.why) add(`risk: incident ${incident.id} needs why`);
  }
}

function ops(config: RiskConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  return {
    score: new Set(config.risks.map((r) => r.id)),
    link: new Set((config.incidents ?? []).map((i) => i.id)),
  };
}

export const riskTool: ToolModule<RiskConfig> = {
  create: (config, parts) => new RiskRegister(config, parts),
  validate,
  ops,
};
