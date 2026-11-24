// The honeypot: a decoy machine the learner puts on the network. Nobody has a
// reason to touch it, so whatever does is suspicious, however slowly it moves.
// The learner picks where it stands and what it pretends to be; a decoy only
// catches anything where the attacker looks, dressed as what they look for.
// Its window keeps a log of every touch, which is the evidence.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome } from './tool.ts';
import type { LabEvent } from '../core.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';
import type { ServiceDef } from '../../world/types.ts';
import { inCidr } from '../../world/net.ts';

export interface SpotDef {
  id: string;
  /** Where it stands, in words. */
  name: string;
  zone: string;
  ip: string;
  /** The room it shows in on the floor. */
  room: string;
}

export interface PersonaDef {
  id: string;
  /** What it pretends to be. */
  name: string;
  hostname: string;
  os: string;
  services: ServiceDef[];
}

export interface HoneypotConfig {
  spots: SpotDef[];
  personas: PersonaDef[];
  /** Where a sensible analyst puts it, and what as. */
  expect: { spot: string; persona: string };
  /** Said when the spot or the persona is off. */
  why: { spot: string; persona: string };
}

interface Touch {
  at: number;
  src: string;
  port: number;
}

const KEY = 'honeypot';

class Honeypot extends Tool<HoneypotConfig> {
  readonly id = 'honeypot';
  private placed: { spot: SpotDef; persona: PersonaDef; at: number } | null = null;
  private touches: Touch[] = [];

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op === 'deploy') return this.deploy(args);
    if (op === 'remove') return this.remove();
    return { ok: false, message: 'The honeypot cannot do that.' };
  }

  private deploy(args: ToolArgs): ToolOutcome {
    const spot = this.config.spots.find((s) => s.id === this.text(args, 'spot'));
    const persona = this.config.personas.find((p) => p.id === this.text(args, 'persona'));
    if (!spot || !persona) return { ok: false, message: 'Choose where the honeypot stands and what it pretends to be.' };
    const key = `${this.parts.org}/${KEY}`;
    this.parts.world.addDecoy({
      key,
      org: this.parts.org,
      dept: spot.room,
      id: KEY,
      name: `Honeypot: ${persona.name}`,
      hostname: persona.hostname,
      zone: spot.zone,
      ip: spot.ip,
      os: persona.os,
      services: persona.services,
    });
    const moved = this.placed !== null;
    this.placed = { spot, persona, at: this.parts.clock.now };
    this.touches = [];
    this.emit({ kind: 'tool.update', host: key, summary: `Honeypot up at ${spot.ip}`, data: { tool: this.id } });
    const message = `${moved ? 'Moved the honeypot' : 'Put up a honeypot'}: "${persona.name}" at ${spot.ip}`;
    const off: string[] = [];
    if (spot.id !== this.config.expect.spot) off.push(this.config.why.spot);
    if (persona.id !== this.config.expect.persona) off.push(this.config.why.persona);
    if (off.length > 0) {
      return { ok: true, message, target: spot.id, correct: false, reply: off.join(' ') };
    }
    return { ok: true, message, target: spot.id, correct: true };
  }

  private remove(): ToolOutcome {
    if (!this.placed) return { ok: false, message: 'There is no honeypot up.' };
    this.parts.world.removeHost(`${this.parts.org}/${KEY}`);
    this.placed = null;
    this.emit({ kind: 'tool.update', summary: 'Honeypot taken down', data: { tool: this.id } });
    return { ok: true, message: 'Took the honeypot down' };
  }

  override observe(event: LabEvent): void {
    if (!this.placed || event.kind !== 'net.probe' || event.dst !== this.placed.spot.ip || !event.src) return;
    this.touches.push({ at: event.t, src: event.src, port: event.dstPort ?? 0 });
    this.emit({ kind: 'tool.update', summary: `Honeypot touched from ${event.src}`, data: { tool: this.id } });
  }

  view(): unknown {
    const clock = this.parts.clock;
    const world = this.parts.world;
    const placed = this.placed;
    return {
      spots: this.config.spots.map((s) => ({ id: s.id, name: s.name, ip: s.ip })),
      personas: this.config.personas.map((p) => ({ id: p.id, name: p.name, ports: p.services.map((s) => `${s.port}/${s.name}`) })),
      placed: placed
        ? {
            spot: placed.spot.id,
            persona: placed.persona.id,
            name: placed.persona.name,
            ip: placed.spot.ip,
            hostname: placed.persona.hostname,
            since: clock.clockText(placed.at),
            key: `${this.parts.org}/${KEY}`,
          }
        : null,
      touches: this.touches
        .slice(-12)
        .reverse()
        .map((t) => {
          const from = world.byIp.get(t.src);
          return { at: clock.clockText(t.at), src: t.src, port: t.port, from: from && from.org === this.parts.org ? from.name : null };
        }),
      total: this.touches.length,
      sources: [...new Set(this.touches.map((t) => t.src))].length,
    };
  }
}

function validate(config: HoneypotConfig, check: ToolCheck): void {
  const { add, bundleOrg } = check;
  const zones = bundleOrg.zones;
  const rooms = new Set(bundleOrg.departments.map((d) => d.id));
  const used = new Set(bundleOrg.systems.map((s) => s.ip));
  if (!Array.isArray(config?.spots) || config.spots.length === 0) add('honeypot: needs at least one spot');
  if (!Array.isArray(config?.personas) || config.personas.length === 0) add('honeypot: needs at least one persona');
  for (const spot of config?.spots ?? []) {
    const zone = zones.find((z) => z.id === spot.zone);
    if (!zone) add(`honeypot spot ${spot.id}: no zone ${spot.zone}`);
    else if (!inCidr(spot.ip, zone.cidr)) add(`honeypot spot ${spot.id}: ${spot.ip} is not in ${zone.cidr}`);
    if (used.has(spot.ip)) add(`honeypot spot ${spot.id}: ${spot.ip} is already a machine's address`);
    if (!rooms.has(spot.room)) add(`honeypot spot ${spot.id}: no room ${spot.room}`);
  }
  for (const persona of config?.personas ?? []) {
    if (!persona.name || !persona.hostname || !Array.isArray(persona.services) || persona.services.length === 0) {
      add(`honeypot persona ${persona.id}: needs a name, a hostname and services`);
    }
  }
  if (!config?.spots?.some((s) => s.id === config.expect?.spot)) add('honeypot: expect.spot is not one of the spots');
  if (!config?.personas?.some((p) => p.id === config.expect?.persona)) add('honeypot: expect.persona is not one of the personas');
  if (!config?.why?.spot || !config?.why?.persona) add('honeypot: needs why for the spot and the persona');
}

function ops(config: HoneypotConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  return {
    deploy: new Set(config.spots.map((s) => s.id)),
    remove: null,
  };
}

export const honeypotTool: ToolModule<HoneypotConfig> = {
  create: (config, parts) => new Honeypot(config, parts),
  validate,
  ops,
};
