// The Cloudflare Worker's entry. `npm run cf:build` writes dist/world-files.json
// before wrangler bundles this file; the logic is in app.ts.

import data from './dist/world-files.json' with { type: 'json' };
import { createLab, type WorldFiles } from './app.ts';

const lab = createLab(data as WorldFiles);

export default lab.worker;
export const Round = lab.Round;
