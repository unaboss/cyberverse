// The engine's basic machinery: a seeded random source, the simulated clock
// and the event bus every part of the lab writes to.

// ------------------------------------------------------------------- random

/** Seeded random numbers (mulberry32), so a round can be replayed exactly. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('pick from an empty list');
    }
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** base +/- fraction, for natural-looking timing. */
  jitter(base: number, fraction = 0.3): number {
    return base * (1 - fraction + this.next() * 2 * fraction);
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

// -------------------------------------------------------------------- clock

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Simulated time in milliseconds since the round started. Nothing happens
 * between calls to advance(), so tests can run a 15-minute round in
 * milliseconds and the server can run it in real time.
 */
export class SimClock {
  now = 0;
  private timers: Timer[] = [];
  private seq = 0;
  private stopped = false;

  /** dayOffsetMs is the time of day the round starts at. */
  readonly dayOffsetMs: number;
  readonly date: string;

  constructor(dayOffsetMs: number, date: string = '2026-11-21') {
    this.dayOffsetMs = dayOffsetMs;
    this.date = date;
  }

  static fromTimeOfDay(hhmm: string): SimClock {
    const [h, m] = hhmm.split(':').map(Number);
    return new SimClock(((h ?? 0) * 60 + (m ?? 0)) * 60 * 1000);
  }

  at(delayMs: number, fn: () => void): void {
    if (this.stopped) {
      return;
    }
    const timer = { at: this.now + Math.max(0, delayMs), seq: this.seq++, fn };
    let i = this.timers.length;
    while (i > 0 && (this.timers[i - 1]!.at > timer.at || (this.timers[i - 1]!.at === timer.at && this.timers[i - 1]!.seq > timer.seq))) {
      i--;
    }
    this.timers.splice(i, 0, timer);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.at(ms, resolve));
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    while (!this.stopped) {
      const next = this.timers[0];
      if (!next || next.at > target) {
        break;
      }
      this.timers.shift();
      this.now = Math.max(this.now, next.at);
      next.fn();
      // Let every promise chain the timer woke up run before the next timer.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!this.stopped) {
      this.now = target;
    }
  }

  /** Stop all pending work, for the end of a round. */
  stop(): void {
    this.stopped = true;
    this.timers = [];
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Milliseconds since midnight on the simulated day. */
  timeOfDayMs(at = this.now): number {
    return (this.dayOffsetMs + at) % DAY_MS;
  }

  isWorkHours(at = this.now): boolean {
    const hour = this.timeOfDayMs(at) / 3_600_000;
    return hour >= 8 && hour < 17;
  }

  /** "02:14:07" */
  clockText(at = this.now): string {
    const total = Math.floor(this.timeOfDayMs(at) / 1000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
  }

  /** "Nov 21 02:14:07", the way syslog writes it. */
  syslogStamp(at = this.now): string {
    return `Nov 21 ${this.clockText(at)}`;
  }

  /** "21/Nov/2026:02:14:07 +0200", the way web servers write it. */
  webStamp(at = this.now): string {
    return `21/Nov/2026:${this.clockText(at)} +0200`;
  }
}

export function parseEvery(every: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(every);
  if (!match) {
    throw new Error(`Unreadable schedule: ${every}`);
  }
  const unit = match[2] === 's' ? 1000 : match[2] === 'm' ? 60_000 : 3_600_000;
  return Number(match[1]) * unit;
}

// ------------------------------------------------------------------- events

export interface LabEvent {
  id: number;
  /** Simulated ms since the round started. */
  t: number;
  kind: string;
  /** "attacker", "learner", "defender", "system", "sensor" or "bot:<process>". */
  actor: string;
  /** Ground truth, for scoring and the debrief. Never shown during a round. */
  malicious: boolean;
  /** Organisation the event happens in. */
  org?: string;
  src?: string;
  dst?: string;
  dstPort?: number;
  /** "org/system" where the event is logged. */
  host?: string;
  service?: string;
  user?: string;
  outcome?: 'ok' | 'fail';
  bytes?: number;
  path?: string;
  tags: string[];
  summary: string;
  data?: Record<string, unknown>;
}

export type EventInput = Omit<LabEvent, 'id' | 't' | 'tags' | 'malicious'> & {
  tags?: string[];
  malicious?: boolean;
};

export type Listener = (event: LabEvent) => void;

export class EventBus {
  readonly events: LabEvent[] = [];
  private listeners: Listener[] = [];
  private nextId = 1;

  private readonly clock: SimClock;

  constructor(clock: SimClock) {
    this.clock = clock;
  }

  emit(input: EventInput): LabEvent {
    const event: LabEvent = {
      ...input,
      id: this.nextId++,
      t: this.clock.now,
      tags: input.tags ?? [],
      malicious: input.malicious ?? false,
    };
    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }

  on(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}
