// Live mode drafts: the compose generator stays inside the lab, and the eve
// parser copes with real and broken Suricata output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { loadWorld } from '../src/world/load.ts';
import { bridgeName, buildLivePlan, planInsideLab } from '../src/live/compose.ts';
import { eveAlertSummary, eveSeverity, parseEve, parseEveLine } from '../src/live/eve.ts';

const bundle = loadWorld();

test('every live network is internal and every address is in the lab range', () => {
  const plan = buildLivePlan(bundle, 'siyakhula');
  const compose = parse(plan.files.find((f) => f.path === 'docker-compose.yml')!.content) as {
    networks: Record<string, { internal: boolean; driver_opts: Record<string, string> }>;
    services: Record<string, unknown>;
  };
  for (const [name, net] of Object.entries(compose.networks)) {
    assert.equal(net.internal, true, `${name} is internal`);
    assert.ok(net.driver_opts['com.docker.network.bridge.name']!.length <= 15);
  }
  assert.ok(planInsideLab(plan, bundle.miniverse.labRange));
  assert.ok('gw' in compose.services && 'kali' in compose.services && 'nids' in compose.services);
  assert.ok(!('ids' in compose.services), 'the IDS box is played by the host-network sensor');
});

test('the gateway firewall denies by default and follows the zone policy', () => {
  const plan = buildLivePlan(bundle, 'siyakhula');
  const firewall = plan.files.find((f) => f.path === 'firewall.sh')!.content;
  assert.match(firewall, /iptables -P FORWARD DROP/);
  assert.match(firewall, /-s 10\.88\.0\.0\/24 -d 10\.88\.20\.0\/24 -p tcp -m multiport --dports 25,80,443 -j ACCEPT/);
});

test('an organisation with no network IDS gets a warning, not a sensor', () => {
  const plan = buildLivePlan(bundle, 'dataquant', { level: 1 });
  assert.ok(plan.warnings.some((w) => w.includes('no Suricata sensor')));
});

test('bridge names fit the 15-character limit', () => {
  assert.equal(bridgeName('siyakhula', 'security'), 'cl-siya-securit');
});

test('eve.json alerts, http and flows parse; broken lines are skipped', () => {
  const lines = [
    '{"timestamp":"2026-11-21T02:14:20.123456+0200","event_type":"alert","src_ip":"10.88.0.143","src_port":51234,"dest_ip":"10.88.20.20","dest_port":443,"proto":"TCP","alert":{"action":"allowed","signature_id":2006445,"signature":"ET WEB_SERVER Possible SQL Injection Attempt UNION SELECT","category":"Web Application Attack","severity":1}}',
    '{"timestamp":"2026-11-21T02:14:21.000000+0200","event_type":"http","src_ip":"10.88.0.143","dest_ip":"10.88.20.20","dest_port":443,"http":{"hostname":"eservices.siyakhula.internal","url":"/account.php?id=1","http_method":"GET","status":200,"http_user_agent":"sqlmap/1.8.2"}}',
    'not json',
    '',
    '{"timestamp":"2026-11-21T02:15:12.000000+0200","event_type":"flow","src_ip":"10.88.20.20","dest_ip":"10.88.0.143","flow":{"bytes_toserver":1200,"bytes_toclient":18000000}}',
  ].join('\n');
  const { records, skipped } = parseEve(lines);
  assert.equal(records.length, 3);
  assert.equal(skipped, 1);
  const alert = records[0]!;
  assert.equal(alert.type, 'alert');
  assert.equal(alert.alert?.severity, 'high');
  assert.equal(alert.at, Date.parse('2026-11-21T02:14:20.123456+02:00'));
  assert.equal(records[1]!.http?.userAgent, 'sqlmap/1.8.2');
  assert.equal(records[2]!.bytes?.toClient, 18_000_000);
  assert.equal(eveAlertSummary(alert, (ip) => (ip === '10.88.20.20' ? 'eservices.siyakhula.internal' : ip)), 'ET WEB_SERVER Possible SQL Injection Attempt UNION SELECT: 10.88.0.143 -> eservices.siyakhula.internal:443');
  assert.equal(parseEveLine('[1,2]'), null);
  assert.equal(eveSeverity(1, 'Attempted Administrator Privilege Gain'), 'critical');
  assert.equal(eveSeverity(3), 'low');
});
