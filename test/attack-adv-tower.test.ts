// The advanced attack tower: DataQuant red-teams Ikhaya Stores — a retailer with
// a cloud shop, 120 stores on a flat VPN, and a corporate domain. These tests
// play each hands-on floor through the Kali terminal (credential stuffing, API
// IDOR, a public bucket, an exposed camera recorder, a flat-VPN pivot) and check
// the conceptual floors (the domain, the report) complete on their questions.

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

function answerRight(s: Session, id: string): void {
  const practical = s.practical as PracticalDef;
  const step = practical.guide!.steps.find((st: GuideStepDef) => st.id === current(s));
  assert.ok(step?.ask, `step ${id} has a question`);
  const option = step.ask.options.findIndex((o) => o.correct === true);
  assert.ok(option >= 0, `step ${id} has a correct answer`);
  const r = s.act({ type: 'answer', option });
  assert.ok(r.ok, r.message);
}

async function cmd(s: Session, line: string, ms = 60_000): Promise<string> {
  const pending = s.command(line);
  await s.run(ms);
  return pending;
}

// The cloud exfil goes out in pages over simulated minutes; a big window lets the
// whole command resolve so no promise is left dangling.
const EXFIL_MS = 460_000;

test('the advanced attack tower is valid and tests Ikhaya', () => {
  assert.deepEqual(validateWorld(bundle), []);
  const tower = bundle.towers.find((t) => t.id === 'attack-advanced')!;
  assert.equal(tower.floors.filter((x) => x.practical).length, 8, 'eight floors are registered');
  for (const f of tower.floors.filter((x) => x.practical)) {
    const p = bundle.practicals.find((x) => x.id === f.practical)!;
    assert.ok(p, `${f.practical} exists`);
    assert.equal(p.org, 'ikhaya', `${f.practical} tests Ikhaya`);
    assert.equal(p.role, 'predator', `${f.practical} is an attack floor`);
  }
});

test('floor 0: the engagement at scale', async () => {
  const s = floor('attack-adv-00-engagement');
  answerRight(s, 'surface');
  answerRight(s, 'cloud');
  assert.equal(current(s), 'scope');
  const out = await cmd(s, 'cat scope-letter.pdf', 1000);
  assert.match(out, /AUTHORISATION/i);
  assert.equal(current(s), 'data', 'reading the scope letter advanced the step');
  answerRight(s, 'data');
  assert.ok(snapshot(s).guide?.complete, 'floor 0 completes');
});

test('floor 1: credential stuffing the shop', async () => {
  const s = floor('attack-adv-01-credential-stuffing');
  answerRight(s, 'why');
  assert.equal(current(s), 'stuff');
  const out = await cmd(s, 'hydra -l lerato -P rockyou.txt https://10.88.30.10', 30_000);
  assert.match(out, /login: lerato\s+password:/);
  assert.equal(current(s), 'fix', 'cracking the account advanced the step');
  answerRight(s, 'fix');
  assert.ok(snapshot(s).guide?.complete, 'floor 1 completes');
});

test('floor 2: the orders API (IDOR)', async () => {
  const s = floor('attack-adv-02-api-idor');
  answerRight(s, 'what');
  assert.equal(current(s), 'look');
  const listing = await cmd(s, 'curl https://10.88.30.11/api/orders/', 5000);
  assert.match(listing, /Index of|orders/i);
  assert.equal(current(s), 'scrape', 'querying the API advanced the step');
  await cmd(s, 'curl -O https://10.88.30.11/api/orders/', EXFIL_MS);
  assert.equal(current(s), 'impact', 'scraping the orders advanced the step');
  answerRight(s, 'impact');
  assert.ok(snapshot(s).guide?.complete, 'floor 2 completes');
});

test('floor 3: the public cloud bucket', async () => {
  const s = floor('attack-adv-03-public-bucket');
  answerRight(s, 'why');
  assert.equal(current(s), 'list');
  const listing = await cmd(s, 'curl https://10.88.30.20/exports/', 5000);
  assert.match(listing, /Index of|loyalty/i);
  assert.equal(current(s), 'download', 'listing the bucket advanced the step');
  await cmd(s, 'curl -O https://10.88.30.20/exports/loyalty-2026-10.csv', EXFIL_MS);
  assert.equal(current(s), 'fix', 'downloading the export advanced the step');
  answerRight(s, 'fix');
  assert.ok(snapshot(s).guide?.complete, 'floor 3 completes');
});

test('floor 4: into a store via the camera recorder', async () => {
  const s = floor('attack-adv-04-store-foothold');
  answerRight(s, 'exposed');
  assert.equal(current(s), 'exploit');
  await cmd(s, 'msfconsole', 2000);
  await cmd(s, 'use exploit/linux/http/nvr_web_rce', 2000);
  await cmd(s, 'set RHOSTS 10.88.33.47', 2000);
  const run = await cmd(s, 'run', 30_000);
  assert.match(run, /session \d+ opened/i);
  assert.equal(current(s), 'inside', 'the shell on the recorder advanced the step');
  answerRight(s, 'inside');
  assert.ok(snapshot(s).guide?.complete, 'floor 4 completes');
});

test('floor 5: pivot the flat VPN to head office', async () => {
  const s = floor('attack-adv-05-flat-vpn');
  answerRight(s, 'flat');
  assert.equal(current(s), 'enter');
  await cmd(s, 'sessions -i 1', 2000);
  assert.equal(current(s), 'scan', 'entering the foothold advanced the step');
  const scan = await cmd(s, 'nmap -Pn -p 445,1433,5432,88 10.88.32.10 10.88.32.25 10.88.32.20', 60_000);
  assert.match(scan, /dc01|kerberos/i);
  assert.equal(current(s), 'next', 'discovering head office advanced the step');
  answerRight(s, 'next');
  assert.ok(snapshot(s).guide?.complete, 'floor 5 completes');
});

test('floor 6: the domain (conceptual)', () => {
  const s = floor('attack-adv-06-the-domain');
  answerRight(s, 'kerberoast');
  answerRight(s, 'domainadmin');
  answerRight(s, 'blast');
  answerRight(s, 'fix');
  assert.ok(snapshot(s).guide?.complete, 'floor 6 completes');
});

test('floor 7: the report to the board', () => {
  const s = floor('attack-adv-07-report');
  answerRight(s, 'rank');
  answerRight(s, 'language');
  answerRight(s, 'disclosure');
  answerRight(s, 'retest');
  assert.ok(snapshot(s).guide?.complete, 'floor 7 completes');
});

test('the store foothold is reachable from the internet, before any pivot', async () => {
  // Floor 4 has no seeded foothold: the camera recorder must be exploitable
  // straight from the Kali exit, which is the whole point of the floor.
  const s = floor('attack-adv-04-store-foothold');
  const p = s.practical as PracticalDef;
  assert.equal(p.foothold, undefined, 'floor 4 starts with no foothold');
  answerRight(s, 'exposed');
  await cmd(s, 'msfconsole', 2000);
  await cmd(s, 'use exploit/linux/http/nvr_web_rce', 2000);
  await cmd(s, 'set RHOSTS 10.88.33.47', 2000);
  const run = await cmd(s, 'run', 30_000);
  assert.match(run, /session \d+ opened/i, 'the recorder falls from the internet');
});
