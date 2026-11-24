// Cyberverse command line.
//
//   node src/cli.ts validate
//   node src/cli.ts manual <org> [--level N] [--out dir]
//   node src/cli.ts round <practical> [--seed N]
//   node src/cli.ts compose <org> [--level N] [--placeholders] [--out dir]
//   node src/cli.ts serve [--port 8788]
//   node src/dev.ts [--port 8788] [--no-pull]   serve, restart on changes, pull updates

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadWorld } from './world/load.ts';
import { validateWorld } from './world/validate.ts';
import { buildManual, manualToMarkdown } from './world/manual.ts';
import { LEVELS, type Level } from './world/types.ts';
import { Session } from './engine/session.ts';
import { buildDebrief } from './engine/score.ts';
import { buildLivePlan, planInsideLab } from './live/compose.ts';
import { LabServer } from './server/server.ts';

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2);
      const next = argv[i + 1];
      if (inline !== undefined) {
        flags.set(key!, inline);
      } else if (next !== undefined && !next.startsWith('--')) {
        flags.set(key!, next);
        i++;
      } else {
        flags.set(key!, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function levelFlag(args: Args): Level | undefined {
  const value = args.flags.get('level');
  if (value === undefined) {
    return undefined;
  }
  const level = Number(value) as Level;
  if (!LEVELS.includes(level)) {
    throw new Error('--level must be 1, 2, 3 or 4.');
  }
  return level;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const USAGE = `Cyberverse

  validate                                  check every world file at every level
  manual <org> [--level N] [--out dir]      write the operating manual (Markdown)
  round <practical> [--seed N]              run a round headless and print what happened
  compose <org> [--level N] [--out dir]     draft live-mode files (not approved to run yet)
  serve [--port 8788]                       start the lab on http://127.0.0.1:8788`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (command) {
    case 'validate':
      return validate();
    case 'manual':
      return manual(args);
    case 'round':
      return round(args);
    case 'compose':
      return compose(args);
    case 'serve':
      return serve(args);
    default:
      console.log(USAGE);
      if (command && command !== 'help' && command !== '--help') {
        process.exit(1);
      }
  }
}

function validate(): void {
  const bundle = loadWorld();
  const issues = validateWorld(bundle);
  const orgs = [...bundle.orgs.values()].map((o) => `${o.def.name} (${o.departments.length} departments)`).join(', ');
  console.log(`World: ${orgs}. ${bundle.rules.length} detection rules, ${bundle.practicals.length} practicals.`);
  if (bundle.qctoIds === null) {
    console.log('QCTO blueprints not found in docs/qcto, so QCTO ids were not checked.');
  }
  for (const issue of issues) {
    console.log(`  ${issue.where}: ${issue.message}`);
  }
  if (issues.length > 0) {
    fail(`${issues.length} issue(s).`);
  }
  console.log('No issues at any maturity level.');
}

function manual(args: Args): void {
  const bundle = loadWorld();
  const orgs = args.positional.length > 0 ? args.positional : [...bundle.orgs.keys()];
  const out = args.flags.get('out');
  for (const org of orgs) {
    if (!bundle.orgs.has(org)) {
      fail(`No organisation called ${org}. Try: ${[...bundle.orgs.keys()].join(', ')}.`);
    }
    const doc = buildManual(bundle, org, levelFlag(args));
    const markdown = manualToMarkdown(doc);
    if (typeof out === 'string') {
      mkdirSync(out, { recursive: true });
      const file = join(out, `${org}-level-${doc.level}.md`);
      writeFileSync(file, markdown);
      console.log(`Wrote ${file}`);
    } else {
      console.log(markdown);
    }
  }
}

async function round(args: Args): Promise<void> {
  const bundle = loadWorld();
  const id = args.positional[0];
  const practical = bundle.practicals.find((p) => p.id === id);
  if (!practical) {
    fail(`Choose a practical: ${bundle.practicals.map((p) => p.id).join(', ')}.`);
  }
  const seedFlag = args.flags.get('seed');
  const session = new Session(bundle, practical, typeof seedFlag === 'string' ? { seed: Number(seedFlag) } : {});
  console.log(`${practical.title} (seed ${session.seed}). Nobody defends in a headless round.`);
  session.begin(true);
  await session.run(practical.durationMin * 60_000);
  if (session.status !== 'ended') {
    session.finish('time');
  }
  const debrief = buildDebrief(session);
  for (const item of debrief.items) {
    console.log(`${item.clock}  ${item.lane.padEnd(9)} ${item.title}${item.detail ? `: ${item.detail}` : ""}`);
  }
  if (debrief.blindSpots.length > 0) {
    console.log('\nBlind spots:');
    for (const b of debrief.blindSpots) {
      console.log(`  ${b.what}: ${b.why}`);
    }
  }
  const score = session.score!;
  console.log(`\n${score.outcome}. ${score.total}/100 (${score.grade}).`);
  for (const part of score.parts) {
    console.log(`  ${part.label.padEnd(22)} ${String(part.points).padStart(2)}/${part.max}  ${part.note}`);
  }
}

function compose(args: Args): void {
  const bundle = loadWorld();
  const org = args.positional[0];
  if (!org || !bundle.orgs.has(org)) {
    fail(`Choose an organisation: ${[...bundle.orgs.keys()].join(', ')}.`);
  }
  const plan = buildLivePlan(bundle, org, { ...(levelFlag(args) ? { level: levelFlag(args)! } : {}), placeholders: args.flags.has('placeholders') });
  if (!planInsideLab(plan, bundle.miniverse.labRange)) {
    fail('Refusing: an address in the plan is outside the lab range.');
  }
  const outFlag = args.flags.get('out');
  const out = resolve(typeof outFlag === 'string' ? outFlag : join('live', plan.project));
  mkdirSync(out, { recursive: true });
  for (const file of plan.files) {
    writeFileSync(join(out, file.path), file.content);
  }
  console.log(`Wrote ${plan.files.map((f) => f.path).join(', ')} to ${out}`);
  console.log(`${plan.machines.length} machine(s): ${plan.machines.map((m) => `${m.key} ${m.ip}`).join(', ')}`);
  for (const w of plan.warnings) {
    console.log(`  note: ${w}`);
  }
  console.log('\nLive mode is a DRAFT and is not approved to run yet. See DECISIONS.md (live mode).');
}

async function serve(args: Args): Promise<void> {
  const portFlag = args.flags.get('port');
  const port = typeof portFlag === 'string' ? Number(portFlag) : 8788;
  const server = new LabServer();
  const { port: bound } = await server.listen(port, '127.0.0.1');
  console.log(`Cyberverse is running on http://127.0.0.1:${bound} (this computer only). Ctrl+C stops it.`);
  if (server.dev) {
    console.log('Development mode: open pages reload themselves when the lab changes.');
  }
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
