// Guided floors. The low floors of a tower walk a beginner through one small
// thing at a time: a mentor says why, the card says what to do, and the step
// ticks itself off when the learner does it. Steps can make the world do
// something on cue (a login, a practice alert), so a floor teaches the same
// thing every time.

import type { GuideActionDone, GuideDef, GuideStepDef, GuideTermDone, LockableAction, ScriptDef, Severity, SortDef } from '../world/types.ts';
import type { EventBus, LabEvent, Rng, SimClock } from './core.ts';
import type { Alert, Detector } from './detect.ts';
import type { StaffBots } from './staff.ts';
import type { HostState, World } from './world.ts';
import { compromise, defaultService, fetchUrl, portScan, topPorts, tryLogin, type Ctx } from './attack.ts';
import { hostsIn } from '../world/net.ts';

export interface Look {
  what: 'room' | 'host' | 'tab' | 'alert';
  /** Department id, "org/system" host key, tab name, or alert number. */
  id: string;
}

export interface GuideResult {
  ok: boolean;
  message: string;
}

type StepStatus = 'todo' | 'current' | 'done';

interface StepState {
  status: StepStatus;
  startedAt: number;
  /** False while the step's script is still playing out. */
  ready: boolean;
}

export interface GuideView {
  mentor: { name: string; role: string };
  steps: { id: string; title: string; status: StepStatus }[];
  current: {
    index: number;
    id: string;
    title: string;
    say: string;
    do: string;
    hint: string;
    show: { room?: string; host?: string; tab?: string; alert?: number };
    /** Shown once the step's script has run. */
    ask: { question: string; options: string[] } | null;
    waiting: boolean;
    /** How many of the step's alerts are sorted, on a sorting step. */
    sort: { done: number; total: number } | null;
    /** How many of the step's targets are done, when it waits for several. */
    targets: { done: number; total: number } | null;
    /** The step is waiting on the world for a while: the learner may skip ahead. */
    canSkip: boolean;
    /** The desk tool the step's action is done in, so its window can open by itself. */
    tool: string | null;
  } | null;
  /** The floor's target time and how long it has taken so far, in lab ms. */
  time: { targetMs: number | null; tookMs: number };
  /**
   * The mentor's reply to the alert the learner last sorted, or to an action on
   * the wrong thing; seq goes up with each one.
   */
  verdict: { seq: number; alert?: number; title: string; text: string; correct: boolean } | null;
  /** The reply to the learner's last answer on this step. */
  feedback: { text: string; correct: boolean } | null;
  /** What the mentor said about the step just finished, with its own heading when the step has one. */
  last: { title: string; text: string; wrong: boolean; heading?: string } | null;
  locked: Partial<Record<LockableAction, number>>;
  complete: boolean;
  scored: boolean;
  outro: GuideDef['outro'] | null;
}

/** The seconds after a step's last scripted event before its question shows. */
const SETTLE_SEC = 2;

/** Seconds between a forgetful person's tries, unless the script says. */
const RETRY_SEC = 4;

/** When a scripted event is over, in seconds from the start of its step. */
function scriptEnd(item: ScriptDef): number {
  if (item.event === 'guess') {
    return item.after + Math.max(0, item.tries - 1) * item.every;
  }
  if (item.event === 'login') {
    return item.after + (item.fails ?? 0) * (item.every ?? RETRY_SEC);
  }
  if (item.event === 'scan' || item.event === 'job') {
    return item.after + 3; // a quick scan of the common ports takes a couple of seconds
  }
  if (item.event === 'phish') {
    return item.after + (item.opens ?? 0);
  }
  if (item.event === 'sweep') {
    return item.after + item.for;
  }
  return item.after;
}

/**
 * The window a step works in, so it can open by itself: the desk tool its
 * action is done in, or the tab it shows. A step that asks the learner to open
 * a window leaves it for them. The browser opens it only when it is one of
 * the floor's desk tools.
 */
function stepTool(step: GuideStepDef): string | null {
  const done = step.done;
  if ('action' in done && done.action.includes('.')) return done.action.split('.')[0] ?? null;
  if ('look' in done) return null;
  return step.show?.tab ?? null;
}

/** The learner's actions a step can wait for, by the event each one makes. */
const ACTIONS: Record<string, string> = {
  'fw.block': 'block',
  'host.isolate': 'isolate',
  'host.rebuild': 'rebuild',
  'account.lock': 'lock',
  'account.reset': 'reset',
  'control.change': 'control',
};

/** What an action event was done to, in the terms a step's `done` uses. */
function actionTarget(event: LabEvent): string {
  if (event.kind === 'fw.block') return event.src ?? '';
  if (event.kind === 'control.change') return String(event.data?.control ?? '');
  const system = (event.host ?? '').split('/')[1] ?? '';
  return event.user ? `${system}:${event.user}` : system;
}

/** The addresses a sorting entry's alert may come from. */
function sortSource(world: World, org: string, entry: SortDef): string | undefined {
  return entry.src ?? (entry.from ? world.resolveSystem(org, entry.from)?.ip : undefined);
}

export class Guide {
  readonly def: GuideDef;
  complete = false;
  private index = 0;
  private readonly states: StepState[];
  private readonly drills = new Map<string, number>();
  private feedback: GuideView['feedback'] = null;
  private last: GuideView['last'] = null;
  private verdict: GuideView['verdict'] = null;
  private verdicts = 0;
  /** For each sorting step, the entries sorted so far and whether each was right. */
  private readonly sorted = new Map<string, Map<number, boolean>>();
  /** "action target" for everything the learner has done this round. */
  private readonly acted = new Set<string>();
  /** For each step with several targets, the ones done so far. */
  private readonly progress = new Map<string, Set<string>>();
  /** Lab ms when the floor was finished. */
  private finishedAt: number | null = null;

  private readonly org: string;
  private readonly world: World;
  private readonly bus: EventBus;
  private readonly clock: SimClock;
  private readonly rng: Rng;
  private readonly detector: Detector;
  private readonly bots: StaffBots;
  private readonly onComplete: () => void;

  constructor(
    def: GuideDef,
    org: string,
    parts: { world: World; bus: EventBus; clock: SimClock; rng: Rng; detector: Detector; bots: StaffBots },
    onComplete: () => void,
  ) {
    this.def = def;
    this.org = org;
    this.world = parts.world;
    this.bus = parts.bus;
    this.clock = parts.clock;
    this.rng = parts.rng;
    this.detector = parts.detector;
    this.bots = parts.bots;
    this.onComplete = onComplete;
    this.states = def.steps.map(() => ({ status: 'todo', startedAt: 0, ready: false }));
    // A job the floor runs on cue must not also run on its own schedule, or the
    // learner gets an extra alert the card knows nothing about.
    for (const process of def.hold ?? []) {
      this.bots.hold(org, process);
    }
    for (const step of def.steps) {
      for (const item of step.script ?? []) {
        if (item.event === 'job') {
          this.bots.hold(org, item.process);
        }
      }
    }
  }

  start(): void {
    this.bus.on((event) => this.observe(event));
    this.enter(0);
  }

  get step(): GuideStepDef | null {
    return this.complete ? null : (this.def.steps[this.index] ?? null);
  }

  /** The floor that unlocks an action, if this floor locks it. */
  unlocksOn(action: string): number | undefined {
    return (this.def.locked as Record<string, number> | undefined)?.[action];
  }

  // ------------------------------------------------------------ learner

  look(look: Look): GuideResult {
    const step = this.step;
    if (!step || !('look' in step.done)) {
      return { ok: true, message: '' };
    }
    const done = step.done;
    if (done.look === 'alert') {
      const alert = look.what === 'alert' ? this.detector.get(Number(look.id)) : undefined;
      if (alert && alert.org === this.org && !alert.drill && (!done.rule || alert.rule === done.rule)) {
        this.advance(false);
      }
      return { ok: true, message: '' };
    }
    // Opening a machine inside the room counts as finding the room: that is what a beginner clicks.
    const hostRoom = look.what === 'host' ? this.world.hosts.get(look.id)?.dept : undefined;
    const matches =
      done.look === 'room'
        ? done.id
          ? (look.what === 'room' && look.id === done.id) || hostRoom === done.id
          : look.what === 'room' || look.what === 'host'
        : done.look === look.what && (look.what === 'host' ? look.id === `${this.org}/${done.id}` : look.id === done.id);
    if (matches) {
      this.advance(false);
    }
    return { ok: true, message: '' };
  }

  answer(option: number): GuideResult {
    const step = this.step;
    const state = this.states[this.index];
    if (!step?.ask || !state) {
      return { ok: false, message: 'There is no question on this step.' };
    }
    if (!state.ready) {
      return { ok: false, message: 'Wait a moment: it has not happened yet.' };
    }
    const chosen = step.ask.options[option];
    if (!chosen) {
      return { ok: false, message: 'Choose one of the answers.' };
    }
    const correct = chosen.correct === true;
    const reply = this.fill(chosen.reply);
    this.feedback = { text: reply, correct };
    this.bus.emit({ kind: 'guide.answer', actor: 'system', org: this.org, summary: `Answered "${step.ask.question}": ${chosen.text}`, data: { step: step.id, correct } });
    if (correct && 'answer' in step.done) {
      // The right answer's reply is what the mentor says about the step.
      this.advance(false, step.praise ?? chosen.reply);
    }
    return { ok: true, message: reply };
  }

  // -------------------------------------------------------------- world

  private observe(event: LabEvent): void {
    const current = this.step;
    if (current && 'command' in current.done && this.termHit(current.done.command, event)) {
      this.advance(false);
      return;
    }
    if (event.kind === 'tool.use' && event.actor === 'learner') {
      const action = `${String(event.data?.tool ?? '')}.${String(event.data?.op ?? '')}`;
      const target = String(event.data?.target ?? '');
      const correct = event.data?.correct !== false;
      const reply = typeof event.data?.reply === 'string' ? event.data.reply : undefined;
      if (correct) this.acted.add(`${action} ${target}`);
      this.acting(action, target, { correct, ...(reply !== undefined ? { reply } : {}) });
      return;
    }
    const action = event.actor === 'learner' ? ACTIONS[event.kind] : undefined;
    if (action && !(action === 'control' && event.data?.on !== true)) {
      this.acted.add(`${action} ${actionTarget(event)}`);
      this.acting(action, actionTarget(event));
      return;
    }
    const step = this.step;
    if (!step || event.kind !== 'alert.classified') {
      return;
    }
    if ('sorted' in step.done) {
      this.sort(step, Number(event.data?.alert), String(event.data?.verdict ?? ''));
      return;
    }
    if (!('alert' in step.done)) {
      return;
    }
    const done = step.done;
    const id = Number(event.data?.alert);
    if (done.drill && this.drills.get(step.id) !== id) {
      return;
    }
    if (done.rule && this.detector.get(id)?.rule !== done.rule) {
      return;
    }
    const verdict = String(event.data?.verdict ?? '');
    this.advance(done.verdict !== undefined && verdict !== done.verdict);
  }

  /**
   * An attack step is done when the terminal reaches its milestone. We match on
   * the outcome event the toolkit emits, not on the words the learner typed, so
   * any route to the same result (a different flag, tool or wordlist) still counts.
   */
  private termHit(want: GuideTermDone, event: LabEvent): boolean {
    const hostKey = want.of ? `${this.org}/${want.of}` : null;
    const onHost = (): boolean => !hostKey || event.host === hostKey;
    switch (want.did) {
      case 'read':
        return event.kind === 'terminal.command' && (!want.text || event.summary.toLowerCase().includes(want.text.toLowerCase()));
      case 'scan':
        return event.kind === 'terminal.discovered' && (!hostKey || String(event.data?.host ?? '') === hostKey);
      case 'crack':
        return event.kind === 'auth.success' && event.tags.includes('bruteforce') && onHost() && (!want.user || event.user === want.user);
      case 'login':
        return event.kind === 'auth.success' && event.actor === 'learner' && onHost() && (!want.user || event.user === want.user);
      case 'shell':
        return event.kind === 'proc.exec' && event.tags.includes('shell') && onHost();
      case 'dump':
        return event.kind === 'proc.exec' && event.tags.includes('credential-dump') && onHost();
      case 'exfil':
        return event.kind === 'data.transfer' && onHost();
      default:
        return false;
    }
  }

  /** The learner closed an alert on a sorting step: say whether they sorted it right. */
  private sort(step: GuideStepDef, id: number, verdict: string): void {
    const alert = this.detector.get(id);
    const entries = step.sort ?? [];
    const done = this.sorted.get(step.id) ?? new Map<number, boolean>();
    this.sorted.set(step.id, done);
    const index = alert ? entries.findIndex((entry, i) => !done.has(i) && this.matches(entry, alert)) : -1;
    const entry = entries[index];
    if (!alert || !entry) {
      return;
    }
    const correct = verdict === entry.verdict;
    done.set(index, correct);
    const text = this.fill(correct ? entry.right : entry.wrong);
    this.verdict = { seq: ++this.verdicts, alert: id, title: alert.name, text, correct };
    this.bus.emit({ kind: 'guide.sorted', actor: 'system', org: this.org, summary: `Sorted alert ${id}: ${correct ? 'right' : 'wrong'}`, data: { step: step.id, alert: id, correct } });
    if (done.size < entries.length) {
      return;
    }
    // The last one: its reply leads the step's closing note, so the learner reads one note, not two.
    const right = [...done.values()].filter(Boolean).length;
    const all = right === entries.length;
    const closing = all ? step.praise : (step.wrong ?? step.praise);
    this.verdict = null;
    this.advance(!all, [text, closing ? this.fill(closing) : ''].filter(Boolean).join('\n\n'));
    if (this.last) {
      this.last.heading = all ? `All ${entries.length} sorted right` : `${right} of ${entries.length} sorted right`;
    }
  }

  /**
   * The learner did something: is it what the step waits for, or the same thing
   * to the wrong target? A desk tool also says whether it was done well (a risk
   * scored sensibly, the right part replaced), with what the mentor says about it.
   */
  private acting(action: string, target: string, tool?: { correct: boolean; reply?: string }): void {
    const step = this.step;
    if (!step || !('action' in step.done)) {
      return;
    }
    if (step.done.action !== action) {
      // Another operation of the step's own tool (bagging, while the step
      // waits for the seal): a wrong one still gets the mentor's reason.
      const sameTool = action.includes('.') && step.done.action.split('.')[0] === action.split('.')[0];
      if (sameTool && tool?.correct === false && tool.reply) {
        this.verdict = { seq: ++this.verdicts, title: step.title, text: this.fill(tool.reply), correct: false };
      }
      return;
    }
    const done = step.done;
    const wanted = this.wantedAll(done);
    const progress = this.progress.get(step.id) ?? new Set<string>();
    this.progress.set(step.id, progress);
    const key = target.split(':')[0] ?? target;
    const next = wanted.find((t) => !progress.has(t));
    const onTarget = wanted.length === 0 || (wanted.includes(target) && (!done.order || target === next));
    if (!onTarget || tool?.correct === false) {
      const reply = (tool?.correct === false ? tool.reply : undefined) ?? step.replies?.[target] ?? step.replies?.[key] ?? step.wrong ?? tool?.reply;
      if (reply) {
        this.verdict = { seq: ++this.verdicts, title: step.title, text: this.fill(reply), correct: false };
      }
      this.bus.emit({ kind: 'guide.sorted', actor: 'system', org: this.org, summary: `Not the step's target: ${action} ${target}`, data: { step: step.id, correct: false } });
      return;
    }
    if (wanted.length > 0) progress.add(target);
    if (wanted.length > 0 && progress.size < wanted.length) {
      // One of several: say how that one went, and wait for the rest.
      if (tool?.reply) {
        this.verdict = { seq: ++this.verdicts, title: step.title, text: this.fill(tool.reply), correct: true };
      }
      this.bus.emit({ kind: 'guide.sorted', actor: 'system', org: this.org, summary: `Done ${progress.size} of ${wanted.length}: ${step.title}`, data: { step: step.id, correct: true } });
      return;
    }
    const said = [tool?.reply, step.praise].filter((t): t is string => !!t).map((t) => this.fill(t)).join('\n\n');
    this.advance(false, said || undefined);
  }

  private wanted(done: GuideActionDone): string {
    return done.user ? `${done.target}:${done.user}` : (done.target ?? '');
  }

  /** Every target a step waits for, or none when anything counts. */
  private wantedAll(done: GuideActionDone): string[] {
    if (done.targets?.length) return done.targets;
    return done.target !== undefined ? [this.wanted(done)] : [];
  }

  /** True when the learner already did what a step asks, before the step began. */
  private satisfied(step: GuideStepDef): boolean | 'wrong' {
    const done = step.done;
    if ('action' in done) {
      if (done.action === 'block') return this.world.blocks.some((b) => b.org === this.org && b.src === done.target);
      if (done.action === 'isolate') return this.world.resolveSystem(this.org, done.target ?? '')?.status === 'isolated';
      if (done.action === 'control') return this.world.orgs.get(this.org)?.controlOn.get(done.target ?? '') === true;
      if (done.action.includes('.')) {
        // A desk tool: done ahead of time only if every target was done right already.
        const wanted = this.wantedAll(done);
        return wanted.length > 0 && wanted.every((t) => this.acted.has(`${done.action} ${t}`));
      }
      return this.acted.has(`${done.action} ${this.wanted(done)}`);
    }
    if ('alert' in done && done.rule && !done.drill) {
      const closed = this.detector.alerts.find((a) => a.org === this.org && a.rule === done.rule && !a.drill && a.status === 'closed');
      if (!closed) return false;
      return done.verdict && closed.verdict !== done.verdict ? 'wrong' : true;
    }
    if ('sorted' in done && step.sort?.length) {
      // Alerts closed before the step began count, without a note for each.
      const sorted = this.sorted.get(step.id) ?? new Map<number, boolean>();
      this.sorted.set(step.id, sorted);
      for (const alert of this.detector.alerts.filter((a) => a.status === 'closed')) {
        const index = step.sort.findIndex((entry, i) => !sorted.has(i) && this.matches(entry, alert));
        if (index >= 0) sorted.set(index, alert.verdict === step.sort[index]!.verdict);
      }
      return sorted.size >= step.sort.length;
    }
    return false;
  }

  private matches(entry: SortDef, alert: Alert): boolean {
    if (alert.rule !== entry.rule || alert.org !== this.org || alert.drill) {
      return false;
    }
    const src = sortSource(this.world, this.org, entry);
    return !src || alert.src === src;
  }

  private enter(index: number): void {
    const step = this.def.steps[index];
    const state = this.states[index];
    if (!step || !state) {
      return;
    }
    this.index = index;
    this.feedback = null;
    state.status = 'current';
    state.startedAt = this.clock.now;
    const already = this.satisfied(step);
    if (already) {
      // Done ahead of time, which is fine: say so, and skip its script.
      state.ready = true;
      this.bus.emit({ kind: 'guide.step', actor: 'system', org: this.org, summary: `Step ${index + 1}: ${step.title}`, data: { step: step.id } });
      this.advance(already === 'wrong');
      return;
    }
    const script = step.script ?? [];
    for (const item of script) {
      this.clock.at(item.after * 1000, () => this.play(step.id, item));
    }
    if (script.length === 0) {
      state.ready = true;
    } else {
      const settle = (Math.max(...script.map(scriptEnd)) + SETTLE_SEC) * 1000;
      this.clock.at(settle, () => {
        state.ready = true;
        if (this.index === index && !this.complete) {
          this.bus.emit({ kind: 'guide.ready', actor: 'system', org: this.org, summary: `Ready: ${step.title}` });
        }
      });
    }
    this.bus.emit({ kind: 'guide.step', actor: 'system', org: this.org, summary: `Step ${index + 1}: ${step.title}`, data: { step: step.id } });
  }

  private advance(wrong: boolean, praise?: string): void {
    const step = this.step;
    const state = this.states[this.index];
    if (!step || !state) {
      return;
    }
    state.status = 'done';
    const said = praise ?? (wrong ? step.wrong : step.praise);
    this.last = said ? { title: step.title, text: this.fill(said), wrong } : null;
    this.bus.emit({ kind: 'guide.done', actor: 'system', org: this.org, summary: `Done: ${step.title}`, data: { step: step.id, wrong } });
    if (this.index + 1 >= this.def.steps.length) {
      this.complete = true;
      this.finishedAt = this.clock.now;
      this.feedback = null;
      this.bus.emit({ kind: 'guide.complete', actor: 'system', org: this.org, summary: this.def.outro.title });
      this.onComplete();
      return;
    }
    this.enter(this.index + 1);
  }

  private play(stepId: string, item: ScriptDef): void {
    const ctx: Ctx = { world: this.world, bus: this.bus, clock: this.clock, rng: this.rng, actor: 'bot:guide' };
    if (item.event === 'job') {
      void this.bots.runNow(this.org, item.process);
      return;
    }
    if (item.event === 'phish') {
      this.phish(ctx, item);
      return;
    }
    if (item.event === 'sweep') {
      this.sweep(ctx, item);
      return;
    }
    const host = this.world.resolveSystem(this.org, item.system);
    if (!host) {
      return;
    }
    switch (item.event) {
      case 'guess':
        this.guess(host, item);
        return;
      case 'scan': {
        const src = item.from ? this.world.resolveSystem(this.org, item.from)?.ip : item.src;
        if (src) {
          // -Pn: a scanner that doesn't wait for a ping, so a block stops every probe.
          void portScan(ctx, this.world.endpointFor(src), host.ip, topPorts(item.ports ?? 100), { timing: 4, malicious: true, actor: 'bot:guide', skipPing: true });
        }
        return;
      }
      case 'download':
        fetchUrl(ctx, this.world.endpointFor(item.src), host, item.path, item.port);
        return;
      case 'drill': {
        const alert = this.detector.drill(this.org, this.clock.now, {
          host: host.key,
          name: item.name,
          severity: item.severity as Severity,
          summary: this.fill(item.summary),
          response: this.fill(item.response),
        });
        this.drills.set(stepId, alert.id);
        return;
      }
      case 'login':
        this.login(ctx, host, item);
        return;
    }
  }

  /**
   * A slow scan: probe number i goes to address i div ports, port i mod ports,
   * round and round the zone, one every few seconds.
   */
  private sweep(ctx: Ctx, item: Extract<ScriptDef, { event: 'sweep' }>): void {
    const from = this.world.resolveSystem(this.org, item.from);
    const zone = this.world.orgs.get(this.org)?.resolved.zones.find((z) => z.id === item.zone);
    if (!from || !zone || item.ports.length === 0) {
      return;
    }
    const addresses = hostsIn(zone.cidr);
    const total = addresses.length * item.ports.length;
    const count = Math.floor(item.for / item.every);
    for (let i = 0; i < count; i++) {
      this.clock.at(i * item.every * 1000, () => {
        if (from.status !== 'up') return;
        const n = i % total;
        const ip = addresses[Math.floor(n / item.ports.length)]!;
        const port = item.ports[n % item.ports.length]!;
        void portScan(ctx, this.world.endpointFor(from.ip), ip, [port], { timing: 4, malicious: true, actor: 'bot:guide', skipPing: true });
      });
    }
  }

  /** One of our own people logs in: wrong passwords first if they have forgotten theirs. */
  private login(ctx: Ctx, host: HostState, item: Extract<ScriptDef, { event: 'login' }>): void {
    const from = this.world.resolveSystem(this.org, item.from);
    const account = host.accounts.find((a) => a.user === item.user);
    if (!from || !account) {
      return;
    }
    const service = account.service ?? defaultService(host);
    const src = this.world.endpointFor(from.ip);
    const typo = (): void => {
      tryLogin(ctx, src, host, service, account.user, `${account.password}x`, { malicious: false, actor: 'bot:guide', tags: ['typo'] });
    };
    if (item.outcome === 'fail') {
      typo();
      return;
    }
    const ok = (): void => {
      tryLogin(ctx, src, host, service, account.user, account.password, { malicious: false, actor: 'bot:guide' });
    };
    const fails = item.fails ?? 0;
    if (fails === 0) {
      ok();
      return;
    }
    const every = (item.every ?? RETRY_SEC) * 1000;
    for (let i = 0; i < fails; i++) {
      this.clock.at(i * every, typo);
    }
    this.clock.at(fails * every, ok);
  }

  /**
   * A lure lands in somebody's inbox. If the script says they open it, their
   * device runs the attacker's code and calls out, which no sensor on a laptop
   * without a log agent sees.
   */
  private phish(ctx: Ctx, item: Extract<ScriptDef, { event: 'phish' }>): void {
    const mail = this.world.mailServer(this.org);
    const person = this.world.person(this.org, item.to);
    if (!mail || !person) {
      return;
    }
    this.bus.emit({
      kind: 'mail.received',
      actor: 'bot:guide',
      malicious: true,
      org: this.org,
      src: item.src,
      dst: mail.ip,
      dstPort: 25,
      host: mail.key,
      user: item.to,
      tags: ['malicious', 'attachment'],
      summary: `Mail to ${person.name} with attachment "${item.lure}"`,
    });
    if (item.opens === undefined) {
      return;
    }
    this.clock.at(item.opens * 1000, () => {
      const device = this.world.deviceOf(this.org, item.to);
      if (!device || device.status !== 'up') {
        return;
      }
      this.bus.emit({ kind: 'proc.exec', actor: 'bot:guide', malicious: true, org: this.org, host: device.key, user: item.to, tags: ['suspicious', 'macro'], summary: `${item.lure} started a script on ${device.hostname}` });
      compromise(ctx, device, 'user');
      this.bus.emit({ kind: 'net.connect', actor: 'bot:guide', malicious: true, org: this.org, src: device.ip, dst: item.src, dstPort: 443, host: device.key, tags: ['beacon', 'outbound'], summary: `${device.hostname} connected out to ${item.src}:443` });
    });
  }

  /** Somebody on the internet tries one wrong password after another, and maybe the right one. */
  private guess(host: HostState, item: Extract<ScriptDef, { event: 'guess' }>): void {
    const account = host.accounts.find((a) => a.user === item.user);
    if (!account) {
      return;
    }
    // Real passwords people pick, minus the right one: the guesser only gets in
    // when the script says so, with the account's real (factory) password last.
    const wrong = this.world.wordlist.filter((p) => p !== account.password);
    const ctx: Ctx = { world: this.world, bus: this.bus, clock: this.clock, rng: this.rng, actor: 'bot:guide' };
    const service = account.service ?? defaultService(host);
    const from = this.world.endpointFor(item.src);
    for (let i = 0; i < item.tries; i++) {
      const last = item.getsIn === true && i === item.tries - 1;
      const password = last ? account.password : (wrong[i % Math.max(1, wrong.length)] ?? `guess${i}`);
      this.clock.at(i * item.every * 1000, () => {
        tryLogin(ctx, from, host, service, account.user, password, { malicious: true, actor: 'bot:guide' });
      });
    }
  }

  /** Swap {ip:<system>} for the lab address of that system. */
  private fill(text: string): string {
    return text.replace(/\{ip:([a-z0-9-]+)\}/g, (_, id: string) => this.world.resolveSystem(this.org, id)?.ip ?? id).trim();
  }

  // --------------------------------------------------------------- view

  /** The alert a step's Show me points at: its drill, or the newest open alert from a rule. */
  private shownAlert(step: GuideStepDef): number | undefined {
    const wanted = step.show?.alert;
    if (!wanted) return undefined;
    if (wanted === 'drill') return this.drills.get(step.id);
    const alerts = this.detector.alerts.filter((a) => a.org === this.org && a.rule === wanted);
    return (alerts.findLast((a) => a.status !== 'closed') ?? alerts.at(-1))?.id;
  }

  view(): GuideView {
    const org = this.world.orgs.get(this.org);
    // The mentor usually works in the floor's own organisation; on an attack
    // floor they are a colleague from another (DataQuant tests the target).
    const mentor =
      org?.resolved.people.find((p) => p.id === this.def.mentor) ??
      [...this.world.orgs.values()].flatMap((o) => o.resolved.people).find((p) => p.id === this.def.mentor);
    const step = this.step;
    const state = this.states[this.index];
    const show = step?.show ?? {};
    const drill = step ? this.shownAlert(step) : undefined;
    return {
      mentor: { name: mentor?.name ?? this.def.mentor, role: mentor?.role ?? '' },
      steps: this.def.steps.map((s, i) => ({ id: s.id, title: s.title, status: this.states[i]!.status })),
      current:
        step && state
          ? {
              index: this.index,
              id: step.id,
              title: step.title,
              say: this.fill(step.say),
              do: this.fill(step.do),
              hint: this.fill(step.hint),
              show: {
                ...(show.room ? { room: show.room } : {}),
                ...(show.host ? { host: `${this.org}/${show.host}` } : {}),
                ...(show.tab ? { tab: show.tab } : show.alert ? { tab: 'alerts' } : {}),
                ...(show.alert && drill !== undefined ? { alert: drill } : {}),
              },
              ask: step.ask && state.ready ? { question: step.ask.question, options: step.ask.options.map((o) => this.fill(o.text)) } : null,
              waiting: !!step.ask && !state.ready,
              sort: step.sort ? { done: this.sorted.get(step.id)?.size ?? 0, total: step.sort.length } : null,
              targets: 'action' in step.done && (step.done.targets?.length ?? 0) > 1 ? { done: this.progress.get(step.id)?.size ?? 0, total: step.done.targets!.length } : null,
              tool: stepTool(step),
              canSkip:
                (step.wait ?? 0) * 1000 - (this.clock.now - state.startedAt) > 12_000 ||
                (!state.ready && (step.script ?? []).length > 0 && Math.max(...(step.script ?? []).map(scriptEnd)) * 1000 - (this.clock.now - state.startedAt) > 12_000),
            }
          : null,
      verdict: this.verdict,
      feedback: this.feedback,
      last: this.last,
      locked: { ...(this.def.locked ?? {}) },
      complete: this.complete,
      time: { targetMs: this.def.target ? this.def.target * 60_000 : null, tookMs: this.finishedAt ?? this.clock.now },
      scored: this.def.scored === true,
      outro: this.complete ? this.def.outro : null,
    };
  }
}
