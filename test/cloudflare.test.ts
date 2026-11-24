// The Cloudflare build: the Worker refuses calls without a Cloudflare Access
// login, plays a round in a Durable Object, and never serves the world files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { createLab, type DurableObjectId, type DurableObjectNamespace, type Env } from '../cloudflare/app.ts';
import { accessProblem, forgetAccessKeys } from '../cloudflare/access.ts';
import { collectUiFiles, collectWorldFiles } from '../cloudflare/files.ts';
import { PROJECT_ROOT } from '../src/world/load.ts';

const data = collectWorldFiles(PROJECT_ROOT);
const lab = createLab(data);

/** Durable Objects in memory: one Round per id, like the real namespace. */
function fakeRounds(): DurableObjectNamespace {
  const objects = new Map<string, InstanceType<typeof lab.Round>>();
  let next = 0;
  const idOf = (text: string): DurableObjectId => ({ toString: () => text });
  return {
    newUniqueId: () => idOf((++next).toString(16).padStart(64, '0')),
    idFromString(text) {
      if (!/^[0-9a-f]{64}$/.test(text)) throw new TypeError('Invalid Durable Object ID');
      return idOf(text);
    },
    get(id) {
      const key = id.toString();
      if (!objects.has(key)) objects.set(key, new lab.Round({ id }, {} as Env));
      const round = objects.get(key)!;
      return { fetch: (request: Request) => round.fetch(request) };
    },
  };
}

const openEnv = (): Env => ({ ROUNDS: fakeRounds(), LAB_OPEN: 'local-only', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' });

async function call(env: Env, path: string, init: RequestInit = {}, host = 'localhost'): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await lab.worker.fetch(new Request(`http://${host}${path}`, init), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('the build bundles every world file, and the UI without the world', () => {
  assert.ok(data.files['worlds/miniverse.yaml']);
  assert.ok(Object.keys(data.files).some((f) => f.startsWith('practicals/')));
  assert.match(data.stamp, /^[0-9a-f]{16}$/);
  const ui = collectUiFiles(PROJECT_ROOT);
  assert.ok(ui.includes('index.html') && ui.includes('app.js'));
  assert.ok(ui.every((f) => !f.endsWith('.yaml') && !f.endsWith('.d.ts')));
});

test('refuses every API call until Cloudflare Access is set up', async () => {
  const env: Env = { ROUNDS: fakeRounds(), ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' };
  assert.equal((await call(env, '/api/practicals')).status, 403);
  assert.equal((await call(env, '/api/sessions', post({ practical: 'defend-00-first-day' }))).status, 403);
  // The local-only switch opens localhost and nothing else.
  const open = openEnv();
  assert.equal((await call(open, '/api/practicals')).status, 200);
  assert.equal((await call(open, '/api/practicals', {}, 'lab.example.co.za')).status, 403);
});

test('plays a round in its own Durable Object', async () => {
  const env = openEnv();
  const version = await call(env, '/api/version');
  assert.equal(version.body.boot, data.stamp);
  assert.equal(version.body.dev, false);

  const created = await call(env, '/api/sessions', post({ practical: 'defend-00-first-day' }));
  assert.equal(created.status, 201);
  const id = String(created.body.session);
  assert.match(id, /^[0-9a-f]{64}$/);

  const begun = await call(env, `/api/sessions/${id}/begin`, { method: 'POST' });
  assert.equal(begun.body.status, 'live');
  assert.equal((await call(env, `/api/sessions/${id}/act`, post({ type: 'nonsense' }))).status, 400);
  assert.equal((await call(env, `/api/sessions/${id}/act`, post({ type: 'look', what: 'room', id: 'trust-risk' }))).status, 200);

  const events = await lab.worker.fetch(new Request(`http://localhost/api/sessions/${id}/events`), env);
  assert.equal(events.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = events.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /connected/);
  await reader.cancel();

  const stopped = await call(env, `/api/sessions/${id}/stop`, { method: 'POST' });
  assert.equal(stopped.body.status, 'ended');
  assert.equal((await call(env, '/api/sessions/not-a-round')).status, 404);
  assert.equal((await call(env, `/api/sessions/${'f'.repeat(64)}`)).status, 404);
  assert.equal((await call(env, '/api/sessions', post({ practical: 'no-such-floor' }))).status, 400);
});

test('checks the Access token: signature, audience, team and expiry', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const team = 'cyberverse.cloudflareaccess.com';
  const aud = 'aud-tag-123';
  const settings = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud };
  const fetcher = (async (url: string | URL | Request) => {
    assert.equal(String(url), `https://${team}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [jwk] }));
  }) as typeof fetch;
  const now = Date.UTC(2026, 10, 23, 12, 0, 0);
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = (claims: Record<string, unknown>, kid = 'k1'): string => {
    const unsigned = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64(claims)}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url');
    return `${unsigned}.${signature}`;
  };
  const good = { aud: [aud], iss: `https://${team}`, exp: now / 1000 + 600, email: 'learner@example.com' };
  const check = (jwt: string | null): Promise<string | null> => {
    forgetAccessKeys();
    const headers = jwt ? { 'cf-access-jwt-assertion': jwt } : undefined;
    return accessProblem(new Request('https://lab.example.co.za/api/practicals', headers ? { headers } : {}), settings, fetcher, now);
  };

  assert.equal(await check(token(good)), null);
  assert.match((await check(null)) ?? '', /No Cloudflare Access login/);
  assert.match((await check(token({ ...good, aud: ['someone-else'] }))) ?? '', /another application/);
  assert.match((await check(token({ ...good, iss: 'https://evil.cloudflareaccess.com' }))) ?? '', /another team/);
  assert.match((await check(token({ ...good, exp: now / 1000 - 1 }))) ?? '', /expired/);
  assert.match((await check(token(good, 'k2'))) ?? '', /key this team does not have/);
  const tampered = token(good).split('.');
  tampered[1] = b64({ ...good, email: 'admin@example.com' });
  assert.match((await check(tampered.join('.'))) ?? '', /signature is wrong/);
  assert.match((await check('not.a-token')) ?? '', /malformed/);
});
