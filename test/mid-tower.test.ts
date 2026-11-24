// The intermediate defend tower, at Siyakhula Local Municipality. Each floor
// adds a desk tool; these tests play each floor the way a learner would,
// including the wrong moves, and check it plays the same way every time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorld } from '../src/world/load.ts';
import { validateWorld } from '../src/world/validate.ts';
import { Session } from '../src/engine/session.ts';
import { snapshot } from '../src/engine/view.ts';

const bundle = loadWorld();

function floor(id: string, seed = 1): Session {
  const practical = bundle.practicals.find((p) => p.id === id);
  assert.ok(practical, `${id} exists`);
  const session = new Session(bundle, practical, { seed });
  session.begin(true);
  return session;
}

const current = (s: Session): string | undefined => snapshot(s).guide?.current?.id;
const answer = (s: Session, option: number): void => {
  const r = s.act({ type: 'answer', option });
  assert.ok(r.ok, r.message);
};
const tool = (s: Session, name: string, op: string, args: Record<string, unknown> = {}) => s.act({ type: 'tool', tool: name, op, args });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const view = (s: Session, name: string): any => (snapshot(s).tools as Record<string, unknown>)[name];

test('the intermediate tower is valid and its floors are in order', () => {
  assert.deepEqual(validateWorld(bundle), []);
  const tower = bundle.towers.find((t) => t.id === 'defend-intermediate')!;
  assert.deepEqual(tower.floors.map((f) => f.floor), [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const f of tower.floors.filter((x) => x.practical)) {
    assert.equal(bundle.practicals.find((p) => p.id === f.practical)?.org, 'siyakhula');
  }
});

// ------------------------------------------------------------------ floor 0

test('floor 0: crown jewels, binary, and the risk register', async () => {
  const s = floor('defend-mid-00-crown-jewels');
  s.act({ type: 'look', what: 'room', id: 'ict' });
  assert.equal(current(s), 'jewels');
  answer(s, 1);
  assert.equal(current(s), 'jewels', 'a wrong answer waits');
  answer(s, 0);
  answer(s, 2);
  assert.match(snapshot(s).guide?.feedback?.text ?? '', /72 000/);
  answer(s, 0);
  answer(s, 1);
  answer(s, 0);
  assert.equal(current(s), 'binary');
  answer(s, 0);
  assert.equal(current(s), 'register');
  s.act({ type: 'look', what: 'tab', id: 'risk' });
  assert.equal(current(s), 'score-vending');

  // Two risks come scored; the register shows them on the heat map.
  const before = view(s, 'risk');
  assert.equal(before.risks.filter((r: { score: number | null }) => r.score).length, 2);

  // Too low an impact for a crown jewel: the mentor says why, and the step waits.
  assert.ok(tool(s, 'risk', 'score', { risk: 'vending-takeover', likelihood: 4, impact: 2 }).ok);
  assert.equal(current(s), 'score-vending');
  assert.equal(snapshot(s).guide?.verdict?.correct, false);
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /biggest income/);
  assert.equal(tool(s, 'risk', 'score', { risk: 'vending-takeover', likelihood: 9, impact: 2 }).ok, false, 'scales go 1 to 5');
  assert.ok(tool(s, 'risk', 'score', { risk: 'vending-takeover', likelihood: 4, impact: 5 }).ok);
  assert.equal(current(s), 'score-two');
  assert.match(snapshot(s).guide?.last?.text ?? '', /4 x 5 = 20: a critical risk/);

  // Two targets: the first one right says so and waits for the second.
  tool(s, 'risk', 'score', { risk: 'plant-tampering', likelihood: 2, impact: 5 });
  assert.equal(current(s), 'score-two');
  assert.deepEqual(snapshot(s).guide?.current?.targets, { done: 1, total: 2 });
  assert.equal(snapshot(s).guide?.verdict?.correct, true);
  tool(s, 'risk', 'score', { risk: 'webmail-spray', likelihood: 1, impact: 3 });
  assert.equal(current(s), 'score-two', 'likelihood 1 for an internet-facing password-only login is too low');
  tool(s, 'risk', 'score', { risk: 'webmail-spray', likelihood: 4, impact: 3 });
  assert.equal(current(s), 'precedence');

  answer(s, 1);
  assert.match(snapshot(s).guide?.feedback?.text ?? '', /left to right/);
  answer(s, 0);
  assert.equal(current(s), 'incident');

  // Linking the incident to the wrong risk gets a reply; the right one raises its likelihood to 5.
  tool(s, 'risk', 'link', { incident: 'last-week', risk: 'eservices-dump' });
  assert.equal(current(s), 'incident');
  tool(s, 'risk', 'link', { incident: 'last-week', risk: 'webmail-spray' });
  assert.equal(current(s), 'owner');
  const webmail = view(s, 'risk').risks.find((r: { id: string }) => r.id === 'webmail-spray');
  assert.equal(webmail.likelihood, 5);
  assert.equal(webmail.score, 15);
  assert.deepEqual(webmail.incidents.length, 1);

  answer(s, 0);
  assert.equal(s.end?.reason, 'complete');
});

test('floor 0 is quiet: the municipality works around you and raises no alerts', async () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const s = floor('defend-mid-00-crown-jewels', seed);
    await s.run(20 * 60_000, 2000);
    assert.deepEqual(snapshot(s).alerts.map((a) => a.rule), [], `seed ${seed}`);
  }
});

// ------------------------------------------------------------------ floor 1

test('floor 1: scan, rank, fix and prove it with a rescan', async () => {
  const s = floor('defend-mid-01-patch-tuesday');
  assert.equal(current(s), 'run');
  assert.equal(view(s, 'scan').findings.length, 0, 'no report before the first scan');
  assert.ok(tool(s, 'scan', 'run').ok);
  assert.equal(tool(s, 'scan', 'run').ok, false, 'one scan at a time');
  assert.ok(view(s, 'scan').running, 'the scan is running');
  await s.run(16_000, 1000);
  assert.equal(current(s), 'cvss');
  const report = view(s, 'scan');
  assert.equal(report.findings.length, 8);
  assert.equal(report.findings[0].id, 'samba-usermap', 'ranked by CVSS, 10.0 first');
  assert.deepEqual(report.counts, { critical: 3, high: 0, medium: 4, low: 1 });

  answer(s, 1);
  answer(s, 0);
  answer(s, 0);
  answer(s, 1);
  assert.match(snapshot(s).guide?.feedback?.text ?? '', /weeks of work/);
  answer(s, 0);
  assert.equal(current(s), 'fix-vending');

  // The file server's retirement is a project: the switch refuses.
  const project = s.act({ type: 'control', control: 'retire-legacy-fs', on: true });
  assert.equal(project.ok, false);
  assert.match(project.message, /project, not a switch/);
  assert.equal(snapshot(s).controls.find((c) => c.id === 'retire-legacy-fs')?.project, true);

  s.act({ type: 'control', control: 'disable-listing', on: true });
  assert.equal(current(s), 'fix-vending', 'the wrong control gets a reply');
  s.act({ type: 'control', control: 'vendor-hardening', on: true });
  assert.equal(current(s), 'fix-gis');
  s.act({ type: 'control', control: 'patch-management', on: true });
  assert.equal(current(s), 'rescan');

  tool(s, 'scan', 'run');
  await s.run(16_000, 1000);
  assert.equal(current(s), 'meanwhile');
  const after = view(s, 'scan');
  const status = (id: string) => after.findings.find((f: { id: string }) => f.id === id);
  assert.equal(status('tomcat-default').status, 'fixed');
  assert.equal(status('tomcat-default').change, 'fixed');
  assert.equal(status('geoserver-rce').status, 'fixed');
  assert.equal(status('tenders-listing').status, 'fixed', 'the extra control was proved too');
  assert.equal(status('samba-usermap').status, 'open', 'the project stays red');

  answer(s, 0);
  answer(s, 0);
  assert.equal(s.end?.reason, 'complete');
});

test('floor 1: a rescan before any fix says nothing turned green', async () => {
  const s = floor('defend-mid-01-patch-tuesday', 2);
  tool(s, 'scan', 'run');
  await s.run(16_000, 1000);
  for (const option of [0, 0, 0]) answer(s, option);
  assert.equal(current(s), 'fix-vending');
  s.act({ type: 'control', control: 'vendor-hardening', on: true });
  s.act({ type: 'control', control: 'patch-management', on: true });
  assert.equal(current(s), 'rescan');
  s.act({ type: 'control', control: 'vendor-hardening', on: false });
  s.act({ type: 'control', control: 'patch-management', on: false });
  tool(s, 'scan', 'run');
  await s.run(16_000, 1000);
  assert.equal(current(s), 'rescan');
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /Nothing turned green/);
});

test('floor 1 is quiet while you work', async () => {
  for (const seed of [1, 2, 3]) {
    const s = floor('defend-mid-01-patch-tuesday', seed);
    tool(s, 'scan', 'run');
    await s.run(20 * 60_000, 2000);
    assert.deepEqual(snapshot(s).alerts.map((a) => a.rule), [], `seed ${seed}`);
  }
});

// ------------------------------------------------------------------ floor 2

test('floor 2: a slow scan slips past the sensor and into the honeypot', async () => {
  const s = floor('defend-mid-02-slow-scan');
  assert.equal(snapshot(s).guide?.time?.targetMs, 15 * 60_000, 'the clock starts on this floor');
  answer(s, 1);
  assert.equal(current(s), 'quiet', 'a wrong answer waits');
  answer(s, 0);
  answer(s, 1);
  assert.match(snapshot(s).guide?.feedback?.text ?? '', /Decimal hours/);
  answer(s, 0);
  assert.equal(current(s), 'deploy');

  // In the wrong place, or as the wrong thing: it goes up, and the mentor says why.
  assert.ok(tool(s, 'honeypot', 'deploy', { spot: 'dmz', persona: 'printer' }).ok);
  assert.equal(current(s), 'deploy');
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /server networks.*printer/s);
  assert.ok(s.world.byIp.get('10.88.20.40'), 'the decoy stands in the DMZ');
  assert.ok(tool(s, 'honeypot', 'deploy', { spot: 'servers', persona: 'hr-archive' }).ok);
  assert.equal(s.world.byIp.get('10.88.20.40'), undefined, 'moving it takes it out of the DMZ');
  assert.equal(s.world.byIp.get('10.88.22.13')?.kind, 'decoy');
  const decoy = snapshot(s).org.departments.find((d) => d.id === 'corporate-services')?.hosts.find((h) => h.key === 'siyakhula/honeypot');
  assert.ok(decoy, 'the honeypot shows on the floor');
  assert.equal(current(s), 'when');
  answer(s, 0);
  assert.equal(current(s), 'bite');

  // Six lab minutes of probes, one every 15 seconds: the sensor never fires, the honeypot does.
  await s.run(7 * 60_000, 1000);
  const rules = snapshot(s).alerts.map((a) => a.rule);
  assert.deepEqual(rules, ['decoy-touched'], 'only the honeypot sees it');
  const alert = snapshot(s).alerts[0]!;
  assert.equal(alert.src, '10.88.21.60');
  assert.ok(view(s, 'honeypot').total >= 1);
  s.act({ type: 'look', what: 'alert', id: String(alert.id) });
  assert.equal(current(s), 'who');
  s.act({ type: 'look', what: 'host', id: 'siyakhula/library-pcs' });
  assert.equal(current(s), 'isolate');
  s.act({ type: 'isolate', host: 'siyakhula/library-pcs' });
  assert.equal(current(s), 'close');

  // Isolated, the scanner goes quiet: nothing new reaches the honeypot.
  const touches = view(s, 'honeypot').total;
  await s.run(5 * 60_000, 1000);
  assert.equal(view(s, 'honeypot').total, touches);

  s.act({ type: 'classify', alert: alert.id, verdict: 'true-positive' });
  assert.equal(current(s), 'fix');
  s.act({ type: 'control', control: 'guest-network', on: true });
  assert.equal(current(s), 'trust');
  answer(s, 0);
  assert.equal(s.end?.reason, 'complete');
});

// ------------------------------------------------------------------ floor 3

test('floor 3: a UPS plan for load shedding, then a server on the bench', async () => {
  const s = floor('defend-mid-03-load-shedding');
  assert.equal(view(s, 'power').watts, 2400);
  assert.equal(view(s, 'power').minutes, 90);
  answer(s, 1);
  assert.match(snapshot(s).guide?.feedback?.text ?? '', /inverter lost nothing/);
  answer(s, 0);
  assert.equal(current(s), 'plan');

  const jewels = ['dc01', 'billing', 'vending', 'payroll', 'mail', 'eservices', 'vend-gw'];
  // Shedding a crown jewel, or too little, gets the reason and the step waits.
  assert.ok(tool(s, 'power', 'plan', { keep: jewels.filter((j) => j !== 'billing') }).ok);
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /Municipal billing system is a crown jewel|is a crown jewel/);
  assert.equal(current(s), 'plan');
  tool(s, 'power', 'plan', { keep: [...jewels, 'dwh', 'soc'] });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /runs the battery flat/);
  assert.equal(current(s), 'plan');
  tool(s, 'power', 'plan', { keep: [...jewels, 'ids'] });
  assert.equal(view(s, 'power').minutes, 156);
  assert.equal(current(s), 'startup');
  answer(s, 0);

  // The backup server is down, and re-imaging it does nothing.
  const backup = s.world.resolveSystem('siyakhula', 'backup')!;
  assert.equal(backup.status, 'down');
  const rebuild = s.act({ type: 'rebuild', host: backup.key });
  assert.equal(rebuild.ok, false);
  assert.match(rebuild.message, /hardware fault/);
  assert.equal(current(s), 'safety');

  assert.equal(tool(s, 'bench', 'test', { part: 'psu' }).ok, false, 'the case is shut');
  tool(s, 'bench', 'prepare', { step: 'open' });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /plugged in/);
  tool(s, 'bench', 'prepare', { step: 'strap' });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /unplug first/);
  for (const step of ['unplug', 'strap', 'open']) tool(s, 'bench', 'prepare', { step });
  assert.equal(current(s), 'theory');
  answer(s, 0);

  tool(s, 'bench', 'test', { part: 'psu' });
  assert.equal(current(s), 'test', 'a healthy part reads fine and the step waits');
  tool(s, 'bench', 'test', { part: 'cmos-battery' });
  assert.equal(current(s), 'replace');
  tool(s, 'bench', 'replace', { part: 'ram' });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /costs money/);
  tool(s, 'bench', 'replace', { part: 'cmos-battery' });
  assert.equal(current(s), 'bios');
  tool(s, 'bench', 'bios', { clock: false, boot: 'network' });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /RAID volume.*year 2000/s);
  tool(s, 'bench', 'bios', { clock: true, boot: 'raid' });
  assert.equal(current(s), 'clock');
  answer(s, 0);
  tool(s, 'bench', 'boot');
  assert.equal(backup.status, 'up');
  assert.equal(current(s), 'maintain');
  answer(s, 0);
  assert.equal(s.end?.reason, 'complete');
});

// ------------------------------------------------------------------ floor 4

test('floor 4: six helpdesk tickets, each with a catch', () => {
  const s = floor('defend-mid-04-helpdesk-monday');
  answer(s, 0);
  answer(s, 1);
  assert.equal(current(s), 'queue');
  assert.equal(view(s, 'tickets').open, 6);

  // The wrong handling gets the reason and the ticket stays open.
  tool(s, 'tickets', 'resolve', { ticket: 'lost-phone', option: 'gmail' });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /identity theft/);
  assert.equal(view(s, 'tickets').open, 6);
  const right: Record<string, string> = { 'lost-phone': 'verify', 'usb-stick': 'hand-in', keylogger: 'evidence', 'printer-driver': 'signed', 'linkedin-badge': 'kind', 'windows-10': 'schedule' };
  for (const [ticket, option] of Object.entries(right)) {
    assert.ok(tool(s, 'tickets', 'resolve', { ticket, option }).ok);
  }
  assert.equal(view(s, 'tickets').open, 0);
  assert.equal(view(s, 'tickets').tickets[0].tries, 2);
  assert.equal(tool(s, 'tickets', 'resolve', { ticket: 'usb-stick', option: 'hand-in' }).ok, false, 'closed is closed');
  assert.equal(current(s), 'annoyed');
  answer(s, 0);
  answer(s, 0);
  assert.equal(s.end?.reason, 'complete');
});

// ------------------------------------------------------------------ floor 5

test('floor 5: find the evil twin on the map, then end what it stole', async () => {
  const s = floor('defend-mid-05-evil-twin');
  assert.equal(current(s), 'survey');

  // One reading is not a survey; four are.
  tool(s, 'wifi', 'survey', { x: 18, y: 10 });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /Three more/);
  const reception = view(s, 'wifi').readings[0];
  assert.equal(reception.room, 'Community Services');
  assert.equal(reception.heard[0].bssid, '50:c7:bf:3a:91:0e', 'the twin is the loudest at reception');
  assert.equal(reception.heard[0].signal, -54);
  assert.equal(tool(s, 'wifi', 'survey', { x: 99, y: 10 }).ok, false, 'off the floor');
  tool(s, 'wifi', 'survey', { x: 6, y: 16 });
  tool(s, 'wifi', 'survey', { x: 30, y: 16 });
  assert.equal(current(s), 'survey');
  tool(s, 'wifi', 'survey', { x: 30, y: 6 });
  assert.equal(current(s), 'twin');
  answer(s, 1);
  answer(s, 0);
  assert.equal(current(s), 'find');

  // Seizing needs a mark first; a mark far off says how far.
  assert.equal(tool(s, 'wifi', 'seize').ok, false);
  tool(s, 'wifi', 'locate', { x: 24, y: 18 });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /about 15 m/);
  assert.equal(view(s, 'wifi').located, null, 'the twin stays hidden until found');
  tool(s, 'wifi', 'survey', { x: 16, y: 7 });
  tool(s, 'wifi', 'locate', { x: 16, y: 7 });
  assert.equal(current(s), 'distance');
  assert.match(snapshot(s).guide?.last?.text ?? '', /√\(1² \+ 1²\) = 1.4 m/);
  answer(s, 1);
  answer(s, 0);
  assert.equal(current(s), 'seize');
  tool(s, 'wifi', 'seize');
  assert.equal(view(s, 'wifi').seized.clients.length, 3);
  tool(s, 'wifi', 'survey', { x: 15, y: 6 });
  assert.ok(!view(s, 'wifi').readings.at(-1).heard.some((n: { bssid: string }) => n.bssid === '50:c7:bf:3a:91:0e'), 'gone once unplugged');
  answer(s, 0);
  assert.equal(current(s), 'reset');

  // Ending a stolen session before the password is new: they sign straight back in.
  assert.equal(view(s, 'sessions').active, 5);
  tool(s, 'sessions', 'revoke', { session: 'a3f9c2e17b40' });
  await s.run(70_000, 1000);
  const back = view(s, 'sessions').sessions.find((x: { user: string; uses: { ip: string }[]; ended: string | null }) => x.user === 'johan' && !x.ended && x.uses[0]!.ip === '10.88.0.143');
  assert.ok(back, 'a new session from the thief');

  for (const user of ['johan', 'mpho', 'kagiso']) s.act({ type: 'reset', host: 'siyakhula/mail', user });
  assert.equal(current(s), 'revoke');
  // Johan's own desk session is not the stolen one.
  tool(s, 'sessions', 'revoke', { session: '4d2e8f6a0b91' });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /only used from/);
  tool(s, 'sessions', 'revoke', { session: back.id });
  tool(s, 'sessions', 'revoke', { session: '5e81d0c4a9f2' });
  tool(s, 'sessions', 'revoke', { session: 'c07b3e9d1a65' });
  assert.equal(current(s), 'mfa');
  s.act({ type: 'control', control: 'mfa-remote', on: true });
  answer(s, 1);
  answer(s, 0);
  assert.equal(s.end?.reason, 'complete');
});

// ------------------------------------------------------------------ floor 6

test('floor 6: a DDoS on prepaid vending, a rate limit, and a notice', async () => {
  const s = floor('defend-mid-06-no-electricity');
  const gw = () => s.world.hosts.get('siyakhula/vend-gw')!.status;
  assert.equal(view(s, 'traffic').status, 'full');
  assert.equal(gw(), 'down', 'sales stop while the line is full');
  assert.ok(view(s, 'traffic').series.length > 30, 'the graph starts with the minutes before');
  await s.run(12_000, 1000);
  assert.ok(s.business.state.get('siyakhula')!.health < 100, 'the business feels it');
  s.act({ type: 'look', what: 'tab', id: 'traffic' });
  answer(s, 2);
  answer(s, 0);
  assert.equal(current(s), 'scrub');

  // A limit before the line is clear does nothing.
  tool(s, 'traffic', 'limit', { rate: 30 });
  assert.equal(view(s, 'traffic').status, 'full');
  assert.equal(gw(), 'down');
  tool(s, 'traffic', 'limit', { rate: 1000 });
  s.act({ type: 'control', control: 'ddos-protection', on: true });
  assert.equal(view(s, 'traffic').status, 'over', 'the request flood still outruns it');
  assert.equal(gw(), 'down');
  answer(s, 0);
  assert.equal(current(s), 'limit');

  // Too low cuts the banks; too high still overloads; 25 to 52 works.
  tool(s, 'traffic', 'limit', { rate: 10 });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /vending aggregator sends 25 a second/);
  tool(s, 'traffic', 'limit', { rate: 60 });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /40 × 60 \+ 400 = 2 800 a second, and it answers 2 500/);
  assert.equal(current(s), 'limit');
  tool(s, 'traffic', 'limit', { rate: 50 });
  assert.equal(view(s, 'traffic').status, 'ok');
  assert.equal(gw(), 'up');
  assert.equal(current(s), 'sneak');
  assert.ok(view(s, 'traffic').paths.some((p: { path: string; status: number }) => p.path === '/admin/login' && p.status === 401));
  s.act({ type: 'block', src: '10.88.0.77' });
  assert.equal(view(s, 'traffic').paths.find((p: { path: string }) => p.path === '/admin/login').rate, 0);
  answer(s, 0);
  answer(s, 0);
  assert.equal(current(s), 'notice');

  // Every part must be right; the first wrong one says why.
  const right = ['headline:plain', 'what:plain', 'now:plain', 'scam:plain', 'sorry:plain'];
  assert.equal(tool(s, 'compose', 'publish', { choices: ['headline:plain'] }).ok, false, 'every part needs a line');
  tool(s, 'compose', 'publish', { choices: [...right.filter((c) => !c.startsWith('what')), 'what:guess'] });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /^What happened: Nothing shows that/);
  tool(s, 'compose', 'publish', { choices: right });
  assert.equal(s.end?.reason, 'complete');
  await s.run(30_000, 1000);
  assert.equal(gw(), 'up', 'and it stays up');
});

// ------------------------------------------------------------------ floor 7

test('floor 7: ransomware, by the disaster recovery plan', async () => {
  const s = floor('defend-mid-07-ransomware');
  const encrypted = () => view(s, 'recovery').spread.encrypted;
  const before = encrypted();
  await s.run(30_000, 1000);
  assert.ok(encrypted() > before, 'still encrypting until it is cut off');
  s.act({ type: 'isolate', host: 'siyakhula/fs01' });
  const stopped = encrypted();
  await s.run(30_000, 1000);
  assert.equal(encrypted(), stopped, 'cut off, it stops');
  assert.ok(view(s, 'recovery').plan[0].done, 'the plan ticks itself off');
  answer(s, 1);
  answer(s, 0);
  assert.equal(current(s), 'evidence');

  // Not evidence gets the reason; sealing early says how many are missing.
  tool(s, 'evidence', 'bag', { item: 'whatsapp' });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /Gossip/);
  for (const item of ['note', 'sample', 'image', 'samba', 'phish', 'exfil']) tool(s, 'evidence', 'bag', { item });
  tool(s, 'evidence', 'seal');
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /one more thing/);
  tool(s, 'evidence', 'bag', { item: 'backup-log' });
  assert.match(view(s, 'evidence').items[0].bagged.hash, /^[0-9a-f]{64}$/);
  tool(s, 'evidence', 'seal');
  assert.equal(current(s), 'way-in');
  s.act({ type: 'isolate', host: 'siyakhula/hr-pc' });
  answer(s, 0);
  assert.equal(current(s), 'restore');

  // The online copy is encrypted; the infected server is no place to restore to.
  tool(s, 'recovery', 'restore', { set: 'nightly', to: 'fs02' });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /svc_backup/);
  tool(s, 'recovery', 'restore', { set: 'offline', to: 'fs01' });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /attacker's door/);
  tool(s, 'recovery', 'restore', { set: 'offline', to: 'fs02' });
  assert.equal(current(s), 'how-long');
  answer(s, 0);
  answer(s, 1);
  answer(s, 0);
  assert.equal(current(s), 'restored');
  await s.run(260_000, 2000);
  assert.equal(current(s), 'register');
  assert.ok(view(s, 'recovery').restored);
  tool(s, 'risk', 'link', { incident: 'ransomware', risk: 'fileserver-exploit' });
  assert.equal(current(s), 'report');
  tool(s, 'compose', 'publish', { choices: ['summary:blame', 'cause:plain', 'impact:plain', 'done:plain', 'lessons:plain'] });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /^Summary: Blaming one person/);
  tool(s, 'compose', 'publish', { choices: ['summary:plain', 'cause:plain', 'impact:plain', 'done:plain', 'lessons:plain'] });
  assert.equal(s.end?.reason, 'complete');
  assert.ok(view(s, 'recovery').plan.every((p: { done: string | null }) => p.done), 'every step of the plan done');
});

test('floor 7: wiping the server before imaging it loses the evidence', () => {
  const s = floor('defend-mid-07-ransomware');
  s.act({ type: 'rebuild', host: 'siyakhula/fs01' });
  assert.equal(tool(s, 'evidence', 'bag', { item: 'image' }).ok, false);
  assert.ok(view(s, 'evidence').items.find((i: { id: string }) => i.id === 'image').lost);
});
