// The world files load, validate at every level, and resolve per level.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorld } from '../src/world/load.ts';
import { validateWorld } from '../src/world/validate.ts';
import { activeAt, resolveMiniverse, resolveOrg } from '../src/world/resolve.ts';
import { inCidr, parseCidr, ipToInt, intToIp, cidrInside } from '../src/world/net.ts';

const bundle = loadWorld();

test('the world validates with no issues at any level', () => {
  assert.deepEqual(validateWorld(bundle), []);
});

test('DataQuant has the nine agreed departments and Siyakhula is fictional', () => {
  const dq = bundle.orgs.get('dataquant')!;
  assert.deepEqual(
    dq.departments.map((d) => d.name).sort(),
    ['Academy', 'AI Operations', 'Data & Insights', 'Growth', 'Offensive Security', 'Operations', 'Solutions Studio', 'Strategy & Leadership', 'Trust & Risk'].sort(),
  );
  assert.equal(dq.def.fictional, false);
  assert.equal(bundle.orgs.get('siyakhula')!.def.fictional, true);
});

test('level gating: items appear and disappear with maturity', () => {
  assert.equal(activeAt({}, 1), true);
  assert.equal(activeAt({ from: 2 }, 1), false);
  assert.equal(activeAt({ from: 2, until: 3 }, 4), false);
  const l1 = resolveOrg(bundle, 'dataquant', 1);
  const l2 = resolveOrg(bundle, 'dataquant', 2);
  assert.ok(!l1.zones.some((z) => z.id === 'office'), 'no office network at level 1');
  assert.ok(l2.zones.some((z) => z.id === 'office'), 'office network from level 2');
  assert.ok(l2.systems.length > l1.systems.length, 'DataQuant gains systems as it matures');
});

test('every lab address sits inside the lab range', () => {
  const range = bundle.miniverse.labRange;
  for (const org of resolveMiniverse(bundle, { dataquant: 4, siyakhula: 4 }).orgs.values()) {
    for (const zone of org.zones) {
      assert.ok(cidrInside(zone.cidr, range), `${zone.cidr} inside ${range}`);
    }
    for (const sys of org.systems) {
      assert.ok(inCidr(sys.ip, range), `${sys.key} ${sys.ip}`);
    }
  }
});

test('the supply-chain link exists once both ends exist', () => {
  const low = resolveMiniverse(bundle, { siyakhula: 3, dataquant: 1 });
  assert.ok(low.links.some((l) => l.src === 'dataquant/etl' && l.dst === 'siyakhula/dwh'));
});

test('IPv4 helpers', () => {
  assert.equal(intToIp(ipToInt('10.88.20.20')), '10.88.20.20');
  assert.equal(parseCidr('10.88.20.7/24').size, 256);
  assert.ok(inCidr('10.88.20.200', '10.88.20.0/24'));
  assert.ok(!inCidr('10.88.21.1', '10.88.20.0/24'));
  assert.throws(() => ipToInt('10.88.300.1'));
});

test('map sites: every room in one site, and moved sites never overlap', () => {
  const siya = bundle.orgs.get('siyakhula')!;
  assert.deepEqual(siya.def.sites?.map((s) => s.id), ['civic', 'services', 'depot']);
  const clone = structuredClone(bundle);
  const def = clone.orgs.get('siyakhula')!.def;
  def.sites = [
    { id: 'a', name: 'A', rooms: ['municipal-manager', 'corporate-services', 'treasury', 'planning'] },
    { id: 'b', name: 'B', rooms: ['ict', 'community', 'electrical', 'water'], shift: { x: 0, y: -3 } },
  ];
  const issues = validateWorld(clone).map((i) => i.message);
  assert.ok(issues.some((m) => m.includes('sites a and b overlap')), issues.join('\n'));
  def.sites = [{ id: 'a', name: 'A', rooms: ['ict', 'ict'] }];
  const more = validateWorld(clone).map((i) => i.message);
  assert.ok(more.some((m) => m.includes('room ict is in sites a and a')));
  assert.ok(more.some((m) => m.includes('room water is in no site')));
});
