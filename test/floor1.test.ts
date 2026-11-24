// Defend floor 1, "Your first alert": somebody on the internet guesses the CRM's
// admin password and fails. The floor plays the same way every time, the guesses
// never get in, and closing the alert as a false positive still finishes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorld, type WorldBundle } from '../src/world/load.ts';
import { validateWorld } from '../src/world/validate.ts';
import type { PracticalDef } from '../src/world/types.ts';
import { Session } from '../src/engine/session.ts';
import { hostLogs, snapshot } from '../src/engine/view.ts';

const bundle = loadWorld();
const FLOOR1 = 'defend-01-first-alert';
const RULE = 'hids-login-bruteforce';
const GUESSER = '10.88.0.77';

function floor1(seed = 1): Session {
  const practical = bundle.practicals.find((p) => p.id === FLOOR1);
  assert.ok(practical, 'floor 1 exists');
  const session = new Session(bundle, practical, { seed });
  session.begin(true);
  return session;
}

const current = (s: Session): string | undefined => snapshot(s).guide?.current?.id;
const theAlert = (s: Session) => snapshot(s).alerts.find((a) => a.rule === RULE);

/** Let the guesses land, then open the alert and the CRM, and answer the three questions. */
async function upToVerdict(s: Session): Promise<number> {
  await s.run(30_000);
  const alert = theAlert(s);
  assert.ok(alert, 'the guesses raise an alert');
  s.act({ type: 'look', what: 'alert', id: String(alert.id) });
  s.act({ type: 'look', what: 'host', id: 'dataquant/crm' });
  for (let i = 0; i < 3; i++) s.act({ type: 'answer', option: 0 });
  assert.equal(current(s), 'close-alert');
  return alert.id;
}

test('floor 1 sits on the defend tower', () => {
  const defend = bundle.towers.find((t) => t.id === 'defend');
  assert.equal(defend?.floors.find((f) => f.floor === 1)?.practical, FLOOR1);
});

test('floor 1 plays from the first alert to the report, the same way every time', async () => {
  const s = floor1();
  assert.equal(snapshot(s).clock.timed, false);
  assert.equal(current(s), 'wait-alert');
  assert.equal(snapshot(s).alerts.length, 0, 'quiet to begin with');

  await s.run(30_000);
  const alert = theAlert(s);
  assert.ok(alert, 'the guesses raise "Repeated failed logins"');
  assert.ok(!alert.drill, 'a real alert, not a drill');
  assert.equal(alert.host, 'dataquant/crm');
  assert.equal(alert.src, GUESSER);
  assert.equal(snapshot(s).alerts.length, 1, 'only the one alert');
  assert.equal(snapshot(s).guide?.current?.show.alert, alert.id, 'Show me points at it');

  // Opening the Alerts tab is not opening the alert.
  s.act({ type: 'look', what: 'tab', id: 'alerts' });
  s.act({ type: 'look', what: 'alert', id: '999' });
  assert.equal(current(s), 'wait-alert');
  s.act({ type: 'look', what: 'alert', id: String(alert.id) });
  assert.equal(current(s), 'open-log');
  assert.match(snapshot(s).guide?.last?.text ?? '', /real, not a drill/);

  s.act({ type: 'look', what: 'host', id: 'dataquant/website' });
  assert.equal(current(s), 'open-log', 'the wrong machine does not count');
  s.act({ type: 'look', what: 'host', id: 'dataquant/crm' });
  assert.equal(current(s), 'which-account');

  // The log holds the answers.
  const lines = hostLogs(s, 'dataquant/crm');
  const failed = lines.filter((l) => l.includes(`login failed for admin from ${GUESSER}`));
  assert.equal(failed.length, 10, lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('login ok for admin')), 'nobody got in');

  // Which account, from where, and did it work. A wrong answer explains and stays.
  assert.equal(s.act({ type: 'answer', option: 1 }).ok, true);
  assert.equal(current(s), 'which-account');
  assert.equal(snapshot(s).guide?.feedback?.correct, false);
  s.act({ type: 'answer', option: 0 });
  assert.equal(current(s), 'from-where');
  const options = snapshot(s).guide?.current?.ask?.options ?? [];
  assert.ok(options[0]?.includes(GUESSER));
  assert.ok(options[1]?.includes('10.88.11.10'), 'the {ip:...} placeholder is filled in');
  s.act({ type: 'answer', option: 0 });
  assert.equal(current(s), 'got-in');
  s.act({ type: 'answer', option: 0 });
  assert.equal(current(s), 'close-alert');
  assert.equal(snapshot(s).guide?.current?.show.alert, alert.id);

  // The verdict, then the report.
  s.act({ type: 'acknowledge', alert: alert.id });
  assert.equal(current(s), 'close-alert', 'picking it up is not closing it');
  s.act({ type: 'classify', alert: alert.id, verdict: 'true-positive' });
  assert.equal(current(s), 'report');
  assert.equal(snapshot(s).guide?.last?.wrong, false);
  s.act({ type: 'answer', option: 1 });
  assert.equal(snapshot(s).guide?.feedback?.correct, false, 'overstating it is wrong');
  s.act({ type: 'answer', option: 0 });

  const end = snapshot(s);
  assert.equal(s.status, 'ended');
  assert.equal(s.end?.reason, 'complete');
  assert.equal(end.guide?.complete, true);
  assert.equal(end.guide?.outro?.title, 'Floor 1 complete');
  assert.ok(end.guide?.steps.every((step) => step.status === 'done'));
});

test('closing it as a false positive still moves on, with the reason why', async () => {
  const s = floor1(2);
  const id = await upToVerdict(s);
  s.act({ type: 'classify', alert: id, verdict: 'false-positive' });
  const view = snapshot(s);
  assert.equal(current(s), 'report');
  assert.equal(view.guide?.last?.wrong, true);
  assert.match(view.guide?.last?.text ?? '', /still an\s+attack/);
});

test('the guesser never gets in, and the business is not touched', async () => {
  for (const seed of [3, 4, 5]) {
    const s = floor1(seed);
    await s.run(10 * 60_000, 10_000);
    const lines = hostLogs(s, 'dataquant/crm');
    assert.equal(lines.filter((l) => l.includes(`from ${GUESSER}`) && l.includes('login failed')).length, 10, `seed ${seed}`);
    assert.ok(!lines.some((l) => l.includes(`login ok`) && l.includes(GUESSER)), `seed ${seed}: nobody got in`);
    assert.equal(s.status, 'live', 'no clock runs out');
    assert.equal(snapshot(s).business?.health, 100);
    assert.equal(s.act({ type: 'block', src: GUESSER }).ok, false, 'blocking waits for floor 3');
  }
});

test('a broken guess is caught by the validator', () => {
  const practical = bundle.practicals.find((p) => p.id === FLOOR1)!;
  const broken: PracticalDef = structuredClone(practical);
  const steps = broken.guide!.steps;
  steps[0]!.script = [{ after: 1, event: 'guess', system: 'crm', user: 'nobody', src: '10.88.10.10', tries: 0, every: 0 }];
  steps[0]!.done = { look: 'alert', rule: 'no-such-rule' };
  steps[5]!.show = { alert: 'nor-this' };
  const copy: WorldBundle = { ...bundle, practicals: [broken] };
  const messages = validateWorld(copy).map((i) => `${i.where}: ${i.message}`).join('\n');
  assert.match(messages, /crm has no account nobody/);
  assert.match(messages, /guesses must come from the internet range 10\.88\.0\.0\/24, not 10\.88\.10\.10/);
  assert.match(messages, /1 to 50 tries/);
  assert.match(messages, /seconds between tries/);
  assert.match(messages, /no detection rule no-such-rule/);
  assert.match(messages, /shows alerts from unknown rule nor-this/);
});
