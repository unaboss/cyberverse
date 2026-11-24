// npm run dev: the lab server while it is being built.
//
//   node src/dev.ts [--port 8788] [--no-pull]
//
// Starts the server and restarts it whenever the game code (src/), the world
// (worlds/) or the practicals change. Once a minute it asks GitHub whether this
// branch has new commits and, if it can do so safely, fast-forwards to them, so
// updates arrive without typing anything. Open pages reload themselves when the
// server restarts or the UI files change (see /api/version in the server).
//
// The pull only ever fast-forwards. It leaves your copy alone if you have changed
// tracked files or made commits of your own, and says so once.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PROJECT_ROOT } from './world/load.ts';

const run = promisify(execFile);
const WATCHED = ['src', 'worlds', 'practicals'];
const PULL_EVERY_MS = 60_000;
const SETTLE_MS = 400;

const argv = process.argv.slice(2);
const pulling = !argv.includes('--no-pull');
const serveArgs = argv.filter((a) => a !== '--no-pull');

let child: ChildProcess | null = null;
let restarting = false;
let stopping = false;
let settle: ReturnType<typeof setTimeout> | null = null;
const said = new Set<string>();

function say(line: string): void {
  console.log(`[dev] ${line}`);
}

/** Say something once per run, for a state that will not change by itself. */
function sayOnce(key: string, line: string): void {
  if (!said.has(key)) {
    said.add(key);
    say(line);
  }
}

// ------------------------------------------------------------------ server

function start(): void {
  const proc = spawn(process.execPath, [join(PROJECT_ROOT, 'src', 'cli.ts'), 'serve', ...serveArgs], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: { ...process.env, CYBERVERSE_DEV: '1' },
  });
  child = proc;
  proc.on('exit', (code) => {
    if (child === proc) {
      child = null;
    }
    if (stopping) {
      return;
    }
    if (restarting) {
      restarting = false;
      start();
      return;
    }
    say(`The server stopped${code ? ` (exit code ${code})` : ''}. It starts again as soon as a file changes.`);
  });
}

function restart(why: string): void {
  say(`${why}: restarting the server.`);
  if (child) {
    restarting = true;
    child.kill();
  } else {
    start();
  }
}

function changed(dir: string, file: string | null): void {
  if (file && (/(^|[\\/])\.|~$|\.swp$/.test(file))) {
    return; // editor scratch files
  }
  if (settle) {
    clearTimeout(settle);
  }
  settle = setTimeout(() => {
    settle = null;
    restart(`${file ? join(dir, file) : dir} changed`);
  }, SETTLE_MS);
}

// ------------------------------------------------------------------ GitHub

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd: PROJECT_ROOT,
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

async function pull(): Promise<void> {
  let upstream: string;
  try {
    upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  } catch {
    sayOnce('no-upstream', 'This branch does not track a branch on GitHub, so updates are not fetched. Run git pull yourself.');
    return;
  }
  const slash = upstream.indexOf('/');
  const remote = upstream.slice(0, slash);
  const branch = upstream.slice(slash + 1);
  try {
    await git('fetch', '--quiet', remote, branch);
  } catch (err) {
    sayOnce('fetch', `Could not reach GitHub to check for updates (${firstLine(err)}). I'll keep trying quietly.`);
    return;
  }
  said.delete('fetch');
  const behind = Number(await git('rev-list', '--count', `HEAD..${upstream}`));
  if (behind === 0) {
    return;
  }
  const ahead = Number(await git('rev-list', '--count', `${upstream}..HEAD`));
  if (ahead > 0) {
    sayOnce(`ahead-${upstream}`, `${behind} update(s) are on GitHub, but this copy has ${ahead} commit(s) of its own, so I'm not pulling. Sort it out with git, then I'll carry on.`);
    return;
  }
  if ((await git('status', '--porcelain', '--untracked-files=no')) !== '') {
    sayOnce(`dirty-${behind}`, `${behind} update(s) are on GitHub, but you have changed files here, so I'm leaving them alone. Commit or undo your changes and I'll pull on the next check.`);
    return;
  }
  const subjects = (await git('log', '--reverse', '--format=%s', `HEAD..${upstream}`)).split('\n').map((line) => `      - ${line}`).join('\n');
  const packages = await git('diff', '--name-only', 'HEAD', upstream, '--', 'package.json', 'package-lock.json');
  try {
    await git('merge', '--ff-only', '--quiet', upstream);
  } catch (err) {
    sayOnce(`merge-${behind}`, `Could not pull the update (${firstLine(err)}). Run git pull to see why.`);
    return;
  }
  say(`Pulled ${behind} update(s) from GitHub:\n${subjects}`);
  if (packages !== '') {
    say('The packages changed: stop this with Ctrl+C, run npm install, then npm run dev again.');
  }
  // The file watcher restarts the server for code, world and practical changes; the
  // pages reload themselves for UI changes.
}

function firstLine(err: unknown): string {
  const text = err instanceof Error ? ((err as Error & { stderr?: string }).stderr || err.message) : String(err);
  return text.trim().split('\n')[0] ?? 'unknown error';
}

let pullBusy = false;
async function check(): Promise<void> {
  if (pullBusy) {
    return;
  }
  pullBusy = true;
  try {
    await pull();
  } catch (err) {
    sayOnce('pull', `Checking GitHub for updates failed (${firstLine(err)}). Run git pull yourself.`);
  } finally {
    pullBusy = false;
  }
}

// ------------------------------------------------------------------ main

for (const dir of WATCHED) {
  watch(join(PROJECT_ROOT, dir), { recursive: true }, (_event, file) => changed(dir, file));
}
start();
say(`Watching ${WATCHED.join(', ')} and ui. Pages reload themselves.`);
if (pulling) {
  say('Checking GitHub for updates every minute (npm run dev -- --no-pull turns that off).');
  setTimeout(() => void check(), 3_000);
  setInterval(() => void check(), PULL_EVERY_MS);
}

const stop = (): void => {
  stopping = true;
  child?.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
