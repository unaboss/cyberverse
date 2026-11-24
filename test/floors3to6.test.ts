// Defend floors 3 to 6: the floors where the learner acts, not only looks.
// Floor 3 blocks a scanner, floor 4 resets an account and switches a control
// on, floor 5 isolates and rebuilds a phished laptop, and floor 6 switches on a
// sensor nobody had. Each plays the same way every time, a wrong move gets a
// reply and the step waits, and doing a step early counts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorld, type WorldBundle } from '../src/world/load.ts';
import { validateWorld } from '../src/world/validate.ts';
import type { PracticalDef } from '../src/world/types.ts';
import { Session } from '../src/engine/session.ts';
import { hostLogs, snapshot, type AlertView } from '../src/engine/view.ts';

const bundle = loadWorld();

function floor(id: string, seed = 1): Session {
  const practical = bundle.practicals.find((p) => p.id === id);
  assert.ok(practical, `${id} exists`);
  const session = new Session(bundle, practical, { seed });
  session.begin(true);
  return session;
}

const current = (s: Session): string | undefined => snapshot(s).guide?.current?.id;
const alertsOf = (s: Session, rule: string): AlertView[] => snapshot(s).alerts.filter((a) => a.rule === rule);
const open = (s: Session, rule: string): AlertView => {
  const alert = alertsOf(s, rule)[0];
  assert.ok(alert, `an alert from ${rule}: ${snapshot(s).alerts.map((a) => a.rule).join(', ')}`);
  s.act({ type: 'look', what: 'alert', id: String(alert.id) });
  return alert;
};

test('floors 3 to 6 sit on the defend tower, and the world is still valid', () => {
  const defend = bundle.towers.find((t) => t.id === 'defend')!;
  const ids = [3, 4, 5, 6].map((n) => defend.floors.find((f) => f.floor === n)?.practical);
  assert.deepEqual(ids, ['defend-03-close-the-door', 'defend-04-default-password', 'defend-05-the-lure', 'defend-06-what-you-cant-see']);
  assert.deepEqual(validateWorld(bundle), []);
});

test('each floor unlocks what it teaches, and nothing later', () => {
  const locked = (id: string) => snapshot(floor(id)).guide?.locked ?? {};
  assert.deepEqual(Object.keys(locked('defend-03-close-the-door')).sort(), ['control', 'isolate', 'lock', 'rebuild', 'release', 'reset']);
  assert.deepEqual(Object.keys(locked('defend-04-default-password')).sort(), ['isolate', 'rebuild', 'release']);
  assert.deepEqual(locked('defend-05-the-lure'), {});
  assert.deepEqual(locked('defend-06-what-you-cant-see'), {});
  assert.equal(floor('defend-03-close-the-door').act({ type: 'isolate', host: 'dataquant/crm' }).ok, false);
});

// ------------------------------------------------------------------ floor 3

test('floor 3: block the scanner, check it held, close the alert', async () => {
  const s = floor('defend-03-close-the-door');
  await s.run(20_000);
  const alert = open(s, 'nids-port-scan');
  assert.equal(alert.src, '10.88.0.143');
  assert.equal(current(s), 'how-much');
  s.act({ type: 'answer', option: 1 });
  assert.match(snapshot(s).guide?.feedback?.text ?? '', /every client/);
  s.act({ type: 'answer', option: 0 });
  assert.equal(current(s), 'block');

  // Too wide: the step waits, Ayanda says why, and the business feels it.
  s.act({ type: 'block', src: '10.88.0.0/24' });
  assert.equal(current(s), 'block');
  assert.equal(snapshot(s).guide?.verdict?.correct, false);
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /whole internet range/);
  assert.ok((snapshot(s).business?.health ?? 100) < 60, 'clients are shut out');
  s.act({ type: 'unblock', src: '10.88.0.0/24' });
  assert.equal(snapshot(s).business?.health, 100);

  s.act({ type: 'block', src: '10.88.0.143' });
  assert.equal(current(s), 'check');
  await s.run(20_000);
  assert.equal(alertsOf(s, 'nids-port-scan').length, 1, 'the blocked scan raised no new alert');
  assert.ok((snapshot(s).stopped['10.88.0.143'] ?? 0) >= 100, 'the block counts what it stopped');
  s.act({ type: 'answer', option: 0 });
  assert.equal(current(s), 'close');
  s.act({ type: 'classify', alert: alert.id, verdict: 'true-positive' });
  assert.equal(s.end?.reason, 'complete');
});

test('floor 3: blocking before the question still counts', async () => {
  const s = floor('defend-03-close-the-door', 2);
  await s.run(20_000);
  open(s, 'nids-port-scan');
  s.act({ type: 'block', src: '10.88.0.143' });
  assert.equal(current(s), 'how-much', 'the question still comes');
  s.act({ type: 'answer', option: 0 });
  assert.equal(current(s), 'check', 'the block step was already done');
  assert.match(snapshot(s).guide?.last?.text ?? '', /stops at the perimeter/);
});

// ------------------------------------------------------------------ floor 4

test('floor 4: a factory password gets in, and the learner fixes the cause', async () => {
  const s = floor('defend-04-default-password');
  await s.run(20_000);
  assert.deepEqual(snapshot(s).alerts.map((a) => a.rule), ['hids-default-credentials'], 'one alert, nothing else');
  const lines = hostLogs(s, 'dataquant/crm').filter((l) => l.includes('10.88.0.201'));
  assert.deepEqual(lines.map((l) => /login (ok|failed)/.exec(l)?.[1]), ['failed', 'ok']);
  const alert = open(s, 'hids-default-credentials');
  s.act({ type: 'answer', option: 0 });
  assert.equal(current(s), 'reset');

  s.act({ type: 'reset', host: 'dataquant/crm', user: 'ayanda' });
  assert.equal(current(s), 'reset', 'the wrong account');
  s.act({ type: 'reset', host: 'dataquant/crm', user: 'admin' });
  assert.equal(current(s), 'block');
  s.act({ type: 'block', src: '10.88.0.201' });
  assert.equal(current(s), 'control');

  s.act({ type: 'control', control: 'mfa-everywhere', on: true });
  assert.equal(current(s), 'control', 'MFA helps, but the cause is the factory password');
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /default\s+passwords too/);
  s.act({ type: 'control', control: 'crm-hardening', on: true });
  assert.equal(current(s), 'why');
  s.act({ type: 'answer', option: 0 });
  assert.equal(s.end?.reason, 'complete');
  assert.equal(alert.severity, 'high');
});

test('floor 4: with the control on, the factory password no longer works', async () => {
  const s = floor('defend-04-default-password', 3);
  s.act({ type: 'control', control: 'crm-hardening', on: true });
  await s.run(20_000);
  assert.equal(alertsOf(s, 'hids-default-credentials').length, 0);
});

// ------------------------------------------------------------------ floor 5

test('floor 5: the lure, the scan from our own laptop, isolate and rebuild', async () => {
  const s = floor('defend-05-the-lure');
  await s.run(20_000);
  const mail = open(s, 'mail-malicious-attachment');
  assert.equal(mail.src, '10.88.0.166');
  s.act({ type: 'answer', option: 1 });
  assert.match(snapshot(s).guide?.feedback?.text ?? '', /post office/);
  s.act({ type: 'answer', option: 0 });
  assert.equal(current(s), 'spreading');
  await s.run(20_000);
  const scan = open(s, 'nids-port-scan');
  assert.equal(scan.srcHost, 'dataquant/founder-laptop', 'one of ours');
  assert.equal(scan.host, 'dataquant/git');
  assert.equal(snapshot(s).alerts.length, 2, 'nothing sees the infection itself: the laptop has no log agent');
  assert.equal(current(s), 'isolate');

  s.act({ type: 'isolate', host: 'dataquant/git' });
  assert.equal(current(s), 'isolate');
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /what my laptop was scanning/);
  s.act({ type: 'release', host: 'dataquant/git' });
  s.act({ type: 'isolate', host: 'dataquant/founder-laptop' });
  assert.equal(current(s), 'next');
  s.act({ type: 'answer', option: 0 });
  s.act({ type: 'rebuild', host: 'dataquant/founder-laptop' });
  assert.equal(current(s), 'close');
  s.act({ type: 'classify', alert: mail.id, verdict: 'true-positive' });
  s.act({ type: 'classify', alert: scan.id, verdict: 'true-positive' });
  assert.equal(s.end?.reason, 'complete');
  assert.equal(snapshot(s).guide?.outro?.title, 'Floor 5 complete');
});

test('floor 5: alerts closed early still count for the last step', async () => {
  const s = floor('defend-05-the-lure', 4);
  await s.run(20_000);
  const mail = open(s, 'mail-malicious-attachment');
  s.act({ type: 'classify', alert: mail.id, verdict: 'false-positive' });
  s.act({ type: 'answer', option: 0 });
  await s.run(20_000);
  const scan = open(s, 'nids-port-scan');
  s.act({ type: 'classify', alert: scan.id, verdict: 'true-positive' });
  s.act({ type: 'isolate', host: 'dataquant/founder-laptop' });
  s.act({ type: 'answer', option: 0 });
  s.act({ type: 'rebuild', host: 'dataquant/founder-laptop' });
  assert.equal(s.end?.reason, 'complete');
});

// ------------------------------------------------------------------ floor 6

test('floor 6: no sensor sees the bucket until the learner switches one on', async () => {
  const s = floor('defend-06-what-you-cant-see');
  await s.run(10_000);
  assert.equal(snapshot(s).alerts.length, 0, 'a quiet afternoon');
  s.act({ type: 'look', what: 'host', id: 'dataquant/dataroom' });
  s.act({ type: 'answer', option: 0 });
  assert.equal(current(s), 'sensor');

  s.act({ type: 'control', control: 'private-buckets', on: true });
  assert.equal(current(s), 'sensor', 'closing the hole first is not seeing');
  s.act({ type: 'control', control: 'private-buckets', on: false });
  s.act({ type: 'control', control: 'storage-access-logs', on: true });
  assert.equal(current(s), 'back');
  await s.run(20_000);
  const alert = open(s, 'weblog-anonymous-listing');
  assert.equal(alert.src, '10.88.0.58');
  assert.ok(hostLogs(s, 'dataquant/dataroom').some((l) => l.includes('GET /client-datasets/')), 'every read is on record now');
  s.act({ type: 'answer', option: 1 });
  assert.equal(current(s), 'for-good');
  s.act({ type: 'answer', option: 0 });
  s.act({ type: 'control', control: 'private-buckets', on: true });
  assert.equal(current(s), 'tell');
  s.act({ type: 'answer', option: 0 });
  assert.equal(s.end?.reason, 'complete');
});

test('floor 6: with the sensor off, the same download raises nothing', async () => {
  const practical = structuredClone(bundle.practicals.find((p) => p.id === 'defend-06-what-you-cant-see')!);
  const back = practical.guide!.steps.find((step) => step.id === 'back')!;
  practical.guide!.steps = [{ ...back, done: { answer: 'correct' }, ask: { question: '?', options: [{ text: 'ok', correct: true, reply: 'ok' }] } }];
  const s = new Session(bundle, practical, { seed: 1 });
  s.begin(true);
  await s.run(20_000);
  assert.equal(snapshot(s).alerts.length, 0);
});

// --------------------------------------------------------------- validator

test('a broken action step is caught by the validator', () => {
  const practical = bundle.practicals.find((p) => p.id === 'defend-04-default-password')!;
  const broken: PracticalDef = structuredClone(practical);
  const steps = broken.guide!.steps;
  steps[2]!.done = { action: 'reset', target: 'crm', user: 'nobody' };
  steps[3]!.done = { action: 'isolate', target: 'crm' };
  delete steps[3]!.wrong;
  steps[4]!.done = { action: 'control', target: 'cloud-audit-logging' };
  steps[4]!.replies = { 'no-such-control': 'x' };
  steps[0]!.script = [{ after: 1, event: 'phish', to: 'nobody', src: '10.88.10.5', lure: '' }];
  broken.guide!.hold = ['no-such-process'];
  const copy: WorldBundle = { ...bundle, practicals: [broken] };
  const messages = validateWorld(copy).map((i) => `${i.where}: ${i.message}`).join('\n');
  assert.match(messages, /crm has no account nobody/);
  assert.match(messages, /waits for isolate, but this floor locks it/);
  assert.match(messages, /an action step needs a wrong reply/);
  assert.match(messages, /control cloud-audit-logging is already on at the start/);
  assert.match(messages, /reply for unknown control target no-such-control/);
  assert.match(messages, /phish goes to unknown person nobody/);
  assert.match(messages, /phishing must come from the internet range/);
  assert.match(messages, /a phish needs a lure/);
  assert.match(messages, /holds unknown process no-such-process/);
});
