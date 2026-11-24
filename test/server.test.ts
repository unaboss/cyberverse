// The local server: loopback only, refuses strangers, and drives a round.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { LabServer, parseAction } from '../src/server/server.ts';

const server = new LabServer({ log: () => {} });
let base = '';

before(async () => {
  const { port } = await server.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await server.close();
});

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test('refuses to listen anywhere but this computer', async () => {
  const other = new LabServer({ log: () => {} });
  await assert.rejects(other.listen(0, '0.0.0.0'), /Refusing to listen/);
});

test('answers only requests addressed to localhost', async () => {
  const status = await new Promise<number>((done, fail) => {
    const req = request(`${base}/api/practicals`, { headers: { host: 'lab.example.com' } }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on('error', fail);
    req.end();
  });
  assert.equal(status, 403);
});

test('serves the UI and nothing outside it', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Cyberverse/);
  assert.match(index.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  const escape = await fetch(`${base}/%2e%2e/package.json`);
  assert.equal(escape.status, 404);
});

test('says which run of the server this is, so dev pages can reload', async () => {
  const plain = (await (await fetch(`${base}/api/version`)).json()) as { boot: string; dev: boolean; ui: number };
  assert.match(plain.boot, /^[0-9a-f-]{36}$/);
  assert.equal(plain.dev, false);
  assert.equal(plain.ui, 0, 'outside dev mode the UI files are not even looked at');

  const dev = new LabServer({ log: () => {}, dev: true });
  const { port } = await dev.listen(0, '127.0.0.1');
  try {
    const answer = (await (await fetch(`http://127.0.0.1:${port}/api/version`)).json()) as { boot: string; dev: boolean; ui: number };
    assert.equal(answer.dev, true);
    assert.notEqual(answer.boot, plain.boot, 'every start is a new run');
    assert.ok(answer.ui > 0, 'when the UI files last changed');
  } finally {
    await dev.close();
  }
});

test('lists practicals, organisations and manuals', async () => {
  const practicals = (await (await fetch(`${base}/api/practicals`)).json()) as { id: string }[];
  assert.ok(practicals.some((p) => p.id === 'smoke-prey-night-shift'));
  const orgs = (await (await fetch(`${base}/api/orgs`)).json()) as { id: string }[];
  assert.deepEqual(orgs.map((o) => o.id).sort(), ['dataquant', 'ikhaya', 'siyakhula']);
  const manual = (await (await fetch(`${base}/api/manual/dataquant?level=2`)).json()) as { markdown: string; level: number };
  assert.equal(manual.level, 2);
  assert.match(manual.markdown, /^# DataQuant operating manual/);
  assert.equal((await fetch(`${base}/api/manual/dataquant?level=9`)).status, 400);
});

test('runs a round: create, begin, act, refuse bad actions, stop', async () => {
  const created = await post('/api/sessions', { practical: 'smoke-prey-night-shift', seed: 7, speed: 20 });
  assert.equal(created.status, 201);
  const id = String(created.json.session);
  assert.equal(created.json.status, 'briefing');
  const begun = await post(`/api/sessions/${id}/begin`, {});
  assert.equal(begun.json.status, 'live');
  const block = await post(`/api/sessions/${id}/act`, { type: 'block', src: '10.88.0.143' });
  assert.equal(block.status, 200);
  assert.equal(block.json.ok, true);
  assert.equal((await post(`/api/sessions/${id}/act`, { type: 'format-c' })).status, 400);
  assert.equal((await post(`/api/sessions/${id}/act`, { type: 'classify', alert: 'x', verdict: 'true-positive' })).status, 400);
  const stopped = await post(`/api/sessions/${id}/stop`, {});
  assert.equal(stopped.json.status, 'ended');
  assert.ok((stopped.json.debrief as { score: unknown }).score);
  assert.equal((await fetch(`${base}/api/sessions/nope`)).status, 404);
  assert.equal((await post('/api/sessions', { practical: 'nope' })).status, 400);
});

test('streams events over server-sent events', async () => {
  const created = await post('/api/sessions', { practical: 'smoke-prey-night-shift', seed: 7, speed: 60 });
  const id = String(created.json.session);
  await post(`/api/sessions/${id}/begin`, {});
  const controller = new AbortController();
  const res = await fetch(`${base}/api/sessions/${id}/events`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body!.getReader();
  let text = '';
  const until = Date.now() + 4000;
  while (Date.now() < until && !text.includes('"type":"tick"')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  controller.abort();
  await post(`/api/sessions/${id}/stop`, {});
  assert.match(text, /"type":"tick"/);
});

test('parseAction checks every field', () => {
  assert.deepEqual(parseAction({ type: 'lock', host: 'siyakhula/dc01', user: 'kagiso' }), { type: 'lock', host: 'siyakhula/dc01', user: 'kagiso' });
  assert.throws(() => parseAction({ type: 'control', control: 'x', on: 'yes' }));
  assert.throws(() => parseAction({ type: 'report', summary: 'a', impact: 'b', actions: 'c' }));
});

test('lists the towers, and a guided floor keeps its own pace', async () => {
  const towers = (await (await fetch(`${base}/api/towers`)).json()) as { id: string; tier: string; floors: { floor: number; practical: string | null }[] }[];
  const defend = towers.find((t) => t.id === 'defend');
  assert.equal(defend?.tier, 'intro');
  assert.equal(towers.length, 6, 'three blue and three red buildings');
  assert.equal(defend?.floors[0]?.floor, 0);
  assert.equal(defend?.floors[0]?.practical, 'defend-00-first-day');
  assert.equal(defend?.floors.find((f) => f.floor === 1)?.practical, 'defend-01-first-alert');
  assert.equal(defend?.floors.find((f) => f.floor === 2)?.practical, 'defend-02-real-or-not');
  assert.ok(defend?.floors.every((f) => f.practical), 'every intro defend floor is playable');
  const practicals = (await (await fetch(`${base}/api/practicals`)).json()) as { id: string; guided: boolean }[];
  assert.equal(practicals.find((p) => p.id === 'defend-00-first-day')?.guided, true);

  const created = await post('/api/sessions', { practical: 'defend-00-first-day', speed: 20 });
  const id = String(created.json.session);
  assert.equal((created.json.clock as { speed: number }).speed, 1);
  assert.equal((created.json.guide as { current: { id: string } }).current.id, 'meet-floor');
  await post(`/api/sessions/${id}/begin`, {});
  const looked = await post(`/api/sessions/${id}/act`, { type: 'look', what: 'room', id: 'growth' });
  assert.equal(looked.status, 200);
  const block = await post(`/api/sessions/${id}/act`, { type: 'block', src: '10.88.0.143' });
  assert.equal(block.status, 409);
  assert.match(String(block.json.message), /unlocks on floor 3/);
  const snap = (await (await fetch(`${base}/api/sessions/${id}`)).json()) as { guide: { current: { id: string } } };
  assert.equal(snap.guide.current.id, 'find-team');
  await post(`/api/sessions/${id}/stop`, {});
});
