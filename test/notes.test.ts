// The notes pad: notes land as Markdown entries in notes/, screenshots as PNGs,
// and only the lab's own page on this computer can send one.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LabServer } from '../src/server/server.ts';
import { NotesBook } from '../src/server/notes.ts';

// A 1x1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let dir = '';
let base = '';
let server: LabServer;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cyberverse-notes-'));
  server = new LabServer({ log: () => {}, notesDir: dir });
  const { port } = await server.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

async function send(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test('the local server says it has a notes pad; the hosted lab does not', async () => {
  const version = (await (await fetch(`${base}/api/version`)).json()) as { notes: boolean };
  assert.equal(version.notes, true);
  const off = new LabServer({ log: () => {}, notesDir: null });
  const { port } = await off.listen(0, '127.0.0.1');
  try {
    const answer = (await (await fetch(`http://127.0.0.1:${port}/api/version`)).json()) as { notes: boolean };
    assert.equal(answer.notes, false);
    const res = await fetch(`http://127.0.0.1:${port}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"tab":"ui","text":"hi"}' });
    assert.equal(res.status, 404);
  } finally {
    await off.close();
  }
});

test('saves a note with where you were and its screenshot', async () => {
  const saved = await send(
    {
      tab: 'ui',
      text: 'The firewall button is hard to find.\n# not a heading\n---\nend',
      where: { screen: 'Round', floor: '3, Close the door (defend-03-close-the-door)', room: 'Operations\n## Screen: fake', size: '1440 × 900', secret: 'dropped' },
      shot: PNG,
    },
    { origin: base },
  );
  assert.equal(saved.status, 201);
  assert.equal(saved.json.file, 'notes/ui-notes.md');
  assert.match(String(saved.json.shot), /^notes\/shots\/\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d-ui-[0-9a-f]{6}\.png$/);

  const md = await readFile(join(dir, 'ui-notes.md'), 'utf8');
  assert.match(md, /^### \d{4}-\d\d-\d\d \d\d:\d\d:\d\d - .+\n## Screen: Round\n- Floor: 3, Close the door \(defend-03-close-the-door\)\n- Room open: Operations ## Screen: fake\n- Browser size: 1440 × 900\n/);
  assert.match(md, /The firewall button is hard to find\.\n\\# not a heading\n\\---\nend\n/);
  assert.match(md, /!\[screenshot\]\(shots\/.+\.png\)\n\n---\n/);
  assert.doesNotMatch(md, /secret|dropped/);
  const shots = await readdir(join(dir, 'shots'));
  assert.equal(shots.length, 1);
  const bytes = await readFile(join(dir, 'shots', shots[0]!));
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');

  const lesson = await send({ tab: 'practicals', text: 'Step 2 says "the log" but there are two logs.' });
  assert.equal(lesson.status, 201);
  assert.equal(lesson.json.shot, null);
  assert.match(await readFile(join(dir, 'practicals-notes.md'), 'utf8'), /## Screen: Unknown\n\nStep 2 says/);
});

test('refuses notes that are empty, unknown, not PNG, or not from this page', async () => {
  assert.equal((await send({ tab: 'ui', text: '   ' })).status, 400);
  assert.equal((await send({ tab: 'other', text: 'hi' })).status, 400);
  assert.equal((await send({ tab: 'ui', shot: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
  assert.equal((await send({ tab: 'ui', shot: 'data:image/png;base64,R0lGODlhAQABAAAAACw=' })).status, 400);
  assert.equal((await send({ tab: 'ui', text: 'hi' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await send({ tab: 'ui', text: 'hi' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const plain = await fetch(`${base}/api/notes`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"tab":"ui","text":"hi"}' });
  assert.equal(plain.status, 415);
  // Other API calls keep their small limit; a note may carry a screenshot.
  const big = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ practical: 'x'.repeat(100_000) }) });
  assert.equal(big.status, 413);
});

test('two notes sent at once are both written whole', async () => {
  const book = new NotesBook(join(dir, 'together'), { author: 'tester', now: () => new Date(2026, 10, 24, 13, 52, 10) });
  await Promise.all([book.add({ tab: 'ui', text: 'first' }), book.add({ tab: 'ui', text: 'second' })]);
  const md = await readFile(join(dir, 'together', 'ui-notes.md'), 'utf8');
  assert.equal(md, '### 2026-11-24 13:52:10 - tester\n## Screen: Unknown\n\nfirst\n\n---\n\n### 2026-11-24 13:52:10 - tester\n## Screen: Unknown\n\nsecond\n\n---\n\n');
});
