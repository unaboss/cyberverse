// A round: one learner, one practical, one living miniverse. It wires the
// world, the clock, the sensors, the staff bots, the business pulse and the
// live opponent together, and keeps the score.

import { randomUUID } from 'node:crypto';
import type { WorldBundle } from '../world/load.ts';
import type { PracticalDef } from '../world/types.ts';
import { EventBus, Rng, SimClock, type LabEvent } from './core.ts';
import { Detector } from './detect.ts';
import { World } from './world.ts';
import { Business, StaffBots } from './staff.ts';
import { DefenderBot, Responder, type ActionResult } from './response.ts';
import { LiveAttacker, type AttackerResult } from './attacker.ts';
import type { Ctx } from './attack.ts';
import { Terminal } from './terminal.ts';
import { Guide, type Look } from './guide.ts';
import { scoreRound, type RoundScore } from './score.ts';
import { Toolbox } from './tools/index.ts';

export type RoundStatus = 'briefing' | 'live' | 'paused' | 'ended';

export interface StatusReport {
  summary: string;
  impact: string;
  actions: string;
  recommendations: string;
  submittedAt: number;
}

export interface RoundEnd {
  reason: 'time' | 'contained' | 'objective' | 'caught' | 'stopped' | 'complete';
  at: number;
}

export class Session {
  readonly id: string;
  readonly clock: SimClock;
  readonly rng: Rng;
  readonly bus: EventBus;
  readonly world: World;
  readonly detector: Detector;
  readonly business: Business;
  readonly responder: Responder;
  readonly bots: StaffBots;
  attacker: LiveAttacker | null = null;
  defender: DefenderBot | null = null;
  terminal: Terminal | null = null;
  guide: Guide | null = null;
  /** The floor's desk tools, when it has any. */
  tools: Toolbox | null = null;
  status: RoundStatus = 'briefing';
  end: RoundEnd | null = null;
  report: StatusReport | null = null;
  score: RoundScore | null = null;
  readonly seed: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly durationMs: number;
  speed: number;
  /** While waiting on a guided floor, the clock can run fast until something happens. */
  private fastUntil: number | null = null;
  private normalSpeed = 1;

  readonly bundle: WorldBundle;
  readonly practical: PracticalDef;

  constructor(
    bundle: WorldBundle,
    practical: PracticalDef,
    opts: { seed?: number; speed?: number; id?: string } = {},
  ) {
    this.id = opts.id ?? randomUUID();
    this.bundle = bundle;
    this.practical = practical;
    this.seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    this.rng = new Rng(this.seed);
    this.clock = SimClock.fromTimeOfDay(practical.startTime);
    this.bus = new EventBus(this.clock);
    this.world = new World(bundle, practical, this.rng);
    this.detector = new Detector(this.world, this.bus);
    this.business = new Business(this.world, this.bus, this.clock);
    this.responder = new Responder(this.world, this.bus, this.clock);
    this.bots = new StaffBots(this.world, this.bus, this.clock, this.rng);
    this.durationMs = practical.durationMin * 60_000;
    this.speed = opts.speed ?? practical.speed ?? 1;

    const ctx: Ctx = {
      world: this.world,
      bus: this.bus,
      clock: this.clock,
      rng: this.rng,
      actor: practical.role === 'prey' ? 'attacker' : 'learner',
      onLeak: (key, by, fraction) => this.business.leak(key, by, fraction),
    };
    if (practical.role === 'prey' && practical.attacker) {
      this.attacker = new LiveAttacker(ctx, practical.attacker, practical.org, (result) => this.attackerEnded(result));
    }
    if (practical.role === 'predator') {
      this.terminal = new Terminal(ctx, this.world.attackerPool, practical.org);
      for (const id of practical.foothold ? (Array.isArray(practical.foothold) ? practical.foothold : [practical.foothold]) : []) {
        this.terminal.seedFoothold(id);
      }
      if (practical.defender?.enabled !== false) {
        this.defender = new DefenderBot(practical.org, this.world, this.bus, this.clock, this.rng, this.detector, this.responder, practical.defender?.reaction ?? 1);
      }
    }
    if (practical.tools && practical.role === 'prey') {
      this.tools = new Toolbox(practical.tools, {
        world: this.world,
        bus: this.bus,
        clock: this.clock,
        rng: this.rng,
        detector: this.detector,
        bots: this.bots,
        business: this.business,
        responder: this.responder,
        org: practical.org,
      });
    }
    if (practical.guide) {
      const parts = { world: this.world, bus: this.bus, clock: this.clock, rng: this.rng, detector: this.detector, bots: this.bots };
      this.guide = new Guide(practical.guide, practical.org, parts, () => this.finish('complete'));
    }
    // Fast-forward stops the moment there is something to look at.
    this.bus.on((event) => {
      if (this.fastUntil !== null && (event.kind === 'alert.raised' || event.kind === 'guide.ready' || event.kind === 'guide.step' || event.kind === 'guide.done' || this.clock.now >= this.fastUntil)) {
        this.slow();
      }
    });
  }

  /** True while the clock is running fast. */
  get fast(): boolean {
    return this.fastUntil !== null;
  }

  /** Run the clock 20 times faster until an alert lands, the step moves on, or ten lab minutes pass. */
  fastForward(): ActionResult {
    if (this.fastUntil !== null) {
      return { ok: true, message: 'Already skipping ahead.' };
    }
    this.normalSpeed = this.speed;
    this.speed = Math.max(this.speed, 20);
    this.fastUntil = this.clock.now + 10 * 60_000;
    this.clock.at(10 * 60_000, () => this.slow());
    return { ok: true, message: 'Skipping ahead until something happens.' };
  }

  private slow(): void {
    if (this.fastUntil === null) {
      return;
    }
    this.fastUntil = null;
    this.speed = this.normalSpeed;
  }

  get org(): string {
    return this.practical.org;
  }

  /** False when the practical has no time limit. */
  get timed(): boolean {
    return this.durationMs > 0;
  }

  get remainingMs(): number {
    return this.timed ? Math.max(0, this.durationMs - this.clock.now) : 0;
  }

  /** Start the world. In real time unless `manual` (tests drive the clock). */
  begin(manual = false): void {
    if (this.status !== 'briefing') {
      return;
    }
    this.status = 'live';
    this.bus.emit({ kind: 'round.start', actor: 'system', org: this.org, summary: `${this.practical.title} begins` });
    this.bots.start();
    this.business.start();
    this.defender?.start();
    this.tools?.start();
    this.guide?.start();
    if (this.attacker) {
      void this.attacker.run();
    }
    if (this.timed) {
      this.clock.at(this.durationMs, () => this.finish('time'));
    }
    if (!manual) {
      this.timer = setInterval(() => {
        if (this.status === 'live') {
          void this.clock.advance(100 * this.speed);
        }
      }, 100);
    }
  }

  pause(): void {
    if (this.status === 'live') {
      this.status = 'paused';
    }
  }

  resume(): void {
    if (this.status === 'paused') {
      this.status = 'live';
    }
  }

  /** Run the round forward without real time passing (tests, headless runs). */
  async run(ms: number, step = 1000): Promise<void> {
    for (let done = 0; done < ms && this.status === 'live'; done += step) {
      await this.clock.advance(step);
    }
  }

  private attackerEnded(result: AttackerResult): void {
    if (result === 'objective') {
      this.finish('objective');
    } else if (result === 'gave-up') {
      this.finish('contained');
    }
  }

  finish(reason: RoundEnd['reason']): void {
    if (this.status === 'ended') {
      return;
    }
    this.end = { reason, at: this.clock.now };
    this.bus.emit({ kind: 'round.end', actor: 'system', org: this.org, summary: `Round over: ${reason}`, data: { reason } });
    this.business.tick(0);
    this.status = 'ended';
    this.score = scoreRound(this);
    this.clock.stop();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop(): void {
    this.finish('stopped');
  }

  // ------------------------------------------------------- learner actions

  private guard(): ActionResult | null {
    if (this.status !== 'live' && this.status !== 'paused') {
      return { ok: false, message: 'The round is not running.' };
    }
    return null;
  }

  act(action: LearnerAction): ActionResult {
    if (action.type === 'report') {
      // The status report is usually written once the round is over.
      if (this.status === 'briefing') {
        return { ok: false, message: 'The round has not started.' };
      }
      const { summary, impact, actions, recommendations } = action;
      return this.submitReport({ summary, impact, actions, recommendations });
    }
    const blocked = this.guard();
    if (blocked) {
      return blocked;
    }
    // Guide actions work on either side: an attack floor is guided too, with the
    // mentor card over the terminal.
    if (action.type === 'look') {
      return this.guide ? this.guide.look(action) : { ok: true, message: '' };
    }
    if (action.type === 'answer') {
      return this.guide ? this.guide.answer(action.option) : { ok: false, message: 'There is no question to answer.' };
    }
    if (action.type === 'fast') {
      return this.fastForward();
    }
    if (this.practical.role !== 'prey') {
      return { ok: false, message: 'Defensive actions are for prey rounds.' };
    }
    if (action.type === 'tool') {
      return this.tools ? this.tools.act(action.tool, action.op, action.args ?? {}) : { ok: false, message: 'There are no desk tools on this floor.' };
    }
    const unlocks = this.guide?.unlocksOn(action.type);
    if (unlocks !== undefined) {
      return { ok: false, message: `That unlocks on floor ${unlocks}. Follow the card for now.` };
    }
    const r = this.responder;
    switch (action.type) {
      case 'block':
        return r.block(this.org, action.src, 'learner');
      case 'unblock':
        return r.unblock(this.org, action.src, 'learner');
      case 'isolate':
        return this.ownHost(action.host) ?? r.isolate(action.host, 'learner');
      case 'release':
        return this.ownHost(action.host) ?? r.release(action.host, 'learner');
      case 'rebuild':
        return this.ownHost(action.host) ?? r.rebuild(action.host, 'learner');
      case 'lock':
        return this.ownHost(action.host) ?? r.lock(action.host, action.user, 'learner');
      case 'reset':
        return this.ownHost(action.host) ?? r.resetPassword(action.host, action.user, 'learner');
      case 'control':
        return r.setControl(this.org, action.control, action.on, 'learner');
      case 'classify': {
        const alert = this.detector.get(action.alert);
        if (!alert || alert.org !== this.org) {
          return { ok: false, message: 'No such alert.' };
        }
        alert.verdict = action.verdict;
        alert.status = 'closed';
        this.bus.emit({
          kind: 'alert.classified',
          actor: 'learner',
          org: this.org,
          summary: `Marked alert #${alert.id} (${alert.name}) as ${action.verdict.replace('-', ' ')}`,
          data: { alert: alert.id, verdict: action.verdict, correct: (action.verdict === 'true-positive') === alert.truth },
        });
        return { ok: true, message: `Alert #${alert.id} closed as ${action.verdict.replace('-', ' ')}.` };
      }
      case 'acknowledge': {
        const alert = this.detector.get(action.alert);
        if (!alert || alert.org !== this.org) {
          return { ok: false, message: 'No such alert.' };
        }
        if (alert.status === 'new') {
          alert.status = 'acknowledged';
          this.bus.emit({ kind: 'alert.acknowledged', actor: 'learner', org: this.org, summary: `Picked up alert #${alert.id}`, data: { alert: alert.id } });
        }
        return { ok: true, message: `Alert #${alert.id} is yours.` };
      }
    }
  }

  private ownHost(key: string): ActionResult | null {
    const host = this.world.hosts.get(key);
    return host && host.org === this.org ? null : { ok: false, message: 'That machine is not yours to touch.' };
  }

  submitReport(report: Omit<StatusReport, 'submittedAt'>): ActionResult {
    this.report = { ...report, submittedAt: this.clock.now };
    this.bus.emit({ kind: 'report.submitted', actor: 'learner', org: this.org, summary: 'Status report submitted' });
    if (this.status === 'ended') {
      this.score = scoreRound(this);
    }
    return { ok: true, message: 'Status report saved.' };
  }

  async command(line: string): Promise<string> {
    if (!this.terminal) {
      return 'There is no attack terminal on a prey round.';
    }
    if (this.status !== 'live' && this.status !== 'paused') {
      return 'The round is not running.';
    }
    return this.terminal.run(line);
  }

  onEvent(listener: (event: LabEvent) => void): () => void {
    return this.bus.on(listener);
  }
}

export type LearnerAction =
  | { type: 'block' | 'unblock'; src: string }
  | { type: 'isolate' | 'release' | 'rebuild'; host: string }
  | { type: 'lock' | 'reset'; host: string; user: string }
  | { type: 'control'; control: string; on: boolean }
  | { type: 'classify'; alert: number; verdict: 'true-positive' | 'false-positive' }
  | { type: 'acknowledge'; alert: number }
  | ({ type: 'look' } & Look)
  | { type: 'answer'; option: number }
  | { type: 'fast' }
  | { type: 'tool'; tool: string; op: string; args?: Record<string, unknown> }
  | ({ type: 'report' } & Omit<StatusReport, 'submittedAt'>);
