// The intermediate attack tower: DataQuant runs an authorised INTERNAL test of
// Siyakhula. These tests play each floor through the Kali terminal, driving the
// seeded foothold, the pivot, internal exploitation, credential dumping, data
// exfiltration and a read-only touch of the water plant's controller. Each floor
// checks the guide advances on what the commands actually achieve.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorld } from '../src/world/load.ts';
import { validateWorld } from '../src/world/validate.ts';
import { Session } from '../src/engine/session.ts';
import { snapshot } from '../src/engine/view.ts';
import type { PracticalDef, GuideStepDef } from '../src/world/types.ts';

const bundle = loadWorld();

function floor(id: string, seed = 1): Session {
  const practical = bundle.practicals.find((p) => p.id === id);
  assert.ok(practical, `${id} exists`);
  const session = new Session(bundle, practical, { seed });
  session.begin(true);
  return session;
}

const current = (s: Session): string | undefined => snapshot(s).guide?.current?.id;

/** Answer the current question with its one correct option, found from the def. */
function answerRight(s: Session, id: string): void {
  const practical = s.practical as PracticalDef;
  const step = practical.guide!.steps.find((st: GuideStepDef) => st.id === current(s));
  assert.ok(step?.ask, `step ${id} has a question`);
  const option = step.ask.options.findIndex((o) => o.correct === true);
  assert.ok(option >= 0, `step ${id} has a correct answer`);
  const r = s.act({ type: 'answer', option });
  assert.ok(r.ok, r.message);
}

/** Run a terminal command to completion, advancing the clock. */
async function cmd(s: Session, line: string, ms = 60_000): Promise<string> {
  const pending = s.command(line);
  await s.run(ms);
  return pending;
}

test('the intermediate attack tower is valid and tests Siyakhula', () => {
  assert.deepEqual(validateWorld(bundle), []);
  const tower = bundle.towers.find((t) => t.id === 'attack-intermediate')!;
  assert.equal(tower.floors.filter((x) => x.practical).length, 8, 'eight floors are registered');
  for (const f of tower.floors.filter((x) => x.practical)) {
    const p = bundle.practicals.find((x) => x.id === f.practical)!;
    assert.ok(p, `${f.practical} exists`);
    assert.equal(p.org, 'siyakhula', `${f.practical} tests Siyakhula`);
    assert.equal(p.role, 'predator', `${f.practical} is an attack floor`);
  }
});

test('floor 0: the internal engagement', async () => {
  const s = floor('attack-mid-00-engagement');
  assert.equal(current(s), 'method');
  answerRight(s, 'method');
  assert.equal(current(s), 'scope');
  const out = await cmd(s, 'cat scope-letter.pdf', 1000);
  assert.match(out, /AUTHORISATION/i);
  assert.equal(current(s), 'data', 'reading the scope letter advanced the step');
  answerRight(s, 'data');
  answerRight(s, 'damage');
  assert.ok(snapshot(s).guide?.complete, 'floor 0 completes');
});

test('floor 1: the foothold via a web-shell exploit', async () => {
  const s = floor('attack-mid-01-foothold');
  answerRight(s, 'why');
  assert.equal(current(s), 'find');
  // Searching Metasploit for the upload module advances the find step.
  await cmd(s, 'msfconsole', 2000);
  await cmd(s, 'search upload', 2000);
  assert.equal(current(s), 'shell', 'searching advanced the step');
  // Load the module, point it at the plans portal, and run for a shell.
  await cmd(s, 'use upload-webshell', 2000);
  await cmd(s, 'set RHOSTS 10.88.20.30', 2000);
  const run = await cmd(s, 'run', 30_000);
  assert.match(run, /session \d+ opened/i);
  assert.equal(current(s), 'inside', 'the shell advanced the step');
  answerRight(s, 'inside');
  assert.ok(snapshot(s).guide?.complete, 'floor 1 completes');
});

test('floor 2: pivoting scans the server network from the foothold', async () => {
  const s = floor('attack-mid-02-pivoting');
  answerRight(s, 'why');
  assert.equal(current(s), 'enter');
  // Step into the seeded foothold, then scan the internal servers through it.
  await cmd(s, 'sessions -i 1', 2000);
  assert.equal(current(s), 'scan', 'interacting with the session advanced the step');
  const scan = await cmd(s, 'nmap -Pn -p 8080 10.88.22.30 10.88.22.50', 60_000);
  assert.match(scan, /vending|8080/i);
  assert.equal(current(s), 'next', 'discovering the internal servers advanced the step');
  answerRight(s, 'next');
  assert.ok(snapshot(s).guide?.complete, 'floor 2 completes');
});

test('floor 3: internal exploitation lands root on the vending server', async () => {
  const s = floor('attack-mid-03-internal-exploitation');
  answerRight(s, 'soft');
  assert.equal(current(s), 'exploit');
  await cmd(s, 'msfconsole', 2000);
  await cmd(s, 'use exploit/multi/http/tomcat_mgr_upload', 2000);
  await cmd(s, 'set RHOSTS 10.88.22.30', 2000);
  const run = await cmd(s, 'run', 30_000);
  assert.match(run, /session \d+ opened/i);
  assert.equal(current(s), 'root', 'the shell on vending advanced the step');
  answerRight(s, 'root');
  assert.ok(snapshot(s).guide?.complete, 'floor 3 completes');
});

test('floor 4: credential access dumps and cracks the hashes', async () => {
  const s = floor('attack-mid-04-credential-access');
  assert.equal(current(s), 'enter');
  await cmd(s, 'sessions -i 1', 2000);
  assert.equal(current(s), 'dump', 'entering the server advanced the step');
  const dump = await cmd(s, 'hashdump', 10_000);
  assert.match(dump, /tomcat/i);
  assert.equal(current(s), 'reuse', 'dumping the hashes advanced the step');
  answerRight(s, 'reuse');
  assert.ok(snapshot(s).guide?.complete, 'floor 4 completes');
});

test('floor 5: the crown jewels — prove the data is reachable', async () => {
  const s = floor('attack-mid-05-crown-jewels');
  assert.equal(current(s), 'enter');
  await cmd(s, 'sessions -i 1', 2000);
  assert.equal(current(s), 'exfil', 'entering the server advanced the step');
  // The full transfer runs to many pages; the exfil step advances on the first.
  const dl = await cmd(s, 'download /opt/vending/data', 150_000);
  assert.match(dl, /Downloaded|MB/i);
  assert.equal(current(s), 'handle', 'taking the data advanced the step');
  answerRight(s, 'handle');
  assert.ok(snapshot(s).guide?.complete, 'floor 5 completes');
});

test('floor 6: the water plant — read the controller, touch nothing', async () => {
  const s = floor('attack-mid-06-water-plant');
  answerRight(s, 'careful');
  assert.equal(current(s), 'read');
  // Modbus read auto-pivots through the seeded vending foothold to the PLC.
  const mb = await cmd(s, 'modbus read 10.88.23.20', 20_000);
  assert.match(mb, /chlorine|setpoint|40001/i);
  assert.equal(current(s), 'finding', 'reading the controller advanced the step');
  answerRight(s, 'finding');
  assert.ok(snapshot(s).guide?.complete, 'floor 6 completes');
});

test('floor 7: lateral movement and the report', () => {
  const s = floor('attack-mid-07-report');
  answerRight(s, 'lateral');
  answerRight(s, 'sniff');
  answerRight(s, 'wireless');
  answerRight(s, 'report');
  assert.ok(snapshot(s).guide?.complete, 'floor 7 completes');
});

test('the water-plant floor is completed by a read alone', async () => {
  // The floor teaches read-only proof: the only command step is a `read`, and
  // the floor completes without ever writing to the controller.
  const s = floor('attack-mid-06-water-plant');
  const commandSteps = (s.practical as PracticalDef).guide!.steps.filter(
    (st: GuideStepDef) => st.done && 'command' in st.done,
  );
  for (const st of commandSteps) {
    const done = st.done as { command: { did: string } };
    assert.equal(done.command.did, 'read', `step ${st.id} is a read, not a write`);
  }
  answerRight(s, 'careful');
  await cmd(s, 'modbus read 10.88.23.20', 20_000);
  answerRight(s, 'finding');
  assert.ok(snapshot(s).guide?.complete, 'a read-only play completes the floor');
});
