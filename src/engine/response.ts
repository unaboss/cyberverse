// Defensive actions, shared by the learner (on prey rounds) and the defender
// bot (on predator rounds): block, isolate, rebuild, lock, reset, switch a
// control on. Each one is an event, so it shows on the debrief timeline.

import type { EventBus, Rng, SimClock } from './core.ts';
import type { Detector, Alert } from './detect.ts';
import type { World } from './world.ts';

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

export class Responder {
  private readonly world: World;
  private readonly bus: EventBus;
  private readonly clock: SimClock;

  constructor(
    world: World,
    bus: EventBus,
    clock: SimClock,
  ) {
    this.world = world;
    this.bus = bus;
    this.clock = clock;
  }

  block(orgId: string, src: string, by: string): ActionResult {
    if (!this.world.orgs.has(orgId)) {
      return { ok: false, message: 'Unknown organisation.' };
    }
    if (!this.world.isLabAddress(src.split('/')[0] ?? '')) {
      return { ok: false, message: `${src} is not a lab address.` };
    }
    if (this.world.blocks.some((b) => b.org === orgId && b.src === src)) {
      return { ok: false, message: `${src} is already blocked.` };
    }
    this.world.blocks.push({ org: orgId, src, by, at: this.clock.now, stopped: 0 });
    this.bus.emit({ kind: 'fw.block', actor: by, org: orgId, src, summary: `Blocked ${src} at the ${this.world.orgs.get(orgId)!.name} perimeter` });
    return { ok: true, message: `Blocked ${src}.` };
  }

  unblock(orgId: string, src: string, by: string): ActionResult {
    const index = this.world.blocks.findIndex((b) => b.org === orgId && b.src === src);
    if (index < 0) {
      return { ok: false, message: `${src} is not blocked.` };
    }
    this.world.blocks.splice(index, 1);
    this.bus.emit({ kind: 'fw.unblock', actor: by, org: orgId, src, summary: `Unblocked ${src}` });
    return { ok: true, message: `Unblocked ${src}.` };
  }

  isolate(hostKey: string, by: string): ActionResult {
    const host = this.world.hosts.get(hostKey);
    if (!host) {
      return { ok: false, message: 'Unknown machine.' };
    }
    if (host.status === 'isolated') {
      return { ok: false, message: `${host.hostname} is already isolated.` };
    }
    host.status = 'isolated';
    this.bus.emit({
      kind: 'host.isolate',
      actor: by,
      org: host.org,
      host: host.key,
      summary: `Isolated ${host.hostname}${host.critical ? ' (a critical system: the business feels this)' : ''}`,
    });
    return { ok: true, message: `${host.hostname} is cut off from the network.` };
  }

  release(hostKey: string, by: string): ActionResult {
    const host = this.world.hosts.get(hostKey);
    if (!host || host.status !== 'isolated') {
      return { ok: false, message: 'That machine is not isolated.' };
    }
    host.status = 'up';
    this.bus.emit({ kind: 'host.release', actor: by, org: host.org, host: host.key, summary: `Reconnected ${host.hostname}` });
    return { ok: true, message: `${host.hostname} is back on the network.` };
  }

  /** Wipe and restore from a clean image. Takes the machine down for two minutes. */
  rebuild(hostKey: string, by: string): ActionResult {
    const host = this.world.hosts.get(hostKey);
    if (!host) {
      return { ok: false, message: 'Unknown machine.' };
    }
    if (host.fault) {
      return { ok: false, message: host.fault };
    }
    host.status = 'down';
    this.bus.emit({ kind: 'host.rebuild', actor: by, org: host.org, host: host.key, summary: `Rebuilding ${host.hostname} from a clean image` });
    this.clock.at(120_000, () => {
      host.compromise = null;
      host.status = 'up';
      this.bus.emit({ kind: 'host.restored', actor: 'system', org: host.org, host: host.key, summary: `${host.hostname} restored from a clean image` });
    });
    return { ok: true, message: `${host.hostname} will be back in about two minutes, clean.` };
  }

  lock(hostKey: string, user: string, by: string): ActionResult {
    const account = this.world.hosts.get(hostKey)?.accounts.find((a) => a.user === user);
    if (!account) {
      return { ok: false, message: `No account ${user} there.` };
    }
    account.locked = true;
    this.bus.emit({ kind: 'account.lock', actor: by, host: hostKey, org: hostKey.split('/')[0]!, user, summary: `Locked ${user}` });
    return { ok: true, message: `${user} is locked.` };
  }

  resetPassword(hostKey: string, user: string, by: string): ActionResult {
    const account = this.world.hosts.get(hostKey)?.accounts.find((a) => a.user === user);
    if (!account) {
      return { ok: false, message: `No account ${user} there.` };
    }
    account.password = this.world.strongPassword();
    account.originalPassword = account.password;
    account.locked = false;
    account.failures = 0;
    this.bus.emit({ kind: 'account.reset', actor: by, host: hostKey, org: hostKey.split('/')[0]!, user, summary: `Reset the password for ${user}` });
    return { ok: true, message: `${user} has a new password.` };
  }

  setControl(orgId: string, controlId: string, on: boolean, by: string): ActionResult {
    const org = this.world.orgs.get(orgId);
    const control = org?.controls.get(controlId);
    if (!org || !control) {
      return { ok: false, message: 'That control does not exist at this level.' };
    }
    if (on && org.projects.has(controlId)) {
      return {
        ok: false,
        message: `"${control.name}" is a project, not a switch: it needs a budget, a plan and its owner's sign-off. It stays on the plan for now.`,
      };
    }
    this.world.setControl(orgId, controlId, on);
    this.bus.emit({
      kind: 'control.change',
      actor: by,
      org: orgId,
      summary: `${on ? 'Switched on' : 'Switched off'}: ${control.name}`,
      data: { control: controlId, on },
    });
    return { ok: true, message: `${control.name} is ${on ? 'on' : 'off'}.` };
  }
}

/**
 * The company fighting back on predator rounds. It only knows what its own
 * alerts tell it, so a quiet attacker is never caught.
 */
export class DefenderBot {
  private handled = new Set<number>();

  private readonly orgId: string;
  private readonly world: World;
  private readonly bus: EventBus;
  private readonly clock: SimClock;
  private readonly rng: Rng;
  private readonly detector: Detector;
  private readonly responder: Responder;
  private readonly reaction: number;

  constructor(
    orgId: string,
    world: World,
    bus: EventBus,
    clock: SimClock,
    rng: Rng,
    detector: Detector,
    responder: Responder,
    reaction: number = 1,
  ) {
    this.orgId = orgId;
    this.world = world;
    this.bus = bus;
    this.clock = clock;
    this.rng = rng;
    this.detector = detector;
    this.responder = responder;
    this.reaction = reaction;
  }

  start(): void {
    this.bus.on((event) => {
      if (event.kind !== 'alert.raised' || event.org !== this.orgId) {
        return;
      }
      const alert = this.detector.get(Number(event.data?.alert));
      if (!alert || this.handled.has(alert.id) || alert.severity === 'low') {
        return;
      }
      this.handled.add(alert.id);
      const base = { critical: 40, high: 90, medium: 240, low: 0 }[alert.severity];
      const levelFactor = 1.6 - this.world.orgs.get(this.orgId)!.level * 0.15;
      this.clock.at(Math.round(this.rng.jitter(base * 1000 * levelFactor * this.reaction, 0.35)), () => this.respond(alert));
    });
  }

  private respond(alert: Alert): void {
    alert.status = 'acknowledged';
    const external = alert.src && this.world.zoneOfIp(alert.src).org !== this.orgId;
    if (external && alert.src) {
      this.responder.block(this.orgId, alert.src, 'defender');
    }
    const host = alert.host ? this.world.hosts.get(alert.host) : undefined;
    if (host && ['nids-exploit-signature', 'hids-suspicious-process', 'hids-ransomware-encrypt', 'hids-mass-file-read'].includes(alert.rule)) {
      this.responder.isolate(host.key, 'defender');
    }
    if (host && alert.user && ['hids-login-after-failures', 'hids-service-account-new-source', 'hids-default-credentials'].includes(alert.rule)) {
      this.responder.resetPassword(host.key, alert.user, 'defender');
    }
    if (!external && alert.src && alert.rule.startsWith('nids-')) {
      const source = this.world.byIp.get(alert.src);
      if (source && source.org === this.orgId && ['nids-port-scan', 'nids-host-sweep'].includes(alert.rule) && source.kind !== 'security') {
        this.responder.isolate(source.key, 'defender');
      }
    }
  }
}
