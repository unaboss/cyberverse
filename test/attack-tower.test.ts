// The intro attack tower: DataQuant's offensive team runs an authorised
// external test of Siyakhula. These tests play each floor the way a learner
// would, driving the Kali terminal, and check the guide advances on what the
// commands actually achieve.

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

test('the intro attack tower is valid and tests Siyakhula', () => {
  assert.deepEqual(validateWorld(bundle), []);
  const tower = bundle.towers.find((t) => t.id === 'attack')!;
  for (const f of tower.floors.filter((x) => x.practical)) {
    const p = bundle.practicals.find((x) => x.id === f.practical)!;
    assert.equal(p.org, 'siyakhula', `${f.practical} tests Siyakhula`);
  }
});

test('floor 0: the rules of engagement', async () => {
  const s = floor('attack-00-rules');
  assert.equal(current(s), 'what');
  answerRight(s, 'what');
  assert.equal(current(s), 'scope');
  // Reading the scope letter is what advances the step.
  const out = await cmd(s, 'cat scope-letter.pdf', 1000);
  assert.match(out, /AUTHORISATION/i);
  assert.equal(current(s), 'out');
  answerRight(s, 'out');
  answerRight(s, 'safety');
  answerRight(s, 'notes');
  assert.ok(snapshot(s).guide?.complete, 'floor 0 completes');
});

test('floor 1: footprinting the DMZ', async () => {
  const s = floor('attack-01-footprinting');
  assert.equal(current(s), 'first');
  answerRight(s, 'first');
  assert.equal(current(s), 'sweep');
  // A ping sweep finds live hosts in the DMZ.
  const sweep = await cmd(s, 'nmap -sn 10.88.20.0/24', 30_000);
  assert.match(sweep, /eservices/);
  assert.equal(current(s), 'ports', 'the sweep advanced the step');
  // A port scan of the portal.
  await cmd(s, 'nmap 10.88.20.20', 60_000);
  assert.equal(current(s), 'read', 'the port scan advanced the step');
  answerRight(s, 'read');
  assert.ok(snapshot(s).guide?.complete, 'floor 1 completes');
});

test('floor 2: fingerprinting and a quiet scan', async () => {
  const s = floor('attack-02-fingerprinting');
  answerRight(s, 'why');
  const sv = await cmd(s, 'nmap -sV 10.88.20.20', 60_000);
  assert.match(sv, /Apache httpd 2\.4\.29/);
  assert.equal(current(s), 'noise', 'version scan advanced the step');
  answerRight(s, 'noise');
  // A slow, targeted scan of the tenders portal.
  await cmd(s, 'nmap -sV -T2 -F 10.88.20.21', 60_000);
  assert.equal(current(s), 'found', 'the quiet scan advanced the step');
  answerRight(s, 'found');
  assert.ok(snapshot(s).guide?.complete, 'floor 2 completes');
});

test('floor 3: enumeration finds the open folder and a known exploit', async () => {
  const s = floor('attack-03-enumeration');
  answerRight(s, 'what');
  const listing = await cmd(s, 'curl https://10.88.20.21/uploads/', 2000);
  assert.match(listing, /uploads|bid/i);
  assert.equal(current(s), 'listing', 'browsing the folder advanced the step');
  answerRight(s, 'listing');
  await cmd(s, 'searchsploit apache', 2000);
  assert.equal(current(s), 'next', 'searchsploit advanced the step');
  answerRight(s, 'next');
  assert.ok(snapshot(s).guide?.complete, 'floor 3 completes');
});

test('floor 4: hydra cracks the webmail login', async () => {
  const s = floor('attack-04-passwords');
  answerRight(s, 'online');
  const out = await cmd(s, 'hydra -l kagiso -P rockyou.txt https://10.88.20.25', 20_000);
  assert.match(out, /login: kagiso\s+password:/);
  assert.equal(current(s), 'why', 'cracking the login advanced the step');
  answerRight(s, 'why');
  answerRight(s, 'offline');
  assert.ok(snapshot(s).guide?.complete, 'floor 4 completes');
});

test('floor 5: sqlmap reads the database and proves impact', async () => {
  const s = floor('attack-05-exploitation');
  answerRight(s, 'what');
  // The dump emits the first data.transfer early; that advances the step.
  await cmd(s, 'sqlmap -u "https://10.88.20.20/account.php?id=1" --batch --dump', 400_000);
  assert.equal(current(s), 'impact', 'reading the database advanced the step');
  answerRight(s, 'impact');
  answerRight(s, 'report');
  answerRight(s, 'disclose');
  assert.ok(snapshot(s).guide?.complete, 'floor 5 completes');
});

test('a guided attack step only advances on the right milestone', async () => {
  const s = floor('attack-01-footprinting');
  answerRight(s, 'first');
  assert.equal(current(s), 'sweep');
  // An out-of-scope scan is recorded but must not finish the sweep step
  // (it does discover a host, so the sweep step — which accepts any host — is
  // satisfied; instead check the ports step needs the portal specifically).
  await cmd(s, 'nmap -sn 10.88.20.0/24', 30_000);
  assert.equal(current(s), 'ports');
  // Scanning a different DMZ host does not satisfy "scan the e-services portal".
  await cmd(s, 'nmap 10.88.20.21', 60_000);
  assert.equal(current(s), 'ports', 'scanning the wrong host leaves the step');
  await cmd(s, 'nmap 10.88.20.20', 60_000);
  assert.equal(current(s), 'read', 'scanning the portal advances it');
});
