// Cyberverse on Cloudflare: the Worker that answers the API, and the Durable
// Object that runs one round.
//
// - The screens (ui/) are static assets. Cloudflare serves them before the
//   Worker runs, so the Worker only sees /api/ calls.
// - Every API call must carry a valid Cloudflare Access login (access.ts).
// - The lists (practicals, towers, manuals) come from the world, built once
//   per Worker from files bundled at build time (build.ts). The world never
//   goes out as a static file: it holds the attacker's plans and lab-only
//   passwords that learners must not see.
// - Each round lives in its own Durable Object, named by the round id, so its
//   clock and attacker keep running between calls and every call for that
//   round reaches the same place. The local server (src/server) uses the same
//   handlers from src/server/api.ts.

import { buildWorld, memorySource, type WorldBundle } from '../src/world/build.ts';
import { snapshot } from '../src/engine/view.ts';
import { apiParts, catalogue, errorResponse, HttpError, json, newSession, readJson, sessionRoute, type Live } from '../src/server/api.ts';
import { accessProblem, type AccessSettings } from './access.ts';

// The few Cloudflare runtime types this file uses, kept here so the project
// needs no extra type package.
export interface DurableObjectId {
  toString(): string;
}
export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}
export interface DurableObjectNamespace {
  newUniqueId(): DurableObjectId;
  idFromString(id: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
export interface DurableObjectState {
  readonly id: DurableObjectId;
}

export interface Env extends AccessSettings {
  ROUNDS: DurableObjectNamespace;
  /**
   * Set only by `npm run cf:dev` (wrangler dev --var LAB_OPEN:local-only): skip
   * the Access check for requests to localhost. Never set in wrangler.jsonc.
   */
  LAB_OPEN?: string;
}

/** The world files and a stamp for this build, written by build.ts. */
export interface WorldFiles {
  stamp: string;
  files: Record<string, string>;
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const log = (line: string): void => console.log(line);

export function createLab(data: WorldFiles) {
  let world: WorldBundle | null = null;
  const bundle = (): WorldBundle => (world ??= buildWorld(memorySource(data.files)));

  async function allowed(request: Request, env: Env, url: URL): Promise<boolean> {
    if (env.LAB_OPEN === 'local-only' && LOCAL.has(url.hostname)) {
      return true;
    }
    const problem = await accessProblem(request, env);
    if (problem) {
      log(`[access] refused ${request.method} ${url.pathname}: ${problem}`);
      return false;
    }
    return true;
  }

  async function api(request: Request, env: Env, url: URL): Promise<Response> {
    const parts = apiParts(url);
    const method = request.method;
    if (parts[0] === 'version' && parts.length === 1 && method === 'GET') {
      return json(200, { boot: data.stamp, dev: false, ui: 0, notes: false });
    }
    const listed = catalogue(bundle(), parts, method, url);
    if (listed) {
      return listed;
    }
    if (parts[0] !== 'sessions') {
      throw new HttpError(404, 'No such endpoint.');
    }
    if (parts.length === 1 && method === 'POST') {
      // A new Durable Object for the new round; its id is the round's id.
      const id = env.ROUNDS.newUniqueId();
      const body = JSON.stringify(await readJson(request));
      return env.ROUNDS.get(id).fetch(new Request(new URL('/new', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
    }
    let id: DurableObjectId;
    try {
      id = env.ROUNDS.idFromString(parts[1] ?? '');
    } catch {
      throw new HttpError(404, 'No such round. It may have expired.');
    }
    return env.ROUNDS.get(id).fetch(request);
  }

  const worker = {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) {
        // Static files are served before the Worker runs; anything else is not here.
        return json(404, { error: 'Not found.' });
      }
      if (!(await allowed(request, env, url))) {
        return json(403, { error: 'Sign in through the lab\'s login page first.' });
      }
      try {
        return await api(request, env, url);
      } catch (err) {
        return errorResponse(err, log, `${request.method} ${url.pathname}`);
      }
    },
  };

  /** One round: its session lives in this object's memory while the round is played. */
  class Round {
    private live: Live | null = null;
    private readonly state: DurableObjectState;

    constructor(state: DurableObjectState, _env: Env) {
      this.state = state;
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      try {
        if (url.pathname === '/new' && request.method === 'POST') {
          if (this.live) {
            throw new HttpError(409, 'This round has already started.');
          }
          const session = newSession(bundle(), await readJson(request), this.state.id.toString());
          this.live = { session, endedAt: null, queue: Promise.resolve() };
          log(`[round] ${session.id} ${session.practical.id} seed ${session.seed}`);
          return json(201, snapshot(session));
        }
        const parts = apiParts(url);
        if (!this.live || parts[0] !== 'sessions' || parts[1] !== this.live.session.id) {
          throw new HttpError(404, 'No such round. It may have expired.');
        }
        return await sessionRoute(this.live, parts.slice(2), request.method, request);
      } catch (err) {
        return errorResponse(err, log, `round ${request.method} ${url.pathname}`);
      }
    }
  }

  return { worker, Round };
}
