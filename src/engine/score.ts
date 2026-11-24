// Scoring and the debrief. The debrief puts both sides on one timeline: what
// the attacker did, what the sensors caught, what the learner did, and every
// blind spot with the reason it was missed. That is where the learning lands,
// and it doubles as QCTO evidence.

import type { LabEvent, SimClock } from './core.ts';
import { ruleMatches, sightings } from './detect.ts';
import type { Session } from './session.ts';
import type { World } from './world.ts';

export interface ScorePart {
  label: string;
  points: number;
  max: number;
  note: string;
}

export interface RoundScore {
  role: 'prey' | 'predator';
  outcome: string;
  total: number;
  grade: string;
  parts: ScorePart[];
}

function grade(total: number): string {
  if (total >= 85) return 'Distinction';
  if (total >= 70) return 'Competent';
  if (total >= 50) return 'Developing';
  return 'Not yet competent';
}

const minutes = (ms: number): string => `${Math.max(0, ms / 60_000).toFixed(1)} min`;

export function scoreRound(session: Session): RoundScore {
  return session.practical.role === 'prey' ? scorePrey(session) : scorePredator(session);
}

function scorePrey(session: Session): RoundScore {
  const { detector, bus, business, practical } = session;
  const org = practical.org;
  const alerts = detector.alerts.filter((a) => a.org === org);
  const real = alerts.filter((a) => a.truth);
  const parts: ScorePart[] = [];
  const firstMalicious = bus.events.find((e) => e.malicious && e.org === org && e.actor === 'attacker' && e.kind !== 'attacker.step');

  // Detection
  const acks = bus.events.filter((e) => (e.kind === 'alert.acknowledged' || e.kind === 'alert.classified') && real.some((a) => a.id === Number(e.data?.alert)));
  if (real.length === 0) {
    parts.push({ label: 'Detection', points: 0, max: 20, note: 'The attack never raised an alert. See the blind spots.' });
  } else if (acks.length === 0) {
    parts.push({ label: 'Detection', points: 6, max: 20, note: `${real.length} real alert(s) fired, but you never picked one up.` });
  } else {
    const first = real[0]!;
    const delay = acks[0]!.t - first.t;
    const points = Math.max(8, Math.round(20 - (delay / 60_000) * 3));
    parts.push({ label: 'Detection', points, max: 20, note: `Picked up the first real alert ${minutes(delay)} after it fired.` });
  }

  // Containment
  const reason = session.end?.reason;
  const containment =
    reason === 'contained'
      ? { points: 25, note: `Contained: the attacker gave up ${minutes((session.end?.at ?? 0) - (firstMalicious?.t ?? 0))} after starting.` }
      : reason === 'objective'
        ? { points: 0, note: 'The attacker reached its objective.' }
        : { points: 14, note: 'You held out until the end of the shift, but the attacker was still active.' };
  parts.push({ label: 'Containment', max: 25, ...containment });

  // Data
  const state = business.state.get(org)!;
  const objective = practical.attacker?.objective;
  const lostObjective = state.leaked.some((l) => l.key === objective && l.fraction >= 0.5);
  const leakedValue = state.leaked.reduce((s, l) => s + l.impact, 0);
  parts.push({
    label: 'Data protected',
    points: lostObjective ? 0 : Math.max(0, Math.round(20 - leakedValue / 100_000)),
    max: 20,
    note: state.leaked.length === 0 ? 'Nothing left the building.' : `Lost: ${state.leaked.map((l) => (l.fraction < 1 ? `part of ${l.name}` : l.name)).join(', ')} (R${Math.round(leakedValue).toLocaleString('en-ZA')} in harm).`,
  });

  // Business
  parts.push({
    label: 'Business kept running',
    points: Math.round((state.health / 100) * 10),
    max: 10,
    note: `Business health ${state.health}%. Downtime cost R${Math.round(state.downtimeLost).toLocaleString('en-ZA')}.`,
  });

  // Triage
  const classified = alerts.filter((a) => a.verdict);
  const correct = classified.filter((a) => (a.verdict === 'true-positive') === a.truth);
  parts.push({
    label: 'Triage accuracy',
    points: classified.length === 0 ? 0 : Math.round((correct.length / classified.length) * 10),
    max: 10,
    note: classified.length === 0 ? 'Close alerts as true or false positives to score here.' : `${correct.length} of ${classified.length} alerts classified correctly.`,
  });

  // Status report (EAS FA4.3)
  const report = session.report;
  const fields = report ? [report.summary, report.impact, report.actions, report.recommendations] : [];
  const filled = fields.filter((f) => f.trim().length >= 20).length;
  parts.push({
    label: 'Status report',
    points: filled === 4 ? 15 : filled > 0 ? 8 : 0,
    max: 15,
    note: report ? `${filled} of 4 sections written. A facilitator moderates the content.` : 'No status report submitted.',
  });

  const total = parts.reduce((s, p) => s + p.points, 0);
  const outcome = reason === 'contained' ? 'Attacker contained' : reason === 'objective' ? 'Breached' : reason === 'time' ? 'Shift ended' : reason === 'complete' ? 'Floor complete' : 'Stopped';
  return { role: 'prey', outcome, total, grade: grade(total), parts };
}

function scorePredator(session: Session): RoundScore {
  const { detector, bus, practical, terminal } = session;
  const org = practical.org;
  const parts: ScorePart[] = [];
  const stolen = terminal?.stolen ?? [];
  const partial = terminal?.partial ?? [];
  const objective = practical.attacker?.objective;
  const footholds = terminal?.sessions.length ?? 0;
  parts.push({
    label: 'Objective',
    points: objective && stolen.includes(objective) ? 40 : objective && partial.includes(objective) ? 30 : stolen.length > 0 ? 25 : partial.length > 0 ? 18 : footholds > 0 ? 12 : 0,
    max: 40,
    note: stolen.length + partial.length > 0
      ? `Took: ${[...stolen.map((k) => session.world.dataByKey(k)?.name ?? k), ...partial.map((k) => `part of ${session.world.dataByKey(k)?.name ?? k}`)].join(', ')}.`
      : footholds > 0 ? `${footholds} foothold(s), no data taken.` : 'No foothold.',
  });
  const raised = detector.alerts.filter((a) => a.org === org && a.truth);
  parts.push({ label: 'Stealth', points: Math.max(0, 25 - raised.length * 3), max: 25, note: `${raised.length} alert(s) raised by your activity.` });
  const caught = bus.events.filter((e) => e.actor === 'defender' && ['fw.block', 'host.isolate', 'account.reset'].includes(e.kind)).length;
  parts.push({ label: 'Not caught', points: Math.max(0, 15 - caught * 5), max: 15, note: caught === 0 ? 'The defender never reacted to you.' : `The defender reacted ${caught} time(s).` });
  const violations = terminal?.scopeViolations ?? [];
  parts.push({ label: 'Stayed in scope', points: violations.length === 0 ? 10 : 0, max: 10, note: violations.length === 0 ? 'Every command stayed inside the signed scope.' : `Out of scope: ${violations.join(', ')}. In real work this can be a crime.` });
  const durationMs = practical.durationMin * 60_000;
  const firstSteal = bus.events.find((e) => e.kind === 'data.leaked' && e.org === org);
  parts.push({ label: 'Speed', points: firstSteal ? Math.round(10 * (1 - firstSteal.t / durationMs)) : 0, max: 10, note: firstSteal ? `First data out after ${minutes(firstSteal.t)}.` : 'No data taken.' });
  const total = parts.reduce((s, p) => s + p.points, 0);
  return { role: 'predator', outcome: objective && stolen.includes(objective) ? 'Objective reached' : stolen.length > 0 ? 'Data taken' : partial.length > 0 ? 'Partial data taken' : footholds > 0 ? 'Foothold only' : 'No way in', total, grade: grade(total), parts };
}

// ------------------------------------------------------------------- debrief

export type Lane = 'attacker' | 'detection' | 'response' | 'business';

export interface DebriefItem {
  t: number;
  clock: string;
  lane: Lane;
  title: string;
  detail?: string;
  severity?: string;
  host?: string;
  falsePositive?: boolean;
  /** The attacker's decision (its plan), as opposed to traffic it sent. */
  intent?: boolean;
}

export interface BlindSpot {
  t: number;
  clock: string;
  what: string;
  why: string;
  fix: string;
  count: number;
}

const LABELS: Record<string, string> = {
  'net.probe': 'Scanning',
  'auth.fail': 'Failed logins',
  'auth.success': 'A login',
  'exploit.attempt': 'Exploit traffic',
  'proc.exec': 'A suspicious process',
  'file.read': 'Bulk file reads',
  'file.write': 'Files rewritten',
  'data.transfer': 'Data sent out',
  'mail.received': 'A malicious mail',
  'http.request': 'Web attack requests',
  'ot.write': 'A controller write',
  'net.connect': 'A call-home connection',
};

export interface Debrief {
  items: DebriefItem[];
  blindSpots: BlindSpot[];
  score: RoundScore | null;
  leaked: { name: string; impact: number; personal: boolean }[];
  attacker?: { sources: string[]; result: string | null };
}

const AGGREGATE = new Set(['net.probe', 'auth.fail', 'http.request', 'file.read', 'file.write']);
const WATCH = new Set(['net.probe', 'auth.fail', 'auth.success', 'exploit.attempt', 'proc.exec', 'file.read', 'file.write', 'data.transfer', 'mail.received', 'http.request', 'ot.write', 'net.connect']);
const RESPONSE = new Set(['fw.block', 'fw.unblock', 'host.isolate', 'host.release', 'host.rebuild', 'account.lock', 'account.reset', 'control.change', 'alert.classified', 'alert.acknowledged', 'report.submitted']);

function hostName(world: World, e: LabEvent): string {
  const host = e.host ? world.hosts.get(e.host) : e.dst ? world.byIp.get(e.dst) : undefined;
  return host?.fqdn ?? e.dst ?? 'the network';
}

export function buildDebrief(session: Session): Debrief {
  const { bus, world, detector, clock, practical } = session;
  const items: DebriefItem[] = [];
  const stamp = (t: number): string => clock.clockText(t);
  let group: { key: string; first: LabEvent; last: LabEvent; count: number } | null = null;
  const flush = (): void => {
    if (!group) return;
    const e = group.first;
    const what =
      e.kind === 'net.probe'
        ? group.first.dst === group.last.dst
          ? `Scanned ${hostName(world, e)} (${group.count} probes)`
          : `Swept the ${world.zoneOfIp(e.dst ?? '').zone} network (${group.count} probes)`
        : e.kind === 'auth.fail'
          ? `${group.count} failed logins on ${hostName(world, e)}`
          : e.kind === 'http.request'
            ? `${group.count} web requests to ${hostName(world, e)}${e.tags.includes('sqli') ? ' carrying SQL injection' : ''}`
            : `${group.count} × ${e.summary}`;
    items.push({ t: e.t, clock: stamp(e.t), lane: 'attacker', title: what, detail: `from ${e.src ?? '?'}`, ...(e.host ? { host: e.host } : {}) });
    group = null;
  };

  for (const e of bus.events) {
    if (e.malicious && (e.actor === 'attacker' || e.actor === 'learner') && WATCH.has(e.kind)) {
      const wide = e.kind === 'net.probe' || (e.kind === 'auth.fail' && e.tags.includes('spray'));
      const key = wide ? `${e.kind}|${e.src}` : `${e.kind}|${e.src}|${e.dst ?? e.host}`;
      if (AGGREGATE.has(e.kind)) {
        if (group && group.key === key && e.t - group.last.t < 30_000) {
          group.count++;
          group.last = e;
          continue;
        }
        flush();
        group = { key, first: e, last: e, count: 1 };
        continue;
      }
      flush();
      items.push({ t: e.t, clock: stamp(e.t), lane: 'attacker', title: e.summary, ...(e.src ? { detail: `from ${e.src}` } : {}), ...(e.host ? { host: e.host } : {}) });
      continue;
    }
    if (e.kind === 'attacker.step') {
      flush();
      items.push({ t: e.t, clock: stamp(e.t), lane: 'attacker', title: e.summary, intent: true });
    } else if (e.kind === 'alert.raised') {
      const alert = detector.get(Number(e.data?.alert));
      if (alert) {
        items.push({ t: e.t, clock: stamp(e.t), lane: 'detection', title: alert.summary, severity: alert.severity, ...(alert.host ? { host: alert.host } : {}), falsePositive: !alert.truth });
      }
    } else if (RESPONSE.has(e.kind)) {
      items.push({ t: e.t, clock: stamp(e.t), lane: 'response', title: e.summary, detail: e.actor === 'defender' ? 'Defender bot' : e.actor === 'learner' ? 'You' : e.actor });
    } else if (e.kind === 'data.leaked' || e.kind === 'host.down' || e.kind === 'attacker.objective' || e.kind === 'attacker.gave-up') {
      items.push({ t: e.t, clock: stamp(e.t), lane: 'business', title: e.summary });
    }
  }
  flush();

  const state = session.business.state.get(practical.org);
  return {
    items: items.sort((a, b) => a.t - b.t),
    blindSpots: blindSpots(session, clock),
    score: session.score,
    leaked: (state?.leaked ?? []).map((l) => ({ name: l.name, impact: l.impact, personal: l.personal })),
    ...(session.attacker ? { attacker: { sources: [...session.attacker.burned, session.attacker.ip], result: session.attacker.result } } : {}),
  };
}

function blindSpots(session: Session, clock: SimClock): BlindSpot[] {
  const { bus, world, detector } = session;
  const seen = new Set<string>();
  const out: BlindSpot[] = [];
  for (const e of bus.events) {
    if (!e.malicious || !WATCH.has(e.kind) || detector.explained.has(e.id) || !(e.actor === 'attacker' || e.actor === 'learner')) {
      continue;
    }
    const org = (e.host ? world.hosts.get(e.host)?.org : undefined) ?? (e.dst ? world.zoneOfIp(e.dst).org : null) ?? e.org;
    if (!org) {
      continue;
    }
    const rules = [...world.rules.values()].filter((r) => ruleMatches(r, e));
    let why: string;
    let fix: string;
    if (rules.length === 0) {
      continue;
    }
    const enabled = rules.filter((r) => world.ruleEnabled(org, r.id));
    const visible = sightings(world, e).filter((s) => s.org === org);
    if (enabled.length === 0) {
      why = `No control switches on "${rules[0]!.name}" here.`;
      const control = [...(world.orgs.get(org)?.controls.values() ?? [])].find((c) => (c.rules ?? []).includes(rules[0]!.id));
      fix = control ? `Switch on "${control.name}".` : `Add a control that enables ${rules[0]!.id}.`;
    } else if (!enabled.some((r) => visible.some((v) => v.sensor === r.sensor))) {
      const sensor = enabled[0]!.sensor;
      const where = sensor === 'nids' ? `the ${world.zoneOfIp(e.dst ?? e.src ?? '').zone} network` : e.host ? (world.hosts.get(e.host)?.hostname ?? e.host) : 'there';
      why = `No ${sensorName(sensor)} watches ${where}.`;
      fix = sensor === 'hids' ? `Install a log agent on ${where}.` : `Extend ${sensorName(sensor)} to cover ${where}.`;
    } else {
      const rule = enabled.find((r) => r.threshold) ?? enabled[0]!;
      why = rule.threshold ? `Too slow or too small for "${rule.name}" (needs ${rule.threshold.count} in ${rule.threshold.withinSec}s).` : `Matched "${rule.name}" but was merged into an earlier alert.`;
      fix = rule.threshold ? 'Consider a lower threshold or a longer window, and weigh the extra false alarms.' : 'Review the cooldown for this rule.';
    }
    const wide = e.kind === 'net.probe' || e.kind === 'auth.fail';
    const zone = e.dst ? world.zoneOfIp(e.dst).zone : '';
    const what = wide ? `${LABELS[e.kind] ?? e.kind} from ${e.src ?? '?'} into the ${zone} network` : `${LABELS[e.kind] ?? e.kind} on ${hostName(world, e)}`;
    const key = `${what}|${why}`;
    if (seen.has(key)) {
      const existing = out.find((b) => `${b.what}|${b.why}` === key);
      if (existing) existing.count++;
      continue;
    }
    seen.add(key);
    out.push({ t: e.t, clock: clock.clockText(e.t), what, why, fix, count: 1 });
  }
  return out;
}

function sensorName(type: string): string {
  return { nids: 'network sensor', hids: 'log agent', weblog: 'web log feed', mail: 'mail gateway' }[type] ?? type;
}
