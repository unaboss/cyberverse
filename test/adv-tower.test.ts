// The advanced defend tower, at Ikhaya Stores. Each floor adds a desk tool;
// these tests play each floor the way a learner would, including the wrong
// moves, and check it plays the same way every time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorld } from '../src/world/load.ts';
import { validateWorld } from '../src/world/validate.ts';
import { Session } from '../src/engine/session.ts';
import { snapshot } from '../src/engine/view.ts';
import { query } from '../src/engine/tools/sql-engine.ts';
import { DATASETS } from '../src/engine/tools/datasets.ts';

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
const sql = (s: Session, text: string) => tool(s, 'sql', 'query', { sql: text });

test('the advanced tower is valid and plays at Ikhaya Stores', () => {
  assert.deepEqual(validateWorld(bundle), []);
  const tower = bundle.towers.find((t) => t.id === 'defend-advanced')!;
  for (const f of tower.floors.filter((x) => x.practical)) {
    assert.equal(bundle.practicals.find((p) => p.id === f.practical)?.org, 'ikhaya');
  }
  assert.deepEqual(
    tower.floors.map((f) => f.floor),
    tower.floors.map((_, i) => i),
  );
});

// --------------------------------------------------------------- SQL engine

test('the SQL engine answers the questions an analyst asks', () => {
  const t = { name: 'logs', columns: ['ip', 'user', 'ok', 'bytes'], rows: [
    { ip: 'a', user: 'x', ok: 'fail', bytes: 10 },
    { ip: 'a', user: 'y', ok: 'fail', bytes: 20 },
    { ip: 'b', user: 'x', ok: 'ok', bytes: 5 },
    { ip: 'c', user: 'z', ok: 'fail', bytes: null },
  ] };
  const q = (s: string) => query(s, [t]);
  assert.deepEqual(q('SELECT COUNT(*) FROM logs').rows, [[4]]);
  assert.deepEqual(q("SELECT ip, COUNT(*) AS n FROM logs WHERE ok = 'fail' GROUP BY ip ORDER BY n DESC, ip").rows, [['a', 2], ['c', 1]]);
  assert.deepEqual(q('SELECT COUNT(DISTINCT user), SUM(bytes), MAX(bytes) FROM logs').rows, [[3, 35, 20]]);
  assert.deepEqual(q("SELECT user FROM logs WHERE ip IN ('a', 'c') AND user LIKE '%z%'").rows, [['z']]);
  assert.deepEqual(q('SELECT ip FROM logs WHERE bytes IS NULL').rows, [['c']]);
  assert.deepEqual(q('SELECT DISTINCT ip FROM logs ORDER BY ip DESC LIMIT 2').rows, [['c'], ['b']]);
  assert.deepEqual(q('SELECT ip, COUNT(*) FROM logs GROUP BY ip HAVING COUNT(*) > 1').rows, [['a', 2]]);
  assert.deepEqual(q('SELECT bytes * 2 AS twice FROM logs WHERE bytes BETWEEN 6 AND 20 ORDER BY 1').rows, [[20], [40]]);
  assert.equal(q('SELECT * FROM logs LIMIT 1 OFFSET 2').rows[0]![0], 'b');
  // Mistakes get a reason a learner can act on.
  assert.throws(() => q('SELECT ip, COUNT(*) FROM logs'), /GROUP BY ip/);
  assert.throws(() => q('SELECT usr FROM logs'), /no column "usr".*Did you mean user/);
  assert.throws(() => q("DELETE FROM logs WHERE ip = 'a'"), /read-only/);
  assert.throws(() => q("SELECT * FROM logs WHERE ok = 'fail"), /never closed/);
  assert.throws(() => q('SELECT * FROM logs WHERE COUNT(*) > 1'), /HAVING/);
  assert.throws(() => q('SELECT * FROM signins'), /no table "signins"/);
  assert.throws(() => q('SELECT ip FROM logs ORDER BY ip LIMIT 2 WHERE ip = 1'), /wrong place/);
});

test('the sign-in log holds one credential-stuffing run, the same every time', () => {
  const a = DATASETS.signins!.make(4207);
  const b = DATASETS.signins!.make(4207);
  assert.equal(a.table.rows.length, 122_000);
  assert.deepEqual(a.sets.taken, b.sets.taken);
  assert.equal(a.sets.taken!.length, 63);
  const bot = query("SELECT COUNT(*), COUNT(DISTINCT username), COUNT(DISTINCT ip) FROM signins WHERE user_agent LIKE '%Chrome/108%'", [a.table]);
  assert.deepEqual(bot.rows, [[70_000, 70_000, 180]]);
  for (const row of a.table.rows) {
    assert.match(String(row.ip), /^10\.88\.0\.\d+$/, 'lab internet addresses only');
    assert.match(String(row.username), /@[a-z]+\.example$/, 'reserved domains only');
  }
});

// ------------------------------------------------------------------ floor 0

test('floor 0: find the stuffing run with SQL and reset exactly the 63', () => {
  const s = floor('defend-adv-00-sign-ins');
  s.act({ type: 'look', what: 'tab', id: 'sql' });
  assert.equal(current(s), 'count');
  assert.equal(view(s, 'sql').tables[0].rows, 122_000);

  // A typo gets a reason, not a step.
  sql(s, 'SELECT COUNT(*) FORM signins');
  assert.match(view(s, 'sql').last.error, /FROM/);
  assert.equal(current(s), 'count');
  sql(s, 'select count(*) from signins');
  assert.equal(current(s), 'size');
  answer(s, 0);
  sql(s, 'SELECT hour, COUNT(*) AS n FROM signins GROUP BY hour ORDER BY hour');
  assert.equal(current(s), 'when');
  answer(s, 0);

  // Counting every sign-in per address puts a shared mobile address on top: not the bot.
  sql(s, 'SELECT ip, COUNT(*) FROM signins GROUP BY ip ORDER BY COUNT(*) DESC LIMIT 10');
  assert.equal(current(s), 'by-ip');
  sql(s, "SELECT ip, COUNT(*) FROM signins WHERE result = 'fail' GROUP BY ip ORDER BY COUNT(*) DESC LIMIT 10");
  assert.equal(current(s), 'block');
  answer(s, 1);
  assert.equal(current(s), 'block');
  answer(s, 0);
  sql(s, "SELECT user_agent, COUNT(*) FROM signins WHERE result = 'fail' GROUP BY user_agent ORDER BY 2 DESC");
  assert.equal(current(s), 'distinct');
  sql(s, "SELECT COUNT(*) FROM signins WHERE user_agent LIKE '%Chrome/108%'");
  assert.equal(current(s), 'distinct', 'the count alone does not show one try per account');
  sql(s, "SELECT COUNT(*), COUNT(DISTINCT username) FROM signins WHERE user_agent LIKE '%Chrome/108%'");
  assert.equal(current(s), 'what');
  answer(s, 0);

  // Every username the bot tried is too many: resetting them locks out 69 937 innocent customers.
  sql(s, "SELECT DISTINCT username FROM signins WHERE user_agent LIKE '%Chrome/108%'");
  assert.equal(current(s), 'taken');
  assert.equal(view(s, 'sql').last.count, 70_000);
  assert.equal(view(s, 'sql').last.rows.length, 100, 'the window shows the first 100');
  sql(s, "SELECT DISTINCT username FROM signins WHERE user_agent LIKE '%Chrome/108%' AND result = 'ok'");
  assert.equal(current(s), 'reset');
  sql(s, "SELECT DISTINCT username FROM signins WHERE user_agent LIKE '%Chrome/108%'");
  assert.ok(tool(s, 'sql', 'act').ok);
  assert.equal(current(s), 'reset');
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /70 000 customers, and only 63 of them were broken into/);
  sql(s, "SELECT username FROM signins WHERE result = 'ok' AND user_agent LIKE '%Chrome/108%' ORDER BY username");
  assert.ok(tool(s, 'sql', 'act').ok);
  assert.equal(current(s), 'rate');
  assert.equal(view(s, 'sql').action.done.count, 63);
  answer(s, 0);
  s.act({ type: 'control', control: 'shop-bot-protection', on: true });
  assert.equal(current(s), 'advice');
  answer(s, 0);
  answer(s, 0);
  assert.equal(snapshot(s).guide?.complete, true);
});

// ------------------------------------------------------------------ floor 1

test('floor 1: finish the script, survive a dead store, fix and prove it', () => {
  const s = floor('defend-adv-01-forty-stores');
  s.act({ type: 'look', what: 'tab', id: 'script' });
  answer(s, 0);
  answer(s, 0);
  assert.equal(current(s), 'write');
  const run = (scope: string, loop: string, errors: string, verdict: string, lang = 'bash') =>
    tool(s, 'script', 'run', { lang, scope, choices: [`loop:${loop}`, `errors:${errors}`, `verdict:${verdict}`] });

  // An empty block can't run.
  assert.equal(tool(s, 'script', 'run', { lang: 'bash', scope: 'one', choices: ['errors:crash'] }).ok, false);
  // Looping over the file's name prints nonsense, and the mentor says why.
  run('one', 'name', 'crash', 'right', 'python');
  assert.equal(current(s), 'write');
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /letters of the file's name/);
  assert.match(view(s, 'script').last.lines.join('\n'), /ValueError/);
  // Reading 401 as the default password flags store 41.
  run('one', 'each', 'crash', 'inverted');
  assert.equal(current(s), 'write');
  assert.match(view(s, 'script').last.lines[0], /41 .*DEFAULT PASSWORD/);
  run('one', 'each', 'crash', 'right');
  assert.equal(current(s), 'run');

  // Lindiwe's error handling dies at store 47: everything after it goes unchecked.
  run('all', 'each', 'crash', 'right');
  assert.equal(current(s), 'run');
  assert.match(view(s, 'script').last.summary, /Stopped at store 47: 34 stores never checked/);
  // Swallowing the error drops two stores without a word.
  run('all', 'each', 'skip', 'right', 'powershell');
  assert.equal(current(s), 'run');
  assert.equal(view(s, 'script').last.lines.length, 38);
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /two stores are missing/);
  run('all', 'each', 'handled', 'right', 'python');
  assert.equal(current(s), 'unknown');
  assert.deepEqual(view(s, 'script').found, [44, 52, 58, 63, 71]);
  assert.match(view(s, 'script').last.summary, /40 checked · 5 on the factory password · 2 no answer/);
  answer(s, 0);
  assert.ok(tool(s, 'script', 'fix').ok);
  assert.equal(current(s), 'prove');
  run('all', 'each', 'handled', 'right');
  assert.equal(current(s), 'cli');
  assert.ok(!view(s, 'script').last.lines.some((l: string) => /DEFAULT/.test(l)));
  answer(s, 0);
  answer(s, 0);
  assert.equal(snapshot(s).guide?.complete, true);
});

// ------------------------------------------------------------------ floor 2

test('floor 2: find the scraper, close the hole before the key, and empty the bucket', async () => {
  const s = floor('defend-adv-02-scraper');
  s.act({ type: 'look', what: 'tab', id: 'sql' });
  sql(s, 'SELECT api_key, account, COUNT(*) FROM api_requests GROUP BY api_key, account ORDER BY COUNT(*) DESC LIMIT 10');
  assert.equal(current(s), 'sequence');
  sql(s, "SELECT time, path, order_id, status FROM api_requests WHERE api_key = 'k_9d41e7' ORDER BY time LIMIT 20");
  assert.equal(current(s), 'idor');
  answer(s, 0);
  answer(s, 0);
  sql(s, "SELECT COUNT(DISTINCT order_id) FROM api_requests WHERE api_key = 'k_9d41e7'");
  assert.equal(current(s), 'close');

  // Revoking first only buys a minute: it signs up again.
  assert.ok(tool(s, 'cloud', 'revoke', { key: 'k_9d41e7' }).ok);
  assert.equal(current(s), 'close');
  await s.run(65_000);
  const back = view(s, 'cloud').keys.find((k: { id: string }) => k.id === 'k_2b7c0f');
  assert.ok(back && !back.revoked && back.requests > 0, 'the scraper is back with a new key');
  s.act({ type: 'control', control: 'api-authz', on: true });
  assert.equal(current(s), 'revoke');
  // A customer's key is not the scraper's.
  tool(s, 'cloud', 'revoke', { key: 'k_8bafb6' });
  assert.equal(current(s), 'revoke');
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /locks them out of their own orders/);
  tool(s, 'cloud', 'revoke', { key: 'k_2b7c0f' });
  assert.equal(current(s), 'bucket');

  // Making the bucket private would break the shop's photos; removing the photos too.
  tool(s, 'cloud', 'private', { bucket: 'media' });
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /empty box/);
  tool(s, 'cloud', 'remove', { object: 'photos' });
  assert.equal(current(s), 'bucket');
  tool(s, 'cloud', 'remove', { object: 'loyalty-export' });
  assert.equal(current(s), 'downloaded');
  answer(s, 0);
  answer(s, 0);
  s.act({ type: 'control', control: 'private-buckets', on: true });
  answer(s, 0);
  assert.equal(snapshot(s).guide?.complete, true);
});

// ------------------------------------------------------------------ floor 3

test('floor 3: cut off the recorder, close the way in, reflash, and segment every store', async () => {
  const s = floor('defend-adv-03-branch-dark');
  await s.run(5_000);
  s.act({ type: 'look', what: 'host', id: 'ikhaya/cctv' });
  assert.equal(current(s), 'why');
  answer(s, 0);
  s.act({ type: 'isolate', host: 'ikhaya/cctv' });
  assert.equal(current(s), 'map');
  s.act({ type: 'look', what: 'tab', id: 'segments' });
  // Flat today: every device reaches everything.
  const flat = view(s, 'segments');
  assert.equal(flat.applied.length, flat.sources.length * flat.destinations.length);
  answer(s, 0);
  assert.equal(current(s), 'forwards');
  tool(s, 'segments', 'close', { forward: 'nvr' });
  assert.equal(current(s), 'forwards');
  tool(s, 'segments', 'close', { forward: 'rdp' });
  assert.equal(current(s), 'reflash');
  s.act({ type: 'rebuild', host: 'ikhaya/cctv' });
  assert.equal(current(s), 'password');
  s.act({ type: 'reset', host: 'ikhaya/cctv', user: 'admin' });
  assert.equal(current(s), 'segment');

  const needs = ['tills>pos', 'office>pos', 'office>wms', 'office>directory', 'office>web', 'cameras>video', 'guest>web'];
  // Block everything breaks the tills.
  tool(s, 'segments', 'apply', { allow: [] });
  assert.equal(current(s), 'segment');
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /Tills → POS server is blocked/);
  // One flow too many: the very flow the recorder used this morning.
  tool(s, 'segments', 'apply', { allow: [...needs, 'cameras>directory', 'office>stores'] });
  assert.equal(current(s), 'segment');
  assert.match(snapshot(s).guide?.verdict?.text ?? '', /Camera recorder → Directory is still allowed.*2 flows in all/);
  assert.equal(view(s, 'segments').appliedAt, null, 'a wrong plan is never applied');
  tool(s, 'segments', 'apply', { allow: needs });
  assert.equal(current(s), 'iot');
  assert.equal(view(s, 'segments').applied.length, 7);
  assert.ok(snapshot(s).controls.some((c: { id: string; on: boolean }) => c.id === 'store-segmentation' && c.on), 'segmentation is on');
  answer(s, 0);
  answer(s, 0);
  assert.equal(snapshot(s).guide?.complete, true);
});

// ------------------------------------------------------------------ floor 4

test('floor 4: design thinking, stage by stage, with the wrong turns', () => {
  const s = floor('defend-adv-04-why-click');
  const verdict = (): string => snapshot(s).guide?.verdict?.text ?? '';
  s.act({ type: 'look', what: 'tab', id: 'design' });
  answer(s, 0);
  answer(s, 0);
  answer(s, 0);
  assert.equal(current(s), 'empathise');
  // Stages unlock in order.
  assert.equal(tool(s, 'design', 'define', { option: 'pov' }).ok, false);

  const all = view(s, 'design').empathise.map((c: { id: string }) => c.id);
  tool(s, 'design', 'empathise', { keep: all });
  assert.equal(current(s), 'empathise');
  assert.match(verdict(), /judgement about people/);
  tool(s, 'design', 'empathise', { keep: all.filter((id: string) => !['careless', 'phones', 'phone'].includes(id)) });
  assert.match(verdict(), /Jaco saw that/);
  tool(s, 'design', 'empathise', { keep: all.filter((id: string) => !['careless', 'phones'].includes(id)) });
  assert.equal(current(s), 'define');

  tool(s, 'design', 'define', { option: 'training' });
  assert.match(verdict(), /solution dressed up/);
  tool(s, 'design', 'define', { option: 'pov' });
  answer(s, 0);
  assert.equal(current(s), 'ideate');

  tool(s, 'design', 'ideate', { ideas: ['banner', 'button', 'fine'] });
  assert.match(verdict(), /Fear is why/);
  tool(s, 'design', 'ideate', { ideas: ['banner', 'button'] });
  assert.match(verdict(), /Which idea answers "the last person who owned up was punished"/);
  tool(s, 'design', 'ideate', { ideas: ['banner', 'button', 'thanks'] });
  assert.equal(current(s), 'prototype');

  tool(s, 'design', 'prototype', { option: 'all' });
  assert.equal(current(s), 'prototype');
  tool(s, 'design', 'prototype', { option: 'five' });
  assert.equal(view(s, 'design').test.rows, undefined, 'no results before the test');
  tool(s, 'design', 'test');
  assert.equal(current(s), 'iterate');
  assert.equal(view(s, 'design').test.rows.length, 2);
  assert.equal(view(s, 'design').current, null);
  answer(s, 0);
  s.act({ type: 'control', control: 'report-button', on: true });
  answer(s, 0);
  assert.equal(snapshot(s).guide?.complete, true);
});

// ------------------------------------------------------------------ floor 5

test('floor 5: find the insider in the audit trail, stop the payment, and split the duties', () => {
  const s = floor('defend-adv-05-insider');
  const verdict = (): string => snapshot(s).guide?.verdict?.text ?? '';
  answer(s, 0);
  s.act({ type: 'look', what: 'tab', id: 'sql' });
  sql(s, "SELECT * FROM erp_audit WHERE supplier = 'Mvelo Packaging' AND action = 'supplier.bank_change'");
  assert.equal(current(s), 'duties');
  answer(s, 0);
  // Only the changes to the account: three rows, three suppliers, still the finding.
  sql(s, "SELECT time, supplier, new_value FROM erp_audit WHERE user = approved_by AND new_value LIKE 'Ubuntu%'");
  assert.equal(current(s), 'lost');
  sql(s, "SELECT SUM(amount) FROM payments WHERE paid_to = 'Ubuntu Mutual 6201 9344 71'");
  assert.equal(current(s), 'hold');

  tool(s, 'approvals', 'hold', { payment: 'all' });
  assert.match(verdict(), /341 honest payments/);
  tool(s, 'approvals', 'hold', { payment: 'umoya' });
  assert.match(verdict(), /process working/);
  tool(s, 'approvals', 'hold', { payment: 'mvelo' });
  assert.equal(current(s), 'callback');
  tool(s, 'approvals', 'call', { payment: 'mvelo', number: 'letter' });
  assert.equal(current(s), 'callback');
  assert.match(verdict(), /reaches whoever wrote the letter/);
  tool(s, 'approvals', 'call', { payment: 'mvelo', number: 'contract' });
  answer(s, 0);
  assert.equal(current(s), 'evidence');

  tool(s, 'evidence', 'bag', { item: 'social' });
  assert.match(verdict(), /isn't ours to search/);
  for (const item of ['audit', 'letter', 'vpn', 'paid']) tool(s, 'evidence', 'bag', { item });
  tool(s, 'evidence', 'seal');
  assert.equal(current(s), 'lock');
  s.act({ type: 'lock', host: 'ikhaya/erp', user: 'precious' });
  assert.equal(current(s), 'lock');
  s.act({ type: 'lock', host: 'ikhaya/erp', user: 'yusuf' });
  assert.equal(current(s), 'roles');

  const live = view(s, 'approvals').grants as string[];
  // Moving the approval to the payments clerk swaps one conflict for another.
  tool(s, 'approvals', 'roles', { grants: [...live.filter((g) => g !== 'procurement>approve'), 'clerk>approve'] });
  assert.match(verdict(), /payments clerk can still approve a bank change and prepare the payment run/);
  // Taking it away from everyone stops finance.
  tool(s, 'approvals', 'roles', { grants: live.filter((g) => !g.endsWith('>approve')) });
  assert.match(verdict(), /Nobody can approve a bank change now/);
  tool(s, 'approvals', 'roles', { grants: live.filter((g) => g !== 'procurement>approve') });
  assert.equal(current(s), 'friend');
  assert.ok(snapshot(s).controls.some((c: { id: string; on: boolean }) => c.id === 'two-person-bank' && c.on));
  answer(s, 0);
  answer(s, 0);
  assert.equal(snapshot(s).guide?.complete, true);
});

// ------------------------------------------------------------------ floor 6

test('floor 6: import, relate, pivot and chart the monthly report, then publish five tiles', () => {
  const s = floor('defend-adv-06-monthly-report');
  const verdict = (): string => snapshot(s).guide?.verdict?.text ?? '';
  answer(s, 0);
  s.act({ type: 'look', what: 'tab', id: 'sheet' });
  // No incidents yet, no pivot.
  assert.equal(tool(s, 'sheet', 'pivot', { rows: 'month', columns: '', value: 'count' }).ok, false);
  tool(s, 'sheet', 'import', { source: 'siem' });
  assert.equal(current(s), 'phish');
  tool(s, 'sheet', 'import', { source: 'phish', delimiter: ',' });
  assert.match(verdict(), /one column/);
  assert.equal(view(s, 'sheet').tables.find((t: { name: string }) => t.name === 'phishing').garbled, true);
  tool(s, 'sheet', 'import', { source: 'phish', delimiter: ';' });
  assert.equal(current(s), 'more');
  tool(s, 'sheet', 'import', { source: 'hr' });
  assert.match(verdict(), /salaries or ID numbers/);
  tool(s, 'sheet', 'import', { source: 'stores' });
  tool(s, 'sheet', 'import', { source: 'vulns' });
  assert.equal(current(s), 'relate');

  tool(s, 'sheet', 'relate', { from: 'incidents.store', to: 'stores.name' });
  assert.match(verdict(), /number to number/);
  tool(s, 'sheet', 'relate', { from: 'incidents.store', to: 'stores.store' });
  assert.equal(current(s), 'trend');

  tool(s, 'sheet', 'pivot', { rows: 'opened', columns: '', value: 'count' });
  assert.match(verdict(), /Month level/);
  tool(s, 'sheet', 'pivot', { rows: 'month', columns: '', value: 'count' });
  assert.deepEqual(view(s, 'sheet').pivot.rowTotals, [96, 88, 81, 105]);
  assert.equal(current(s), 'chart');
  tool(s, 'sheet', 'chart', { type: 'pie' });
  assert.match(verdict(), /parts of one whole/);
  tool(s, 'sheet', 'chart', { type: 'line' });
  assert.equal(current(s), 'region');

  // Months down the rows and regions across also counts.
  tool(s, 'sheet', 'pivot', { rows: 'month', columns: 'region', value: 'count' });
  const p = view(s, 'sheet').pivot;
  const east = p.colLabels.indexOf('Eastern Cape');
  assert.deepEqual(p.cells.map((r: number[]) => r[east]), [10, 16, 12, 31]);
  assert.equal(p.colTotals[p.colLabels.indexOf('(blank)')], 59);
  assert.equal(current(s), 'blank');
  answer(s, 0);
  answer(s, 0);

  tool(s, 'sheet', 'pivot', { rows: 'month', columns: '', value: 'sum-minutes' });
  assert.match(verdict(), /use the average/);
  tool(s, 'sheet', 'pivot', { rows: 'month', columns: '', value: 'avg-minutes' });
  assert.deepEqual(view(s, 'sheet').pivot.rowTotals.map(Math.round), [75, 66, 57, 42]);
  answer(s, 0);
  assert.equal(current(s), 'dashboard');

  const good = ['trend', 'regions', 'respond', 'phishing', 'vulns'];
  tool(s, 'sheet', 'publish', { tiles: [...good, 'analysts'] });
  assert.match(verdict(), /league table/);
  tool(s, 'sheet', 'publish', { tiles: good.slice(0, 4) });
  assert.match(verdict(), /also need "Critical vulnerabilities/);
  tool(s, 'sheet', 'publish', { tiles: good });
  assert.equal(view(s, 'sheet').tiles.find((t: { id: string }) => t.id === 'vulns').show.figure, '3');
  answer(s, 0);
  assert.equal(snapshot(s).guide?.complete, true);
});

// ------------------------------------------------------------------ floor 7

test('floor 7: fund the plan with the best return, then take it to the board', () => {
  const s = floor('defend-adv-07-board');
  const verdict = (): string => snapshot(s).guide?.verdict?.text ?? '';
  s.act({ type: 'look', what: 'tab', id: 'budget' });
  const seg = view(s, 'budget').projects.find((p: { id: string }) => p.id === 'segment');
  assert.equal(seg.before, 4_080_000);
  assert.equal(seg.reduced, 3_400_000);
  answer(s, 0);
  tool(s, 'budget', 'rosi');
  assert.equal(view(s, 'budget').projects.find((p: { id: string }) => p.id === 'ai').rosi, -75);
  answer(s, 0);
  assert.equal(current(s), 'plan');

  tool(s, 'budget', 'fund', { projects: ['soc247', 'segment', 'bots', 'backups', 'button', 'insurance'] });
  assert.match(verdict(), /R3.4m is R400 000 over the R3m/);
  tool(s, 'budget', 'fund', { projects: ['backups', 'ai'] });
  assert.match(verdict(), /return of -75%|return of −75%/);
  tool(s, 'budget', 'fund', { projects: ['segment', 'bots', 'backups', 'button', 'insurance'] });
  assert.match(verdict(), /Another mix within R3m reduces R10.88m/);
  tool(s, 'budget', 'fund', { projects: ['soc247', 'segment', 'bots', 'backups', 'button'] });
  assert.equal(current(s), 'insurance');
  answer(s, 0);
  answer(s, 0);
  answer(s, 0);
  assert.equal(current(s), 'deck');

  const parts = view(s, 'compose').parts as { id: string; options: { id: string }[] }[];
  const first = parts.map((p) => `${p.id}:${p.options[0]!.id}`);
  tool(s, 'compose', 'publish', { choices: first.map((c) => (c.startsWith('left:') ? 'left:promise' : c)) });
  assert.match(verdict(), /Nobody can promise that/);
  tool(s, 'compose', 'publish', { choices: first });
  assert.equal(current(s), 'deepfake');
  answer(s, 0);
  answer(s, 0);
  answer(s, 0);
  assert.equal(snapshot(s).guide?.complete, true);
});
