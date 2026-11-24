// Defend floor 2, "Real or not?": three alerts on a busy morning. Ayanda types
// her old mail password, our own Recon agent scans our website on schedule, and
// somebody on the internet scans it too. The learner sorts them, and the mentor
// says right away whether each verdict was right.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorld, type WorldBundle } from '../src/world/load.ts';
import { validateWorld } from '../src/world/validate.ts';
import type { PracticalDef } from '../src/world/types.ts';
import { Session } from '../src/engine/session.ts';
import { hostLogs, snapshot, type AlertView } from '../src/engine/view.ts';

const bundle = loadWorld();
const FLOOR2 = 'defend-02-real-or-not';
const SCANNER = '10.88.0.143';
const LAPTOP = '10.88.11.10';
const VAULT = '10.88.10.50';

function floor2(seed = 1): Session {
  const practical = bundle.practicals.find((p) => p.id === FLOOR2);
  assert.ok(practical, 'floor 2 exists');
  const session = new Session(bundle, practical, { seed });
  session.begin(true);
  return session;
}

const current = (s: Session): string | undefined => snapshot(s).guide?.current?.id;

/** Find the controls, then let the three alerts arrive. */
async function morning(s: Session): Promise<{ login: AlertView; ours: AlertView; theirs: AlertView }> {
  s.act({ type: 'look', what: 'tab', id: 'controls' });
  assert.equal(current(s), 'sort');
  await s.run(90_000);
  const alerts = snapshot(s).alerts;
  const login = alerts.find((a) => a.rule === 'hids-login-after-failures');
  const ours = alerts.find((a) => a.rule === 'nids-port-scan' && a.src === VAULT);
  const theirs = alerts.find((a) => a.rule === 'nids-port-scan' && a.src === SCANNER);
  assert.ok(login && ours && theirs, alerts.map((a) => `${a.rule} ${a.src}`).join('\n'));
  return { login, ours, theirs };
}

test('floor 2 sits on the defend tower and the world is still valid', () => {
  const defend = bundle.towers.find((t) => t.id === 'defend');
  assert.equal(defend?.floors.find((f) => f.floor === 2)?.practical, FLOOR2);
  assert.deepEqual(validateWorld(bundle), []);
});

test('the network sensor is on for this floor only', () => {
  const s = floor2();
  assert.equal(snapshot(s).controls.find((c) => c.id === 'cloud-ids')?.on, true);
  const floor1 = new Session(bundle, bundle.practicals.find((p) => p.id === 'defend-01-first-alert')!, { seed: 1 });
  assert.equal(snapshot(floor1).controls.find((c) => c.id === 'cloud-ids'), undefined, 'DataQuant only plans it at level 1');
});

test('the same three alerts arrive every time, and nothing else', async () => {
  for (const seed of [1, 2, 3, 4, 5, 42]) {
    const s = floor2(seed);
    const { login, ours, theirs } = await morning(s);
    await s.run(15 * 60_000, 5_000);
    assert.equal(snapshot(s).alerts.length, 3, `seed ${seed}: ${snapshot(s).alerts.map((a) => `${a.clock} ${a.rule} ${a.src}`).join(', ')}`);
    assert.equal(login.severity, 'critical', 'harmless, but marked critical');
    assert.equal(login.src, LAPTOP);
    assert.equal(login.srcHost, 'dataquant/founder-laptop');
    assert.equal(login.host, 'dataquant/mail');
    assert.equal(ours.srcHost, 'dataquant/vault', 'the Recon agent scans from the vault');
    assert.equal(theirs.srcHost, undefined, 'the scanner is not one of ours');
    assert.ok(login.t < ours.t && ours.t < theirs.t, 'one at a time');
    assert.equal(s.status, 'live', 'no clock runs out');
  }
});

test("Ayanda's log shows three wrong tries, then the right one", async () => {
  const s = floor2();
  await morning(s);
  const lines = hostLogs(s, 'dataquant/mail').filter((l) => l.includes(`ayanda from ${LAPTOP}`));
  assert.deepEqual(lines.slice(0, 4).map((l) => /login (ok|failed)/.exec(l)?.[1]), ['failed', 'failed', 'failed', 'ok']);
});

test('the engagement vault says what runs from it', () => {
  const s = floor2();
  const vault = snapshot(s).org.departments.flatMap((d) => d.hosts).find((h) => h.key === 'dataquant/vault');
  assert.ok(vault?.jobs?.some((j) => j.startsWith('Own attack surface check (Recon agent, daily): from here, scans the public website')), JSON.stringify(vault?.jobs));
});

test('sorting all three right: a note for each, then the questions', async () => {
  const s = floor2();
  const { login, ours, theirs } = await morning(s);
  assert.deepEqual(snapshot(s).guide?.current?.sort, { done: 0, total: 3 });

  s.act({ type: 'classify', alert: theirs.id, verdict: 'true-positive' });
  let guide = snapshot(s).guide!;
  assert.deepEqual(guide.current?.sort, { done: 1, total: 3 }, 'any order will do');
  assert.equal(guide.verdict?.correct, true);
  assert.equal(guide.verdict?.alert, theirs.id);
  assert.match(guide.verdict?.text ?? '', /on the internet/);
  const first = guide.verdict!.seq;

  s.act({ type: 'classify', alert: login.id, verdict: 'false-positive' });
  guide = snapshot(s).guide!;
  assert.equal(guide.verdict?.correct, true);
  assert.ok(guide.verdict!.seq > first, 'each verdict is a new note');
  assert.match(guide.verdict?.text ?? '', /that was me/);
  assert.equal(current(s), 'sort');

  s.act({ type: 'classify', alert: ours.id, verdict: 'false-positive' });
  guide = snapshot(s).guide!;
  assert.equal(current(s), 'in-common');
  assert.equal(guide.verdict, null, 'the last reply goes in the closing note instead');
  assert.equal(guide.last?.wrong, false);
  assert.equal(guide.last?.heading, 'All 3 sorted right');
  assert.match(guide.last?.text ?? '', /Recon agent[\s\S]*one real/);

  s.act({ type: 'answer', option: 1 });
  assert.match(snapshot(s).guide?.feedback?.text ?? '', /critical/, '"low severity" is the trap');
  assert.equal(current(s), 'in-common');
  s.act({ type: 'answer', option: 0 });
  assert.equal(current(s), 'needs-action');
  s.act({ type: 'answer', option: 2 });
  assert.equal(current(s), 'needs-action');
  s.act({ type: 'answer', option: 0 });

  assert.equal(s.status, 'ended');
  assert.equal(s.end?.reason, 'complete');
  assert.equal(snapshot(s).guide?.outro?.title, 'Floor 2 complete');
});

test('a wrong verdict is explained, and the floor still moves on', async () => {
  const s = floor2(7);
  const { login, ours, theirs } = await morning(s);
  s.act({ type: 'classify', alert: ours.id, verdict: 'true-positive' });
  const guide = snapshot(s).guide!;
  assert.equal(guide.verdict?.correct, false);
  assert.match(guide.verdict?.text ?? '', /10\.88\.10\.50, the engagement vault/, 'the {ip:...} placeholder is filled in');
  s.act({ type: 'classify', alert: login.id, verdict: 'false-positive' });
  s.act({ type: 'classify', alert: theirs.id, verdict: 'false-positive' });
  const after = snapshot(s).guide!;
  assert.equal(current(s), 'in-common');
  assert.equal(after.last?.wrong, true);
  assert.equal(after.last?.heading, '1 of 3 sorted right');
  assert.match(after.last?.text ?? '', /true\s+positive[\s\S]*Sorting takes practice/);
});

test('the scheduled scan and the real one each count once', async () => {
  const s = floor2(3);
  const { ours, theirs } = await morning(s);
  // Closing the real scan as harmless uses up its entry, not the Recon agent's.
  s.act({ type: 'classify', alert: theirs.id, verdict: 'false-positive' });
  assert.equal(snapshot(s).guide?.verdict?.correct, false);
  s.act({ type: 'classify', alert: ours.id, verdict: 'false-positive' });
  assert.equal(snapshot(s).guide?.verdict?.correct, true);
  assert.deepEqual(snapshot(s).guide?.current?.sort, { done: 2, total: 3 });
});

test('blocking still waits for floor 3', async () => {
  const s = floor2();
  await morning(s);
  assert.equal(s.act({ type: 'block', src: SCANNER }).ok, false);
});

test('a broken sort list or script is caught by the validator', () => {
  const practical = bundle.practicals.find((p) => p.id === FLOOR2)!;
  const broken: PracticalDef = structuredClone(practical);
  const sort = broken.guide!.steps[1]!;
  sort.script = [
    { after: 1, event: 'job', process: 'no-such-job' },
    { after: 2, event: 'scan', system: 'website', src: '10.88.10.20' },
    { after: 3, event: 'login', system: 'mail', user: 'ayanda', from: 'founder-laptop', fails: 40 },
  ];
  sort.sort = [{ rule: 'nope', from: 'no-machine', verdict: 'maybe' as 'true-positive', right: '', wrong: 'x' }];
  broken.guide!.steps[2]!.done = { sorted: true };
  const copy: WorldBundle = { ...bundle, practicals: [broken] };
  const messages = validateWorld(copy).map((i) => `${i.where}: ${i.message}`).join('\n');
  assert.match(messages, /dataquant has no process no-such-job/);
  assert.match(messages, /scans must come from the internet range 10\.88\.0\.0\/24, not 10\.88\.10\.20/);
  assert.match(messages, /1 to 9 wrong tries/);
  assert.match(messages, /sort entry 1: no detection rule nope/);
  assert.match(messages, /sort entry 1: comes from unknown machine no-machine/);
  assert.match(messages, /sort entry 1: verdict is true-positive or false-positive/);
  assert.match(messages, /sort entry 1: needs what to say when it is sorted right/);
  assert.match(messages, /step in-common: done when the alerts are sorted, but there is no sort list/);
});
