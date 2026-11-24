// Reads the world files from disk. The building itself is in build.ts, which a
// Cloudflare Worker also uses with files bundled into it instead of a disk.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorld, type WorldSource, type WorldBundle } from './build.ts';

export type { OrgBundle, WorldBundle, WorldSource } from './build.ts';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The world files on disk, under the project folder. */
export function diskSource(root: string = PROJECT_ROOT): WorldSource {
  const at = (path: string): string => join(root, path);
  return {
    read: (path) => readFileSync(at(path), 'utf8'),
    exists: (path) => existsSync(at(path)),
    list: (dir) => readdirSync(at(dir)),
    where: at,
  };
}

export function loadWorld(root: string = PROJECT_ROOT): WorldBundle {
  return buildWorld(diskSource(root), root);
}
