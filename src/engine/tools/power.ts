// The UPS panel: the server room's battery, what it carries, and how long it
// lasts. Load shedding is announced; the learner chooses which machines stay
// on the UPS and which are shut down cleanly before the power goes, so the
// battery outlasts the slot. Runtime = usable watt-hours / watts, in hours,
// which the panel turns into hours and minutes with div and mod.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome } from './tool.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export interface LoadDef {
  system: string;
  watts: number;
}

export interface PowerConfig {
  ups: { name: string; /** Watt-hours. */ battery: number; /** Share of the battery that reaches the load, 0 to 1. */ efficiency: number };
  /** What always runs on the UPS: switches, firewall, cooling. */
  fixed: { name: string; watts: number };
  /** The load-shedding slot, "HH:MM". */
  slot: { from: string; to: string };
  loads: LoadDef[];
}

/** Minutes from "HH:MM" to "HH:MM", across midnight if need be. */
function slotMinutes(slot: { from: string; to: string }): number {
  const m = (t: string): number => {
    const [h, min] = t.split(':').map(Number);
    return (h ?? 0) * 60 + (min ?? 0);
  };
  return (m(slot.to) - m(slot.from) + 24 * 60) % (24 * 60);
}

/** "2 h 27 min": div for the hours, mod for the minutes left over. */
export function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

class UpsPanel extends Tool<PowerConfig> {
  readonly id = 'power';
  /** Systems that stay on the UPS. Everything starts on it. */
  private keep = new Set(this.config.loads.map((l) => l.system));
  private saved = false;

  private runtime(keep: Set<string>): { watts: number; minutes: number } {
    const watts = this.config.fixed.watts + this.config.loads.filter((l) => keep.has(l.system)).reduce((sum, l) => sum + l.watts, 0);
    const usable = this.config.ups.battery * this.config.ups.efficiency;
    return { watts, minutes: Math.floor((usable / watts) * 60) };
  }

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op !== 'plan') return { ok: false, message: 'The UPS panel cannot do that.' };
    const raw = args.keep;
    if (!Array.isArray(raw)) return { ok: false, message: 'Choose which machines stay on the UPS.' };
    const ids = new Set(this.config.loads.map((l) => l.system));
    const keep = new Set(raw.filter((k): k is string => typeof k === 'string' && ids.has(k)));
    this.keep = keep;
    this.saved = true;
    this.emit({ kind: 'tool.update', summary: 'UPS plan saved', data: { tool: this.id } });
    const { watts, minutes } = this.runtime(keep);
    const slot = slotMinutes(this.config.slot);
    const shed = this.config.loads.filter((l) => !keep.has(l.system));
    const message = `UPS plan: ${keep.size} machines on the battery, ${shed.length} shut down first. ${watts} W lasts ${hm(minutes)}`;
    const world = this.parts.world;
    const name = (id: string): string => world.resolveSystem(this.parts.org, id)?.name ?? id;
    const jewels = shed.filter((l) => world.resolveSystem(this.parts.org, l.system)?.critical);
    if (jewels.length > 0) {
      return {
        ok: true,
        message,
        target: 'plan',
        correct: false,
        reply: `${jewels.map((l) => name(l.system)).join(', ')} ${jewels.length === 1 ? 'is a crown jewel' : 'are crown jewels'}. The town needs ${jewels.length === 1 ? 'it' : 'them'} through the slot: shed something else.`,
      };
    }
    if (minutes < slot) {
      return {
        ok: true,
        message,
        target: 'plan',
        correct: false,
        reply: `${watts} W runs the battery flat in ${hm(minutes)}, before the ${hm(slot)} slot ends, and then everything drops at once. Shed more of what isn't critical.`,
      };
    }
    const sensor = shed.find((l) => world.resolveSystem(this.parts.org, l.system)?.kind === 'security' && l.watts <= 100);
    const extra = sensor ? ` If the budget allows, keep ${name(sensor.system)} on: attackers like a dark building too.` : '';
    return {
      ok: true,
      message,
      target: 'plan',
      correct: true,
      reply: `${watts} W lasts ${hm(minutes)}, longer than the ${hm(slot)} slot, with every crown jewel on.${extra}`,
    };
  }

  view(): unknown {
    const world = this.parts.world;
    const { watts, minutes } = this.runtime(this.keep);
    const slot = slotMinutes(this.config.slot);
    return {
      ups: this.config.ups,
      fixed: this.config.fixed,
      slot: { ...this.config.slot, minutes: slot, text: hm(slot) },
      saved: this.saved,
      loads: this.config.loads.map((l) => {
        const host = world.resolveSystem(this.parts.org, l.system);
        return {
          system: l.system,
          name: host?.name ?? l.system,
          critical: host?.critical ?? false,
          watts: l.watts,
          on: this.keep.has(l.system),
        };
      }),
      watts,
      minutes,
      runtime: hm(minutes),
    };
  }
}

function validate(config: PowerConfig, check: ToolCheck): void {
  const { add, bundleOrg } = check;
  const systems = new Set(bundleOrg.systems.map((s) => s.id));
  if (!config?.ups || !(config.ups.battery > 0) || !(config.ups.efficiency > 0 && config.ups.efficiency <= 1)) {
    add('power: the UPS needs a battery in watt-hours and an efficiency from 0 to 1');
  }
  if (!config?.fixed || !(config.fixed.watts >= 0)) add('power: fixed needs watts');
  if (!/^\d\d:\d\d$/.test(config?.slot?.from ?? '') || !/^\d\d:\d\d$/.test(config?.slot?.to ?? '')) add('power: the slot runs from HH:MM to HH:MM');
  if (!Array.isArray(config?.loads) || config.loads.length === 0) {
    add('power: needs loads');
    return;
  }
  for (const load of config.loads) {
    if (!systems.has(load.system)) add(`power: no machine ${load.system}`);
    if (!(load.watts > 0)) add(`power: ${load.system} needs watts`);
  }
}

function ops(_config: PowerConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  return { plan: new Set(['plan']) };
}

export const powerTool: ToolModule<PowerConfig> = {
  create: (config, parts) => new UpsPanel(config, parts),
  validate,
  ops,
};
