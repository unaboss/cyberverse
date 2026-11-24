// Builds the Cloudflare upload into cloudflare/dist/:
//   dist/world-files.json   the world, bundled into the Worker (never served)
//   dist/public/            the UI, served as static files, with _headers
//
// Run by `npm run cf:dev` and `npm run cf:deploy`; on its own: `npm run cf:build`.

import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectUiFiles, collectWorldFiles } from './files.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(here, 'dist');
const pub = join(dist, 'public');

// The same headers the local server sends with the UI.
const HEADERS = `/*
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  Cache-Control: no-cache
`;

rmSync(dist, { recursive: true, force: true });
mkdirSync(pub, { recursive: true });

const world = collectWorldFiles(root);
writeFileSync(join(dist, 'world-files.json'), JSON.stringify(world));

const ui = collectUiFiles(root);
for (const name of ui) {
  mkdirSync(dirname(join(pub, name)), { recursive: true });
  cpSync(join(root, 'ui', name), join(pub, name));
}
writeFileSync(join(pub, '_headers'), HEADERS);

console.log(`Built cloudflare/dist: ${Object.keys(world.files).length} world files (stamp ${world.stamp}), ${ui.length} UI files.`);
