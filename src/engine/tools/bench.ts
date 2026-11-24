// The workbench: a server that won't boot, with its case open. The learner
// works like a technician: make it safe (unplug, wrist strap, then open), form
// a theory from the symptoms, test the parts with a meter, replace only the
// part that failed, set the BIOS again, and boot it. The machine stays down
// until then, and re-imaging it does nothing, because the fault is hardware.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome } from './tool.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export type PartId = 'psu' | 'board' | 'cpu' | 'ram' | 'cmos-battery' | 'disks' | 'nic' | 'fans';

interface PartInfo {
  name: string;
  about: string;
  healthy: string;
  failed: string;
}

/** What each part is, what a meter says when it is fine, and when it is not. */
export const PARTS: Record<PartId, PartInfo> = {
  psu: {
    name: 'Power supply (PSU)',
    about: 'Turns 230 V mains into the low voltages the parts use: 12 V for the drives and processor, 5 V and 3.3 V for the logic.',
    healthy: '12 V rail 12.1 V, 5 V rail 5.0 V, 3.3 V rail 3.3 V. All within 5 per cent.',
    failed: '12 V rail 10.4 V. More than 5 per cent low: the supply is failing.',
  },
  board: {
    name: 'Motherboard',
    about: 'The board everything plugs into. It carries the chipset, the slots and the firmware (BIOS or UEFI) that starts the machine.',
    healthy: 'No swollen capacitors, no scorch marks, every connector seated.',
    failed: 'Two capacitors near the processor are swollen at the top.',
  },
  cpu: {
    name: 'Processor (CPU)',
    about: 'Does the computing. It sits in a socket under the heatsink, with thermal paste between them to carry the heat away.',
    healthy: 'Heatsink firm, paste even, and the BIOS reports the processor correctly.',
    failed: 'The BIOS reports a processor fault and the heatsink is loose.',
  },
  ram: {
    name: 'Memory (RAM)',
    about: 'Holds what the machine is working on right now, and forgets it when the power goes. Servers use ECC memory, which corrects small errors.',
    healthy: '4 x 16 GB ECC, seated firmly. The memory test passes.',
    failed: 'The memory test fails on the second module.',
  },
  'cmos-battery': {
    name: 'CMOS battery (CR2032)',
    about: 'A coin cell that keeps the BIOS settings and the clock alive while the machine is unplugged. It lasts a few years.',
    healthy: '3.0 V. A healthy CR2032.',
    failed: '2.1 V. A healthy CR2032 reads about 3 V.',
  },
  disks: {
    name: 'Disks (RAID 1 mirror)',
    about: 'Two drives holding the same data, so one can fail without losing anything. The RAID controller presents them as one volume.',
    healthy: 'Both drives spin up, SMART reports healthy and the mirror is in sync.',
    failed: 'One drive clicks and SMART reports it failing. The mirror is running on one disk.',
  },
  nic: {
    name: 'Network card (NIC)',
    about: 'Connects the server to the network through an RJ45 port. Its lights show the link and the traffic.',
    healthy: 'Link light on at 1 Gb/s when cabled.',
    failed: 'No link light, even with a known-good cable.',
  },
  fans: {
    name: 'Fans and airflow',
    about: 'Pull cool air in at the front, over the parts and out at the back. Dust on the filters makes everything run hot.',
    healthy: 'All fans spin, but the front filter is grey with dust.',
    failed: 'One fan doesn\'t spin.',
  },
};

const SAFETY = ['unplug', 'strap', 'open'] as const;
type Safety = (typeof SAFETY)[number];

export interface BenchConfig {
  /** The machine on the bench, by system id. */
  system: string;
  /** The part that failed. */
  fault: PartId;
  /** What the screen shows when it is switched on. */
  symptoms: string[];
}

class Workbench extends Tool<BenchConfig> {
  readonly id = 'bench';
  private readonly done = new Set<Safety>();
  private readonly tested = new Set<PartId>();
  private replaced: PartId[] = [];
  private bios: { clock: boolean; boot: string } = { clock: false, boot: 'network' };
  private biosSaved = false;
  private booted = false;

  private get host() {
    return this.parts.world.resolveSystem(this.parts.org, this.config.system);
  }

  private get fixed(): boolean {
    return this.replaced.includes(this.config.fault);
  }

  override start(): void {
    const host = this.host;
    if (!host) return;
    host.status = 'down';
    host.fault = `${host.name} has a hardware fault. Re-imaging it won't help: it needs opening up on the bench.`;
  }

  act(op: string, args: ToolArgs): ToolOutcome {
    switch (op) {
      case 'prepare':
        return this.prepare(this.text(args, 'step'));
      case 'test':
        return this.test(this.text(args, 'part'));
      case 'replace':
        return this.replace(this.text(args, 'part'));
      case 'bios':
        return this.setBios(args);
      case 'boot':
        return this.boot();
      default:
        return { ok: false, message: 'The workbench cannot do that.' };
    }
  }

  private update(summary: string): void {
    this.emit({ kind: 'tool.update', summary, data: { tool: this.id } });
  }

  private prepare(step: string): ToolOutcome {
    if (!(SAFETY as readonly string[]).includes(step)) return { ok: false, message: 'Choose a step.' };
    if (this.booted) return { ok: false, message: 'The server is running again.' };
    const s = step as Safety;
    if (s === 'strap' && !this.done.has('unplug')) {
      return { ok: true, message: 'Put on the wrist strap', target: s, correct: false, reply: 'A strap protects the parts from you, not you from the mains. Switch off and unplug first.' };
    }
    if (s === 'open' && (!this.done.has('unplug') || !this.done.has('strap'))) {
      const missing = !this.done.has('unplug') ? 'It is still plugged in. Mains voltage inside a case can kill: switch it off and unplug it first.' : 'You are not earthed. Static from your hands can kill a memory module or a board without a spark you can see: put on the wrist strap first.';
      return { ok: true, message: 'Tried to open the case', target: s, correct: false, reply: missing };
    }
    this.done.add(s);
    this.update(`Bench: ${s}`);
    const message = { unplug: 'Switched off and unplugged the server', strap: 'Put on the anti-static wrist strap, clipped to the bare metal of the case', open: 'Opened the case' }[s];
    return { ok: true, message, target: s, correct: true };
  }

  private part(id: string): PartId | null {
    return id in PARTS ? (id as PartId) : null;
  }

  private test(id: string): ToolOutcome {
    const part = this.part(id);
    if (!part) return { ok: false, message: 'Choose a part.' };
    if (!this.done.has('open')) return { ok: false, message: 'Open the case safely first.' };
    this.tested.add(part);
    this.update(`Bench: tested ${part}`);
    const info = PARTS[part];
    const bad = part === this.config.fault && !this.fixed;
    const reading = bad ? info.failed : info.healthy;
    return { ok: true, message: `Tested the ${info.name}: ${reading}`, target: part, correct: true, reply: reading };
  }

  private replace(id: string): ToolOutcome {
    const part = this.part(id);
    if (!part) return { ok: false, message: 'Choose a part.' };
    if (!this.done.has('open')) return { ok: false, message: 'Open the case safely first.' };
    const info = PARTS[part];
    if (part !== this.config.fault) {
      return {
        ok: true,
        message: `Replaced the ${info.name}`,
        target: part,
        correct: false,
        reply: `The old ${info.name.toLowerCase()} was fine. Swapping parts that test fine costs money and changes nothing: test first, then replace the part that failed.`,
      };
    }
    if (!this.replaced.includes(part)) this.replaced.push(part);
    this.update(`Bench: replaced ${part}`);
    return { ok: true, message: `Replaced the ${info.name}. The new one reads 3.2 V.`, target: part, correct: true };
  }

  private setBios(args: ToolArgs): ToolOutcome {
    if (!this.fixed) {
      return { ok: false, message: 'Fix the fault first. Settings saved now would be lost the next time it is unplugged.' };
    }
    const clock = args.clock === true || args.clock === 'set';
    const boot = this.text(args, 'boot');
    if (!['raid', 'usb', 'network'].includes(boot)) return { ok: false, message: 'Choose what it boots from.' };
    this.bios = { clock, boot };
    this.biosSaved = true;
    this.update('Bench: BIOS saved');
    const message = `Closed the case, plugged it in and saved the BIOS: clock ${clock ? 'set to now' : 'left at 01/01/2000'}, boots from ${boot === 'raid' ? 'the RAID volume' : boot === 'usb' ? 'USB' : 'the network'}`;
    const off: string[] = [];
    if (boot !== 'raid') off.push(`The operating system lives on the RAID volume. Booting from ${boot === 'usb' ? 'USB' : 'the network'} finds nothing, or worse, whatever somebody plugged in.`);
    if (!clock) off.push('A clock stuck in the year 2000 breaks more than the logs: certificates look not yet valid, and the directory refuses logins from a clock more than five minutes out.');
    if (off.length > 0) return { ok: true, message, target: 'bios', correct: false, reply: off.join(' ') };
    return { ok: true, message, target: 'bios', correct: true };
  }

  private boot(): ToolOutcome {
    const host = this.host;
    if (!host) return { ok: false, message: 'No machine on the bench.' };
    if (this.booted) return { ok: false, message: `${host.name} is already running.` };
    if (!this.fixed || !this.biosSaved) {
      return { ok: true, message: `Switched on ${host.name}: it stops at the BIOS screen again`, target: 'boot', correct: false, reply: 'Same screen as before. Fix the fault and set the BIOS, then try again.' };
    }
    if (this.bios.boot !== 'raid') {
      return { ok: true, message: `Switched on ${host.name}: "No boot device found"`, target: 'boot', correct: false, reply: 'It found nothing to start. Set the BIOS to boot from the RAID volume.' };
    }
    if (!this.bios.clock) {
      return { ok: true, message: `Switched on ${host.name}: it boots, but the backup jobs fail to log in`, target: 'boot', correct: false, reply: 'The backup account can\'t log in to the directory: its clock is 26 years out. Set the clock in the BIOS.' };
    }
    this.booted = true;
    host.status = 'up';
    delete host.fault;
    this.emit({ kind: 'host.restored', host: host.key, summary: `${host.hostname} boots again after a new CMOS battery` });
    this.update('Bench: booted');
    return { ok: true, message: `Switched on ${host.name}: it boots, and the backup jobs log in`, target: 'boot', correct: true };
  }

  view(): unknown {
    const host = this.host;
    return {
      machine: host ? { key: host.key, name: host.name, ip: host.ip, status: host.status } : null,
      symptoms: this.booted ? [] : this.fixed && this.biosSaved ? ['BIOS settings saved.'] : this.config.symptoms,
      safety: SAFETY.map((s) => ({ id: s, done: this.done.has(s) })),
      open: this.done.has('open') && !this.biosSaved,
      parts: (Object.keys(PARTS) as PartId[]).map((id) => {
        const info = PARTS[id];
        const bad = id === this.config.fault && !this.fixed;
        return {
          id,
          name: info.name,
          about: info.about,
          reading: this.tested.has(id) ? (bad ? info.failed : info.healthy) : null,
          bad: this.tested.has(id) && bad,
          replaced: this.replaced.includes(id),
        };
      }),
      fixed: this.fixed,
      bios: this.biosSaved ? this.bios : null,
      booted: this.booted,
    };
  }
}

function validate(config: BenchConfig, check: ToolCheck): void {
  const { add, bundleOrg } = check;
  if (!bundleOrg.systems.some((s) => s.id === config?.system)) add(`bench: no machine ${config?.system}`);
  if (!(config?.fault in PARTS)) add(`bench: fault ${config?.fault} is not a part: use ${Object.keys(PARTS).join(', ')}`);
  if (!Array.isArray(config?.symptoms) || config.symptoms.length === 0 || !config.symptoms.every((s) => typeof s === 'string')) add('bench: needs symptoms, the lines on screen');
}

function ops(_config: BenchConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  const parts = new Set(Object.keys(PARTS));
  return {
    prepare: new Set(SAFETY),
    test: parts,
    replace: parts,
    bios: new Set(['bios']),
    boot: new Set(['boot']),
  };
}

export const benchTool: ToolModule<BenchConfig> = {
  create: (config, parts) => new Workbench(config, parts),
  validate,
  ops,
};
