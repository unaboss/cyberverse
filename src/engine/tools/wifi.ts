// The Wi-Fi survey: a laptop that listens to every access point it can hear,
// on a map of the floor in metres. The learner walks the floor taking
// readings, spots the network that has the right name but the wrong maker,
// follows its signal to where it is strongest, marks it on the map and
// unplugs it. The map uses ordinary coordinates (x across, y up, from the
// bottom-left corner), so "how far is it" is Pythagoras.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome } from './tool.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export interface AccessPointDef {
  id: string;
  /** What ICT calls it, for the ones ICT put up. */
  name?: string;
  ssid: string;
  bssid: string;
  vendor: string;
  channel: number;
  security: string;
  /** Metres from the floor's bottom-left corner. */
  x: number;
  y: number;
  /** ICT installed it, so it is on the map from the start. */
  known?: boolean;
  /** The one to find. */
  rogue?: boolean;
}

export interface WifiConfig {
  /** Metres per floor-plan cell. */
  scale?: number;
  aps: AccessPointDef[];
  /** Readings before the survey is enough to go on. */
  readings?: number;
  /** How close a mark has to be, in metres. */
  near?: number;
  /** What is in the box once it is unplugged. */
  seized: {
    found: string;
    clients: { name: string; device: string }[];
    capture: string[];
  };
}

interface Reading {
  n: number;
  x: number;
  y: number;
  at: number;
  room: string;
  heard: { bssid: string; signal: number }[];
}

/** Signal strength in dBm at a distance in metres: about -35 beside it, falling with distance. */
export function signalAt(metres: number): number {
  return Math.round(-35 - 25 * Math.log10(metres + 1));
}

/** Distance between two points, to one decimal. */
export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.round(Math.hypot(ax - bx, ay - by) * 10) / 10;
}

const MORE: Record<number, string> = { 1: 'One more', 2: 'Two more', 3: 'Three more' };

class WifiSurvey extends Tool<WifiConfig> {
  readonly id = 'wifi';
  private readings: Reading[] = [];
  private marks: { x: number; y: number; d: number }[] = [];
  private located = false;
  private seized = false;

  private get scale(): number {
    return this.config.scale ?? 2;
  }

  private get size(): { width: number; height: number } {
    const floor = this.org()?.def.floor ?? { width: 20, height: 10 };
    return { width: floor.width * this.scale, height: floor.height * this.scale };
  }

  private get rogue(): AccessPointDef {
    return this.config.aps.find((a) => a.rogue)!;
  }

  private org(): ResolvedOrg | undefined {
    return this.parts.world.orgs.get(this.parts.org)?.resolved;
  }

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op === 'survey') return this.survey(args);
    if (op === 'locate') return this.locate(args);
    if (op === 'seize') return this.seize();
    return { ok: false, message: 'The Wi-Fi survey cannot do that.' };
  }

  private point(args: ToolArgs): { x: number; y: number } | null {
    const x = Math.round(Number(args.x));
    const y = Math.round(Number(args.y));
    const { width, height } = this.size;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) return null;
    return { x, y };
  }

  /** The room a point is in, by name. */
  private roomAt(x: number, y: number): { id: string; name: string } | null {
    const org = this.org();
    if (!org) return null;
    const s = this.scale;
    const floorH = org.def.floor.height;
    for (const d of org.departments) {
      const r = d.room;
      const left = r.x * s;
      const bottom = (floorH - r.y - r.h) * s;
      if (x >= left && x <= left + r.w * s && y >= bottom && y <= bottom + r.h * s) return { id: d.id, name: d.name };
    }
    return null;
  }

  private survey(args: ToolArgs): ToolOutcome {
    const at = this.point(args);
    if (!at) return { ok: false, message: 'Choose a spot on the floor map.' };
    const room = this.roomAt(at.x, at.y);
    const heard = this.config.aps
      .filter((ap) => !(ap.rogue && this.seized))
      .map((ap) => ({ bssid: ap.bssid, signal: signalAt(Math.hypot(ap.x - at.x, ap.y - at.y)) }))
      .sort((a, b) => b.signal - a.signal);
    const n = this.readings.length + 1;
    this.readings.push({ n, ...at, at: this.parts.clock.now, room: room?.name ?? 'Corridor', heard });
    if (this.readings.length > 40) this.readings.shift();
    this.emit({ kind: 'tool.update', summary: `Wi-Fi reading at (${at.x}, ${at.y})`, data: { tool: this.id } });
    const message = `Wi-Fi reading ${n} at (${at.x}, ${at.y}), ${room?.name ?? 'the corridor'}`;
    const need = this.config.readings ?? 4;
    if (n < need) {
      const more = MORE[need - n] ?? `${need - n} more`;
      return { ok: true, message, target: room?.id ?? '', correct: false, reply: `One reading says who is loud here, not where they are. ${more}, spread around the floor.` };
    }
    return { ok: true, message, target: room?.id ?? '', correct: true };
  }

  private locate(args: ToolArgs): ToolOutcome {
    const at = this.point(args);
    if (!at) return { ok: false, message: 'Choose a spot on the floor map.' };
    if (this.readings.length === 0) return { ok: false, message: 'Take some readings first.' };
    if (this.located) return { ok: false, message: 'You found it already. Unplug it.' };
    const r = this.rogue;
    const d = distance(at.x, at.y, r.x, r.y);
    this.marks.push({ ...at, d });
    this.emit({ kind: 'tool.update', summary: `Marked (${at.x}, ${at.y})`, data: { tool: this.id } });
    const message = `Marked the twin at (${at.x}, ${at.y})`;
    if (d > (this.config.near ?? 3)) {
      return {
        ok: true,
        message,
        target: r.id,
        correct: false,
        reply: `Nothing there: it's about ${Math.round(d)} m from your mark. Take readings around your strongest one. Where the signal peaks, you're close.`,
      };
    }
    this.located = true;
    const dx = Math.abs(at.x - r.x);
    const dy = Math.abs(at.y - r.y);
    const sum = d === 0 ? 'right on it' : `√(${dx}² + ${dy}²) = ${d} m away`;
    return { ok: true, message, target: r.id, correct: true, reply: `You marked (${at.x}, ${at.y}). It's at (${r.x}, ${r.y}): ${sum}.` };
  }

  private seize(): ToolOutcome {
    if (!this.located) return { ok: false, message: 'Mark where it is on the map first.' };
    if (this.seized) return { ok: false, message: 'It is unplugged already.' };
    this.seized = true;
    this.emit({ kind: 'tool.update', summary: 'Rogue access point unplugged', data: { tool: this.id } });
    return { ok: true, message: `Unplugged the rogue access point (${this.rogue.bssid})`, target: this.rogue.id, correct: true };
  }

  view(): unknown {
    const org = this.org();
    const s = this.scale;
    const floorH = org?.def.floor.height ?? 10;
    const clock = this.parts.clock;
    return {
      ...this.size,
      rooms: (org?.departments ?? []).map((d) => ({ name: d.name, x: d.room.x * s, y: (floorH - d.room.y - d.room.h) * s, w: d.room.w * s, h: d.room.h * s })),
      known: this.config.aps.filter((a) => a.known).map((a) => ({ name: a.name ?? a.id, bssid: a.bssid, x: a.x, y: a.y })),
      networks: this.config.aps.map((a) => ({ bssid: a.bssid, ssid: a.ssid, vendor: a.vendor, channel: a.channel, security: a.security, known: a.known === true })),
      readings: this.readings.map((r) => ({ n: r.n, x: r.x, y: r.y, room: r.room, at: clock.clockText(r.at), heard: r.heard })),
      need: this.config.readings ?? 4,
      marks: this.marks.map((m) => ({ x: m.x, y: m.y })),
      located: this.located ? { x: this.rogue.x, y: this.rogue.y, bssid: this.rogue.bssid } : null,
      seized: this.seized ? this.config.seized : null,
    };
  }
}

function validate(config: WifiConfig, check: ToolCheck): void {
  const { add, bundleOrg } = check;
  const s = config?.scale ?? 2;
  const width = bundleOrg.def.floor.width * s;
  const height = bundleOrg.def.floor.height * s;
  if (!Array.isArray(config?.aps) || config.aps.length === 0) {
    add('wifi: needs access points');
    return;
  }
  if (config.aps.filter((a) => a.rogue).length !== 1) add('wifi: needs exactly one rogue access point');
  const bssids = new Set<string>();
  for (const ap of config.aps) {
    const at = `wifi ap ${ap.id}`;
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(ap.bssid ?? '')) add(`${at}: bssid must look like 24:de:c6:4a:10:01`);
    if (bssids.has(ap.bssid)) add(`${at}: duplicate bssid ${ap.bssid}`);
    bssids.add(ap.bssid);
    for (const key of ['ssid', 'vendor', 'security'] as const) {
      if (typeof ap[key] !== 'string' || ap[key] === '') add(`${at}: needs ${key}`);
    }
    if (!Number.isInteger(ap.channel)) add(`${at}: channel must be a whole number`);
    if (ap.known && (ap.x < 0 || ap.y < 0 || ap.x > width || ap.y > height)) add(`${at}: (${ap.x}, ${ap.y}) is off the ${width} x ${height} m floor`);
    if (ap.rogue && ap.known) add(`${at}: the rogue one can't be on ICT's map`);
  }
  const rogue = config.aps.find((a) => a.rogue);
  if (rogue && (rogue.x < 0 || rogue.y < 0 || rogue.x > width || rogue.y > height)) add(`wifi: the rogue access point is off the ${width} x ${height} m floor`);
  if (!config.seized?.found || !Array.isArray(config.seized.clients) || !Array.isArray(config.seized.capture)) add('wifi: seized needs found, clients and capture');
}

function ops(config: WifiConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  const rogue = config.aps.find((a) => a.rogue)?.id ?? '';
  return { survey: null, locate: new Set([rogue]), seize: new Set([rogue]) };
}

export const wifiTool: ToolModule<WifiConfig> = {
  create: (config, parts) => new WifiSurvey(config, parts),
  validate,
  ops,
};
