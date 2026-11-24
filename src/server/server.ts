// The local web server: serves the office-floor UI and runs rounds on this
// computer. The API itself is in api.ts, shared with the Cloudflare Worker.
//
// It binds to the loopback address only, and answers only requests addressed
// to localhost. Hosting is the Cloudflare build's job (cloudflare/), behind a
// Cloudflare Access login (DECISIONS.md, 2026-11-23).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { loadWorld, PROJECT_ROOT, type WorldBundle } from '../world/load.ts';
import { snapshot } from '../engine/view.ts';
import { apiParts, catalogue, errorResponse, HttpError, json, MAX_BODY, newSession, readJson, sessionRoute, type Live } from './api.ts';
import { NOTE_MAX_BODY, NotesBook } from './notes.ts';

export { parseAction } from './api.ts';

export interface ServeOptions {
  port?: number;
  host?: string;
  bundle?: WorldBundle;
  /** Folder the UI is served from. */
  uiDir?: string;
  /** Development mode (npm run dev): open pages reload when the server or the UI changes. */
  dev?: boolean;
  /** Where the notes pad saves notes (default: notes/ in the project). Null turns the pad off. */
  notesDir?: string | null;
  log?: (line: string) => void;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_SESSIONS = 6;
const ENDED_TTL_MS = 60 * 60_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export class LabServer {
  readonly bundle: WorldBundle;
  /** Changes every time the server starts, so a page can tell it restarted. */
  readonly boot = randomUUID();
  readonly dev: boolean;
  /** The notes pad's notes, or null when the pad is off. */
  readonly notes: NotesBook | null;
  private readonly uiDir: string;
  private readonly sessions = new Map<string, Live>();
  private readonly log: (line: string) => void;
  private server: Server | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ServeOptions = {}) {
    this.bundle = opts.bundle ?? loadWorld();
    this.uiDir = resolve(opts.uiDir ?? join(PROJECT_ROOT, 'ui'));
    this.dev = opts.dev ?? process.env.CYBERVERSE_DEV === '1';
    const notesDir = opts.notesDir === undefined ? join(PROJECT_ROOT, 'notes') : opts.notesDir;
    this.notes = notesDir === null ? null : new NotesBook(resolve(notesDir));
    this.log = opts.log ?? ((line) => console.log(line));
  }

  async listen(port = 8788, host = '127.0.0.1'): Promise<{ port: number; host: string }> {
    if (!LOOPBACK.has(host)) {
      throw new Error(`Refusing to listen on ${host}. The lab serves this computer only (127.0.0.1); opening it to a network goes through DECISIONS.md first.`);
    }
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((done, fail) => {
      this.server!.once('error', fail);
      this.server!.listen(port, host, () => done());
    });
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
    const address = this.server.address();
    const bound = typeof address === 'object' && address ? address.port : port;
    return { port: bound, host };
  }

  async close(): Promise<void> {
    if (this.sweeper) {
      clearInterval(this.sweeper);
    }
    for (const live of this.sessions.values()) {
      live.session.stop();
    }
    this.sessions.clear();
    const server = this.server;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, live] of this.sessions) {
      if (live.session.status === 'ended') {
        live.endedAt ??= now;
        if (now - live.endedAt > ENDED_TTL_MS) {
          this.sessions.delete(id);
        }
      }
    }
  }

  // ---------------------------------------------------------------- routing

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.checkHost(req);
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const limit = url.pathname === '/api/notes' && this.notes ? NOTE_MAX_BODY : MAX_BODY;
        const response = await this.api(await toRequest(req, url, limit), url).catch((err: unknown) => errorResponse(err, this.log, `${req.method} ${req.url}`));
        await reply(response, req, res);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'Method not allowed.');
      }
      await this.static(res, url.pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) {
        this.log(`[server] ${req.method} ${req.url}: ${(err as Error).stack ?? String(err)}`);
      }
      if (!res.headersSent) {
        send(res, status, { error: err instanceof HttpError ? err.message : 'Something went wrong in the lab server.' });
      } else {
        res.end();
      }
    }
  }

  /** Only answer requests addressed to this machine (stops DNS rebinding). */
  private checkHost(req: IncomingMessage): void {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!LOOPBACK.has(host)) {
      throw new HttpError(403, 'This lab only answers on localhost.');
    }
  }

  private async api(request: Request, url: URL): Promise<Response> {
    const parts = apiParts(url);
    const method = request.method;

    if (parts[0] === 'version' && parts.length === 1 && method === 'GET') {
      return json(200, { boot: this.boot, dev: this.dev, ui: this.dev ? await this.uiStamp() : 0, notes: this.notes !== null });
    }
    if (parts[0] === 'notes' && parts.length === 1 && method === 'POST' && this.notes) {
      fromThisPage(request);
      return json(201, await this.notes.add(await readJson(request, NOTE_MAX_BODY)));
    }
    const listed = catalogue(this.bundle, parts, method, url);
    if (listed) {
      return listed;
    }
    if (parts[0] !== 'sessions') {
      throw new HttpError(404, 'No such endpoint.');
    }
    if (parts.length === 1 && method === 'POST') {
      return json(201, this.create(await readJson(request)));
    }
    const live = this.sessions.get(parts[1] ?? '');
    if (!live) {
      throw new HttpError(404, 'No such round. It may have expired.');
    }
    return sessionRoute(live, parts.slice(2), method, request);
  }

  private create(body: Record<string, unknown>): unknown {
    this.sweep();
    const running = [...this.sessions.values()].filter((l) => l.session.status !== 'ended');
    if (running.length >= MAX_SESSIONS) {
      throw new HttpError(429, 'Too many rounds are running. Stop one first.');
    }
    const session = newSession(this.bundle, body);
    this.sessions.set(session.id, { session, endedAt: null, queue: Promise.resolve() });
    this.log(`[round] ${session.id} ${session.practical.id} seed ${session.seed}`);
    return snapshot(session);
  }

  // ----------------------------------------------------------------- static

  /** When the UI files last changed, so a page in dev mode can reload itself. */
  private async uiStamp(): Promise<number> {
    const names = await readdir(this.uiDir, { recursive: true }).catch(() => [] as string[]);
    const times = await Promise.all(names.map((name) => stat(join(this.uiDir, name)).then((info) => (info.isFile() ? info.mtimeMs : 0), () => 0)));
    return Math.round(Math.max(0, ...times));
  }

  private async static(res: ServerResponse, pathname: string): Promise<void> {
    const wanted = pathname === '/' ? '/index.html' : pathname;
    const file = resolve(this.uiDir, `.${normalize(decodeURIComponent(wanted))}`);
    if (file !== this.uiDir && !file.startsWith(this.uiDir + sep)) {
      throw new HttpError(404, 'Not found.');
    }
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) {
      throw new HttpError(404, 'Not found.');
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
    });
    res.end(await readFile(file));
  }
}

// ---------------------------------------------------------------- helpers

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
}

/**
 * Notes are written to disk, so only the lab's own page may send one: a JSON
 * body (another website can't send that without the browser asking first, and
 * this server never says yes) from a page on this computer.
 */
function fromThisPage(request: Request): void {
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Send the note as JSON.');
  }
  const origin = request.headers.get('origin');
  let host = '';
  try {
    host = origin ? new URL(origin).hostname.replace(/^\[|\]$/g, '') : 'localhost';
  } catch {
    host = '';
  }
  if (!LOOPBACK.has(host) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError(403, 'Notes can only come from the lab page on this computer.');
  }
}

/** A Node request as a standard Request, its body read up to the limit. */
async function toRequest(req: IncomingMessage, url: URL, limit = MAX_BODY): Promise<Request> {
  const method = req.method ?? 'GET';
  const headers = new Headers();
  for (const name of ['content-type', 'origin', 'sec-fetch-site']) {
    const value = req.headers[name];
    if (typeof value === 'string') {
      headers.set(name, value);
    }
  }
  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { method, headers });
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      throw new HttpError(413, 'Request too large.');
    }
    chunks.push(chunk as Buffer);
  }
  return new Request(url, { method, headers, ...(size > 0 ? { body: Buffer.concat(chunks) } : {}) });
}

/** Write a standard Response back through Node, streaming it (server-sent events stay open). */
async function reply(response: Response, req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  const stop = (): void => {
    void reader.cancel().catch(() => {});
  };
  req.on('close', stop);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    req.off('close', stop);
    res.end();
  }
}
