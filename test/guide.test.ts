// Guided floors and the towers: floor 0 plays the same way every time, a
// beginner cannot break anything, and a broken guide file is caught early.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorld, type WorldBundle } from '../src/world/load.ts';
import { validateWorld } from '../src/world/validate.ts';
import type { PracticalDef } from '../src/world/types.ts';
import { Session } from '../src/engine/session.ts';
import { hostLogs, snapshot, StreamFilter } from '../src/engine/view.ts';
import { parseAction } from '../src/server/server.ts';

const bundle = loadWorld();
const FLOOR0 = 'defend-00-first-day';

function floor0(seed = 1): Session {
  const practical = bundle.practicals.find((p) => p.id === FLOOR0);
  assert.ok(practical, 'floor 0 exists');
  const session = new Session(bundle, practical, { seed });
  session.begin(true);
  return session;
}

const current = (s: Session): string | undefined => snapshot(s).guide?.current?.id;

/** Walk floor 0 up to (not into) the fire drill. */
async function upToDrill(s: Session): Promise<void> {
  s.act({ type: 'look', what: 'room', id: 'growth' });
  s.act({ type: 'look', what: 'room', id: 'trust-risk' });
  s.act({ type: 'look', what: 'host', id: 'dataquant/log-collector' });
  s.act({ type: 'look', what: 'host', id: 'dataquant/crm' });
  await s.run(8_000);
  s.act({ type: 'answer', option: 0 });
  s.act({ type: 'look', what: 'host', id: 'dataquant/dataroom' });
  s.act({ type: 'look', what: 'host', id: 'dataquant/founder-laptop' });
  assert.equal(current(s), 'fire-drill');
  await s.run(5_000);
}

test('the towers point at real practicals, and floor 0 starts the defend tower', () => {
  const defend = bundle.towers.find((t) => t.id === 'defend');
  assert.ok(defend);
  assert.equal(defend.role, 'prey');
  const ground = defend.floors.find((f) => f.floor === 0);
  assert.equal(ground?.practical, FLOOR0);
  assert.equal(defend.floors.find((f) => f.floor === 7)?.practical, 'smoke-prey-night-shift');
  assert.ok(!bundle.practicals.some((p) => (p.id as string) === 'towers'), 'towers.yaml is not loaded as a practical');
});

test('the town has one building for each side and tier', () => {
  const buildings = bundle.towers.map((t) => `${t.role} ${t.tier}`).sort();
  assert.deepEqual(buildings, ['predator advanced', 'predator intermediate', 'predator intro', 'prey advanced', 'prey intermediate', 'prey intro']);
  assert.equal(bundle.towers.find((t) => t.id === 'defend')?.tier, 'intro');
  const copy: WorldBundle = { ...bundle, towers: [...bundle.towers, { ...bundle.towers[0]!, id: 'defend-again' }, { ...bundle.towers[1]!, id: 'odd', tier: 'expert' as never }] };
  const messages = validateWorld(copy).map((i) => `${i.where}: ${i.message}`).join('\n');
  assert.match(messages, /two prey intro towers/);
  assert.match(messages, /tower odd: tier must be one of intro, intermediate, advanced/);
});

test('floor 0 plays from the first step to done, the same way every time', async () => {
  const s = floor0();
  const view = snapshot(s);
  assert.equal(view.clock.timed, false);
  assert.equal(view.guide?.mentor.name, 'Ayanda Khumalo');
  assert.equal(view.guide?.steps.length, 8);
  assert.equal(current(s), 'meet-floor');

  // Any room will do for the first step; the second wants Trust & Risk.
  s.act({ type: 'look', what: 'room', id: 'growth' });
  assert.equal(current(s), 'find-team');
  s.act({ type: 'look', what: 'room', id: 'growth' });
  assert.equal(current(s), 'find-team', 'the wrong room does not tick the step');
  s.act({ type: 'look', what: 'room', id: 'trust-risk' });
  assert.match(snapshot(s).guide?.last?.text ?? '', /triage agent/);
  s.act({ type: 'look', what: 'host', id: 'dataquant/log-collector' });
  s.act({ type: 'look', what: 'host', id: 'dataquant/crm' });
  assert.equal(current(s), 'watch-login');

  // The question waits until Ayanda's login has landed in the CRM's log.
  assert.equal(snapshot(s).guide?.current?.ask, null);
  assert.equal(snapshot(s).guide?.current?.waiting, true);
  assert.equal(s.act({ type: 'answer', option: 0 }).ok, false);
  await s.run(8_000);
  const lines = hostLogs(s, 'dataquant/crm');
  assert.ok(lines.some((l) => /login ok for ayanda from 10\.88\.11\.10/.test(l)), lines.join('\n'));
  const ask = snapshot(s).guide?.current?.ask;
  assert.ok(ask?.options[0]?.includes('10.88.11.10'), 'the {ip:...} placeholder is filled in');

  // A wrong answer explains, and the step stays; the right one moves on.
  const wrong = s.act({ type: 'answer', option: 1 });
  assert.equal(wrong.ok, true);
  assert.equal(current(s), 'watch-login');
  assert.equal(snapshot(s).guide?.feedback?.correct, false);
  s.act({ type: 'answer', option: 0 });
  assert.equal(current(s), 'crown-jewels');

  s.act({ type: 'look', what: 'host', id: 'dataquant/dataroom' });
  s.act({ type: 'look', what: 'host', id: 'dataquant/founder-laptop' });
  assert.equal(current(s), 'fire-drill');

  // The fire drill: a practice alert, marked as one.
  await s.run(5_000);
  const alerts = snapshot(s).alerts;
  assert.equal(alerts.length, 1);
  const drill = alerts[0]!;
  assert.equal(drill.drill, true);
  assert.deepEqual(snapshot(s).guide?.current?.show, { tab: 'alerts', alert: drill.id });
  s.act({ type: 'acknowledge', alert: drill.id });
  assert.equal(s.status, 'live');
  s.act({ type: 'classify', alert: drill.id, verdict: 'false-positive' });

  const end = snapshot(s);
  assert.equal(s.status, 'ended');
  assert.equal(s.end?.reason, 'complete');
  assert.equal(end.guide?.complete, true);
  assert.equal(end.guide?.current, null);
  assert.equal(end.guide?.outro?.title, 'Floor 0 complete');
  assert.equal(end.guide?.last?.wrong, false);
  assert.ok(end.guide?.steps.every((step) => step.status === 'done'));
});

test('closing the drill as a true positive still finishes, with a gentle correction', async () => {
  const s = floor0(2);
  await upToDrill(s);
  const drill = snapshot(s).alerts[0]!;
  s.act({ type: 'classify', alert: drill.id, verdict: 'true-positive' });
  const view = snapshot(s);
  assert.equal(s.end?.reason, 'complete');
  assert.equal(view.guide?.last?.wrong, true);
  assert.match(view.guide?.last?.text ?? '', /false positive/);
});

test('a beginner cannot hurt the business on floor 0, and there is no clock to beat', async () => {
  const s = floor0(3);
  for (const action of [
    { type: 'block', src: '10.88.0.201' },
    { type: 'isolate', host: 'dataquant/crm' },
    { type: 'rebuild', host: 'dataquant/crm' },
    { type: 'lock', host: 'dataquant/crm', user: 'ayanda' },
    { type: 'reset', host: 'dataquant/crm', user: 'ayanda' },
    { type: 'control', control: 'mfa-everywhere', on: true },
  ] as const) {
    const result = s.act(action);
    assert.equal(result.ok, false, action.type);
    assert.match(result.message, /unlocks on floor \d/);
  }
  assert.equal(s.world.blocks.length, 0);
  assert.equal(s.world.hosts.get('dataquant/crm')?.status, 'up');
  // An hour of doing nothing: no attacker, no end of shift.
  await s.run(60 * 60_000, 10_000);
  assert.equal(s.status, 'live');
  assert.equal(snapshot(s).business?.health, 100);
});

test('guide events reach the browser as a refresh', async () => {
  const s = floor0(4);
  const filter = new StreamFilter(s);
  const mapped: unknown[] = [];
  s.onEvent((event) => {
    const out = filter.map(event);
    if (out) mapped.push(out);
  });
  s.act({ type: 'look', what: 'room', id: 'growth' });
  assert.ok(mapped.some((e) => (e as { type: string }).type === 'guide'));
});

test('a broken guide is caught by the validator', () => {
  const practical = bundle.practicals.find((p) => p.id === FLOOR0)!;
  const broken: PracticalDef = structuredClone(practical);
  const guide = broken.guide!;
  guide.mentor = 'nobody';
  guide.steps[1]!.done = { look: 'room', id: 'no-such-room' };
  guide.steps[4]!.ask!.options[1]!.correct = true;
  guide.steps[7]!.script = [];
  guide.steps.push({ ...guide.steps[0]! });
  const copy: WorldBundle = { ...bundle, practicals: [broken] };
  const messages = validateWorld(copy).map((i) => `${i.where}: ${i.message}`).join('\n');
  assert.match(messages, /mentor nobody/);
  assert.match(messages, /no room no-such-room/);
  assert.match(messages, /exactly one correct answer/);
  assert.match(messages, /waits for a drill alert/);
  assert.match(messages, /duplicate step id meet-floor/);
  assert.match(messages, /tower defend: floor 7 plays unknown practical/);
});

test('look and answer actions are checked like every other action', () => {
  assert.deepEqual(parseAction({ type: 'look', what: 'host', id: 'dataquant/crm' }), { type: 'look', what: 'host', id: 'dataquant/crm' });
  assert.deepEqual(parseAction({ type: 'answer', option: 2 }), { type: 'answer', option: 2 });
  assert.throws(() => parseAction({ type: 'look', what: 'desk', id: 'x' }), /room, host, tab or alert/);
  assert.throws(() => parseAction({ type: 'look', what: 'room' }), /"id"/);
  assert.throws(() => parseAction({ type: 'answer', option: -1 }), /answer/);
  assert.throws(() => parseAction({ type: 'answer', option: 1.5 }), /answer/);
});

test('opening a machine inside the room counts as finding the room', () => {
  const s = floor0(5);
  s.act({ type: 'look', what: 'room', id: 'growth' });
  assert.equal(current(s), 'find-team');
  s.act({ type: 'look', what: 'host', id: 'dataquant/crm' });
  assert.equal(current(s), 'find-team', 'a machine in another room does not count');
  s.act({ type: 'look', what: 'host', id: 'dataquant/log-collector' });
  assert.equal(current(s), 'log-collector');
});
