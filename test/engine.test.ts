// The engine: clock, detection rules, the live attacker, the defender,
// what each side is allowed to see, and scoring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorld } from '../src/world/load.ts';
import { EventBus, Rng, SimClock } from '../src/engine/core.ts';
import { Session } from '../src/engine/session.ts';
import { snapshot, StreamFilter, hostLogs } from '../src/engine/view.ts';
import type { PracticalDef } from '../src/world/types.ts';

const bundle = loadWorld();
const prey = bundle.practicals.find((p) => p.id === 'smoke-prey-night-shift')!;
const predator = bundle.practicals.find((p) => p.id === 'smoke-predator-pentest')!;

function short(p: PracticalDef, minutes: number): PracticalDef {
  return { ...p, durationMin: minutes };
}

test('the seeded random source repeats', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  assert.deepEqual([a.next(), a.next(), a.int(1, 6)], [b.next(), b.next(), b.int(1, 6)]);
});

test('the clock runs timers in order and tells the time of day', async () => {
  const clock = SimClock.fromTimeOfDay('02:10');
  const seen: string[] = [];
  clock.at(2000, () => seen.push('two'));
  clock.at(1000, () => seen.push('one'));
  await clock.advance(2500);
  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(clock.clockText(), '02:10:02');
  assert.equal(clock.isWorkHours(), false);
});

test('the event bus stamps events with the clock', () => {
  const clock = SimClock.fromTimeOfDay('09:00');
  const bus = new EventBus(clock);
  const event = bus.emit({ kind: 'test', actor: 'system', summary: 'hello' });
  assert.equal(event.t, 0);
  assert.equal(event.malicious, false);
});

test('the same seed plays out the same round', async () => {
  const run = async (): Promise<string[]> => {
    const s = new Session(bundle, short(prey, 6), { seed: 11 });
    s.begin(true);
    await s.run(6 * 60_000);
    return s.bus.events.filter((e) => e.kind === 'attacker.step').map((e) => `${e.t} ${e.summary}`);
  };
  assert.deepEqual(await run(), await run());
});

test('an idle defender loses the data; detection still fires', async () => {
  const s = new Session(bundle, prey, { seed: 7 });
  s.begin(true);
  await s.run(15 * 60_000);
  assert.equal(s.end?.reason, 'objective');
  const names = s.detector.alerts.map((a) => a.rule);
  assert.ok(names.includes('nids-port-scan'));
  assert.ok(names.includes('weblog-sqli'));
  assert.ok(names.includes('nids-large-outbound'));
  assert.ok(s.detector.alerts.every((a) => a.truth || a.rule.length > 0));
  assert.equal(s.score?.parts.find((p) => p.label === 'Data protected')?.points, 0);
});

test('a quick block keeps the data in and the attacker gives up', async () => {
  const s = new Session(bundle, prey, { seed: 11 });
  const blocked = new Set<string>();
  s.onEvent((e) => {
    if (e.kind !== 'alert.raised') return;
    // A learner who reads each alert and blocks the outside address in it, 30 seconds later.
    const alert = s.detector.get(Number(e.data?.alert))!;
    const outside = [alert.src, alert.dst].find((ip) => ip && s.world.zoneOfIp(ip).org === null);
    if (alert.severity !== 'low' && outside && !blocked.has(outside)) {
      blocked.add(outside);
      s.clock.at(30_000, () => {
        s.act({ type: 'block', src: outside });
      });
    }
  });
  s.begin(true);
  await s.run(15 * 60_000);
  assert.equal(s.end?.reason, 'contained');
  assert.equal(s.business.state.get('siyakhula')!.leaked.length, 0);
  assert.equal(s.score?.parts.find((p) => p.label === 'Containment')?.points, 25);
});

test('a block mid-transfer leaks only part of the data', async () => {
  const s = new Session(bundle, prey, { seed: 7 });
  s.onEvent((e) => {
    if (e.kind === 'data.transfer' && e.data?.page === 2 && e.dst) {
      s.act({ type: 'block', src: e.dst });
    }
  });
  s.begin(true);
  await s.run(15 * 60_000);
  const leaked = s.business.state.get('siyakhula')!.leaked;
  assert.equal(leaked.length, 1);
  assert.ok(leaked[0]!.fraction > 0 && leaked[0]!.fraction < 0.5, `fraction ${leaked[0]!.fraction}`);
});

test('prey sees no leak until the round ends, and no lab truth', async () => {
  const s = new Session(bundle, short(prey, 10), { seed: 7 });
  s.begin(true);
  await s.run(6 * 60_000);
  const view = snapshot(s);
  assert.equal(view.role, 'prey');
  assert.equal(view.debrief, null);
  const text = JSON.stringify(view);
  assert.ok(!text.includes('"truth"'), 'alerts do not say whether they are real');
  for (const host of s.world.hosts.values()) {
    for (const account of host.accounts) {
      assert.ok(account.password.length < 6 || !text.includes(account.password), `lab password of ${host.key}:${account.user}`);
    }
  }
  assert.ok(!text.includes('weakness'), 'no weaknesses');
  assert.equal(view.terminal, null);
});

test('host logs only show what a sensor captured', async () => {
  const s = new Session(bundle, short(prey, 10), { seed: 7 });
  s.begin(true);
  await s.run(5 * 60_000);
  const web = hostLogs(s, 'siyakhula/eservices');
  assert.ok(web.some((line) => line.includes('sqlmap')), 'web log shows the injection');
  assert.deepEqual(hostLogs(s, 'siyakhula/fs01'), [], 'the file server has no log agent');
});

test('the stream sends alerts and sparks but never attacker plans to prey', async () => {
  const s = new Session(bundle, short(prey, 10), { seed: 7 });
  const filter = new StreamFilter(s);
  const types = new Set<string>();
  s.onEvent((e) => {
    const out = filter.map(e);
    if (out) types.add(out.type);
  });
  s.begin(true);
  await s.run(5 * 60_000);
  assert.ok(types.has('alert'));
  assert.ok(types.has('flow'));
  assert.ok(!types.has('terminal'));
});

test('predator: fog of war lifts only with recon', async () => {
  const s = new Session(bundle, predator, { seed: 3 });
  s.begin(true);
  const before = snapshot(s);
  assert.ok(before.org.departments.every((d) => !d.revealed));
  const pending = s.command('nmap -sn 10.88.20.0/24');
  await s.run(30_000);
  const output = await pending;
  assert.match(output, /eservices\.siyakhula\.internal \(10\.88\.20\.20\)/);
  const after = snapshot(s);
  assert.ok(after.org.departments.some((d) => d.revealed));
  assert.equal(after.alerts.length, 0, 'the attacker does not see the defender\'s alerts');
});

test('predator: out-of-scope targets are recorded', async () => {
  const s = new Session(bundle, predator, { seed: 3 });
  s.begin(true);
  const pending = s.command('nmap -sV 10.88.10.10');
  await s.run(60_000);
  await pending;
  assert.ok(s.terminal!.scopeViolations.length > 0);
});

test('predator: the defender bot blocks a noisy tester', async () => {
  const s = new Session(bundle, predator, { seed: 3 });
  s.begin(true);
  const scan = s.command('nmap -sV eservices.siyakhula.internal');
  await s.run(90_000);
  await scan;
  const dump = s.command('sqlmap -u "https://eservices.siyakhula.internal/account.php?id=1" --batch --dump');
  await s.run(8 * 60_000);
  const out = await dump;
  assert.ok(s.bus.events.some((e) => e.kind === 'fw.block' && e.actor === 'defender'));
  assert.match(out, /dump interrupted|table dumped/);
  const vpn = await s.command('vpn next');
  assert.match(vpn, /now leaves from|No unused VPN exits/);
});

test('learner actions are refused outside a prey round or before it starts', () => {
  const s = new Session(bundle, prey, { seed: 1 });
  assert.equal(s.act({ type: 'block', src: '10.88.0.143' }).ok, false);
  s.begin(true);
  assert.equal(s.act({ type: 'block', src: '10.88.0.143' }).ok, true);
  assert.equal(s.act({ type: 'isolate', host: 'dataquant/website' }).ok, false, 'not your machine');
  s.stop();
});
