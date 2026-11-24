// The operating manual comes from the same files as the lab, so it must never
// carry anything marked LAB ONLY.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorld } from '../src/world/load.ts';
import { buildManual, manualToMarkdown } from '../src/world/manual.ts';
import { resolveOrg } from '../src/world/resolve.ts';
import { LEVELS } from '../src/world/types.ts';

const bundle = loadWorld();

for (const orgId of bundle.orgs.keys()) {
  for (const level of LEVELS) {
    test(`${orgId} level ${level} manual has no lab-only details`, () => {
      const markdown = manualToMarkdown(buildManual(bundle, orgId, level));
      const org = resolveOrg(bundle, orgId, level);
      assert.ok(!markdown.includes('10.88.'), 'no lab addresses');
      assert.ok(!markdown.includes('.internal'), 'no lab hostnames');
      for (const sys of org.systems) {
        for (const account of sys.accounts ?? []) {
          assert.ok(account.password.length < 4 || !markdown.includes(account.password), `password of ${sys.key}:${account.user}`);
        }
        for (const weakness of sys.weaknesses ?? []) {
          assert.ok(!markdown.includes(weakness.name), `weakness ${weakness.id}`);
          assert.ok(!weakness.cve || !markdown.includes(weakness.cve), `CVE of ${weakness.id}`);
        }
        if (sys.live) {
          assert.ok(!markdown.includes(sys.live.image), `live image of ${sys.key}`);
        }
      }
      for (const threat of org.threats) {
        assert.ok(!markdown.includes(threat.name), `threat ${threat.id}`);
      }
      for (const person of org.people.filter((p) => p.kind === 'human')) {
        assert.ok(!markdown.includes(person.name), `lab persona ${person.name}`);
      }
      for (const data of org.data) {
        if (data.records && data.records >= 1000) {
          assert.ok(!markdown.includes(data.records.toLocaleString('en-ZA')) && !markdown.includes(String(data.records)), `record count of ${data.id}`);
        }
      }
    });
  }
}

test('the manual covers every department and the maturity path', () => {
  const manual = buildManual(bundle, 'dataquant', 1);
  assert.equal(manual.sections.length, 1 + bundle.orgs.get('dataquant')!.departments.length);
  const md = manualToMarkdown(manual);
  assert.match(md, /Level 1 \(current\)/);
  assert.match(md, /Level 2 \(next\)/);
  assert.match(md, /Runs weekly/, 'real cadence, not the compressed lab schedule');
});
