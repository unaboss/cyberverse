// Gathers what the Cloudflare build needs from disk: the world files the
// Worker builds the world from, and the UI it serves as static files.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { QCTO_FILES } from '../src/world/build.ts';
import type { WorldFiles } from './app.ts';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const posix = (path: string): string => path.split(sep).join('/');

/** Every world, practical and QCTO blueprint file, keyed by its path from the project folder. */
export function collectWorldFiles(root: string): WorldFiles {
  const files: Record<string, string> = {};
  for (const dir of ['worlds', 'practicals']) {
    for (const path of walk(join(root, dir)).sort()) {
      if (/\.(ya?ml|txt|json)$/.test(path)) {
        files[posix(relative(root, path))] = readFileSync(path, 'utf8');
      }
    }
  }
  for (const file of QCTO_FILES) {
    const path = join(root, file);
    if (existsSync(path)) {
      files[file] = readFileSync(path, 'utf8');
    }
  }
  const hash = createHash('sha256');
  for (const [name, text] of Object.entries(files)) {
    hash.update(name).update('\0').update(text).update('\0');
  }
  return { stamp: hash.digest('hex').slice(0, 16), files };
}

/** The UI files to serve, keyed by their path under ui/ (type declarations left out). */
export function collectUiFiles(root: string): string[] {
  const ui = join(root, 'ui');
  return walk(ui)
    .map((path) => posix(relative(ui, path)))
    .filter((name) => !name.endsWith('.d.ts'))
    .sort();
}
