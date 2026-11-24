// The lab's web API in the standard Request and Response shape, so the same
// handlers serve the local Node server (server.ts) and the Cloudflare Worker
// (cloudflare/), where each round lives in its own Durable Object.
//
//   GET  /api/version                         which run of the server this is, for dev reloads
//   GET  /api/practicals                      the practicals you can start
//   GET  /api/towers                          the storylines, floor by floor
//   GET  /api/orgs                            the organisations in the miniverse
//   GET  /api/manual/:org?level=N             the operating manual (Markdown)
//   POST /api/sessions {practical, seed?, speed?}
//   GET  /api/sessions/:id                    what the learner may see now
//   POST /api/sessions/:id/(begin|pause|resume|stop)
//   POST /api/sessions/:id/act {type, ...}    a defensive action (prey)
//   POST /api/sessions/:id/console {line}     an attack-terminal line (predator), 202
//   GET  /api/sessions/:id/events             server-sent events
//   GET  /api/sessions/:id/hosts/:key/logs    a machine's captured log lines

import type { WorldBundle } from '../world/build.ts';
import { buildManual, manualToMarkdown } from '../world/manual.ts';
import { LEVELS, type Level, type PracticalDef } from '../world/types.ts';
import { Session, type LearnerAction } from '../engine/session.ts';
import { hostLogs, snapshot, StreamFilter, type ClientEvent } from '../engine/view.ts';

export const MAX_BODY = 64 * 1024;

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A round being played, and the terminal lines waiting their turn. */
export interface Live {
  session: Session;
  endedAt: number | null;
  /** Terminal lines run one at a time, in order. */
  queue: Promise<void>;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

/** An error as the learner's browser should see it. Unexpected ones are logged, not shown. */
export function errorResponse(err: unknown, log: (line: string) => void, where = ''): Response {
  if (err instanceof HttpError) {
    return json(err.status, { error: err.message });
  }
  log(`[server] ${where}: ${(err as Error)?.stack ?? String(err)}`);
  return json(500, { error: 'Something went wrong in the lab server.' });
}

/** The path after /api/, split and decoded: /api/sessions/abc/act -> ['sessions', 'abc', 'act']. */
export function apiParts(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY) {
    throw new HttpError(413, 'Request too large.');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new HttpError(413, 'Request too large.');
    }
    chunks.push(value);
  }
  if (size === 0) {
    return {};
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Send a JSON object.');
  }
}

// ------------------------------------------------------------- catalogue

/**
 * The read-only lists every page asks for: practicals, towers, organisations
 * and manuals. Null when the path is something else.
 */
export function catalogue(bundle: WorldBundle, parts: string[], method: string, url: URL): Response | null {
  if (method !== 'GET' || parts.length === 0) {
    return null;
  }
  if (parts[0] === 'practicals' && parts.length === 1) {
    return json(200, practicals(bundle));
  }
  if (parts[0] === 'towers' && parts.length === 1) {
    return json(200, towers(bundle));
  }
  if (parts[0] === 'orgs' && parts.length === 1) {
    return json(200, [...bundle.orgs.values()].map((o) => ({ id: o.def.id, name: o.def.name, level: o.def.level, fictional: o.def.fictional })));
  }
  if (parts[0] === 'manual' && parts.length === 2) {
    return json(200, manual(bundle, parts[1]!, url.searchParams.get('level')));
  }
  return null;
}

function practicals(bundle: WorldBundle): unknown {
  return bundle.practicals.map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    role: p.role,
    org: p.org,
    orgName: bundle.orgs.get(p.org)?.def.name ?? p.org,
    startTime: p.startTime,
    durationMin: p.durationMin,
    briefing: p.briefing,
    guided: p.guide !== undefined,
    map: p.map ?? null,
    mapSeen: mapSeen(bundle, p),
    qcto: p.qcto,
  }));
}

/**
 * The rooms a floor's map ends with: the ones it draws plus any its guide walks
 * into, so the floor above knows which rooms are already familiar. Null means
 * the whole organisation.
 */
function mapSeen(bundle: WorldBundle, p: PracticalDef): string[] | null {
  const rooms = p.map?.rooms;
  if (!rooms || p.role === 'predator') return null;
  const org = bundle.orgs.get(p.org);
  const seen = new Set(rooms);
  for (const step of p.guide?.steps ?? []) {
    if (step.show?.room) seen.add(step.show.room);
    const host = step.show?.host;
    const dept = host ? org?.departments.find((d) => d.systems.some((sy) => sy.id === host)) : undefined;
    if (dept) seen.add(dept.id);
  }
  return [...seen];
}

function towers(bundle: WorldBundle): unknown {
  return bundle.towers.map((tower) => ({
    id: tower.id,
    name: tower.name,
    role: tower.role,
    tier: tower.tier,
    blurb: tower.blurb,
    floors: [...tower.floors]
      .sort((a, b) => a.floor - b.floor)
      .map((f) => ({ floor: f.floor, title: f.title, teaches: f.teaches, practical: f.practical && bundle.practicals.some((p) => p.id === f.practical) ? f.practical : null })),
  }));
}

function manual(bundle: WorldBundle, orgId: string, levelText: string | null): unknown {
  if (!bundle.orgs.has(orgId)) {
    throw new HttpError(404, 'No such organisation.');
  }
  const level = levelText === null ? undefined : (Number(levelText) as Level);
  if (level !== undefined && !LEVELS.includes(level)) {
    throw new HttpError(400, 'Level must be 1 to 4.');
  }
  const built = buildManual(bundle, orgId, level);
  return { ...built, markdown: manualToMarkdown(built) };
}

// ----------------------------------------------------------------- rounds

/** Start a round of a practical from a request body. The id is given when the host names rounds itself. */
export function newSession(bundle: WorldBundle, body: Record<string, unknown>, id?: string): Session {
  const practical = bundle.practicals.find((p) => p.id === body.practical);
  if (!practical) {
    throw new HttpError(400, 'Choose a practical by id.');
  }
  const seed = typeof body.seed === 'number' && Number.isInteger(body.seed) ? body.seed : undefined;
  // A guided floor runs at its own pace: the scripted moments are timed for a person reading.
  const speed = !practical.guide && typeof body.speed === 'number' && body.speed > 0 && body.speed <= 60 ? body.speed : undefined;
  return new Session(bundle, practical, {
    ...(seed !== undefined ? { seed } : {}),
    ...(speed !== undefined ? { speed } : {}),
    ...(id !== undefined ? { id } : {}),
  });
}

/** Everything under /api/sessions/:id. `rest` is the path after the id. */
export async function sessionRoute(live: Live, rest: string[], method: string, request: Request): Promise<Response> {
  const { session } = live;
  const action = rest[0];
  if (rest.length === 0 && method === 'GET') {
    return json(200, snapshot(session));
  }
  if (action === 'events' && rest.length === 1 && method === 'GET') {
    return eventStream(session);
  }
  if (action === 'hosts' && rest[2] === 'logs' && rest.length === 3 && method === 'GET') {
    return json(200, { lines: hostLogs(session, `${rest[1]}`) });
  }
  if (method !== 'POST') {
    throw new HttpError(405, 'Method not allowed.');
  }
  switch (action) {
    case 'begin':
      session.begin();
      return json(200, snapshot(session));
    case 'pause':
      session.pause();
      return json(200, { status: session.status });
    case 'resume':
      session.resume();
      return json(200, { status: session.status });
    case 'stop':
      session.stop();
      return json(200, snapshot(session));
    case 'act': {
      const result = session.act(parseAction(await readJson(request)));
      return json(result.ok ? 200 : 409, result);
    }
    case 'console': {
      const body = await readJson(request);
      const line = typeof body.line === 'string' ? body.line.slice(0, 500) : null;
      if (line === null) {
        throw new HttpError(400, 'Send {"line": "..."}.');
      }
      // The answer can take simulated minutes (a slow scan), so it comes back on the stream.
      live.queue = live.queue.then(async () => {
        const output = await session.command(line);
        session.bus.emit({ kind: 'terminal.output', actor: 'system', summary: 'terminal output', data: { text: output, command: line, prompt: session.terminal?.prompt ?? '' } });
      });
      return json(202, { queued: true });
    }
    default:
      throw new HttpError(404, 'No such action.');
  }
}

/** The round as server-sent events: what the learner may see, plus a tick every second. */
export function eventStream(session: Session): Response {
  const encoder = new TextEncoder();
  let cleanup = (): void => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const raw = (text: string): void => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const write = (event: ClientEvent | Record<string, unknown>): void => raw(`data: ${JSON.stringify(event)}\n\n`);
      raw(': connected\n\n');
      const filter = new StreamFilter(session);
      const off = session.onEvent((event) => {
        if (event.kind === 'terminal.output' && event.data?.command !== undefined) {
          write({ type: 'console', text: String(event.data.text ?? ''), command: String(event.data.command), prompt: String(event.data.prompt ?? '') });
          return;
        }
        const mapped = filter.map(event);
        if (mapped) {
          write(mapped);
        }
      });
      const business = session.business.state.get(session.org)!;
      const tick = setInterval(() => {
        write({
          type: 'tick',
          status: session.status,
          clock: session.clock.clockText(),
          remainingMs: session.remainingMs,
          downtime: Math.round(business.downtimeLost),
          criticalDown: business.criticalDown,
        });
      }, 1000);
      cleanup = () => {
        clearInterval(tick);
        off();
      };
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

// ---------------------------------------------------------------- actions

function str(body: Record<string, unknown>, key: string, max = 200): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new HttpError(400, `"${key}" must be text.`);
  }
  return value;
}

/** Turn a request body into a learner action, or refuse it. */
export function parseAction(body: Record<string, unknown>): LearnerAction {
  switch (body.type) {
    case 'block':
    case 'unblock':
      return { type: body.type, src: str(body, 'src', 64) };
    case 'isolate':
    case 'release':
    case 'rebuild':
      return { type: body.type, host: str(body, 'host') };
    case 'lock':
    case 'reset':
      return { type: body.type, host: str(body, 'host'), user: str(body, 'user', 64) };
    case 'control':
      if (typeof body.on !== 'boolean') {
        throw new HttpError(400, '"on" must be true or false.');
      }
      return { type: 'control', control: str(body, 'control'), on: body.on };
    case 'classify': {
      if (body.verdict !== 'true-positive' && body.verdict !== 'false-positive') {
        throw new HttpError(400, '"verdict" must be true-positive or false-positive.');
      }
      return { type: 'classify', alert: alertId(body), verdict: body.verdict };
    }
    case 'acknowledge':
      return { type: 'acknowledge', alert: alertId(body) };
    case 'look': {
      if (body.what !== 'room' && body.what !== 'host' && body.what !== 'tab' && body.what !== 'alert') {
        throw new HttpError(400, '"what" must be room, host, tab or alert.');
      }
      return { type: 'look', what: body.what, id: str(body, 'id') };
    }
    case 'answer': {
      if (typeof body.option !== 'number' || !Number.isInteger(body.option) || body.option < 0 || body.option > 9) {
        throw new HttpError(400, '"option" must be the number of an answer.');
      }
      return { type: 'answer', option: body.option };
    }
    case 'fast':
      return { type: 'fast' };
    case 'tool':
      return { type: 'tool', tool: str(body, 'tool', 40), op: str(body, 'op', 40), args: toolArgs(body.args) };
    case 'report':
      return {
        type: 'report',
        summary: str(body, 'summary', 4000),
        impact: str(body, 'impact', 4000),
        actions: str(body, 'actions', 4000),
        recommendations: str(body, 'recommendations', 4000),
      };
    default:
      throw new HttpError(400, 'Unknown action.');
  }
}

/** A desk tool's arguments: a small flat object of text, numbers, true/false and short lists of them. */
function toolArgs(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 20) {
    throw new HttpError(400, '"args" must be a small object.');
  }
  const plain = (v: unknown): boolean => (typeof v === 'string' && v.length <= 8000) || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,30}$/.test(key) || !(plain(value) || (Array.isArray(value) && value.length <= 60 && value.every(plain)))) {
      throw new HttpError(400, `"args.${key}" must be text, a number, true/false or a short list of them.`);
    }
    out[key] = value;
  }
  return out;
}

function alertId(body: Record<string, unknown>): number {
  if (typeof body.alert !== 'number' || !Number.isInteger(body.alert)) {
    throw new HttpError(400, '"alert" must be an alert number.');
  }
  return body.alert;
}
