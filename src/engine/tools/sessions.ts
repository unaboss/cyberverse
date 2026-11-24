// Webmail sessions: the mail server's list of who is signed in, from where.
// A session is the ticket the server hands out once the password checks out;
// whoever holds the ticket is that person until the session ends. A stolen
// one shows as one session used from two places at once. Ending it throws the
// thief out, but only for good once the password is new as well: with the old
// password they simply sign in again.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome } from './tool.ts';
import type { LabEvent } from '../core.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export interface SessionUseDef {
  ip: string;
  /** Where that address is, in words. */
  where: string;
  device: string;
  /** "08:52" */
  since: string;
}

export interface SessionDef {
  id: string;
  user: string;
  uses: SessionUseDef[];
}

export interface SessionsConfig {
  /** The system whose sign-ins these are. */
  system: string;
  sessions: SessionDef[];
  /** The thief: where the stolen uses come from, and a new sign-in would too. */
  thief: { ip: string; where: string; device: string };
}

interface SessionState {
  id: string;
  user: string;
  uses: SessionUseDef[];
  ended: number | null;
}

class WebmailSessions extends Tool<SessionsConfig> {
  readonly id = 'sessions';
  private readonly sessions: SessionState[] = this.config.sessions.map((s) => ({ id: s.id, user: s.user, uses: s.uses.map((u) => ({ ...u })), ended: null }));
  private readonly reset = new Map<string, number>();

  private get hostKey(): string {
    return `${this.parts.org}/${this.config.system}`;
  }

  private stolen(s: SessionState): boolean {
    return s.uses.some((u) => u.ip === this.config.thief.ip);
  }

  private person(user: string): string {
    const org = this.parts.world.orgs.get(this.parts.org)?.resolved;
    const account = org?.systems.find((s) => s.id === this.config.system)?.accounts?.find((a) => a.user === user);
    const name = org?.people.find((p) => p.id === account?.person)?.name;
    return name ?? user;
  }

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op !== 'revoke') return { ok: false, message: 'Webmail sessions cannot do that.' };
    const session = this.sessions.find((s) => s.id === this.text(args, 'session'));
    if (!session) return { ok: false, message: 'Choose a session.' };
    if (session.ended !== null) return { ok: false, message: 'That session has ended already.' };
    session.ended = this.parts.clock.now;
    this.emit({ kind: 'tool.update', host: this.hostKey, summary: `Webmail session ${session.id} ended`, data: { tool: this.id } });
    const name = this.person(session.user);
    const first = name.split(' ')[0] ?? name;
    const message = `Ended ${first}'s webmail session ${session.id.slice(0, 6)}`;
    if (!this.stolen(session)) {
      const where = session.uses[0]?.where ?? 'one place';
      return { ok: true, message, target: session.user, correct: false, reply: `That session is only used from ${where}: it's ${first} at work. Ending it just makes them sign in again. Look for one session used from two places.` };
    }
    if (!this.reset.has(session.user)) {
      this.comeBack(session.user);
      return {
        ok: true,
        message,
        target: session.user,
        correct: false,
        reply: `Ended, for about a minute. They have ${first}'s password too, so they'll simply sign in again: watch the list. Reset the password first, then end the session.`,
      };
    }
    return { ok: true, message, target: session.user, correct: true, reply: `Thrown out of ${first}'s mailbox. The stolen ticket is worthless now, and the old password won't get them a new one.` };
  }

  /** With the old password still good, the thief signs in again a minute later. */
  private comeBack(user: string): void {
    this.parts.clock.at(60_000, () => {
      if (this.reset.has(user)) return;
      const thief = this.config.thief;
      const id = Array.from({ length: 12 }, () => this.parts.rng.int(0, 15).toString(16)).join('');
      this.sessions.push({ id, user, uses: [{ ip: thief.ip, where: thief.where, device: thief.device, since: this.parts.clock.clockText() }], ended: null });
      this.emit({ kind: 'tool.update', host: this.hostKey, user, summary: `New webmail session for ${user} from ${thief.ip}`, data: { tool: this.id } });
    });
  }

  override observe(event: LabEvent): void {
    if (event.kind === 'account.reset' && event.host === this.hostKey && event.user) {
      this.reset.set(event.user, event.t);
    }
  }

  view(): unknown {
    const clock = this.parts.clock;
    const order = (s: SessionState): number => (s.ended === null ? 0 : 1);
    return {
      system: this.config.system,
      host: this.hostKey,
      active: this.sessions.filter((s) => s.ended === null).length,
      sessions: [...this.sessions]
        .sort((a, b) => order(a) - order(b))
        .map((s) => ({
          id: s.id,
          user: s.user,
          name: this.person(s.user),
          uses: s.uses,
          ended: s.ended !== null ? clock.clockText(s.ended) : null,
          reset: this.reset.has(s.user) ? clock.clockText(this.reset.get(s.user)) : null,
        })),
    };
  }
}

function validate(config: SessionsConfig, check: ToolCheck): void {
  const { add, bundleOrg } = check;
  const system = bundleOrg.systems.find((s) => s.id === config?.system);
  if (!system) {
    add(`sessions: no system ${config?.system}`);
    return;
  }
  const users = new Set((system.accounts ?? []).map((a) => a.user));
  if (!config.thief?.ip || !config.thief.where || !config.thief.device) add('sessions: needs a thief with ip, where and device');
  const ids = new Set<string>();
  for (const s of config.sessions ?? []) {
    if (ids.has(s.id)) add(`sessions: duplicate session ${s.id}`);
    ids.add(s.id);
    if (!users.has(s.user)) add(`sessions ${s.id}: ${config.system} has no account ${s.user}`);
    if (!Array.isArray(s.uses) || s.uses.length === 0) add(`sessions ${s.id}: needs at least one use`);
    for (const u of s.uses ?? []) {
      if (!u.ip || !u.where || !u.device || !/^\d\d:\d\d$/.test(u.since ?? '')) add(`sessions ${s.id}: each use needs ip, where, device and since ("08:52")`);
    }
  }
}

function ops(config: SessionsConfig, org: ResolvedOrg): Record<string, Set<string> | null> {
  const system = org.systems.find((s) => s.id === config.system);
  return { revoke: new Set((system?.accounts ?? []).map((a) => a.user)) };
}

export const sessionsTool: ToolModule<SessionsConfig> = {
  create: (config, parts) => new WebmailSessions(config, parts),
  validate,
  ops,
};
